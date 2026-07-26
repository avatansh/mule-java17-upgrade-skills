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
//   [optional] auto-create Jira ticket ──► COMMITTING
//        ▼
//   apply transforms (SKILL 2) ──► commit + open PR (SKILL 3) ──► COMMITTED ──► PR_OPEN
//        ▼
//   notify (Slack + Jira) ──► record branchName/commitSha/prNumber/prUrl + branch index
//
// On ANY stage error: job → FAILED_ASSESS (validation/http) or FAILED_COMMIT (else), lock released,
// failure notified — same taxonomy as the Mule async error-handler.
//
// The deploy-monitoring tail (PR_OPEN → DEPLOYING → DEPLOYED) is POLLING and lives in
// mule-upgrade-job's reconcile.js (run on a timer); this pipeline stops at PR_OPEN, matching the app.

import { assess } from "../../mule-upgrade-assess/scripts/assess.js";
import { applyChangePlan } from "../../mule-upgrade-apply/scripts/apply_edits.js";
import { commitAndPrApi, commitAndPrLocal } from "../../mule-upgrade-pr/scripts/commit_pr.js";
import * as store from "../../mule-upgrade-job/scripts/jobstore.js";
import {
  slackNotify,
  jiraComment,
  jiraCreateIssue,
  prOpenedSlackText,
  failureSlackText,
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
 * @param {object} [opts.deps]          injectable {assess, applyChangePlan, commitApi, commitLocal, notify}
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
    jiraBaseUrl = process.env.JIRA_BASE_URL || "",
    deps = {},
  } = opts;
  let jiraTicketId = opts.jiraTicketId ?? null;

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
    const { result } = await doAssess({ repo, appName, headSha, ...(opts.assessOpts ?? {}) });
    assessment = result;
  }
  const changePlan = assessment.changePlan;
  const warnings = assessment.warnings ?? [];

  // short-circuit: nothing to change → ALREADY_UPGRADED (no lock, no job)
  if (!changePlan || (changePlan.fileEdits ?? []).length === 0) {
    return {
      status: "ALREADY_UPGRADED",
      appName,
      environment,
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

  // ── (2) acquire lock + persist PROCESSING job ──────────────────────────────────────────
  let jobId;
  try {
    const created = store.createJob({
      appName,
      environment,
      jiraTicketId,
      approvedChangePlan: opts.approvedChangePlan ?? null,
      coords,
      changePlan,
    });
    jobId = created.jobId;
  } catch (e) {
    if (e.code === "CONFLICT") {
      const held = store.getJob(e.existingJobId) ?? {};
      return {
        status: "CONFLICT",
        code: "UPGRADE_IN_PROGRESS",
        appName,
        existingJobId: e.existingJobId,
        prUrl: held.prUrl ?? null,
        message:
          `An upgrade for app "${appName}" is already in progress (jobId=${e.existingJobId}).` +
          (held.prUrl ? ` PR: ${held.prUrl}.` : "") +
          ` Wait for it to complete or fail before starting a new one.`,
      };
    }
    throw e;
  }

  // ── (3) the pipeline proper — any throw here maps to a FAILED_* terminal + lock release ──
  try {
    // optional Jira auto-create (pf-jira-create-issue) — non-fatal
    if (!jiraTicketId) {
      const created = await notifiers.jiraCreateIssue({ appName, jobId });
      if (created.created && created.key) {
        jiraTicketId = created.key;
        store.patchJob(jobId, { jiraTicketId });
      }
    }

    store.setStatus(jobId, "COMMITTING");

    // apply transforms (SKILL 2) → staged files [{path, content}]
    const stagedFiles = doApply(changePlan, repoRoot);

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
    const pr =
      mode === "local"
        ? doCommitLocal({ ...commitArgs, repoRoot })
        : await doCommitApi({ ...commitArgs, coords });

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

    // notify (Slack + Jira) — non-fatal
    const slackText = prOpenedSlackText({ appName, prUrl: pr.prUrl, jobId, jiraTicketId, jiraBaseUrl, warnings });
    await notifiers.slackNotify(slackText);
    await notifiers.jiraComment(
      jiraTicketId,
      `Java 17 upgrade PR opened for ${appName} — status PR_OPEN.`,
      pr.prUrl
    );

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
    store.releaseLock(appName);
    const failText = failureSlackText({
      appName,
      jobId,
      status: failureStatus,
      error: e.message,
      jiraTicketId,
      jiraBaseUrl,
    });
    await notifiers.slackNotify(failText);
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
