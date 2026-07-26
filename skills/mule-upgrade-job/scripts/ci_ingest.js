// ci_ingest.js — SKILL 5 CI/CD result ingestion. Faithful port of mf-impl-post-cd-result
// (process/post-webhook.xml), the ONE endpoint that serves three CI/CD stages keyed off
// `body.stage` (default "deploy"):
//
//   · stage=test             → MUnit CI result.
//                                failure → park MUNIT_FAILED (idempotent; lock NOT released)
//                                success → resume MUNIT_FAILED→PR_OPEN, or (if PR_OPEN) mark
//                                          munit.passed sub-stage, else note-only
//   · stage=dependency-guard → Java-17 dependency gate (full tree incl. transitives).
//                                failure → park DEP_GUARD_FAILED + summarized violations report
//                                success → resume DEP_GUARD_FAILED→PR_OPEN, else note-only
//   · stage=deploy           → finalize: success → verify platform → DEPLOYED / FAILED_DEPLOY;
//                                failure → FAILED_DEPLOY (+rolledBack). Lock released on finalize.
//
// This is the "inbound webhook/cd-result" capability the plan deferred to polling — but the actual
// STATE MACHINE is preserved here verbatim so it can be driven by (a) the /webhook/cd-result HTTP
// handler in the MCP server, AND (b) reconcile's `gh pr checks` poller. Both call ingestCiResult().
//
// PURE-ish: all persistence goes through an injectable `store` (defaults to the real jobstore) and
// notifications through injectable `notify`; the returned {response, statusCode, updated} lets the
// HTTP layer shape the reply. Idempotency (delivery de-dup) is the caller's concern (markOnce).

import * as defaultStore from "./jobstore.js";
import { nowUtc } from "../../../lib_shared/dates.js";

// Statuses that make a failure callback a no-op (already parked or terminal).
// DEP_GUARD_FAILED is included so an out-of-order / concurrent MUnit failure does NOT clobber a
// job already parked on the higher-priority dependency gate (symmetric with DEPGUARD_NOOP).
const MUNIT_NOOP = new Set([
  "MUNIT_FAILED",
  "DEP_GUARD_FAILED",
  "DEPLOYED",
  "FAILED_DEPLOY",
  "FAILED_CI",
  "FAILED_ASSESS",
  "FAILED_COMMIT",
  "FAILED_INTERRUPTED",
]);
const DEPGUARD_NOOP = new Set([
  "DEP_GUARD_FAILED",
  "MUNIT_FAILED",
  "DEPLOYED",
  "FAILED_DEPLOY",
  "FAILED_CI",
  "FAILED_ASSESS",
  "FAILED_COMMIT",
  "FAILED_INTERRUPTED",
]);
const DEPLOY_TERMINAL = new Set(["DEPLOYED", "FAILED_DEPLOY"]);

const ack = (extra) => ({ acknowledged: true, ...extra });

/**
 * ingestCiResult(body, opts): apply a CI/CD callback to the job store.
 *
 * @param {object} body            { jobId, result: "success"|"failure", stage?, deployUrl?, error?, report? }
 * @param {object} [opts]
 * @param {object} [opts.store]    job store (getJob/setStatus/patchJob/releaseLock) — injectable
 * @param {(event:string, rec:object)=>void} [opts.notify]   fired on each transition (non-fatal)
 * @param {(rec:object)=>{status:'healthy'|'unhealthy'|'unknown'|'disabled', platform?}} [opts.verifyDeploy]
 *        platform confirmation for stage=deploy success (ADR-015). Omitted/disabled → trust CI.
 * @returns {{statusCode:number, response:object, updated?:object}}
 */
export function ingestCiResult(body = {}, opts = {}) {
  const store = opts.store ?? defaultStore;
  const notify = opts.notify ?? (() => {});
  const verifyDeploy = opts.verifyDeploy ?? null;

  const jobId = body.jobId;
  const result = body.result ?? "";
  const stage = body.stage ?? "deploy";
  const deployUrl = body.deployUrl ?? null;
  const cdError = body.error ?? null;
  const report = body.report ?? [];

  if (!jobId) {
    return { statusCode: 400, response: { error: "jobId is required" } };
  }
  const rec = store.getJob(jobId);
  if (!rec) {
    return { statusCode: 404, response: { error: `No job found with id ${jobId}.` } };
  }
  const cur = rec.status ?? "";

  // ── stage=test (MUnit CI) ──────────────────────────────────────────────────────────────
  if (stage === "test") {
    if (result === "failure") {
      if (MUNIT_NOOP.has(cur)) {
        return { statusCode: 200, response: ack({ idempotent: true, jobId, status: cur }) };
      }
      const updated = store.setStatus(jobId, "MUNIT_FAILED", {
        error: cdError ?? "MUnit tests failed in CI",
      });
      notify("MUNIT_FAILED", updated);
      return { statusCode: 200, response: ack({ jobId, status: "MUNIT_FAILED" }), updated };
    }
    if (result === "success") {
      if (cur === "MUNIT_FAILED") {
        const updated = store.setStatus(jobId, "PR_OPEN", { error: null });
        notify("MUNIT_RESUMED", updated);
        return { statusCode: 200, response: ack({ resumed: true, jobId, status: "PR_OPEN" }), updated };
      }
      if (cur === "PR_OPEN") {
        // MUnit passed while PR_OPEN → record the sub-stage (enum stays PR_OPEN).
        const updated = store.patchJob(jobId, { munit: { result: "passed", at: nowUtc() } });
        notify("MUNIT_PASSED", updated);
        return { statusCode: 200, response: ack({ jobId, status: "PR_OPEN", munit: "passed" }), updated };
      }
      return {
        statusCode: 200,
        response: ack({ jobId, status: cur, note: "munit success noted" }),
      };
    }
    return { statusCode: 400, response: { error: "invalid result (expected success|failure)" } };
  }

  // ── stage=dependency-guard (Java 17 dep gate) ────────────────────────────────────────────
  if (stage === "dependency-guard") {
    if (result === "failure") {
      if (DEPGUARD_NOOP.has(cur)) {
        return { statusCode: 200, response: ack({ idempotent: true, jobId, status: cur }) };
      }
      const updated = store.setStatus(jobId, "DEP_GUARD_FAILED", {
        error: cdError ?? "Java 17 dependency violations found in CI",
        depGuard: { report, at: nowUtc() },
      });
      notify("DEP_GUARD_FAILED", updated);
      return {
        statusCode: 200,
        response: ack({ jobId, status: "DEP_GUARD_FAILED", violations: report.length }),
        updated,
      };
    }
    if (result === "success") {
      if (cur === "DEP_GUARD_FAILED") {
        const updated = store.setStatus(jobId, "PR_OPEN", {
          error: null,
          depGuard: { result: "passed", at: nowUtc() },
        });
        notify("DEP_GUARD_RESUMED", updated);
        return { statusCode: 200, response: ack({ resumed: true, jobId, status: "PR_OPEN" }), updated };
      }
      return {
        statusCode: 200,
        response: ack({ jobId, status: cur, note: "dependency-guard success noted" }),
      };
    }
    return { statusCode: 400, response: { error: "invalid result (expected success|failure)" } };
  }

  // ── stage=deploy (finalize) ──────────────────────────────────────────────────────────────
  if (DEPLOY_TERMINAL.has(cur)) {
    return { statusCode: 200, response: ack({ idempotent: true, jobId, status: cur }) };
  }

  if (result === "success") {
    // Post-deploy platform confirmation (ADR-015): CI said success — confirm health on the platform.
    //   verified + healthy    → DEPLOYED
    //   verified + unhealthy   → FAILED_DEPLOY (discrepancy)
    //   unreachable/disabled   → trust CI → DEPLOYED
    let verify = { verified: false, status: "DISABLED", healthy: false };
    if (verifyDeploy) {
      try {
        const v = verifyDeploy(rec) ?? {};
        const s = String(v.status ?? "unknown").toLowerCase();
        verify = {
          verified: s === "healthy" || s === "unhealthy",
          status: v.platform?.status ?? v.status ?? "UNKNOWN",
          healthy: s === "healthy",
        };
      } catch {
        verify = { verified: false, status: "UNREACHABLE", healthy: false };
      }
    }
    const verdict = verify.verified && !verify.healthy ? "FAILED_DEPLOY" : "DEPLOYED";
    const extra = {
      deployUrl,
      platformVerified: verify.verified,
      platformStatus: verify.status ?? null,
    };
    if (verdict === "FAILED_DEPLOY") {
      extra.error = `CD reported success but platform status=${verify.status ?? "UNKNOWN"}`;
    }
    const updated = store.setStatus(jobId, verdict, extra);
    if (rec.appName) store.releaseLock(rec.appName);
    notify(verdict === "DEPLOYED" ? "DEPLOYED" : "FAILED_DEPLOY_DISCREPANCY", updated);
    return {
      statusCode: 200,
      response: ack({ jobId, status: verdict, platformVerified: verify.verified }),
      updated,
    };
  }

  if (result === "failure") {
    const updated = store.setStatus(jobId, "FAILED_DEPLOY", {
      error: cdError ?? "CD pipeline reported failure",
      rolledBack: true,
    });
    if (rec.appName) store.releaseLock(rec.appName);
    notify("FAILED_DEPLOY", updated);
    return { statusCode: 200, response: ack({ jobId, status: "FAILED_DEPLOY" }), updated };
  }

  return { statusCode: 400, response: { error: "invalid result (expected success|failure)" } };
}
