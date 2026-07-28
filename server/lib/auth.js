// server/lib/auth.js — transport-layer authentication for the hosted MCP/HTTP server.
//
// Two independent mechanisms, faithful to the Mule app's global-config + post-webhook.xml:
//
//   1. Bearer guard (MCP + REST)  — clients present `Authorization: Bearer <token>`. The expected
//      token is MCP_BEARER_TOKEN (env). When it is UNSET the guard is DISABLED (open) so local /
//      IDE use needs no token; set it in any hosted/Agentforce deployment to require auth.
//
//   2. Webhook signature (CI/CD callbacks) — GitHub-style HMAC-SHA256 over the RAW request body:
//         expected = "sha256=" + hex(HMAC-SHA256(webhookSecret, rawBody))
//      compared against `x-hub-signature-256` (POST /webhook) or `x-cd-signature-256`
//      (POST /webhook/cd-result), constant-time via crypto.timingSafeEqual. A transitional
//      shared-token fallback authenticates a cd-result delivery whose `x-cd-token` equals the
//      webhook secret (matches the Mule X-CD-Token branch). The secret is the decrypted
//      `github.webhookSecret` (env GITHUB_WEBHOOK_SECRET overrides the encrypted YAML).
//
// All comparisons are constant-time and never throw on malformed input (return false instead).

import crypto from "node:crypto";
import { get } from "../../lib_shared/config.js";

/** Read a config value, swallowing lookup/decrypt errors -> fallback. */
function cfg(dotted, fallback) {
  try {
    const v = get(dotted, undefined);
    return v === undefined || v === null || v === "" ? fallback : v;
  } catch {
    return fallback;
  }
}

/** The expected bearer token, or "" when bearer auth is disabled. */
export function expectedBearer() {
  return process.env.MCP_BEARER_TOKEN || "";
}

/** Constant-time string compare that never throws (length-mismatch -> false). */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ab.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

/**
 * checkBearer(headers): true when the request is authorized.
 * Disabled (always true) when MCP_BEARER_TOKEN is unset. Otherwise requires an exact
 * `Authorization: Bearer <MCP_BEARER_TOKEN>` match (constant-time).
 */
export function checkBearer(headers = {}) {
  const expected = expectedBearer();
  if (!expected) return true; // auth disabled
  const raw = headers["authorization"] ?? headers["Authorization"] ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  if (!m) return false;
  return safeEqual(m[1], expected);
}

/** The decrypted webhook HMAC secret (env override -> encrypted YAML). "" when unconfigured. */
export function webhookSecret() {
  return process.env.GITHUB_WEBHOOK_SECRET || cfg("github.webhookSecret", "");
}

/** Compute the GitHub-style signature "sha256=<hex>" for a raw body + secret. */
export function computeSignature(rawBody, secret) {
  const h = crypto.createHmac("sha256", Buffer.from(String(secret ?? ""), "utf8"));
  h.update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ""), "utf8"));
  return "sha256=" + h.digest("hex");
}

/**
 * verifyWebhook({rawBody, headers, signatureHeader, allowTokenFallback}): validate a webhook
 * delivery. Returns {ok:boolean, reason?}. NEVER throws.
 *
 * @param {object} [opts]
 * @param {Buffer|string} [opts.rawBody]             the exact bytes the signature was computed over
 * @param {Record<string,string>} [opts.headers]   lower-cased header map
 * @param {string} [opts.signatureHeader]          "x-hub-signature-256" | "x-cd-signature-256"
 * @param {boolean} [opts.allowTokenFallback]      accept x-cd-token === webhookSecret (cd-result only)
 */
export function verifyWebhook({
  rawBody,
  headers = {},
  signatureHeader = "x-hub-signature-256",
  allowTokenFallback = false,
} = {}) {
  const secret = webhookSecret();
  if (!secret) return { ok: false, reason: "webhook secret not configured" };

  const provided = String(headers[signatureHeader] ?? headers[signatureHeader.toLowerCase()] ?? "");
  if (provided) {
    const expected = computeSignature(rawBody, secret);
    if (safeEqual(provided, expected)) return { ok: true, via: "signature" };
  }
  if (allowTokenFallback) {
    const token = String(headers["x-cd-token"] ?? "");
    if (token && safeEqual(token, secret)) return { ok: true, via: "token" };
  }
  return { ok: false, reason: provided ? "signature mismatch" : "missing signature" };
}
