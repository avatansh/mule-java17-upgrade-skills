// reconcile.js — SKILL 5 reconcile sweep. Faithful port of system/reconcile.xml (pf-reconcile),
// adapted from the Mule app's webhook+scheduler model to POLLING (the locked design decision).
//
// A skill cannot host a webhook listener, so instead of waiting for inbound merge/deploy events we
// scan every persisted job and, for each one whose updatedAt is older than the stale threshold,
// drive it forward by actively POLLING its external state:
//
//   · stale PR_OPEN (+prNumber)   → poll the PR:
//                                     merged      → DEPLOYING  (+notify hook)
//                                     closed      → CLOSED     + release app lock
//                                     still open  → leave as-is (not counted as fixed)
//   · stale DEPLOYING             → verify deployment:
//                                     healthy     → DEPLOYED
//                                     unhealthy   → FAILED_DEPLOY
//                                     unknown     → leave as-is
//   · stale early-stage           → FAILED_INTERRUPTED + release app lock
//     (PROCESSING/ASSESSING/COMMITTING/COMMITTED — orphaned by a crash/restart, mirrors the
//      Mule reconciler's "no external state to reconcile against, finalize as interrupted" branch)
//
// PR polling / deploy verification / notification are INJECTABLE so the sweep is pure and testable;
// the defaults shell out to `gh` (pollPrViaGh) and are no-ops otherwise.

import { execFileSync } from "node:child_process";
import * as store from "./jobstore.js";
import { listJobs, setStatus, releaseLock } from "./jobstore.js";
import { ingestCiResult } from "./ci_ingest.js";
import { get } from "../../../lib_shared/config.js";

const EARLY_STAGES = new Set(["PROCESSING", "ASSESSING", "COMMITTING", "COMMITTED"]);
// Statuses eligible for a CI-checks poll (the job is open, waiting on CI or already parked by it).
const CI_POLLABLE = new Set(["PR_OPEN", "MUNIT_FAILED", "DEP_GUARD_FAILED"]);

/** isStale(rec, staleSeconds, nowMs): updatedAt older than the threshold. */
export function isStale(rec, staleSeconds, nowMs) {
  if (!rec?.updatedAt) return false;
  const t = Date.parse(rec.updatedAt);
  if (Number.isNaN(t)) return false;
  return nowMs - t > staleSeconds * 1000;
}

/**
 * Default PR poller: `gh pr view <prNumber> --repo owner/repo --json state,mergedAt,url`.
 * Returns { merged, closed, open } booleans. Any failure → all false (leave the job untouched).
 */
export function pollPrViaGh(rec) {
  const owner = rec?.coords?.owner;
  const repo = rec?.coords?.repo;
  const prNumber = rec?.prNumber;
  if (!owner || !repo || prNumber == null) return { merged: false, closed: false, open: false };
  try {
    const out = execFileSync(
      "gh",
      ["pr", "view", String(prNumber), "--repo", `${owner}/${repo}`, "--json", "state,mergedAt"],
      { encoding: "utf8" }
    );
    const pr = JSON.parse(out);
    const merged = pr.mergedAt != null || pr.state === "MERGED";
    const closed = !merged && pr.state === "CLOSED";
    return { merged, closed, open: !merged && !closed };
  } catch {
    return { merged: false, closed: false, open: false };
  }
}

/**
 * Default CI-checks poller: `gh pr checks <prNumber> --repo owner/repo --json name,state,bucket`.
 * Returns an array of { name, conclusion } where conclusion ∈ "success"|"failure"|"pending".
 * Any failure → [] (leave the job untouched). Maps gh's bucket/state to success|failure|pending.
 */
export function pollChecksViaGh(rec) {
  const owner = rec?.coords?.owner;
  const repo = rec?.coords?.repo;
  const prNumber = rec?.prNumber;
  if (!owner || !repo || prNumber == null) return [];
  try {
    const out = execFileSync(
      "gh",
      ["pr", "checks", String(prNumber), "--repo", `${owner}/${repo}`, "--json", "name,state,bucket"],
      { encoding: "utf8" }
    );
    const checks = JSON.parse(out);
    return (Array.isArray(checks) ? checks : []).map((c) => ({
      name: String(c.name ?? ""),
      conclusion: mapCheckConclusion(c),
    }));
  } catch {
    return [];
  }
}

// gh reports either `bucket` ("pass"|"fail"|"pending"|"skipping"|"cancel") or `state`
// ("SUCCESS"|"FAILURE"|"ERROR"|...). Normalize to success|failure|pending.
function mapCheckConclusion(c) {
  const bucket = String(c.bucket ?? "").toLowerCase();
  if (bucket === "pass") return "success";
  if (bucket === "fail" || bucket === "cancel") return "failure";
  if (bucket) return "pending";
  const state = String(c.state ?? "").toUpperCase();
  if (state === "SUCCESS") return "success";
  if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(state)) return "failure";
  return "pending";
}

// Load the check-name → stage patterns from config (case-insensitive substring match).
function ciStagePatterns() {
  const parse = (v) =>
    String(v ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  return {
    test: parse(get("ci.checkNames.test", "munit,unit test,test")),
    "dependency-guard": parse(
      get("ci.checkNames.dependencyGuard", "dependency-guard,dep-guard,java17-guard,dependency guard")
    ),
  };
}

// Classify a check name → cd-result stage ("test" | "dependency-guard" | null). dependency-guard
// is tested FIRST so a name like "dependency-guard-test" isn't mis-bucketed as a plain test.
export function classifyCheck(name, patterns) {
  const n = String(name).toLowerCase();
  if (patterns["dependency-guard"].some((p) => n.includes(p))) return "dependency-guard";
  if (patterns.test.some((p) => n.includes(p))) return "test";
  return null;
}

/**
 * reconcileCiChecks(rec, opts): poll a job's PR CI checks and feed matched test / dependency-guard
 * results through ingestCiResult, driving the MUNIT_FAILED / DEP_GUARD_FAILED park/resume machine.
 * Only pending checks are skipped; a decisive success/failure is ingested. Returns the list of
 * {stage, result, to} transitions actually applied (empty when nothing decisive/mapped).
 */
export function reconcileCiChecks(rec, opts = {}) {
  const pollChecks = opts.pollChecks ?? pollChecksViaGh;
  const patterns = opts.ciPatterns ?? ciStagePatterns();
  const ingest = opts.ingest ?? ingestCiResult;
  const notify = opts.notify ?? (() => {});

  const checks = pollChecks(rec) ?? [];
  // Collapse to one decisive result per stage: a failure wins over success (fail-closed).
  const perStage = {};
  for (const c of checks) {
    const stage = classifyCheck(c.name, patterns);
    if (!stage || c.conclusion === "pending") continue;
    if (perStage[stage] === "failure") continue; // already failing → keep failure
    perStage[stage] = c.conclusion;
  }

  const applied = [];
  // Ingest dependency-guard before test so the higher-priority gate parks first if both fail.
  for (const stage of ["dependency-guard", "test"]) {
    if (!(stage in perStage)) continue;
    const before = store.getJob(rec.jobId)?.status;
    const res = ingest(
      { jobId: rec.jobId, stage, result: perStage[stage] },
      { store, notify: (ev, r) => notify(`ci:${ev}`, r) }
    );
    const after = res.updated?.status ?? store.getJob(rec.jobId)?.status;
    if (after && after !== before) applied.push({ stage, result: perStage[stage], to: after });
  }
  return applied;
}

/**
 * runReconcile(opts): scan all jobs and advance stale ones.
 * @param {object} opts
 * @param {number} [opts.staleSeconds=900]  age after which a job is eligible for reconcile
 * @param {number} opts.nowMs               current epoch ms (injected — Date.now() is unavailable in workflow scripts, and injection keeps this testable)
 * @param {(rec)=>{merged,closed,open}} [opts.pollPr=pollPrViaGh]
 * @param {(rec)=>{status:'healthy'|'unhealthy'|'unknown'}} [opts.verifyDeploy]
 * @param {(event, rec)=>void} [opts.notify]  called on PR_OPEN→DEPLOYING and →CLOSED transitions
 * @returns {{scanned, fixed, actions:Array}}
 */
export function runReconcile(opts = {}) {
  const staleSeconds = opts.staleSeconds ?? 900;
  const nowMs = opts.nowMs ?? Date.parse(new Date().toISOString());
  const pollPr = opts.pollPr ?? pollPrViaGh;
  const verifyDeploy = opts.verifyDeploy ?? (() => ({ status: "unknown" }));
  const notify = opts.notify ?? (() => {});
  // CI-checks polling drives MUNIT_FAILED / DEP_GUARD_FAILED park/resume. Enabled by default;
  // pass ciChecks:false to disable (e.g. environments that rely solely on the webhook callback).
  const ciChecksEnabled = opts.ciChecks !== false;
  const pollChecks = opts.pollChecks ?? pollChecksViaGh;

  const jobs = opts.jobs ?? listJobs();
  const actions = [];
  let fixed = 0;

  for (const rec of jobs) {
    if (!isStale(rec, staleSeconds, nowMs)) continue;

    // ── parked by CI (MUNIT_FAILED / DEP_GUARD_FAILED) → poll checks to resume ────
    if (rec.status === "MUNIT_FAILED" || rec.status === "DEP_GUARD_FAILED") {
      if (ciChecksEnabled) {
        const applied = reconcileCiChecks(rec, { pollChecks, notify });
        for (const a of applied) {
          actions.push({ jobId: rec.jobId, from: rec.status, to: a.to, reason: `ci:${a.stage}=${a.result}` });
          fixed++;
        }
      }
      continue;
    }

    // ── stale PR_OPEN → poll CI checks first, then the PR ─────────────────────────
    if (rec.status === "PR_OPEN" && rec.prNumber != null) {
      // (a) CI checks may park the job (MUNIT_FAILED / DEP_GUARD_FAILED) before merge.
      if (ciChecksEnabled) {
        const applied = reconcileCiChecks(rec, { pollChecks, notify });
        if (applied.some((a) => a.to === "MUNIT_FAILED" || a.to === "DEP_GUARD_FAILED")) {
          for (const a of applied) {
            actions.push({ jobId: rec.jobId, from: "PR_OPEN", to: a.to, reason: `ci:${a.stage}=${a.result}` });
            fixed++;
          }
          continue; // parked — don't also poll the PR this sweep
        }
      }
      // (b) PR merge/close polling.
      const pr = pollPr(rec);
      if (pr.merged) {
        setStatus(rec.jobId, "DEPLOYING");
        notify("PR_OPEN->DEPLOYING", rec);
        actions.push({ jobId: rec.jobId, from: "PR_OPEN", to: "DEPLOYING", reason: "merge detected" });
        fixed++;
      } else if (pr.closed) {
        setStatus(rec.jobId, "CLOSED");
        if (rec.appName) releaseLock(rec.appName);
        notify("PR_OPEN->CLOSED", rec);
        actions.push({
          jobId: rec.jobId,
          from: "PR_OPEN",
          to: "CLOSED",
          reason: "closed unmerged; lock released",
        });
        fixed++;
      }
      continue;
    }

    // ── stale DEPLOYING → verify deployment ──────────────────────────────────────
    if (rec.status === "DEPLOYING") {
      const v = verifyDeploy(rec);
      if (v.status === "healthy") {
        setStatus(rec.jobId, "DEPLOYED");
        actions.push({ jobId: rec.jobId, from: "DEPLOYING", to: "DEPLOYED", reason: "platform healthy" });
        fixed++;
      } else if (v.status === "unhealthy") {
        setStatus(rec.jobId, "FAILED_DEPLOY", {
          error: "Deployment reported unhealthy by platform verification (reconciled).",
        });
        actions.push({ jobId: rec.jobId, from: "DEPLOYING", to: "FAILED_DEPLOY", reason: "platform unhealthy" });
        fixed++;
      }
      continue;
    }

    // ── stale early-stage → interrupted ──────────────────────────────────────────
    if (EARLY_STAGES.has(rec.status)) {
      setStatus(rec.jobId, "FAILED_INTERRUPTED", {
        error:
          "Upgrade was interrupted before completion (likely a runtime restart or crash) and did not " +
          "advance within the stale threshold. Automatically failed by the reconciler; re-submit to retry.",
      });
      if (rec.appName) releaseLock(rec.appName);
      actions.push({
        jobId: rec.jobId,
        from: rec.status,
        to: "FAILED_INTERRUPTED",
        reason: "orphaned by restart/crash; lock released",
      });
      fixed++;
      continue;
    }
  }

  return { scanned: jobs.length, fixed, actions };
}
