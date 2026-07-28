// server/lib/logger.js — structured (JSON-lines) logging + a request-scoped correlation context.
//
// This is the skill-server analogue of the Mule app's MDC (Mapped Diagnostic Context) work: every
// log line emitted while handling a request carries the same `correlationId` (and any other context
// keys we stash), so a single hosted run is traceable end-to-end across the HTTP layer, the MCP
// dispatcher, and the tool handlers — without threading an id argument through every function.
//
// HOW THE CONTEXT PROPAGATES
//   We use Node's AsyncLocalStorage. server.js calls withContext({ correlationId, ... }, () => route())
//   once per request; any log() call inside that async tree (however deep) automatically merges the
//   stored context into the emitted record. This is exactly MDC semantics: set once at the edge,
//   read everywhere, cleared when the request's async scope ends.
//
// OUTPUT
//   One JSON object per line on stderr (so stdout stays clean for any protocol piping). Shape:
//     {"ts":"2026-07-26T12:00:00Z","level":"info","msg":"...","correlationId":"...", ...fields}
//   JSON lines are the lingua franca of log shippers (CloudWatch, Loki, Datadog) — a hosted run is
//   grep/jq-able and every line joins on correlationId. Set LOG_FORMAT=text for a compact
//   human-readable line during local dev.
//
// LEVELS
//   error > warn > info > debug. LOG_LEVEL (env) sets the floor (default "info"). Cheap: a filtered
//   line does zero formatting work.

import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { nowUtc } from "../../lib_shared/dates.js";

/** @typedef {"error"|"warn"|"info"|"debug"} Level */

const LEVELS = /** @type {const} */ ({ error: 50, warn: 40, info: 30, debug: 20 });

/** @type {AsyncLocalStorage<Record<string, any>>} */
const als = new AsyncLocalStorage();

/** The active log floor (numeric). Read once at module load; LOG_LEVEL=debug|info|warn|error. */
function levelFloor() {
  const name = String(process.env.LOG_LEVEL || "info").toLowerCase();
  return LEVELS[/** @type {Level} */ (name)] ?? LEVELS.info;
}

/** True when LOG_FORMAT=text (human line) rather than the default JSON-lines. */
function textMode() {
  return String(process.env.LOG_FORMAT || "").toLowerCase() === "text";
}

/**
 * newCorrelationId(prefix): a short, sortable-ish unique id for one request/run.
 * Not security-sensitive — just needs to be collision-free within a deployment.
 * @param {string} [prefix]
 * @returns {string}
 */
export function newCorrelationId(prefix = "req") {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * currentContext(): the merged context stored for the active async scope (empty object if none).
 * @returns {Record<string, any>}
 */
export function currentContext() {
  return als.getStore() ?? {};
}

/**
 * withContext(context, fn): run fn with `context` merged onto any inherited context, so every log()
 * inside fn (sync or async, however deeply nested) carries these fields. Returns fn's return value.
 * @template T
 * @param {Record<string, any>} context
 * @param {() => T} fn
 * @returns {T}
 */
export function withContext(context, fn) {
  const merged = { ...currentContext(), ...context };
  return als.run(merged, fn);
}

/**
 * bindContext(extra): merge extra keys into the CURRENT scope's context in place (best-effort).
 * Useful to enrich the context once more is known (e.g. the tool name / jobId after parsing) so
 * later lines in the same request pick it up. No-op when called outside a withContext scope.
 * @param {Record<string, any>} extra
 */
export function bindContext(extra) {
  const store = als.getStore();
  if (store) Object.assign(store, extra);
}

/**
 * log(level, msg, fields): emit one structured record at `level`, merged with the active context.
 * Filtered out (zero work) when below the configured floor.
 * @param {Level} level
 * @param {string} msg
 * @param {Record<string, any>} [fields]
 */
export function log(level, msg, fields = {}) {
  if ((LEVELS[level] ?? 0) < levelFloor()) return;
  const record = { ts: nowUtc(), level, msg, ...currentContext(), ...fields };
  process.stderr.write(textMode() ? formatText(record) : JSON.stringify(record) + "\n");
}

/** Compact human line for LOG_FORMAT=text: "ts level [correlationId] msg key=val …". */
function formatText(record) {
  const { ts, level, msg, correlationId, ...rest } = record;
  const cid = correlationId ? ` [${correlationId}]` : "";
  const extra = Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(" ");
  return `${ts} ${String(level).toUpperCase().padEnd(5)}${cid} ${msg}${extra ? " " + extra : ""}\n`;
}

/** Level-specific convenience wrappers. */
export const logger = {
  /** @param {string} msg @param {Record<string,any>} [f] */
  error: (msg, f) => log("error", msg, f),
  /** @param {string} msg @param {Record<string,any>} [f] */
  warn: (msg, f) => log("warn", msg, f),
  /** @param {string} msg @param {Record<string,any>} [f] */
  info: (msg, f) => log("info", msg, f),
  /** @param {string} msg @param {Record<string,any>} [f] */
  debug: (msg, f) => log("debug", msg, f),
};
