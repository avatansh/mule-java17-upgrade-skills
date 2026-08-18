// orchestrate.js — SKILL 6: the end-to-end upgrade pipeline (port of pf-start-upgrade).
//
// Runs SYNCHRONOUSLY what the Mule app split across an HTTP 202 + <async> worker, because a skill
// invocation IS the worker. The stages mirror pf-start-upgrade exactly:
//
//   pre-flight assess ──► short-circuit ALREADY_UPGRADED (no fileEdits) / APP_NOT_FOUND
//        │ (edits exist)
//        ▼
//   acquire lock (CONFLICT:UPGRADE_IN_PROGRESS if held) ──► job PROCESSING
//        ▼
//   [opt-in] create Jira ticket ──► COMMITTING
//        ▼
//   apply transforms (SKILL 2) ──► commit + open PR (SKILL 3) ──► COMMITTED ──► PR_OPEN
//        ▼
//   [opt-in] notify (Slack + Jira) ──► record branchName/commitSha/prNumber/prUrl + branch index
//
// On ANY stage error: job → FAILED_ASSESS (validation/http) or FAILED_COMMIT (else), lock released,
// failure notified — same taxonomy as the Mule async error-handler.
//
// The deploy-monitoring tail (PR_OPEN → DEPLOYING → DEPLOYED) is POLLING and lives in
// mule-upgrade-job's reconcile.js (run on a timer); this pipeline stops at PR_OPEN, matching the app.

import { assess } from "../../mule-upgrade-assess/scripts/assess.js";
import { applyChangePlan } from "../../mule-upgrade-apply/scripts/apply_edits.js";
import { commitAndPrApi, commitAndPrLocal } from "../../mule-upgrade-pr/scripts/commit_pr.js";
import { GitHubApi } from "../../mule-upgrade-pr/scripts/lib/gh_api.js";
import { runParentPomJob } from "../../mule-upgrade-parent-pom/scripts/parent_pom.js";
import * as store from "../../mule-upgrade-job/scripts/jobstore.js";
import { routeUpgradeStrategy } from "./lib/topology_route.js";
import {
  slackNotify,
  jiraComment,
  jiraCreateIssue,
  prOpenedSlackText,
  failureSlackText,
  resolveNotifyPrefs,
} from "./lib/notify.js";

/**
 * runUpgrade(opts): the full pipeline. Returns a result object describing the outcome.
 *
 * @param {object} opts
 * @param {string} opts.appName
 * @param {string} opts.environment
 * @param {string} [opts.jiraTicketId]
 * @param {"local"|"api"} [opts.mode="api"]
 * @param {object} opts.coords          {owner, repo, defaultBranch}
 * @param {string} [opts.repo]          local clone root (assess reads the tree from here)
 * @param {string} [opts.repoRoot]      local clone root for commit (local mode; defaults to opts.repo)
 * @param {string} [opts.headSha]       repo HEAD at assess time (stale-plan anchor)
 * @param {string} [opts.jiraBaseUrl]
 * @param {object} [opts.assessResult]  pre-computed AssessmentResult (skip the assess step)
 * @param {object} [opts.assessOpts]    extra options forwarded to assess() (appPath, environment, orgId, versionStrategy, connectorSelections)
 * @param {object} [opts.approvedChangePlan]  operator-approved ChangePlan recorded on the job
 * @param {{slack?:boolean, jira?:"none"|"comment"|"create"}} [opts.notifyPrefs] per-run Slack/Jira
 *   opt-in. Default (and any malformed value) is SILENT: no Slack, no Jira ticket, no Jira comment —
 *   configured credentials alone are never treated as consent. Persisted on the job so later sweeps
 *   (reconcile / status auto-refresh / webhook) honor the same choice.
 * @param {boolean} [opts.dryRun]       preview ONLY: assess + build the plan, then return status
 *   PLAN_PREVIEW / ALREADY_UPGRADED WITHOUT acquiring a lock, applying edits, or opening a PR.
 *   The confirmation gate for the interactive agent — nothing is written and no job is created.
 * @param {boolean} [opts.routeParentPom] when the assessment routes to "parent-pom" (no app-pom
 *   edits but inherited connector gaps), dispatch the parent-pom job (default true). Set false to
 *   force the plain app pipeline (which would then no-op to ALREADY_UPGRADED).
 * @param {object} [opts.deps]          injectable {assess, applyChangePlan, commitApi, commitLocal,
 *   notify, runParentPomJob, parentPomDeps}
 * @returns {Promise<object>}
 */
export async function runUpgrade(opts) {
  const {
    appName,
    environment,
    mode = "api",
    coords,
    repo,
    repoRoot = opts.repo,
    headSha,
    dryRun = false,
    jiraBaseUrl = process.env.JIRA_BASE_URL || "",
    deps = {},
  } = opts;
  let jiraTicketId = opts.jiraTicketId ?? null;
  const notifyPrefs = resolveNotifyPrefs(opts.notifyPrefs);

  const doAssess = deps.assess ?? assess;
  const doApply = deps.applyChangePlan ?? applyChangePlan;
  const doCommitApi = deps.commitApi ?? commitAndPrApi;
  const doCommitLocal = deps.commitLocal ?? commitAndPrLocal;
  const notifiers = {
    slackNotify: deps.slackNotify ?? slackNotify,
    jiraComment: deps.jiraComment ?? jiraComment,
    jiraCreateIssue: deps.jiraCreateIssue ?? jiraCreateIssue,
  };

  // ── (1) pre-flight assess (synchronous) ────────────────────────────────────────────────
  let assessment = opts.assessResult;
  if (!assessment) {
    const { result } = await doAssess({
      repo,
      appName,
      headSha,
      // Forward GitHub source/coords when running in API mode (no local clone).
      ...(mode === "api" && coords
        ? { source: "github", owner: coords.owner, repoName: coords.repo, branch: coords.defaultBranch }
        : {}),
      ...(opts.assessOpts ?? {}),
    });
    assessment = result;
  }
  const changePlan = assessment.changePlan;
  const warnings = assessment.warnings ?? [];

  // ── (1a) topology routing (Tier 2c) — pick the strategy from the ChangePlan ──────────────
  // "app-pom"    → the app's own pom carries edits: run the app pipeline below.
  // "parent-pom" → no app edits but the app inherits connector(s) below the matrix from a
  //                parent/BOM: the app pom is clean, the shared parent must be bumped. Hand off to
  //                the mule-upgrade-parent-pom job (unless this run already IS a parent-pom pass).
  // "none"       → nothing to change anywhere → ALREADY_UPGRADED (no lock, no job).
  const route = routeUpgradeStrategy(changePlan);

  if (route.strategy === "none") {
    return {
      status: "ALREADY_UPGRADED",
      appName,
      environment,
      topology: route.topology,
      currentRuntime: assessment.currentRuntime ?? "unknown",
      currentJavaVersion: assessment.currentJavaVersion ?? "unknown",
      targetRuntime: changePlan?.targetRuntime,
      targetJavaVersion: changePlan?.targetJavaVersion,
      message: `App '${appName}' is already in the desired state (runtime ${
        assessment.currentRuntime ?? "unknown"
      }, Java ${assessment.currentJavaVersion ?? "unknown"}). No upgrade required.`,
      warnings,
    };
  }

  // parent-pom route: the fix belongs on the shared parent/BOM, not the app pom. Dispatch the
  // parent-pom job (the two skills call each other). Guarded by opts.routeParentPom !== false so a
  // caller can force the plain app pipeline, and skipped in dryRun (the preview shows the routing).
  if (route.strategy === "parent-pom" && !dryRun && opts.routeParentPom !== false) {
    const doParentPomJob = deps.runParentPomJob ?? runParentPomJob;
    // Target the pom that actually MANAGES the inherited connector(s). In a multi-module repo the
    // shared parent is often NOT the repo-root pom.xml — dispatching without a pomPath read the root
    // and returned NO_CHANGE while still claiming routedVia:"parent-pom" (M5). route.parentPomPath is
    // derived from each gap's managedInPath; when known we thread it through so the correct pom is
    // edited. When it can't be resolved (unknown / spread across multiple poms), we surface a warning
    // rather than silently upgrading (or no-op'ing) the wrong file.
    const parentPomPath = route.parentPomPath ?? undefined;
    const routeWarnings = [];
    if (!parentPomPath) {
      routeWarnings.push(
        route.parentPomPaths && route.parentPomPaths.length > 1
          ? `Inherited connector gaps are managed across multiple poms (${route.parentPomPaths.join(", ")}); ` +
              `run the parent-pom upgrade on each. Falling back to the repo-root pom for this dispatch.`
          : `Could not resolve which pom manages the inherited connector gap(s) — the managing parent/BOM ` +
              `may live in a different repo. Falling back to the repo-root pom; if this returns NO_CHANGE, ` +
              `run the parent-pom upgrade directly against the parent's repo/pom.`
      );
    }
    const parent = await doParentPomJob({
      owner: coords?.owner,
      repo: coords?.repo,
      branch: coords?.defaultBranch,
      pomPath: parentPomPath,
      environment,
      jiraTicketId,
      jiraBaseUrl,
      notifyPrefs,
      mode,
      repoRoot,
      // The parent/BOM must be judged against the SAME Java target as the app that routed us here —
      // otherwise a Java 21 app run would raise a parent-pom PR built from Java 17 floors. An
      // explicit matrixOpts.targetJava still wins, so callers can override deliberately.
      matrixOpts: { targetJava: opts.assessOpts?.targetJava, ...(opts.assessOpts?.matrixOpts ?? {}) },
      deps: deps.parentPomDeps ?? {},
    });
    // Annotate the parent-pom result so the caller can see WHY it was routed here.
    return {
      ...parent,
      routedVia: "parent-pom",
      topology: route.topology,
      routeReason: route.reason,
      connectorGaps: route.connectorGaps,
      parentPomPath: route.parentPomPath ?? null,
      appName: parent.appName ?? appName,
      warnings: [...(warnings ?? []), ...routeWarnings, ...(parent.warnings ?? [])],
    };
  }

  // The app pipeline below only makes sense for the "app-pom" route (fileEdits > 0). If we're here
  // with a parent-pom route that was NOT dispatched (routeParentPom:false) — and it isn't a dry-run
  // (which previews below) — there is nothing the APP pom can do: report ALREADY_UPGRADED rather
  // than create a zero-edit job. The inherited gap remains visible in warnings/connectorGaps.
  if (route.strategy !== "app-pom" && !dryRun) {
    return {
      status: "ALREADY_UPGRADED",
      appName,
      environment,
      topology: route.topology,
      currentRuntime: assessment.currentRuntime ?? "unknown",
      currentJavaVersion: assessment.currentJavaVersion ?? "unknown",
      targetRuntime: changePlan?.targetRuntime,
      targetJavaVersion: changePlan?.targetJavaVersion,
      connectorGaps: route.connectorGaps,
      message:
        `App '${appName}' pom needs no edits. ${route.reason} ` +
        `(Parent-pom routing was disabled for this run.)`,
      warnings,
    };
  }

  // ── (1b) dry-run gate — the interactive agent's CONFIRM step ────────────────────────────
  // Preview what the upgrade WOULD do (assess + connector choices + edits + warnings) without
  // acquiring the app lock, applying any transform, creating a job, or opening a PR. Nothing is
  // written. The agent shows this to the operator and re-invokes with dryRun:false to execute.
  if (dryRun) {
    return {
      status: "PLAN_PREVIEW",
      dryRun: true,
      appName,
      environment,
      mode,
      currentRuntime: assessment.currentRuntime ?? "unknown",
      currentJavaVersion: assessment.currentJavaVersion ?? "unknown",
      targetRuntime: changePlan.targetRuntime,
      targetJavaVersion: changePlan.targetJavaVersion,
      topology: changePlan.topology,
      // Tier 2c: surface WHERE a real run would route (app-pom | parent-pom | none) so the agent
      // can tell the operator whether this becomes an app PR or a parent/BOM PR before confirming.
      route: { strategy: route.strategy, reason: route.reason },
      filesToChange: changePlan.filesToChange ?? [],
      fileEdits: changePlan.fileEdits ?? [],
      connectorGaps: changePlan.connectorGaps ?? [],
      connectorChoices: assessment.connectorChoices ?? [],
      versionSelections: assessment.versionSelections ?? [],
      deployedStateCheck: assessment.deployedStateCheck ?? null,
      warnings,
      message:
        `DRY RUN for '${appName}': route=${route.strategy}; ` +
        `${(changePlan.fileEdits ?? []).length} app file edit(s), ` +
        `${(changePlan.connectorGaps ?? []).length} inherited connector gap(s) ` +
        `(runtime ${assessment.currentRuntime ?? "?"} → ${changePlan.targetRuntime}, Java ` +
        `${assessment.currentJavaVersion ?? "?"} → ${changePlan.targetJavaVersion}). ` +
        `${route.reason} Nothing was written. Re-run with dryRun=false to execute.`,
    };
  }

  // ── (2) acquire lock + persist PROCESSING job ──────────────────────────────────────────
  // The lock is claimed per app+environment, so the SAME app can be upgraded in dev and test at once
  // while a second dev run still CONFLICTs. Remember the exact key so the failure path below releases
  // what this job claimed rather than guessing at the bare app name.
  let jobId;
  let lockKey;
  try {
    const created = store.createJob({
      appName,
      environment,
      jiraTicketId,
      notifyPrefs,
      approvedChangePlan: opts.approvedChangePlan ?? null,
      coords,
      changePlan,
    });
    jobId = created.jobId;
    lockKey = created.record.lockKey;
  } catch (e) {
    if (e.code === "CONFLICT") {
      const held = store.getJob(e.existingJobId) ?? {};
      const scope = environment ? `app "${appName}" in ${environment}` : `app "${appName}"`;
      return {
        status: "CONFLICT",
        code: "UPGRADE_IN_PROGRESS",
        appName,
        environment,
        existingJobId: e.existingJobId,
        prUrl: held.prUrl ?? null,
        message:
          `An upgrade for ${scope} is already in progress (jobId=${e.existingJobId}).` +
          (held.prUrl ? ` PR: ${held.prUrl}.` : "") +
          ` Wait for it to complete or fail before starting a new one` +
          (environment ? ` in ${environment} (other environments are unaffected).` : `.`),
      };
    }
    throw e;
  }

  // ── (3) the pipeline proper — any throw here maps to a FAILED_* terminal + lock release ──
  try {
    // optional Jira ticket creation (pf-jira-create-issue) — non-fatal, and only when the operator
    // asked for it via notifyPrefs.jira="create". Guarded in its own try so a Jira outage
    // (503/401/network) can NEVER abort the upgrade before a single edit is applied: the outer catch
    // would otherwise map the throw to FAILED_COMMIT and release the lock for a job that hasn't even
    // started committing. A failed create just leaves jiraTicketId empty and continues.
    if (!jiraTicketId && notifyPrefs.jira === "create") {
      try {
        const created = await notifiers.jiraCreateIssue({ appName, jobId }, { autoCreate: true });
        if (created.created && created.key) {
          jiraTicketId = created.key;
          store.patchJob(jobId, { jiraTicketId });
        }
      } catch {
        /* non-fatal: proceed without a Jira ticket */
      }
    }

    store.setStatus(jobId, "COMMITTING");

    // apply transforms (SKILL 2) → staged files [{path, content}]. In API mode there is NO local clone
    // (repoRoot is undefined), so applyChangePlan can't read files off disk — it must read each file
    // over the GitHub Contents API at the assessed ref. We build that reader here and pass it through.
    // (Skipped when a test injects deps.applyChangePlan — that mock supplies its own staged files —
    // which also avoids constructing GitHubApi, whose ctor requires a token.)
    let apiReadFile;
    if (mode === "api" && !deps.applyChangePlan) {
      const gh = deps.gh ?? new GitHubApi();
      const ref = changePlan.headSha || coords?.defaultBranch || undefined;
      apiReadFile = async (p) => {
        const resp = await gh.getContents(coords.owner, coords.repo, p, ref);
        if (typeof resp?.content !== "string" || resp.content === "") {
          throw new Error(
            `Could not read "${p}" from ${coords?.owner}/${coords?.repo}@${ref ?? "default"} ` +
              `(path may be a directory, empty, or too large).`
          );
        }
        return Buffer.from(resp.content.replace(/[\r\n\t ]/g, ""), "base64").toString("utf-8");
      };
    }
    const stagedFiles = await doApply(changePlan, repoRoot, apiReadFile);

    // commit + open PR (SKILL 3)
    const commitArgs = {
      changePlan: { ...changePlan, headSha: changePlan.headSha ?? headSha },
      stagedFiles,
      appName,
      jobId,
      jiraTicketId,
      jiraBaseUrl,
      warnings,
    };
    const pr = await (mode === "local"
      ? doCommitLocal({ ...commitArgs, repoRoot, coords })
      : doCommitApi({ ...commitArgs, coords }));

    store.setStatus(jobId, "COMMITTED", {
      branchName: pr.branchName,
      commitSha: pr.commitSha,
    });

    // record PR_OPEN + branch→job index
    store.setStatus(jobId, "PR_OPEN", {
      branchName: pr.branchName,
      prUrl: pr.prUrl,
      prNumber: pr.prNumber ?? null,
    });
    if (pr.branchName) store.putBranchIndex(pr.branchName, jobId);

    // notify (Slack + Jira) — non-fatal. Guarded in its own try: the PR is ALREADY open and the job is
    // ALREADY persisted PR_OPEN (with the branch→job index written) by this point, so a notifier error
    // (Slack webhook 500, Jira 401, network blip) must NOT fall through to the outer catch — doing so
    // would flip a genuinely-succeeded PR_OPEN job to FAILED_COMMIT, release the lock, and orphan the
    // live PR from reconcile (which only advances PR_OPEN). A notify failure is cosmetic; swallow it.
    // Both channels are opt-in per run (notifyPrefs); an opted-out run announces nothing anywhere.
    try {
      if (notifyPrefs.slack) {
        await notifiers.slackNotify(
          prOpenedSlackText({
            appName,
            prUrl: pr.prUrl,
            jobId,
            jiraTicketId,
            jiraBaseUrl,
            warnings,
          })
        );
      }
      if (notifyPrefs.jira !== "none" && jiraTicketId) {
        await notifiers.jiraComment(
          jiraTicketId,
          `Java 17 upgrade PR opened for ${appName} — status PR_OPEN.`,
          pr.prUrl
        );
      }
      // Record that PR_OPEN was already announced so the reconcile-driven job notifier (which fires on
      // every later transition, including ones surfaced during a status read) never re-alerts PR_OPEN.
      // Skipped when nothing was sent, so opting in mid-run still gets the next transition.
      if (notifyPrefs.slack || notifyPrefs.jira !== "none") {
        store.patchJob(jobId, { notifiedStatus: "PR_OPEN" });
      }
    } catch {
      /* non-fatal: the PR is open and the job is PR_OPEN; notification delivery is best-effort */
    }

    return {
      status: "PR_OPEN",
      jobId,
      appName,
      environment,
      branchName: pr.branchName,
      commitSha: pr.commitSha,
      prNumber: pr.prNumber ?? null,
      prUrl: pr.prUrl,
      jiraTicketId,
      warnings,
      nextPollSeconds: 0,
      message: `Pull request opened for ${appName}. Poll the job (or run reconcile) to track merge → deploy.`,
    };
  } catch (e) {
    // failure taxonomy mirrors the Mule async error-handler
    const failureStatus =
      e.code === "VALIDATION" || e.code === "STALE_PLAN" || e.code === "APP_NOT_FOUND" || e.httpNotFound
        ? "FAILED_ASSESS"
        : "FAILED_COMMIT";
    store.setStatus(jobId, failureStatus, { error: e.message });
    // Release the EXACT key this job claimed (app::env, not the bare app name), and only if THIS job
    // still holds it — never stomp a lock another job re-acquired (e.g. after this one's was stolen as
    // stale), matching deleteJob's ownership check (L3).
    if (lockKey && store.lockHolder(lockKey) === jobId) store.releaseLock(lockKey);
    if (notifyPrefs.slack) {
      await notifiers.slackNotify(
        failureSlackText({
          appName,
          jobId,
          status: failureStatus,
          error: e.message,
          jiraTicketId,
          jiraBaseUrl,
        })
      );
      // Mark this hard-failure as already announced so a later status read won't duplicate the alert.
      try {
        store.patchJob(jobId, { notifiedStatus: failureStatus });
      } catch {
        /* best-effort */
      }
    }
    return {
      status: failureStatus,
      jobId,
      appName,
      environment,
      error: e.message,
      jiraTicketId,
      message: `Upgrade for ${appName} failed at ${failureStatus}: ${e.message}`,
    };
  }
}
