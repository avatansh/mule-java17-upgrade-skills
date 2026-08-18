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
//   · stale MUNIT_FAILED /        → poll CI checks (resume on success) AND poll the PR, so a job whose
//     DEP_GUARD_FAILED (parked)     PR is manually CLOSED/abandoned (or admin-merged) still finalizes
//                                   (→ CLOSED / DEPLOYING) instead of sticking at *_FAILED forever
//   · stale DEPLOYING             → verify deployment:
//                                     healthy     → DEPLOYED
//                                     unhealthy   → FAILED_DEPLOY
//                                     unknown     → leave as-is
//   · stale early-stage           → FAILED_INTERRUPTED + release app lock
//     (PROCESSING/COMMITTING/COMMITTED — orphaned by a crash/restart, mirrors the
//      Mule reconciler's "no external state to reconcile against, finalize as interrupted" branch)
//
// PR polling / deploy verification / notification are INJECTABLE so the sweep is pure and testable;
// the defaults shell out to `gh` (pollPrViaGh) and are no-ops otherwise.

import { execFileSync } from "node:child_process";
import * as store from "./jobstore.js";
import { listJobs, setStatus, releaseLock, TERMINAL } from "./jobstore.js";
import { ingestCiResult } from "./ci_ingest.js";
import { get } from "../../../lib_shared/config.js";
import { GitHubApi } from "../../mule-upgrade-pr/scripts/lib/gh_api.js";

const EARLY_STAGES = new Set(["PROCESSING", "COMMITTING", "COMMITTED"]);

// Token REST client, memoized ONCE SUCCESSFULLY CONSTRUCTED and reused across sweeps (the GitHubApi
// ctor reads + validates the token; reconcileJob() drives one sweep per "check status now"). We do
// NOT permanently memoize the "no token" case: a token supplied later (env/config) must be picked up
// on a subsequent sweep, and the ctor is a cheap config read. When there's no token we drop to the
// `gh` CLI pollers and warn ONCE so the fallback is visible instead of silent. Cleared by
// _resetReconcileApi() (tests).
let _sharedApi;
let _warnedGhFallback = false;
function sharedGitHubApi() {
  if (_sharedApi) return _sharedApi; // reuse an already-constructed client
  try {
    _sharedApi = new GitHubApi();
    return _sharedApi;
  } catch {
    // No GitHub token available (yet) → gh CLI fallback. Warn once so an operator on a host without a
    // token AND without `gh auth` isn't left with a silent {fixed:0} that looks like "nothing to do".
    if (!_warnedGhFallback) {
      _warnedGhFallback = true;
      process.emitWarning(
        "reconcile: no GitHub token (GITHUB_TOKEN / github.token) — falling back to the `gh` CLI for " +
          "PR/CI polling. If `gh` is not installed or authenticated, polling will report no changes " +
          "silently. Set a token (or run `gh auth login`) for reliable status updates.",
        { code: "RECONCILE_GH_FALLBACK" }
      );
    }
    return null;
  }
}
// One-time warning ONLY for the two cases that make gh polling fail INVISIBLY: the `gh` CLI is missing
// (ENOENT) or unauthenticated. A normal non-zero exit (e.g. `gh pr checks` returns 8 while checks are
// pending / 1 when some fail) is NOT one of these — those still print JSON and are salvaged by the
// caller, so warning on them would be misleading noise.
let _warnedGhError = false;
let _warnedGhOpaque = false;
function warnGhFailure(err, { salvageable = false } = {}) {
  const isEnoent = err?.code === "ENOENT";
  const blob = String(err?.stderr ?? err?.message ?? err ?? "").toLowerCase();
  const isAuth = /auth|login|not logged|unauthor|401|403/.test(blob);
  if (isEnoent || isAuth) {
    if (_warnedGhError) return;
    _warnedGhError = true;
    const hint = isEnoent
      ? "the `gh` CLI is not installed or not on PATH"
      : "the `gh` CLI is not authenticated (run `gh auth login`)";
    process.emitWarning(
      `reconcile: PR/CI polling via \`gh\` failed — ${hint}: ${err?.message ?? err}. Jobs will not ` +
        "advance from polling until a GitHub token is set or `gh` works.",
      { code: "RECONCILE_GH_ERROR" }
    );
    return;
  }
  // Not ENOENT/auth. `gh pr checks` legitimately exits non-zero when checks are PENDING (8) or
  // FAILING (1) but still prints usable JSON — the caller salvages that, so it is NOT an invisible
  // failure and we stay silent. Everything else (network blip, non-JSON output, JSON parse failure)
  // returns a silent false/[] indistinguishable from "no changes" — warn ONCE so it isn't invisible (L1).
  if (salvageable) return;
  if (_warnedGhOpaque) return;
  _warnedGhOpaque = true;
  process.emitWarning(
    `reconcile: PR/CI polling via \`gh\` failed and returned no usable output: ${err?.message ?? err}. ` +
      "This looks like a network error or an unexpected `gh` response; the affected job(s) were left " +
      "unchanged this sweep. Set a GitHub token for the REST poller, or re-run reconcile.",
    { code: "RECONCILE_GH_OPAQUE" }
  );
}
/** Test hook: drop the memoized client + warning latches so a later sweep re-reads the token/env. */
export function _resetReconcileApi() {
  _sharedApi = undefined;
  _warnedGhFallback = false;
  _warnedGhError = false;
  _warnedGhOpaque = false;
}

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
  } catch (err) {
    // A PR view has nothing to salvage — any failure here is invisible (returns all-false).
    warnGhFailure(err, { salvageable: false });
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
    return parseGhChecks(out);
  } catch (err) {
    // `gh pr checks` exits non-zero when checks are PENDING (8) or FAILING (1) but still prints the
    // JSON to stdout. execFileSync attaches that stdout to the thrown error — salvage it FIRST so
    // failing checks still park the job (MUNIT_FAILED / DEP_GUARD_FAILED), and so a genuinely opaque
    // failure (no usable stdout) can be told apart from those expected non-zero exits (L1).
    let salvaged = null;
    if (err?.stdout) {
      try {
        salvaged = parseGhChecks(err.stdout);
      } catch {
        /* not JSON — treat as opaque below */
      }
    }
    warnGhFailure(err, { salvageable: salvaged != null });
    return salvaged ?? [];
  }
}

// Normalize `gh pr checks --json name,state,bucket` output to [{name, conclusion}].
function parseGhChecks(out) {
  const checks = JSON.parse(out);
  return (Array.isArray(checks) ? checks : []).map((c) => ({
    name: String(c.name ?? ""),
    conclusion: mapCheckConclusion(c),
  }));
}

/**
 * Token-based PR poller (api mode, no `gh` CLI): read the PR's live state via the GitHub REST API
 * using the SAME github.token that opened it. Same return shape as pollPrViaGh:
 * { merged, closed, open }. Any failure → all false (leave the job untouched).
 * @param {object} rec  the job record ({coords:{owner,repo}, prNumber})
 * @param {InstanceType<typeof GitHubApi>} api
 * @returns {Promise<{merged:boolean, closed:boolean, open:boolean}>}
 */
export async function pollPrViaApi(rec, api) {
  const owner = rec?.coords?.owner;
  const repo = rec?.coords?.repo;
  const prNumber = rec?.prNumber;
  if (!owner || !repo || prNumber == null || !api) return { merged: false, closed: false, open: false };
  try {
    const pr = await api.getPull(owner, repo, prNumber);
    const merged = pr?.merged === true || pr?.merged_at != null;
    const closed = !merged && String(pr?.state ?? "").toLowerCase() === "closed";
    return { merged, closed, open: !merged && !closed };
  } catch {
    return { merged: false, closed: false, open: false };
  }
}

/**
 * Token-based CI-checks poller (api mode, no `gh` CLI): read the PR head's check-runs AND legacy
 * commit statuses via the REST API and normalize to [{name, conclusion}] where conclusion ∈
 * "success"|"failure"|"pending" — the SAME shape pollChecksViaGh returns. Any failure → [].
 * @param {object} rec
 * @param {InstanceType<typeof GitHubApi>} api
 * @returns {Promise<Array<{name:string, conclusion:string}>>}
 */
export async function pollChecksViaApi(rec, api) {
  const owner = rec?.coords?.owner;
  const repo = rec?.coords?.repo;
  const prNumber = rec?.prNumber;
  if (!owner || !repo || prNumber == null || !api) return [];
  try {
    const pr = await api.getPull(owner, repo, prNumber);
    const ref = pr?.head?.sha ?? rec?.branchName;
    if (!ref) return [];
    const out = [];
    try {
      const cr = await api.listCheckRuns(owner, repo, ref);
      for (const c of cr?.check_runs ?? []) {
        out.push({ name: String(c.name ?? ""), conclusion: mapApiCheckConclusion(c) });
      }
    } catch {
      /* no check-runs (or 404) — fall through to statuses */
    }
    try {
      const st = await api.getCombinedStatus(owner, repo, ref);
      for (const s of st?.statuses ?? []) {
        out.push({ name: String(s.context ?? ""), conclusion: mapStatusConclusion(s.state) });
      }
    } catch {
      /* no combined status */
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * makeApiChecksPoller(api): a pollChecksViaApi wrapper that caches the REST reads per PR for the
 * lifetime of one sweep, so multiple jobs pointing at the SAME PR/head-sha (e.g. several apps in one
 * monorepo PR) share ONE getPull + listCheckRuns + getCombinedStatus round-trip instead of N. Same
 * return shape as pollChecksViaApi. Call .reset() at the start of each sweep for fresh state.
 * @param {InstanceType<typeof GitHubApi>} api
 * @returns {((rec:object)=>Promise<Array<{name:string,conclusion:string}>>) & {reset:()=>void}}
 */
export function makeApiChecksPoller(api) {
  /** @type {Map<string, Promise<Array<{name:string,conclusion:string}>>>} */
  const byPr = new Map();
  const poll = (rec) => {
    const key = `${rec?.coords?.owner}/${rec?.coords?.repo}#${rec?.prNumber}`;
    // Cache the PROMISE so concurrent same-PR jobs coalesce onto one in-flight read.
    if (!byPr.has(key)) byPr.set(key, pollChecksViaApi(rec, api));
    return byPr.get(key);
  };
  poll.reset = () => byPr.clear();
  return poll;
}

// check-runs: decisive only when status==="completed". conclusion success → success; failure-like →
// failure; neutral/skipped/stale/undefined → pending (non-decisive, don't drive a transition).
function mapApiCheckConclusion(c) {
  if (String(c?.status ?? "").toLowerCase() !== "completed") return "pending";
  const con = String(c?.conclusion ?? "").toLowerCase();
  if (con === "success") return "success";
  if (["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(con)) {
    return "failure";
  }
  return "pending";
}

// legacy commit status state: success|failure|error|pending → success|failure|pending.
function mapStatusConclusion(state) {
  const s = String(state ?? "").toLowerCase();
  if (s === "success") return "success";
  if (s === "failure" || s === "error") return "failure";
  return "pending";
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
 * @returns {Promise<Array<{stage:string, result:string, to:string}>>}
 */
export async function reconcileCiChecks(rec, opts = {}) {
  const pollChecks = opts.pollChecks ?? pollChecksViaGh;
  const patterns = opts.ciPatterns ?? ciStagePatterns();
  const ingest = opts.ingest ?? ingestCiResult;
  const notify = opts.notify ?? (() => {});

  // pollChecks may be sync (gh execFileSync) or async (token REST poller) — await handles both.
  const checks = (await pollChecks(rec)) ?? [];
  // Collapse to one decisive result per stage: a failure wins over success (fail-closed).
  const perStage = {};
  for (const c of checks) {
    const stage = classifyCheck(c.name, patterns);
    if (!stage || c.conclusion === "pending") continue;
    if (perStage[stage] === "failure") continue; // already failing → keep failure
    perStage[stage] = c.conclusion;
  }

  // Surface EVERY decisive check we saw (not just the ones that changed the enum) so callers can
  // report "test: passed · dependency-guard: passed" even while the status stays PR_OPEN. Non-breaking:
  // the return value is unchanged (the applied[] array); observed is delivered via an optional callback.
  if (opts.onObserved) {
    opts.onObserved(Object.entries(perStage).map(([stage, result]) => ({ stage, result })));
  }

  const applied = [];
  // Ingest dependency-guard before test so the higher-priority gate parks first if both fail.
  for (const stage of ["dependency-guard", "test"]) {
    if (!(stage in perStage)) continue;
    const before = store.getJob(rec.jobId)?.status;
    const res = await ingest(
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
 * @param {object} [opts]
 * @param {number} [opts.staleSeconds]  age after which a job is eligible for reconcile
 * @param {number} [opts.nowMs]               current epoch ms (injected — Date.now() is unavailable in workflow scripts, and injection keeps this testable)
 * @param {Function} [opts.pollPr]
 * @param {Function} [opts.verifyDeploy]
 * @param {Function} [opts.notify]  called on PR_OPEN→DEPLOYING and →CLOSED transitions
 * @param {boolean} [opts.ciChecks]
 * @param {Function} [opts.pollChecks]
 * @param {object} [opts.ciPatterns]  pre-resolved CI check-name→stage patterns (defaults to ciStagePatterns())
 * @param {InstanceType<typeof GitHubApi>|null} [opts.api]  token REST client for api-mode pollers
 *   (auto-constructed when neither pollPr nor pollChecks is injected and a token is present)
 * @param {any} [opts.jobs]
 * @returns {Promise<{scanned:number, fixed:number, actions:Array, checks:Array}>}
 */
export async function runReconcile(opts = {}) {
  const staleSeconds = opts.staleSeconds ?? 900;
  const nowMs = opts.nowMs ?? Date.parse(new Date().toISOString());
  // Poller selection: prefer the token-based REST pollers (work in api mode with no `gh` CLI, on the
  // same github.token that opened the PR); fall back to the `gh` CLI pollers when no token is present.
  // Only construct the client when NEITHER poller is injected (tests inject their own → untouched).
  let api = opts.api;
  if (api === undefined && !opts.pollPr && !opts.pollChecks) {
    api = sharedGitHubApi(); // memoized ctor: read/validate the token once, reused across sweeps
  }
  const pollPr = opts.pollPr ?? (api ? (rec) => pollPrViaApi(rec, api) : pollPrViaGh);
  const verifyDeploy = opts.verifyDeploy ?? (() => ({ status: "unknown" }));
  // A batched verifier (makeDeployVerifier) caches each environment's deployment list for the sweep so
  // multiple DEPLOYING jobs in the same env share ONE platform read (N+1 → 1-per-env). Reset that cache
  // at the start of every sweep so a repeated watch loop sees fresh state, not the prior sweep's.
  if (typeof (/** @type {any} */ (verifyDeploy).reset) === "function") {
    /** @type {any} */ (verifyDeploy).reset();
  }
  const notify = opts.notify ?? (() => {});
  // CI-checks polling drives MUNIT_FAILED / DEP_GUARD_FAILED park/resume. Enabled by default;
  // pass ciChecks:false to disable (e.g. environments that rely solely on the webhook callback).
  const ciChecksEnabled = opts.ciChecks !== false;
  // In api mode, wrap the token check-poller so several jobs on the SAME PR/head-sha in one sweep
  // share ONE getPull+listCheckRuns+getCombinedStatus read (per-PR promise cache), then reset it so
  // the next sweep sees fresh CI state — the same batching pattern makeDeployVerifier uses per env.
  const pollChecks =
    opts.pollChecks ?? (api ? makeApiChecksPoller(api) : pollChecksViaGh);
  if (typeof (/** @type {any} */ (pollChecks).reset) === "function") {
    /** @type {any} */ (pollChecks).reset();
  }
  // Resolve the CI check-name → stage patterns ONCE per sweep (config read + string splitting) and
  // thread it into every reconcileCiChecks call, rather than re-reading config per stale job.
  const ciPatterns = opts.ciPatterns ?? ciStagePatterns();

  const jobs = opts.jobs ?? listJobs();
  const actions = [];
  // Every decisive CI check seen this sweep (even when it didn't change the enum), so callers/Vibes
  // can surface "test: passed · dependency-guard: passed" instead of "no actions".
  const checks = [];
  const collect = (rec) => (obs) => {
    for (const o of obs) checks.push({ jobId: rec.jobId, stage: o.stage, result: o.result });
  };
  let fixed = 0;

  // Poll a job's PR and apply a merged/closed outcome. Works for ANY non-terminal pre-finalize state
  // that still has an open PR — not just PR_OPEN, but ALSO the CI-parked states (MUNIT_FAILED /
  // DEP_GUARD_FAILED). Merged → DEPLOYING; closed-unmerged → CLOSED (+release lock). Returns the action
  // object when it transitioned the job, else null (caller pushes it + bumps `fixed`).
  const applyPrOutcome = async (rec, fromStatus) => {
    if (rec.prNumber == null) return null;
    const pr = await pollPr(rec); // sync (gh) or async (token REST) — await handles both
    if (pr.merged) {
      setStatus(rec.jobId, "DEPLOYING");
      notify(`${fromStatus}->DEPLOYING`, rec);
      return { jobId: rec.jobId, from: fromStatus, to: "DEPLOYING", reason: "merge detected" };
    }
    if (pr.closed) {
      setStatus(rec.jobId, "CLOSED");
      if (rec.appName) releaseLock(rec.lockKey ?? rec.appName);
      notify(`${fromStatus}->CLOSED`, rec);
      return { jobId: rec.jobId, from: fromStatus, to: "CLOSED", reason: "closed unmerged; lock released" };
    }
    return null;
  };

  for (const rec of jobs) {
    // Terminal jobs have no external state left to reconcile; skip before the (cheap) staleness test
    // so an accumulating history of DEPLOYED/CLOSED/FAILED_* records doesn't grow per-sweep work.
    if (TERMINAL.has(rec.status)) continue;
    if (!isStale(rec, staleSeconds, nowMs)) continue;

    // ── parked by CI (MUNIT_FAILED / DEP_GUARD_FAILED) → poll checks to resume, AND poll the PR ────
    if (rec.status === "MUNIT_FAILED" || rec.status === "DEP_GUARD_FAILED") {
      if (ciChecksEnabled) {
        const applied = await reconcileCiChecks(rec, { pollChecks, ciPatterns, notify, onObserved: collect(rec) });
        for (const a of applied) {
          actions.push({ jobId: rec.jobId, from: rec.status, to: a.to, reason: `ci:${a.stage}=${a.result}` });
          fixed++;
        }
      }
      // A CI-parked PR can also be manually CLOSED/abandoned (or admin-MERGED despite the failing gate).
      // CI polling alone never notices that — so poll the PR too. Without this, a job whose PR is closed
      // while it sits at DEP_GUARD_FAILED / MUNIT_FAILED stays *_FAILED forever and never reports
      // closed-unmerged (the observed bug). Only do it when CI didn't just resume the job this sweep.
      const cur = store.getJob(rec.jobId)?.status ?? rec.status;
      if (cur === "MUNIT_FAILED" || cur === "DEP_GUARD_FAILED") {
        const act = await applyPrOutcome(rec, cur);
        if (act) {
          actions.push(act);
          fixed++;
        }
      }
      continue;
    }

    // ── stale PR_OPEN → poll CI checks first, then the PR ─────────────────────────
    if (rec.status === "PR_OPEN" && rec.prNumber != null) {
      // (a) CI checks may park the job (MUNIT_FAILED / DEP_GUARD_FAILED) before merge.
      if (ciChecksEnabled) {
        const applied = await reconcileCiChecks(rec, { pollChecks, ciPatterns, notify, onObserved: collect(rec) });
        if (applied.some((a) => a.to === "MUNIT_FAILED" || a.to === "DEP_GUARD_FAILED")) {
          for (const a of applied) {
            actions.push({
              jobId: rec.jobId,
              from: "PR_OPEN",
              to: a.to,
              reason: `ci:${a.stage}=${a.result}`,
            });
            fixed++;
          }
          continue; // parked — don't also poll the PR this sweep
        }
      }
      // (b) PR merge/close polling.
      const act = await applyPrOutcome(rec, "PR_OPEN");
      if (act) {
        actions.push(act);
        fixed++;
      }
      continue;
    }

    // ── stale DEPLOYING → verify deployment ──────────────────────────────────────
    if (rec.status === "DEPLOYING") {
      // verifyDeploy may be sync or async (makeDeployVerifier is async) — await handles both.
      const v = (await verifyDeploy(rec)) ?? { status: "unknown" };
      if (v.status === "healthy") {
        setStatus(rec.jobId, "DEPLOYED");
        // Finalize: release the single-flight app lock. The webhook/cd-result deploy path releases
        // in ci_ingest; the poll-driven path must do the same here, else a completed job leaks its
        // lock and blocks re-runs of the same app.
        if (rec.appName) releaseLock(rec.lockKey ?? rec.appName);
        notify("DEPLOYING->DEPLOYED", rec);
        actions.push({ jobId: rec.jobId, from: "DEPLOYING", to: "DEPLOYED", reason: "platform healthy" });
        fixed++;
      } else if (v.status === "unhealthy") {
        setStatus(rec.jobId, "FAILED_DEPLOY", {
          error: "Deployment reported unhealthy by platform verification (reconciled).",
        });
        if (rec.appName) releaseLock(rec.lockKey ?? rec.appName);
        notify("DEPLOYING->FAILED_DEPLOY", rec);
        actions.push({
          jobId: rec.jobId,
          from: "DEPLOYING",
          to: "FAILED_DEPLOY",
          reason: "platform unhealthy",
        });
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
      if (rec.appName) releaseLock(rec.lockKey ?? rec.appName);
      notify(`${rec.status}->FAILED_INTERRUPTED`, rec);
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

  return { scanned: jobs.length, fixed, actions, checks };
}

/**
 * reconcileJob(jobId, opts): reconcile a SINGLE job right now (staleSeconds forced to 0 so it always
 * polls), reusing the full runReconcile engine (token/gh pollers + deploy verify). Used by the
 * get_job_status "auto-refresh" path so "check status now" returns live state without a separate
 * reconcile call. Returns the same shape as runReconcile ({scanned, fixed, actions, checks}).
 * @param {string} jobId
 * @param {object} [opts]  forwarded to runReconcile (e.g. verifyDeploy, api, pollPr/pollChecks)
 * @returns {Promise<{scanned:number, fixed:number, actions:Array, checks:Array}>}
 */
export async function reconcileJob(jobId, opts = {}) {
  const rec = store.getJob(jobId);
  if (!rec) return { scanned: 0, fixed: 0, actions: [], checks: [] };
  return runReconcile({ ...opts, staleSeconds: 0, jobs: [rec] });
}
