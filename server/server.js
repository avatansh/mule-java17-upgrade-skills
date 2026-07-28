// server/server.js — the hosted HTTP + MCP endpoint (port of the Mule shared HTTP listener).
//
// One Node http.Server exposing three surfaces on a single port:
//
//   • MCP JSON-RPC          POST {mcp.endpointPath, default /mcp}   → handleRpc (initialize/tools/*)
//   • REST tool facade      POST /api/v1/tools/{name}               → run a tool directly (bearer-guarded)
//                           GET  /api/v1/tools                      → tool catalog
//   • CI/CD webhooks        POST /webhook, POST /webhook/cd-result  → HMAC-verified ci_ingest
//   • Health                GET  /health                            → liveness + job counts
//   • Metrics               GET  /metrics                           → status histogram + env breakdown
//
// Observability: every request runs inside a correlation context (see lib/logger.js). An inbound
// x-correlation-id / x-request-id is honoured (else one is minted), echoed back on the response
// x-correlation-id header, and stamped into every structured (JSON-lines) log line for the request.
//
// Auth: the MCP + REST surfaces are protected by the bearer guard (disabled when MCP_BEARER_TOKEN
// is unset — so local runs need no token). The webhook surface is protected by HMAC (auth.js), NOT
// the bearer, exactly like the Mule app. Bodies are read raw (Buffer) so the webhook HMAC is computed
// over the exact received bytes.
//
// Run:  node server/server.js        (PORT from MCP_SERVER_PORT / http.port config, default 8080)

import http from "node:http";
import "../lib_shared/env.js";
import { get, requireEnv } from "../lib_shared/config.js";
import { handleRpc } from "./lib/mcp.js";
import { TOOLS_BY_NAME, toolCatalog } from "./lib/tools.js";
import { validateArgs } from "./lib/schema.js";
import { checkBearer } from "./lib/auth.js";
import { handleWebhook } from "./lib/webhook.js";
import { logger, withContext, bindContext, newCorrelationId } from "./lib/logger.js";
import { healthSnapshot, metricsSnapshot } from "./lib/health.js";

function cfg(dotted, fallback) {
  try {
    const v = get(dotted, undefined);
    return v === undefined || v === null || v === "" ? fallback : v;
  } catch {
    return fallback;
  }
}

function readRawBody(req, limitBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error("payload too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj ?? {});
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Inbound correlation id: honour a caller-supplied `x-correlation-id` / `x-request-id` so a trace
 * spans upstream systems (the Agentforce agent, a gateway), else mint a fresh one. Mirrors the Mule
 * app propagating an existing correlationId when present.
 * @param {Record<string, any>} headers
 * @returns {string}
 */
function resolveCorrelationId(headers) {
  const supplied = headers["x-correlation-id"] || headers["x-request-id"] || headers["x-amzn-trace-id"];
  return supplied ? String(supplied) : newCorrelationId();
}

/** Lower-case a Node headers object (values already lower-cased by Node, but be explicit). */
function lowerHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h ?? {})) out[String(k).toLowerCase()] = v;
  return out;
}

export async function route(req, res) {
  const method = req.method || "GET";
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const headers = lowerHeaders(req.headers);
  const correlationId = resolveCorrelationId(headers);

  // Echo the correlation id on the response so the caller can join client- and server-side logs,
  // and stamp it into the request-scoped context so EVERY log line below inherits it (MDC-style).
  res.setHeader("x-correlation-id", correlationId);
  return withContext({ correlationId }, () => dispatch(req, res, { method, path, headers }));
}

/**
 * dispatch: the actual routing, run inside the correlation context established by route().
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{method: string, path: string, headers: Record<string, any>}} ctx
 */
async function dispatch(req, res, { method, path, headers }) {
  const mcpPath = cfg("mcp.endpointPath", "/mcp");
  const startedAt = Date.now();
  logger.info("request.received", { method, path });
  // One completion line per request, whichever branch replied — captures final status + latency.
  res.once("finish", () => {
    logger.info("request.completed", {
      method,
      path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  try {
    // ── health + metrics (open — for probes / scrapers; no secrets exposed) ──────────────────────
    if (method === "GET" && path === "/health") {
      return sendJson(res, 200, healthSnapshot());
    }
    if (method === "GET" && path === "/metrics") {
      return sendJson(res, 200, metricsSnapshot());
    }

    // ── webhooks (HMAC-guarded, NOT bearer) ──────────────────────────────────────────────────────
    if (method === "POST" && (path === "/webhook" || path === "/webhook/cd-result")) {
      const rawBody = await readRawBody(req);
      const { statusCode, body } = await handleWebhook({
        path,
        headers: /** @type {Record<string,string>} */ (headers),
        rawBody,
      });
      logger.info("webhook.handled", { path, status: statusCode, jobId: body?.jobId ?? null });
      return sendJson(res, statusCode, body);
    }

    // ── everything below is bearer-guarded ───────────────────────────────────────────────────────
    if (!checkBearer(headers)) {
      return sendJson(res, 401, { error: "unauthorized: missing or invalid bearer token" });
    }

    // MCP JSON-RPC
    if (method === "POST" && path === mcpPath) {
      const rawBody = await readRawBody(req);
      let message;
      try {
        message = JSON.parse(rawBody.toString("utf8") || "{}");
      } catch {
        return sendJson(res, 200, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
      }
      // Support a JSON-RPC batch (array) as well as a single message.
      if (Array.isArray(message)) {
        bindContext({ rpcBatch: message.length });
        logger.info("mcp.batch", { size: message.length });
        const out = [];
        for (const m of message) {
          const r = await handleRpc(m);
          if (r) out.push(r);
        }
        return sendJson(res, 200, out);
      }
      bindContext({ rpcMethod: message?.method, tool: message?.params?.name });
      logger.info("mcp.request", { rpcMethod: message?.method, tool: message?.params?.name });
      const response = await handleRpc(message);
      if (response == null) {
        res.writeHead(202); // notification → no body
        return res.end();
      }
      return sendJson(res, 200, response);
    }

    // REST tool catalog
    if (method === "GET" && path === "/api/v1/tools") {
      return sendJson(res, 200, { tools: toolCatalog() });
    }

    // REST tool invocation: POST /api/v1/tools/{name}
    const restMatch = /^\/api\/v1\/tools\/([A-Za-z0-9_]+)$/.exec(path);
    if (method === "POST" && restMatch) {
      const name = restMatch[1];
      bindContext({ tool: name, via: "rest" });
      const tool = TOOLS_BY_NAME.get(name);
      if (!tool) return sendJson(res, 404, { error: `Unknown tool: ${name}` });
      const rawBody = await readRawBody(req);
      let args;
      try {
        args = rawBody.length ? JSON.parse(rawBody.toString("utf8")) : {};
      } catch {
        return sendJson(res, 400, { error: "invalid JSON body" });
      }
      const problems = validateArgs(args, tool.inputSchema);
      if (problems.length) {
        logger.warn("tool.invalid_args", { tool: name, problems });
        return sendJson(res, 400, { error: "invalid arguments", problems });
      }
      try {
        logger.info("tool.invoke", { tool: name });
        const result = await tool.handler(args);
        return sendJson(res, 200, result);
      } catch (e) {
        const code = e.code ?? "SYSTEM";
        const statusCode =
          code === "NOT_FOUND" ? 404 : code === "VALIDATION" ? 400 : code === "CONFLICT" ? 409 : 500;
        logger.error("tool.error", { tool: name, code, error: e.message });
        return sendJson(res, statusCode, {
          error: e.message,
          code,
          ...(e.invalidFields ? { invalidFields: e.invalidFields } : {}),
        });
      }
    }

    return sendJson(res, 404, { error: `not found: ${method} ${path}` });
  } catch (e) {
    const statusCode = e.statusCode ?? 500;
    logger.error("request.failed", { method, path, status: statusCode, error: e.message });
    return sendJson(res, statusCode, { error: e.message ?? "internal error" });
  }
}

export function createServer() {
  return http.createServer((req, res) => {
    route(req, res).catch((e) => {
      logger.error("request.unhandled", { error: e?.message ?? String(e) });
      try {
        sendJson(res, 500, { error: e?.message ?? "internal error" });
      } catch {
        /* response already sent */
      }
    });
  });
}

const isMain = process.argv[1] && process.argv[1].endsWith("server.js");
if (isMain) {
  // Mandatory environment selector — mirrors the Mule app refusing to boot without -Denv/mule.env.
  // The server is long-lived under ONE env; require it explicitly (MULE_UPGRADE_ENV) rather than
  // silently defaulting. Fail fast before binding the port.
  let activeEnv;
  try {
    activeEnv = requireEnv(process.env.MULE_UPGRADE_ENV, { flag: "MULE_UPGRADE_ENV" });
  } catch (e) {
    process.stderr.write(`[mule-java17-upgrade-skills] cannot start: ${e.message}\n`);
    process.exit(2);
  }
  const port = Number(process.env.MCP_SERVER_PORT || cfg("http.port", 8080));
  const host = cfg("http.host", "0.0.0.0");
  const server = createServer();
  server.listen(port, host, () => {
    const bearer = process.env.MCP_BEARER_TOKEN ? "ON" : "OFF (open — set MCP_BEARER_TOKEN to require)";
    process.stderr.write(
      `[mule-java17-upgrade-skills] listening on http://${host}:${port}\n` +
        `  Environment  : ${activeEnv} (config-${activeEnv}.yaml + config-secure-${activeEnv}.yaml)\n` +
        `  MCP JSON-RPC : POST ${cfg("mcp.endpointPath", "/mcp")}\n` +
        `  REST tools   : GET /api/v1/tools · POST /api/v1/tools/{name}\n` +
        `  Webhooks     : POST /webhook · POST /webhook/cd-result (HMAC)\n` +
        `  Health       : GET /health · GET /metrics\n` +
        `  Bearer auth  : ${bearer}\n`
    );
    logger.info("server.listening", {
      host,
      port,
      env: activeEnv,
      bearer: process.env.MCP_BEARER_TOKEN ? "on" : "off",
    });
  });
}
