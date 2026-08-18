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
import { makeJobNotifier } from "../../skills/mule-upgrade/scripts/lib/notify.js";

/** Stable idempotency key for a delivery: explicit delivery header, else sha256 of the raw body. */
function deliveryKey(headers, rawBody) {
  const explicit = headers["x-delivery-id"] || headers["x-github-delivery"] || headers["x-cd-delivery-id"];
  if (explicit) return `delivery::${explicit}`;
  const h = crypto
    .createHash("sha256")
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ""), "utf8"));
  return `delivery::${h.digest("hex")}`;
}

/**
 * Build the Anypoint deploy verifier when enabled + configured; else null (trust CI).
 * Returns the async verifier from makeDeployVerifier — ci_ingest now awaits verifyDeploy, so an
 * async verifier is correctly resolved (previously this had to be opt-in because ci_ingest called
 * it synchronously and would have received a Promise → "unknown").
 */
function defaultVerifyDeploy() {
  try {
    const client = new AnypointClient();
    if (!client.configured()) return null;
    return makeDeployVerifier(client);
  } catch {
    return null;
  }
}

/**
 * handleWebhook({ path, headers, rawBody, deps }): authenticate + ingest a CI/CD callback.
 * @param {object} [opts]
 * @param {string} [opts.path]                        "/webhook" | "/webhook/cd-result"
 * @param {Record<string,string>} [opts.headers]    lower-cased header map
 * @param {Buffer|string} [opts.rawBody]
 * @param {object} [opts.deps]                       { store, ingest, verifyDeploy, verifyWebhook } — injectable for tests
 * @returns {Promise<{statusCode:number, body:object}>}
 */
export async function handleWebhook({ path, headers = {}, rawBody = "", deps = {} } = {}) {
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
    body =
      typeof rawBody === "string"
        ? JSON.parse(rawBody || "{}")
        : JSON.parse(rawBody.toString("utf8") || "{}");
  } catch {
    return { statusCode: 400, body: { error: "invalid JSON body" } };
  }

  // ── idempotency (delivery de-dup) ────────────────────────────────────────────────────────────
  const key = deliveryKey(headers, rawBody);
  const fresh = jobStore.markOnce(key, { at: Date.now?.() ?? 0 });
  if (!fresh) {
    const rec = body.jobId ? jobStore.getJob(body.jobId) : null;
    return {
      statusCode: 200,
      body: { acknowledged: true, idempotent: true, jobId: body.jobId ?? null, status: rec?.status ?? null },
    };
  }

  // ── drive the state machine ──────────────────────────────────────────────────────────────────
  // Platform confirmation for stage=deploy success: use the injected verifier if provided, else
  // build the default Anypoint one (null when unconfigured → trust CI). ci_ingest awaits it.
  const verifyDeploy = "verifyDeploy" in deps ? deps.verifyDeploy : defaultVerifyDeploy();
  // Fire Slack + Jira on each state change this callback drives (parked/resumed, deployed, deploy
  // failed). De-duped per status so a resent delivery / no-op sub-stage never double-alerts. Tests can
  // inject deps.notify (including a no-op) to suppress it.
  const notify = "notify" in deps ? deps.notify : makeJobNotifier({ getJob: jobStore.getJob, patchJob: jobStore.patchJob });
  const { statusCode, response } = await ingest(body, {
    store: jobStore,
    verifyDeploy,
    notify,
  });
  return { statusCode, body: response };
}

export { defaultVerifyDeploy };
