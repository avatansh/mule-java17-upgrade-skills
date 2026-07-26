// status.js — faithful port of dwl::jobStatus::buildJobStatus.
//
// Builds the public GET /jobs/{jobId} response from a persisted job record: a status→message +
// nextPollSeconds lookup table, a PR_OPEN "MUnit passed" sub-stage refinement, and the set of
// optional fields (branchName/prUrl/prNumber/jiraTicketId/jiraUrl/completedAt/error/report) that
// are included only when present — preserving the Mule app's response shape exactly.

// Human-readable message + recommended poll interval keyed by status.
// nextPollSeconds === 0 means terminal — the caller should stop polling.
export const statusMeta = {
  PROCESSING: { message: "Upgrade accepted and queued.", nextPollSeconds: 5 },
  ASSESSING: { message: "Analyzing the repository and computing the change plan.", nextPollSeconds: 5 },
  COMMITTING: { message: "Applying transforms and committing changes to a branch.", nextPollSeconds: 5 },
  COMMITTED: { message: "Changes committed; opening a pull request.", nextPollSeconds: 5 },
  PR_OPEN: { message: "Pull request is open and ready for review/merge.", nextPollSeconds: 0 },
  NO_CHANGE: {
    message: "No changes required — the target already meets the Java 17 matrix.",
    nextPollSeconds: 0,
  },
  MUNIT_FAILED: {
    message:
      "MUnit tests failed in CI. Paused for human action — fix the tests; the job resumes automatically when CI reports a test success.",
    nextPollSeconds: 300,
  },
  DEP_GUARD_FAILED: {
    message:
      "Java 17 dependency guard failed in CI: one or more resolved connectors (incl. transitives) are below their Java 17 minimum. Paused for human action — pin the connector(s) to a Java 17-compatible version; the job resumes automatically when CI reports a dependency-guard success. See `report` for the offending dependencies.",
    nextPollSeconds: 300,
  },
  DEPLOYING: { message: "PR merged; CI/CD is building and deploying.", nextPollSeconds: 10 },
  DEPLOYED: { message: "Upgrade deployed successfully.", nextPollSeconds: 0 },
  CLOSED: {
    message:
      "The upgrade pull request was closed without merging. The job is closed and the app lock released — re-run or reapply to try again.",
    nextPollSeconds: 0,
  },
  FAILED_ASSESS: { message: "Assessment failed. See error for details.", nextPollSeconds: 0 },
  FAILED_COMMIT: { message: "Commit/transform stage failed. See error for details.", nextPollSeconds: 0 },
  FAILED_CI: { message: "CI build/tests failed after merge. See error for details.", nextPollSeconds: 0 },
  FAILED_DEPLOY: { message: "Deployment failed. See error for details.", nextPollSeconds: 0 },
  FAILED_INTERRUPTED: {
    message:
      "Upgrade was interrupted before completion (runtime restart/crash) and was automatically failed. Re-submit to retry.",
    nextPollSeconds: 0,
  },
};

const isEmpty = (v) => v == null || (Array.isArray(v) && v.length === 0);

/**
 * Build the public JobStatus payload from a stored job record.
 * @param {object} rec  the persisted job record
 * @param {string} jiraBaseUrl  Jira site base URL (e.g. https://acme.atlassian.net); "" to omit link
 * @returns {object} JobStatus response
 */
export function buildJobStatus(rec, jiraBaseUrl = "") {
  const meta =
    statusMeta[rec?.status] ?? {
      message: `Status: ${rec?.status ?? "UNKNOWN"}`,
      nextPollSeconds: 10,
    };

  // Sub-stage refinement: "MUnit tests passed" is still PR_OPEN (the RAML enum is fixed), so we
  // surface the finer stage through `message` instead of a new enum value.
  const munitResult = String(rec?.munit?.result ?? "");
  const message =
    rec?.status === "PR_OPEN" && munitResult === "passed"
      ? "MUnit tests passed in CI. Pull request is open and ready for review/merge."
      : meta.message;

  const out = {
    jobId: rec?.jobId,
    status: rec?.status,
    message,
    nextPollSeconds: meta.nextPollSeconds,
  };

  if (rec?.branchName != null) out.branchName = rec.branchName;
  if (rec?.prUrl != null) out.prUrl = rec.prUrl;
  if (rec?.prNumber != null) out.prNumber = rec.prNumber;
  if (rec?.jiraTicketId != null) out.jiraTicketId = rec.jiraTicketId;
  if (rec?.jiraTicketId != null && jiraBaseUrl !== "") {
    out.jiraUrl = `${jiraBaseUrl}/browse/${String(rec.jiraTicketId)}`;
  }
  if (rec?.completedAt != null) out.completedAt = rec.completedAt;
  if (rec?.error != null) out.error = rec.error;
  if (!isEmpty(rec?.depGuard?.report)) out.report = rec.depGuard.report;

  return out;
}
