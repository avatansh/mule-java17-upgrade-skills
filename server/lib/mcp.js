// server/lib/mcp.js — minimal MCP (Model Context Protocol) JSON-RPC 2.0 dispatcher.
//
// Implements the subset the Mule mcp:tool-listener exposed, transport-agnostic (the HTTP layer
// feeds it a parsed JSON-RPC message and ships the returned envelope back):
//
//   initialize                 -> serverInfo + capabilities (tools)
//   notifications/initialized  -> no response (notification)
//   tools/list                 -> { tools: [...catalog] }
//   tools/call                 -> run the named tool; wrap the result as MCP content
//
// tools/call validates args against the tool's JSON Schema (required keys + declared types +
// additionalProperties:false) before dispatch, returning a JSON-RPC -32602 (Invalid params) on a
// contract violation — this is the "schema-contract guard" the plan calls for. A handler that
// throws becomes an MCP tool error result ({ isError:true }) rather than a protocol error, so the
// client sees the domain failure, matching the Mule mcp-error-handler envelope.

import { get } from "../../lib_shared/config.js";
import { TOOLS_BY_NAME, toolCatalog } from "./tools.js";
import { validateArgs } from "./schema.js";

const PROTOCOL_VERSION = "2024-11-05";

function cfg(dotted, fallback) {
  try {
    const v = get(dotted, undefined);
    return v === undefined || v === null || v === "" ? fallback : v;
  } catch {
    return fallback;
  }
}

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message, data) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message, ...(data ? { data } : {}) },
});

/**
 * handleRpc(message): process one JSON-RPC request/notification. Returns the response envelope,
 * or null for a notification (no reply). NEVER throws.
 */
export async function handleRpc(message) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
    return rpcError(message?.id, -32600, "Invalid Request: expected JSON-RPC 2.0");
  }
  const { id, method, params } = message;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: cfg("mcp.serverName", "mule-java17-upgrade-skills"),
          version: cfg("mcp.serverVersion", "1.0.0"),
        },
      });

    case "notifications/initialized":
    case "initialized":
      return null; // notification — no response

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: toolCatalog() });

    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const tool = TOOLS_BY_NAME.get(name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);

      const problems = validateArgs(args, tool.inputSchema);
      if (problems.length) {
        return rpcError(id, -32602, `Invalid params for ${name}: ${problems.join("; ")}`, { problems });
      }
      try {
        const result = await tool.handler(args);
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        });
      } catch (e) {
        // Domain/handler failure → MCP tool error result (not a protocol error).
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify({ error: e.message, code: e.code ?? "SYSTEM" }) }],
          isError: true,
        });
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
