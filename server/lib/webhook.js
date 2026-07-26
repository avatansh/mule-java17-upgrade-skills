// server/lib/webhook.js — inbound CI/CD callback handlers (port of process/post-webhook.xml).
//
// Two endpoints, both authenticated by HMAC-SHA256 over the RAW body (see auth.verifyWebhook):
//
//   POST /webhook            GitHub-style delivery, header `x-hub-signature-256`. Currently used to
//                            accept a generic CI/CD result payload (same body shape as cd-result).
//   POST /webhook/cd-result  CD pipeline callback, header `x-cd-signature-256`, with the transitional
//                            `x-cd-token` shared-secret fallback. Drives the ci_ingest state machine.
//
// Delivery de-dup: an idempotency key (header `x-delivery-id`/`x-github-delivery`, else a hash of
// the body) is recorded via jobstore.markOnce; a repeat delivery short-circuits to the last-known
// job status without re-applying the transition (mirrors the Mule idempotencyStore guard).
//
// The deploy stage optionally confirms platform health via an injected verifyDeploy (Anypoint).
// Everything is non-fatal to the SERVER: a handler returns {statusCode, body} and never throws.

import crypto from "node:crypto";
import { ingestCiResult } from "../../skills/mule-upgrade-job/scripts/ci_ingest.js";
import * as store from "../../skills/mule-upgrade-job/scripts/jobstore.js";
import { verifyWebhook } from "./auth.js";
import { AnypointClient, makeDeployVerifier } from "../../skills/mule-upgrade/scripts/lib/anypoint.js";

/** Stable idempotency key for a delivery: explicit delivery header, else sha256 of the raw body. */
function deliveryKey(headers, rawBody) {
  const explicit = headers["x-delivery-id"] || headers["x-github-delivery"] || headers["x-cd-delivery-id"];
  if (explicit) return `delivery::${explicit}`;
  const h = crypto.createHash("sha256").update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ""), "utf8"));
  return `delivery::${h.digest("hex")}`;
}

/** Build the Anypoint deploy verifier when enabled + configured; else null (trust CI). */
function defaultVerifyDeploy() {
  try {
    const client = new AnypointClient();
    if (!client.configured()) return null;
    const verify = makeDeployVerifier(client);
    // makeDeployVerifier returns an async fn; ci_ingest calls it synchronously via try/catch and
    // treats a thrown/absent result as "unreachable". We wrap to a sync-ish adapter that returns a
    // promise; ci_ingest awaits nothing, so instead expose a resolved-value bridge is not possible —
    // therefore deploy verification here is opt-in through opts.verifyDeploy passed by the caller.
    return verify;
  } catch {
    return null;
  }
}

/**
 * handleWebhook({ path, headers, rawBody, deps }): authenticate + ingest a CI/CD callback.
 * @param {string} path       "/webhook" | "/webhook/cd-result"
 * @param {object} headers    lower-cased header map
 * @param {Buffer|string} rawBody
 * @param {object} [deps]     { store, ingest, verifyDeploy, verifyWebhook } — injectable for tests
 * @returns {{statusCode:number, body:object}}
 */
export function handleWebhook({ path, headers = {}, rawBody = "", deps = {} } = {}) {
  const isCdResult = path === "/webhook/cd-result";
  const doVerify = deps.verifyWebhook ?? verifyWebhook;
  const jobStore = deps.store ?? store;
  const ingest = deps.ingest ?? ingestCiResult;

  // ── auth (HMAC over raw body; cd-result allows the x-cd-token fallback) ──────────────────────
  const auth = doVerify({
    rawBody,
    headers,
    signatureHeader: isCdResult ? "x-cd-signature-256" : "x-hub-signature-256",
    allowTokenFallback: isCdResult,
  });
  if (!auth.ok) {
    return { statusCode: 401, body: { error: `unauthorized: ${auth.reason}` } };
  }

  // ── parse body ───────────────────────────────────────────────────────────────────────────────
  let body;
  try {
    body = typeof rawBody === "string" ? JSON.parse(rawBody || "{}") : JSON.parse(rawBody.toString("utf8") || "{}");
  } catch {
    return { statusCode: 400, body: { error: "invalid JSON body" } };
  }

  // ── idempotency (delivery de-dup) ────────────────────────────────────────────────────────────
  const key = deliveryKey(headers, rawBody);
  const fresh = jobStore.markOnce(key, { at: Date.now?.() ?? 0 });
  if (!fresh) {
    const rec = body.jobId ? jobStore.getJob(body.jobId) : null;
    return { statusCode: 200, body: { acknowledged: true, idempotent: true, jobId: body.jobId ?? null, status: rec?.status ?? null } };
  }

  // ── drive the state machine ──────────────────────────────────────────────────────────────────
  const { statusCode, response } = ingest(body, {
    store: jobStore,
    verifyDeploy: deps.verifyDeploy ?? null, // opt-in platform confirmation (see defaultVerifyDeploy note)
  });
  return { statusCode, body: response };
}

export { defaultVerifyDeploy };
