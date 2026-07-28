// commit_pr.js — SKILL 3: atomically commit staged files on a fresh branch and open a PR.
//
// Two modes (locked design decision — BOTH local clone and GitHub REST API):
//   · api   — GitHub Git Data API (blob→tree→commit→ref), exactly like pf-atomic-commit; supports a
//             stale-plan guard (HEAD must still equal changePlan.headSha), collision-free branch
//             naming (matching-refs probe), then pf-open-pr.
//   · local — a local clone with git + gh: checkout -b, write files, commit, push, gh pr create.
//             If the `gh` CLI can't be spawned (very common on Windows — `spawnSync gh ENOENT` even
//             when gh is "installed", a .cmd/.exe/PATH-resolution quirk), PR creation FALLS BACK to
//             the GitHub REST API using the same token api mode uses. The branch is already pushed at
//             that point, so the fallback only needs owner/repo (from coords or the git remote).
//
// Staged files are [{path, content}] (utf-8), e.g. from mule-upgrade-apply's output.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { GitHubApi } from "./lib/gh_api.js";
import { branchBase, pickBranchName, prTitle, prBody, commitMessage } from "./lib/pr_meta.js";

// Warn ONCE per process when the stale-plan guard is enabled but the plan carries no headSha to
// check against — so the missing protection is visible rather than silently no-op'd (L2).
let _warnedNoHeadSha = false;
function warnMissingHeadSha() {
  if (_warnedNoHeadSha) return;
  _warnedNoHeadSha = true;
  process.emitWarning(
    "commit: stale-plan guard is enabled but the changePlan has no headSha — the guard is a no-op " +
      "for this commit, so a repo HEAD that moved since assessment would go undetected. Re-run assess " +
      "so the plan records headSha (or pass enforceStalePlan:false to opt out explicitly).",
    { code: "COMMIT_NO_HEADSHA" }
  );
}

// ── api mode ────────────────────────────────────────────────────────────────────────────
/**
 * commitAndPrApi(opts): full Git Data API commit + PR.
 * @param {object} opts
 * @returns {Promise<{branchName:any, commitSha:any, prNumber:any, prUrl:any}>}
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
  } else if (enforceStalePlan && !changePlan.headSha) {
    // The guard is ON but there's nothing to check against — headSha was never threaded onto the plan.
    // Silently skipping means a HEAD that moved since assessment goes undetected; warn so the missing
    // protection is visible rather than invisible (L2).
    warnMissingHeadSha();
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
  const commitSha = await api.createCommit(owner, repo, commitMessage(jobId, jiraTicketId), treeSha, [
    baseSha,
  ]);
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

/** Parse owner/repo from a git remote URL (git@github.com:o/r.git | https://github.com/o/r[.git]). */
function parseOwnerRepo(url) {
  const m = String(url ?? "")
    .trim()
    .match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : {};
}

/** Read owner/repo from the clone's `origin` remote (best-effort). */
function remoteOwnerRepo(repoRoot, gitRun = git) {
  try {
    return parseOwnerRepo(gitRun(repoRoot, ["remote", "get-url", "origin"]));
  } catch {
    return {};
  }
}

/** Extract the PR number from a PR URL (…/pull/42) — gh prints the URL, the REST API returns .number. */
function prNumberFromUrl(url) {
  const m = String(url ?? "").match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Default `gh pr create` runner (extracted so it can be swapped in tests). */
function defaultRunGh({ repoRoot, defaultBranch, branchName, title, body }) {
  return execFileSync(
    "gh",
    ["pr", "create", "--repo", ".", "--base", defaultBranch, "--head", branchName, "--title", title, "--body", body],
    { cwd: repoRoot, encoding: "utf8" }
  ).trim();
}

/**
 * openPrLocal(opts): open a PR for an already-pushed local-mode branch. Tries the `gh` CLI first; if it
 * can't be spawned / fails (e.g. Windows `spawnSync gh ENOENT`), falls back to the GitHub REST API with
 * the same token api mode uses. Throws PR_OPEN_FAILED (with a manual compare URL) only when BOTH the gh
 * CLI and the REST fallback are unavailable — the branch is still safely pushed either way.
 * @param {object} opts {repoRoot, defaultBranch, branchName, title, body, coords?, deps?}
 *   deps: { runGh?, api?, git? } — all injectable for tests.
 * @returns {Promise<{prUrl:(string|null), prNumber:(number|null)}>}
 */
export async function openPrLocal(opts) {
  const { repoRoot, defaultBranch, branchName, title, body, coords, deps = {} } = opts;
  const runGh = deps.runGh ?? defaultRunGh;
  const gitRun = deps.git ?? git;
  try {
    const prUrl = String(runGh({ repoRoot, defaultBranch, branchName, title, body }) ?? "").trim();
    return { prUrl, prNumber: prNumberFromUrl(prUrl) };
  } catch (ghErr) {
    // gh unavailable → REST API fallback (branch is already pushed; we only need owner/repo).
    const or =
      coords?.owner && coords?.repo
        ? { owner: coords.owner, repo: coords.repo }
        : remoteOwnerRepo(repoRoot, gitRun);
    let api = deps.api;
    if (api === undefined) {
      try {
        api = new GitHubApi();
      } catch {
        api = null; // no token → can't fall back
      }
    }
    if (api && or.owner && or.repo) {
      const pr = await api.openPr(or.owner, or.repo, { title, head: branchName, base: defaultBranch, body });
      return { prUrl: pr.html_url, prNumber: pr.number ?? prNumberFromUrl(pr.html_url) };
    }
    const compare =
      or.owner && or.repo
        ? `https://github.com/${or.owner}/${or.repo}/pull/new/${encodeURIComponent(branchName)}`
        : null;
    const why = !api
      ? "no GitHub token (GITHUB_TOKEN / github.token) was available for the REST API fallback"
      : "could not resolve owner/repo from the git remote for the REST API fallback";
    const err = new Error(
      `Branch "${branchName}" was pushed, but opening the PR automatically failed: ${ghErr.message}. ` +
        `Tried the \`gh\` CLI (failed) then ${why}. ` +
        (compare ? `Open it manually: ${compare}` : "Open it manually from the pushed branch on GitHub.")
    );
    err.code = "PR_OPEN_FAILED";
    throw err;
  }
}

/**
 * commitAndPrLocal(opts): branch, write files, commit, push, then open a PR (gh CLI → REST API fallback)
 * against a local clone.
 * @returns {Promise<{branchName, commitSha, prUrl, prNumber}>}
 */
export async function commitAndPrLocal(opts) {
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
  } else if (enforceStalePlan && !changePlan.headSha) {
    // Guard ON but no headSha to check against → protection is silently absent; warn (L2).
    warnMissingHeadSha();
  }

  // collision-free branch (probe local + remote refs)
  const base = branchBase(appName, changePlan.targetRuntime, changePlan.targetJavaVersion);
  let refs = [];
  try {
    refs = git(repoRoot, [
      "for-each-ref",
      "--format=%(refname)",
      `refs/heads/${base}`,
      `refs/heads/${base}-*`,
    ])
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
  let prNumber = null;
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
    // gh CLI first, then REST API fallback (Windows `spawnSync gh ENOENT` safety net). Returns a
    // prNumber too, so local-mode jobs can be polled by reconcile just like api-mode ones.
    ({ prUrl, prNumber } = await openPrLocal({
      repoRoot,
      defaultBranch,
      branchName,
      title,
      body,
      coords: opts.coords,
      deps: opts.deps,
    }));
  }

  return { branchName, commitSha, prUrl, prNumber };
}

// ── amend an ALREADY-OPEN PR (commit onto its existing branch) ────────────────────────────
// The chained parent→BOM→app flow bumps the parent-pom version reference inside an app's
// already-open upgrade PR. That is NOT a new branch/PR — it is one more commit on the SAME head
// branch, which GitHub auto-attaches to the open PR. No stale-plan branch probe, no openPr.

/**
 * commitToExistingBranchApi(opts): add ONE commit with staged files onto an existing branch via the
 * Git Data API (blob → tree(base_tree=branch head) → commit(parent=branch head) → move ref). Mirrors
 * commitAndPrApi's data path but skips branch creation + PR open. Optionally guards on the branch
 * head sha (expectHeadSha) so a moved branch is not silently amended.
 * @param {object} opts { coords:{owner,repo}, branchName, stagedFiles:[{path,content}], message,
 *   api?, expectHeadSha? }
 * @returns {Promise<{branchName, commitSha, headBefore}>}
 */
export async function commitToExistingBranchApi(opts) {
  const {
    coords,
    branchName,
    stagedFiles,
    message,
    api = new GitHubApi(),
    expectHeadSha = null,
  } = opts;
  const { owner, repo } = coords;
  if (!branchName) throw new Error("commitToExistingBranchApi: branchName is required");
  if (!Array.isArray(stagedFiles) || stagedFiles.length === 0) {
    throw new Error("commitToExistingBranchApi: stagedFiles must be a non-empty array");
  }

  const headBefore = await api.headSha(owner, repo, branchName);
  if (expectHeadSha && headBefore !== expectHeadSha) {
    const err = new Error(
      `Branch "${branchName}" moved (current=${headBefore}, expected=${expectHeadSha}). Re-read before amending.`
    );
    err.code = "STALE_PLAN";
    throw err;
  }
  const blobs = [];
  for (const f of stagedFiles) {
    const blobSha = await api.createBlob(owner, repo, f.content);
    blobs.push({ path: f.path, blobSha });
  }
  const treeSha = await api.createTree(owner, repo, headBefore, blobs);
  const commitSha = await api.createCommit(owner, repo, message, treeSha, [headBefore]);
  await api.updateRef(owner, repo, branchName, commitSha, false);
  return { branchName, commitSha, headBefore };
}

/**
 * commitToExistingBranchLocal(opts): checkout an existing branch in a local clone, write staged
 * files, commit, and (default) push — one more commit on the open PR's branch.
 * @param {object} opts { repoRoot, branchName, stagedFiles:[{path,content}], message, push? }
 * @returns {{branchName, commitSha}}
 */
export function commitToExistingBranchLocal(opts) {
  const { repoRoot, branchName, stagedFiles, message, push = true } = opts;
  if (!branchName) throw new Error("commitToExistingBranchLocal: branchName is required");
  git(repoRoot, ["checkout", branchName]);
  for (const f of stagedFiles) {
    const abs = path.join(repoRoot, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content);
    git(repoRoot, ["add", "--", f.path]);
  }
  git(repoRoot, ["commit", "-m", message]);
  const commitSha = git(repoRoot, ["rev-parse", "HEAD"]);
  if (push) git(repoRoot, ["push", "origin", branchName]);
  return { branchName, commitSha };
}
