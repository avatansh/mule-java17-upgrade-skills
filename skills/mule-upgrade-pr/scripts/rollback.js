// rollback.js — SKILL 3: open a revert PR when a deploy fails (port of pf-rollback).
//
// Strategy (api mode): the upgrade commit had exactly one parent (the pre-upgrade baseSha). To revert
// cleanly without a merge, we recreate the parent's tree on a fresh `revert/<branch>` cut from the
// default branch HEAD, commit it, and open a PR. This restores the exact pre-upgrade file state.
//
//   GET  /repos/{o}/{r}/commits/{upgradeCommit}   → parents[0].sha = baseSha  (getCommitFull)
//   GET  /repos/{o}/{r}/git/commits/{baseSha}      → tree.sha = baseTreeSha    (getCommit)
//   GET  /repos/{o}/{r}/commits/{defaultBranch}    → current HEAD sha          (headSha)
//   POST /repos/{o}/{r}/git/refs                   → create revert/<branch> at HEAD
//   POST /repos/{o}/{r}/git/commits                → commit baseTreeSha, parent=HEAD
//   PATCH /repos/{o}/{r}/git/refs/heads/<revert>   → move ref
//   POST /repos/{o}/{r}/pulls                       → open revert PR

import { GitHubApi } from "./lib/gh_api.js";
import { revertBranchName, revertPrTitle, revertCommitMessage, revertPrBody } from "./lib/pr_meta.js";

/**
 * rollbackApi(opts): open a revert PR restoring the pre-upgrade tree.
 * @param {object} opts
 * @param {{owner:any,repo:any,defaultBranch:any}} opts.coords
 * @param {string} opts.upgradeCommitSha  the commit the upgrade PR introduced
 * @param {string} opts.branchName        the upgrade branch (revert branch = revert/<branchName>)
 * @param {string} opts.appName
 * @param {string} opts.jobId
 * @param {string} [opts.jiraTicketId]
 * @param {string} [opts.jiraBaseUrl]
 * @param {any} [opts.api]
 * @returns {Promise<{revertBranch:any, revertCommitSha:any, prNumber:any, prUrl:any, baseSha:any}>}
 */
export async function rollbackApi(opts) {
  const {
    coords,
    upgradeCommitSha,
    branchName,
    appName,
    jobId,
    jiraTicketId = null,
    jiraBaseUrl = "",
    api = new GitHubApi(),
  } = opts;
  const { owner, repo, defaultBranch } = coords;

  // (1) find the pre-upgrade parent + its tree
  const upgradeCommit = await api.getCommitFull(owner, repo, upgradeCommitSha);
  const baseSha = upgradeCommit.parents?.[0]?.sha;
  if (!baseSha) {
    const err = new Error(`Cannot roll back ${upgradeCommitSha}: it has no first parent.`);
    err.code = "VALIDATION";
    throw err;
  }
  const baseCommit = await api.getCommit(owner, repo, baseSha);
  const baseTreeSha = baseCommit.tree.sha;

  // (2) cut revert branch from the current default-branch HEAD
  const headSha = await api.headSha(owner, repo, defaultBranch);
  const revertBranch = revertBranchName(branchName);
  await api.createRef(owner, repo, revertBranch, headSha);

  // (3) commit the restored tree on top of HEAD, then move the ref
  const revertCommitSha = await api.createCommit(owner, repo, revertCommitMessage(jobId), baseTreeSha, [
    headSha,
  ]);
  await api.updateRef(owner, repo, revertBranch, revertCommitSha, false);

  // (4) open the revert PR
  const pr = await api.openPr(owner, repo, {
    title: revertPrTitle(appName),
    head: revertBranch,
    base: defaultBranch,
    body: revertPrBody({ jobId, jiraTicketId, jiraBaseUrl }),
  });

  return { revertBranch, revertCommitSha, prNumber: pr.number, prUrl: pr.html_url, baseSha };
}
