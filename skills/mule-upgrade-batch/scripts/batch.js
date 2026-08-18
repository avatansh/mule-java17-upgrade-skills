// batch.js — SKILL 11: upgrade a SELECTION of apps in one run, one environment at a time.
//
// The engine has always supported concurrent upgrades of DIFFERENT apps (the single-flight lock is
// keyed `<app>::<env>`, so distinct apps never contend). What was missing was an orchestrator: nothing
// fanned the calls out. `runUpgrade` is synchronous per app and the interactive conductor issues one
// tool call at a time, so N apps meant N manual round-trips. This is that missing layer.
//
// Three phases, deliberately ordered so nothing is written before the operator has seen the whole plan:
//
//   PHASE 1 — PREVIEW    every selected app is dry-run CONCURRENTLY (bounded pool). No locks, no jobs,
//                        no edits. Produces a per-app plan + the reason any app is not upgradeable.
//        │
//   PHASE 2 — GROUP      apps whose connector gaps are managed UPSTREAM are grouped by the pom that
//                        manages them. Batch does NOT auto-run shared parent-pom upgrades: N apps
//                        sharing one parent must edit that pom ONCE, in a chained flow with human
//                        decisions at each hop. They are reported as NEEDS_PARENT_POM and held back.
//        │
//   PHASE 3 — EXECUTE    only with `confirm:true`, and only the app-pom-routed apps. Each runs the
//                        normal `runUpgrade` pipeline, taking its own `<app>::<env>` lock and creating
//                        its own tracked job, so every existing guarantee (stale-plan anchor, failure
//                        taxonomy, lock release, notify opt-in, reconcile) applies unchanged.
//
// Failure isolation is the whole point of a batch: one app's 401/conflict/throw is recorded against
// THAT app and the pool keeps going. The batch never rejects for a per-app failure (only for a bad
// argument), so a 20-app run always returns 20 outcomes.

import { runUpgrade } from "../../mule-upgrade/scripts/orchestrate.js";
import { scanFleet } from "../../mule-upgrade-scan/scripts/scan.js";
import { resolveCoordinates } from "../../../lib_shared/coordinates.js";
import { get } from "../../../lib_shared/config.js";

function cfg(dotted, fallback) {
  try {
    const v = get(dotted, undefined);
    return v === undefined || v === null || v === "" ? fallback : v;
  } catch {
    return fallback;
  }
}

/** Statuses that mean "a PR exists / work landed" vs "nothing to do" vs "failed". */
const SUCCESS = new Set(["PR_OPEN", "PR_UPDATED"]);
const NOOP = new Set(["ALREADY_UPGRADED", "NO_CHANGE"]);

/**
 * Run `limit` async workers over `items`, preserving input order in the output.
 *
 * Deliberately hand-rolled rather than pulled from a dependency: the pack has zero runtime deps and
 * this is ~15 lines. Each slot pulls the next index until the queue drains, so a slow app never blocks
 * a fast one behind it (unlike chunked batching, which waits for the slowest member of every chunk).
 *
 * @template T,R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item:T, index:number)=>Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function pool(items, limit, worker) {
  const size = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
  const out = new Array(items.length);
  let next = 0;
  async function slot() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: size }, slot));
  return out;
}

/**
 * Where an app's connector gaps are managed upstream — the pom path(s) a parent-pom upgrade must edit.
 * Reads the same fields the single-app router uses, so batch grouping can never disagree with routing.
 * @param {object} preview a runUpgrade dry-run result
 * @returns {string[]} distinct managing pom paths (may be empty)
 */
export function managingPomPaths(preview) {
  const paths = new Set();
  const plan = preview?.changePlan ?? preview?.plan ?? {};
  for (const g of plan.connectorGaps ?? []) {
    if (g?.managedInPath) paths.add(String(g.managedInPath));
  }
  for (const p of preview?.parentPomPaths ?? []) if (p) paths.add(String(p));
  if (preview?.parentPomPath) paths.add(String(preview.parentPomPath));
  return [...paths];
}

/**
 * Normalise the app selection into `{appName, owner, repo, appPath, branch, deployedApiName}` records.
 * De-dupes by appName (the lock key's app half) so the same app can't be queued twice in one batch and
 * self-CONFLICT. Coordinates resolve through the SAME waterfall as a single upgrade.
 *
 * @param {Array<object>} apps
 * @param {object} [deps] {resolve?}
 */
export async function resolveSelection(apps, deps = {}) {
  const resolve = deps.resolve ?? resolveCoordinates;
  const seen = new Set();
  const selected = [];
  const skipped = [];
  for (const a of apps ?? []) {
    const appName = typeof a === "string" ? a : a?.appName;
    if (!appName) {
      skipped.push({ appName: null, status: "SKIPPED", reason: "entry has no appName" });
      continue;
    }
    if (seen.has(appName)) {
      skipped.push({ appName, status: "SKIPPED", reason: "duplicate entry in the selection" });
      continue;
    }
    seen.add(appName);
    const req = typeof a === "string" ? {} : a;
    try {
      const coords = await resolve({
        appName,
        request: { owner: req.owner, repo: req.repo, appPath: req.appPath, branch: req.branch },
        discoverBranch: false,
      });
      if (!coords?.owner || !coords?.repo) {
        skipped.push({
          appName,
          status: "SKIPPED",
          reason: "GitHub coordinates could not be resolved — supply owner/repo or add an app-registry entry",
        });
        continue;
      }
      selected.push({
        appName,
        owner: coords.owner,
        repo: coords.repo,
        appPath: coords.appPath ?? req.appPath ?? undefined,
        branch: req.branch ?? coords.defaultBranch,
        defaultBranch: coords.defaultBranch,
        orgId: coords.orgId ?? undefined,
        deployedApiName: req.deployedApiName ?? appName,
      });
    } catch (e) {
      skipped.push({ appName, status: "SKIPPED", reason: `coordinate resolution failed: ${e.message}` });
    }
  }
  return { selected, skipped };
}

/** Pull a candidate list off a fleet scan, keeping only apps that mapped to a repo. */
async function selectionFromScan(opts, deps) {
  const scan = deps.scanFleet ?? scanFleet;
  const report = await scan({
    environments: opts.environments ?? [opts.environment],
    resolveRepos: true,
  });
  const apps = [];
  const skipped = [];
  for (const c of report.candidates ?? []) {
    if (c.needsCoordinates) {
      skipped.push({
        appName: c.appName,
        status: "SKIPPED",
        reason: "fleet scan could not map this app to a GitHub repo",
      });
      continue;
    }
    apps.push({ appName: c.appName, owner: c.owner, repo: c.repo, appPath: c.appPath ?? undefined });
  }
  return { apps, skipped, scanReport: report };
}

/**
 * runBatchUpgrade — preview, group, then (on confirm) upgrade a selection of apps in ONE environment.
 *
 * @param {object} opts
 * @param {Array<object|string>} [opts.apps]  explicit selection: appName + optional owner/repo/appPath/branch
 * @param {boolean} [opts.fromScan]           instead of `apps`, take the fleet-scan candidate list
 * @param {string}  [opts.environment]        ONE Anypoint env for the whole batch (single-env by design).
 *   REQUIRED at runtime — a missing value throws VALIDATION rather than defaulting, matching the engine's
 *   `requireEnv` posture (the conductor, not the engine, is what applies a "dev" default).
 * @param {string}  [opts.repoRoot]           local clone root shared by the batch (mode "local")
 * @param {string[]} [opts.environments]      envs to scan when fromScan (defaults to [environment])
 * @param {"local"|"api"} [opts.mode="api"]
 * @param {boolean} [opts.confirm=false]      REQUIRED to write anything. Without it the batch previews
 *   and returns PLAN_PREVIEW per app — a 20-app run can never open 20 PRs by accident.
 * @param {number}  [opts.concurrency]        bounded pool size (default config batch.concurrency, 3)
 * @param {boolean} [opts.stopOnFailure=false] abandon un-started apps after the first failure
 * @param {boolean} [opts.includeParentPomRouted=false] execute apps whose gaps are managed upstream.
 *   Default false: they need a chained parent-pom flow, which is a human-in-the-loop sequence.
 * @param {string}  [opts.versionStrategy]
 * @param {object}  [opts.connectorSelections]
 * @param {string}  [opts.jiraTicketId]       one ticket for the whole batch (comment mode)
 * @param {{slack?:boolean, jira?:"none"|"comment"|"create"}} [opts.notifyPrefs] applied to EVERY app
 * @param {object}  [opts.deps]               injectable {runUpgrade, scanFleet, resolve}
 * @returns {Promise<object>} batch result
 */
export async function runBatchUpgrade(opts = {}) {
  const environment = opts.environment;
  if (!environment) {
    const e = new Error("batch upgrade requires a single environment");
    // @ts-ignore - tagged for the caller's error taxonomy
    e.code = "VALIDATION";
    throw e;
  }
  const deps = opts.deps ?? {};
  const upgrade = deps.runUpgrade ?? runUpgrade;
  const concurrency = Number(opts.concurrency ?? cfg("batch.concurrency", 3));
  const mode = opts.mode ?? "api";
  const confirm = opts.confirm === true;

  // ── selection ────────────────────────────────────────────────────────────────────────────────
  let inputApps = opts.apps ?? [];
  let scanReport = null;
  const skipped = [];
  if (opts.fromScan) {
    const fromScan = await selectionFromScan(opts, deps);
    inputApps = fromScan.apps;
    scanReport = fromScan.scanReport;
    skipped.push(...fromScan.skipped);
  }
  if (!inputApps.length) {
    return {
      status: "EMPTY_SELECTION",
      environment,
      confirmed: confirm,
      note: opts.fromScan
        ? "The fleet scan returned no repo-mapped stale candidates, so there is nothing to batch."
        : "No apps were selected.",
      concurrency,
      apps: skipped,
      summary: emptySummary(skipped.length),
      scanReport,
    };
  }
  const resolved = await resolveSelection(inputApps, deps);
  skipped.push(...resolved.skipped);
  const selected = resolved.selected;

  // ── PHASE 1 — preview every app concurrently (no locks, no writes) ───────────────────────────
  const previews = await pool(selected, concurrency, async (app) => {
    try {
      const res = await upgrade(buildUpgradeOpts(app, opts, { mode, dryRun: true }));
      return { app, preview: res, error: null };
    } catch (e) {
      return { app, preview: null, error: e };
    }
  });

  // ── PHASE 2 — classify + group by the pom that manages the gaps ──────────────────────────────
  /** @type {Map<string,string[]>} managing pom path -> app names waiting on it */
  const parentPomGroups = new Map();
  const plan = previews.map(({ app, preview, error }) => {
    if (error) {
      return {
        appName: app.appName,
        repo: `${app.owner}/${app.repo}`,
        status: "FAILED_ASSESS",
        reason: error.message,
        upgradeable: false,
      };
    }
    const status = preview.status;
    if (NOOP.has(status)) {
      return {
        appName: app.appName,
        repo: `${app.owner}/${app.repo}`,
        status: "ALREADY_UPGRADED",
        reason: preview.reason ?? "no file edits required — already meets the target",
        upgradeable: false,
      };
    }
    const managed = managingPomPaths(preview);
    const routedUpstream = preview.routedVia === "parent-pom" || (managed.length > 0 && !hasEdits(preview));
    if (routedUpstream) {
      for (const p of managed) {
        const key = `${app.owner}/${app.repo}::${p}`;
        parentPomGroups.set(key, [...(parentPomGroups.get(key) ?? []), app.appName]);
      }
      return {
        appName: app.appName,
        repo: `${app.owner}/${app.repo}`,
        status: "NEEDS_PARENT_POM",
        managingPoms: managed,
        reason:
          "connector versions are pinned in a shared parent/BOM pom — batch does not auto-run chained " +
          "parent-pom upgrades; upgrade that pom once, then re-run this app",
        upgradeable: false,
      };
    }
    return {
      appName: app.appName,
      repo: `${app.owner}/${app.repo}`,
      status: "PLAN_PREVIEW",
      fileEdits: countEdits(preview),
      warnings: preview.changePlan?.warnings ?? preview.plan?.warnings ?? [],
      upgradeable: true,
    };
  });

  const shared = [...parentPomGroups.entries()]
    .filter(([, apps]) => apps.length > 1)
    .map(([key, apps]) => ({ pom: key, apps }));

  const runnable = selected.filter((a, i) => plan[i].upgradeable || includeUpstream(plan[i], opts));

  // ── PHASE 3 — execute (only on explicit confirmation) ────────────────────────────────────────
  if (!confirm) {
    return {
      status: "PLAN_PREVIEW",
      confirmed: false,
      environment,
      mode,
      concurrency,
      note:
        `Previewed ${plan.length} app(s); ${runnable.length} would be upgraded. NOTHING was written. ` +
        `Re-run with confirm:true to execute.`,
      apps: [...plan, ...skipped],
      sharedParentPoms: shared,
      summary: summarise([...plan, ...skipped]),
      scanReport,
    };
  }

  let aborted = false;
  const results = await pool(runnable, concurrency, async (app) => {
    if (aborted) {
      return { appName: app.appName, repo: `${app.owner}/${app.repo}`, status: "SKIPPED", reason: "batch stopped after an earlier failure" };
    }
    try {
      const res = await upgrade(buildUpgradeOpts(app, opts, { mode, dryRun: false }));
      if (opts.stopOnFailure && String(res.status).startsWith("FAILED")) aborted = true;
      return {
        appName: app.appName,
        repo: `${app.owner}/${app.repo}`,
        status: res.status,
        jobId: res.jobId ?? null,
        prUrl: res.prUrl ?? null,
        prNumber: res.prNumber ?? null,
        branchName: res.branchName ?? null,
        error: res.error ?? null,
        code: res.code ?? null,
        routedVia: res.routedVia ?? null,
      };
    } catch (e) {
      // A throw that escaped runUpgrade's own taxonomy (bad arguments, programmer error). Recorded
      // against this app only — never allowed to reject the batch and lose the other outcomes.
      if (opts.stopOnFailure) aborted = true;
      return { appName: app.appName, repo: `${app.owner}/${app.repo}`, status: "ERROR", error: e.message };
    }
  });

  // Apps previewed but deliberately not executed keep their preview verdict in the final report.
  const notRun = plan.filter((p) => !results.some((r) => r.appName === p.appName));
  const apps = [...results, ...notRun, ...skipped];
  return {
    status: "BATCH_COMPLETE",
    confirmed: true,
    environment,
    mode,
    concurrency,
    apps,
    sharedParentPoms: shared,
    summary: summarise(apps),
    scanReport,
  };
}

/** Build the per-app runUpgrade options from the batch-level settings. */
function buildUpgradeOpts(app, opts, { mode, dryRun }) {
  return {
    appName: app.appName,
    environment: opts.environment,
    mode,
    dryRun,
    jiraTicketId: opts.jiraTicketId ?? null,
    notifyPrefs: opts.notifyPrefs,
    repo: app.repoRoot ?? opts.repoRoot ?? app.repo,
    coords: { owner: app.owner, repo: app.repo, defaultBranch: app.branch ?? app.defaultBranch },
    assessOpts: {
      appPath: app.appPath,
      environment: opts.environment,
      orgId: app.orgId,
      versionStrategy: opts.versionStrategy,
      connectorSelections: opts.connectorSelections,
      deployedApiName: app.deployedApiName,
    },
  };
}

function includeUpstream(planEntry, opts) {
  return opts.includeParentPomRouted === true && planEntry.status === "NEEDS_PARENT_POM";
}

function editList(preview) {
  return preview?.changePlan?.fileEdits ?? preview?.plan?.fileEdits ?? [];
}
function countEdits(preview) {
  return editList(preview).length;
}
function hasEdits(preview) {
  return countEdits(preview) > 0;
}

function emptySummary(skippedCount) {
  return { total: skippedCount, upgraded: 0, alreadyUpgraded: 0, needsParentPom: 0, conflicts: 0, failed: 0, skipped: skippedCount };
}

/** Roll the per-app outcomes into the counts a human actually asks for. */
export function summarise(apps) {
  const s = { total: apps.length, upgraded: 0, alreadyUpgraded: 0, needsParentPom: 0, conflicts: 0, failed: 0, skipped: 0, previewed: 0 };
  for (const a of apps) {
    const st = String(a.status ?? "");
    if (SUCCESS.has(st)) s.upgraded++;
    else if (NOOP.has(st)) s.alreadyUpgraded++;
    else if (st === "NEEDS_PARENT_POM") s.needsParentPom++;
    else if (st === "CONFLICT") s.conflicts++;
    else if (st === "SKIPPED") s.skipped++;
    else if (st === "PLAN_PREVIEW") s.previewed++;
    else if (st.startsWith("FAILED") || st === "ERROR") s.failed++;
  }
  return s;
}

/** Human-readable batch report for CLI / chat surfacing. */
export function formatBatch(res) {
  const lines = [];
  const s = res.summary ?? {};
  lines.push(
    `Batch ${res.status} — env ${res.environment}, concurrency ${res.concurrency}` +
      (res.confirmed ? "" : "  (PREVIEW ONLY — nothing written)")
  );
  lines.push(
    `  ${s.total ?? 0} selected · ${s.upgraded ?? 0} PR opened · ${s.previewed ?? 0} would upgrade · ` +
      `${s.alreadyUpgraded ?? 0} already on target · ${s.needsParentPom ?? 0} need a parent-pom · ` +
      `${s.conflicts ?? 0} in progress · ${s.failed ?? 0} failed · ${s.skipped ?? 0} skipped`
  );
  for (const a of res.apps ?? []) {
    const bits = [a.prUrl, a.jobId, a.reason ?? a.error].filter(Boolean).join("  ");
    lines.push(`  · ${String(a.status).padEnd(16)} ${String(a.appName ?? "?").padEnd(32)} ${bits}`);
  }
  for (const g of res.sharedParentPoms ?? []) {
    lines.push(`  ! shared parent pom ${g.pom} blocks ${g.apps.length} apps: ${g.apps.join(", ")}`);
  }
  return lines.join("\n");
}
