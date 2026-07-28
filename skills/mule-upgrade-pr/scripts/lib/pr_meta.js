// lib/pr_meta.js — pure helpers for PR branch naming, titles, bodies, and commit messages.
// Ported from system/github.xml (pf-atomic-commit / pf-open-pr / pf-rollback). No I/O — every
// input is passed in, so these are unit-tested directly.

/** branchBase(appName, targetRuntime, targetJavaVersion): "migrate/<app>-<runtime>-java<java>". */
export function branchBase(appName, targetRuntime, targetJavaVersion) {
  return `migrate/${appName}-${targetRuntime}-java${targetJavaVersion}`;
}

/**
 * pickBranchName(base, existingRefs, jobId): choose a collision-free branch name.
 * Mirrors the DWL: try base, then base-1 … base-50; if all taken, fall back to base-<jobId>.
 * @param {string} base
 * @param {string[]} existingRefs  full ref names ("refs/heads/x") OR bare branch names
 * @param {string} jobId
 */
export function pickBranchName(base, existingRefs = [], jobId = "job") {
  const taken = new Set((existingRefs ?? []).map((r) => String(r).replace(/^refs\/heads\//, "")));
  const candidates = [base, ...Array.from({ length: 50 }, (_, i) => `${base}-${i + 1}`)];
  const free = candidates.find((c) => !taken.has(c));
  return free ?? `${base}-${jobId}`;
}

/** prTitle: "Java 17 upgrade: <app> → <runtime> / Java <java>". */
export function prTitle(appName, targetRuntime, targetJavaVersion) {
  return `Java 17 upgrade: ${appName} → ${targetRuntime} / Java ${targetJavaVersion}`;
}

/**
 * prBody: the upgrade PR description (mirrors pf-open-pr), including optional Jira link and
 * assessment warnings surfaced as a bullet list.
 */
export function prBody({
  appName,
  targetRuntime,
  targetJavaVersion,
  commitSha,
  jobId,
  jiraTicketId,
  jiraBaseUrl = "",
  warnings = [],
}) {
  let body =
    `Automated Java 17 upgrade for **${appName}**.\n\n` +
    `- Target runtime: ${targetRuntime}\n` +
    `- Target Java: ${targetJavaVersion}\n` +
    `- Commit: ${commitSha}\n` +
    `- Job: ${jobId}`;
  if (jiraTicketId != null) {
    body += `\n- Jira: [${jiraTicketId}](${jiraBaseUrl}/browse/${jiraTicketId})`;
  }
  if (Array.isArray(warnings) && warnings.length > 0) {
    body += `\n\n**:warning: Warnings**\n` + warnings.map((w) => `- ${w}`).join("\n");
  }
  return body;
}

/** commitMessage: "Java 17 upgrade (<jobId>)" + optional " <jira>" (mirrors pf-atomic-commit). */
export function commitMessage(jobId, jiraTicketId) {
  return `Java 17 upgrade (${jobId})` + (jiraTicketId != null ? ` ${jiraTicketId}` : "");
}

/** revertBranchName / revertPrTitle / revertPrBody / revertCommitMessage (mirrors pf-rollback). */
export function revertBranchName(branchName) {
  return `revert/${branchName}`;
}
export function revertPrTitle(appName) {
  return `Revert: Java 17 upgrade ${appName}`;
}
export function revertCommitMessage(jobId) {
  return `Revert Java 17 upgrade (${jobId}) — deploy failed`;
}
export function revertPrBody({ jobId, jiraTicketId, jiraBaseUrl = "" }) {
  let body = `Automated rollback for job ${jobId} — the CD deploy failed.`;
  if (jiraTicketId != null) {
    body += `\n\n- Jira: [${jiraTicketId}](${jiraBaseUrl}/browse/${jiraTicketId})`;
  }
  return body;
}
