// commit_pr.js — SKILL 3: atomically commit staged files on a fresh branch and open a PR.
//
// Two modes (locked design decision — BOTH local clone and GitHub REST API):
//   · api   — GitHub Git Data API (blob→tree→commit→ref), exactly like pf-atomic-commit; supports a
//             stale-plan guard (HEAD must still equal changePlan.headSha), collision-free branch
//             naming (matching-refs probe), then pf-open-pr.
//   · local — a local clone with git + gh: checkout -b, write files, commit, push, gh pr create.
//
// Staged files are [{path, content}] (utf-8), e.g. from mule-upgrade-apply's output.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { GitHubApi } from "./lib/gh_api.js";
import {
  branchBase,
  pickBranchName,
  prTitle,
  prBody,
  commitMessage,
} from "./lib/pr_meta.js";

// ── api mode ────────────────────────────────────────────────────────────────────────────
/**
 * commitAndPrApi(opts): full Git Data API commit + PR.
 * @returns {{branchName, commitSha, prNumber, prUrl}}
 * @throws {Error} code "STALE_PLAN" when the repo HEAD moved since assessment.
 */
export async function commitAndPrApi(opts) {
  const {
    coords, // {owner, repo, defaultBranch}
    changePlan, // {headSha, targetRuntime, targetJavaVersion}
    stagedFiles, // [{path, content}]
    appName,
    jobId,
    jiraTicketId = null,
    jiraBaseUrl = "",
    warnings = [],
    api = new GitHubApi(),
    enforceStalePlan = true,
  } = opts;
  const { owner, repo, defaultBranch } = coords;

  // (1) stale-plan guard
  const currentHead = await api.headSha(owner, repo, defaultBranch);
  if (enforceStalePlan && changePlan.headSha && currentHead !== changePlan.headSha) {
    const err = new Error(
      `The repo HEAD moved since assessment (current=${currentHead}, plan=${changePlan.headSha}). ` +
        `Re-run assess to get a fresh changePlan.`
    );
    err.code = "STALE_PLAN";
    throw err;
  }
  const baseSha = changePlan.headSha || currentHead;

  // (2) collision-free branch name
  const base = branchBase(appName, changePlan.targetRuntime, changePlan.targetJavaVersion);
  const existing = await api.matchingRefs(owner, repo, base);
  const branchName = pickBranchName(base, existing, jobId);

  // (3) create branch at baseSha
  await api.createRef(owner, repo, branchName, baseSha);

  // (4) blob per file → tree (base_tree=baseSha) → commit (parent=baseSha) → move ref
  const blobs = [];
  for (const f of stagedFiles) {
    const blobSha = await api.createBlob(owner, repo, f.content);
    blobs.push({ path: f.path, blobSha });
  }
  const treeSha = await api.createTree(owner, repo, baseSha, blobs);
  const commitSha = await api.createCommit(owner, repo, commitMessage(jobId, jiraTicketId), treeSha, [baseSha]);
  await api.updateRef(owner, repo, branchName, commitSha, false);

  // (5) open PR
  const pr = await api.openPr(owner, repo, {
    title: prTitle(appName, changePlan.targetRuntime, changePlan.targetJavaVersion),
    head: branchName,
    base: defaultBranch,
    body: prBody({
      appName,
      targetRuntime: changePlan.targetRuntime,
      targetJavaVersion: changePlan.targetJavaVersion,
      commitSha,
      jobId,
      jiraTicketId,
      jiraBaseUrl,
      warnings,
    }),
  });

  return { branchName, commitSha, prNumber: pr.number, prUrl: pr.html_url };
}

// ── local mode ──────────────────────────────────────────────────────────────────────────
function git(repoRoot, args) {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

/**
 * commitAndPrLocal(opts): branch, write files, commit, push, gh pr create against a local clone.
 * @returns {{branchName, commitSha, prUrl}}
 */
export function commitAndPrLocal(opts) {
  const {
    repoRoot,
    changePlan,
    stagedFiles,
    appName,
    jobId,
    jiraTicketId = null,
    jiraBaseUrl = "",
    warnings = [],
    defaultBranch = git(opts.repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    enforceStalePlan = true,
    push = true,
  } = opts;

  // stale-plan guard against the local HEAD
  if (enforceStalePlan && changePlan.headSha) {
    const head = git(repoRoot, ["rev-parse", "HEAD"]);
    if (head !== changePlan.headSha) {
      const err = new Error(
        `The local HEAD moved since assessment (current=${head}, plan=${changePlan.headSha}). ` +
          `Re-run assess to get a fresh changePlan.`
      );
      err.code = "STALE_PLAN";
      throw err;
    }
  }

  // collision-free branch (probe local + remote refs)
  const base = branchBase(appName, changePlan.targetRuntime, changePlan.targetJavaVersion);
  let refs = [];
  try {
    refs = git(repoRoot, ["for-each-ref", "--format=%(refname)", `refs/heads/${base}`, `refs/heads/${base}-*`])
      .split("\n")
      .filter(Boolean);
  } catch {
    /* no matching refs */
  }
  const branchName = pickBranchName(base, refs, jobId);

  git(repoRoot, ["checkout", "-b", branchName]);
  for (const f of stagedFiles) {
    const abs = path.join(repoRoot, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content);
    git(repoRoot, ["add", "--", f.path]);
  }
  git(repoRoot, ["commit", "-m", commitMessage(jobId, jiraTicketId)]);
  const commitSha = git(repoRoot, ["rev-parse", "HEAD"]);

  let prUrl = null;
  if (push) {
    git(repoRoot, ["push", "-u", "origin", branchName]);
    const title = prTitle(appName, changePlan.targetRuntime, changePlan.targetJavaVersion);
    const body = prBody({
      appName,
      targetRuntime: changePlan.targetRuntime,
      targetJavaVersion: changePlan.targetJavaVersion,
      commitSha,
      jobId,
      jiraTicketId,
      jiraBaseUrl,
      warnings,
    });
    prUrl = execFileSync(
      "gh",
      ["pr", "create", "--repo", ".", "--base", defaultBranch, "--head", branchName, "--title", title, "--body", body],
      { cwd: repoRoot, encoding: "utf8" }
    ).trim();
  }

  return { branchName, commitSha, prUrl };
}
