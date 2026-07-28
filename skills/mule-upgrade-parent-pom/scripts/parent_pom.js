// parent_pom.js — SKILL 4: upgrade a SHARED parent/BOM pom.xml (port of pf-upgrade-parent-pom).
//
// Pins the connector versions a parent/BOM MANAGES so they meet the Java-17 matrix, then (if any
// were pinned) minor-bumps the parent's OWN version, and opens a PR — reusing SKILL 2's rewrite
// (rewriteParentPom) and SKILL 3's commit+PR.
//
// Two entry points:
//   · upgradeParentPom(opts)  — the ORIGINAL targeted one-shot: assess → NO_CHANGE | commit+PR.
//     Touches ONE pom, takes NO lock, creates NO job. Unchanged public contract.
//   · runParentPomJob(opts)   — Tier 2b: the SAME assess+commit phases wrapped in the job/lock
//     pipeline the app upgrade uses (assess-before-lock, NO_CHANGE short-circuit without a job,
//     single-flight lock on edits, FAILED_* terminal + lock release, branch index). This gives a
//     parent/BOM upgrade its own tracked, resumable, single-flight job just like an app upgrade.
//
// Two modes (both entry points):
//   api   — read the pom via the GitHub Contents API @ {ref}, rewrite, commit+PR via Git Data API.
//   local — read the pom from a local clone, rewrite, commit+PR via git/gh.
//
// Coordinate resolution mirrors the Mule fix: repoUrl (if present) is ALWAYS parsed for
// owner/repo/branch/pomPath; explicit owner/repo override only owner/repo, so a
// /tree/<branch>/<dir> URL keeps its branch + sub-path.

import fs from "node:fs";
import path from "node:path";
import { resolveMatrix } from "../../mule-upgrade-assess/scripts/lib/matrix_fetch.js";
import { rewriteParentPom, rewriteParentRefVersion } from "../../mule-upgrade-apply/scripts/rewrites/parent_pom.js";
import {
  commitAndPrApi,
  commitAndPrLocal,
  commitToExistingBranchApi,
  commitToExistingBranchLocal,
} from "../../mule-upgrade-pr/scripts/commit_pr.js";
import { GitHubApi } from "../../mule-upgrade-pr/scripts/lib/gh_api.js";
import * as store from "../../mule-upgrade-job/scripts/jobstore.js";
import { nowUtc } from "../../../lib_shared/dates.js";
import { resolveRepoCoords, resolvePomPath } from "./lib/repo_url.js";
import { detectInheritance } from "./lib/inheritance.js";

function validationError(message) {
  const e = new Error(message);
  e.code = "VALIDATION";
  return e;
}

function connectorSummary(edits) {
  // Connector pins only — exclude the pom's own-version bump AND the chained parent-ref bump.
  const conn = edits.filter((e) => (e.kind ?? "") !== "pomVersion" && (e.kind ?? "") !== "pomParentVersion");
  const ver = edits.find((e) => (e.kind ?? "") === "pomVersion");
  const parentRef = edits.find((e) => (e.kind ?? "") === "pomParentVersion");
  let msg = `pinning ${conn.length} connector(s): ${conn
    .map((e) => `${e.artifactId ?? "?"} ${e.from ?? "unknown"} -> ${e.to ?? "?"}`)
    .join("; ")}`;
  if (parentRef)
    msg += `; parent ref ${parentRef.artifactId ?? "?"} ${parentRef.from ?? "?"} -> ${parentRef.to ?? "?"}`;
  if (ver) msg += `; own version ${ver.from ?? "?"} -> ${ver.to ?? "?"}`;
  return { conn, ver, parentRef, msg };
}

/**
 * assessParentPom(opts): the READ-ONLY phase shared by both entry points. Resolves coords → loads
 * the matrix → resolves the base branch → reads the pom @ HEAD → rewriteParentPom. Writes nothing,
 * takes no lock. Returns everything the commit phase needs plus `edits` (empty ⇒ NO_CHANGE).
 * @returns {Promise<{coords, pomPath, appName, defaultBranch, matrix, matrixSource, matrixWarnings,
 *   headSha, rewrite, edits, inheritance, _api}>}
 */
export async function assessParentPom(opts) {
  const { mode = "api", repoRoot, deps = {}, matrixOpts = {} } = opts;
  const doResolveMatrix = deps.resolveMatrix ?? resolveMatrix;
  let _api = deps.api ?? null;
  const getApi = () => (_api ??= new GitHubApi());

  // ── (1) resolve owner/repo/branch/pomPath ───────────────────────────────────────────────
  const coords = resolveRepoCoords({ repoUrl: opts.repoUrl, owner: opts.owner, repo: opts.repo });
  if (!coords.owner || !coords.repo) {
    throw validationError(
      "Could not resolve owner/repo. Provide a valid repoUrl (https://github.com/<owner>/<repo>) or owner+repo."
    );
  }
  const pomPath = resolvePomPath(opts.pomPath, coords);
  const appName = coords.repo;

  // ── (2) matrix (dynamic connectors + static gating) ─────────────────────────────────────
  const { matrix, source: matrixSource, warnings: matrixWarnings } = await doResolveMatrix(matrixOpts);

  // ── (3) resolve base branch: explicit → URL → repo default ───────────────────────────────
  let defaultBranch = opts.branch || coords.urlBranch || null;
  if (!defaultBranch) {
    if (mode === "api") {
      const repoInfo = await getApi().getRepo(coords.owner, coords.repo);
      defaultBranch = repoInfo.default_branch || "main";
    } else {
      defaultBranch = "main";
    }
  }

  // ── (4) pin the plan to HEAD (stale-plan anchor) + read the pom ───────────────────────────
  let headSha = null;
  let pomText;
  if (deps.readPom) {
    ({ pomText, headSha } = await deps.readPom({ coords, pomPath, defaultBranch }));
  } else if (mode === "api") {
    const api = getApi();
    headSha = await api.headSha(coords.owner, coords.repo, defaultBranch);
    const pomResp = await api.getContents(coords.owner, coords.repo, pomPath, defaultBranch);
    if (typeof pomResp.content !== "string" || pomResp.content === "") {
      throw validationError(
        `The pom.xml at "${pomPath}" in ${coords.owner}/${coords.repo} could not be read ` +
          `(path may be a directory, empty, or too large). Verify pomPath.`
      );
    }
    pomText = Buffer.from(pomResp.content.replace(/[\r\n\t ]/g, ""), "base64").toString("utf-8");
  } else {
    if (!repoRoot) throw validationError("local mode requires --repo-root (path to the clone).");
    const abs = path.join(repoRoot, pomPath);
    if (!fs.existsSync(abs)) throw validationError(`pom.xml not found at ${abs}.`);
    pomText = fs.readFileSync(abs, "utf-8");
    // keep the constructed client available to the commit phase
    if (_api) deps.api = _api;
  }

  // ── (5) rewrite + read-only nested-inheritance detection ─────────────────────────────────
  // Chained intent (optional): repoint this pom's <parent> at a new BOM/parent version and/or force
  // an own-version bump even with no connector edits (the parent-pom step of parent→BOM→app).
  const rewrite = rewriteParentPom(pomText, matrix, pomPath, {
    parentRef: opts.parentRef ?? null,
    bumpOwnVersion: Boolean(opts.bumpOwnVersion),
  });
  const edits = rewrite.edits ?? [];
  // What does THIS pom itself sit on? (a <parent> and/or imported BOMs). Surfaced in every result
  // so the agent can recommend upgrading the deeper pom (the BOM) first, before any edit.
  const inheritance = detectInheritance(pomText);

  return {
    coords,
    pomPath,
    appName,
    defaultBranch,
    matrix,
    matrixSource,
    matrixWarnings,
    headSha,
    rewrite,
    edits,
    inheritance,
    _api,
  };
}

/** Build the NO_CHANGE result object (shared shape). */
function noChangeResult(assessed, { jobId, environment, jiraTicketId, jiraBaseUrl }) {
  return {
    jobId,
    kind: "parentPomUpgrade",
    status: "NO_CHANGE",
    upgraded: false,
    appName: assessed.appName,
    environment,
    pomPath: assessed.pomPath,
    coords: { owner: assessed.coords.owner, repo: assessed.coords.repo, defaultBranch: assessed.defaultBranch },
    edits: [],
    inheritance: assessed.inheritance,
    jiraTicketId,
    jiraUrl: jiraUrlFor(jiraTicketId, jiraBaseUrl),
    matrixSource: assessed.matrixSource,
    warnings: assessed.matrixWarnings,
    message: `Parent/BOM already meets the Java 17 matrix; nothing to change in ${assessed.pomPath}.`,
  };
}

/**
 * Build the DETECTED result: a read-only report used by the chained flow to show what a pom inherits
 * (its <parent>/imported BOMs) and preview the connector edits, WITHOUT taking a lock or committing.
 * Returned when opts.detectOnly is set so the agent can recommend upgrading the BOM first.
 */
function detectResult(assessed, { jobId, environment, jiraTicketId, jiraBaseUrl }) {
  const inh = assessed.inheritance;
  const shared = inh?.inheritsFromShared ? " It inherits from a shared pom (see `inheritance`)." : "";
  return {
    jobId: jobId ?? null,
    kind: "parentPomUpgrade",
    status: "DETECTED",
    upgraded: false,
    appName: assessed.appName,
    environment,
    pomPath: assessed.pomPath,
    coords: { owner: assessed.coords.owner, repo: assessed.coords.repo, defaultBranch: assessed.defaultBranch },
    headSha: assessed.headSha,
    inheritance: inh,
    editsPreview: assessed.edits,
    jiraTicketId,
    jiraUrl: jiraUrlFor(jiraTicketId, jiraBaseUrl),
    matrixSource: assessed.matrixSource,
    warnings: assessed.matrixWarnings,
    message:
      `Read-only assessment of ${assessed.pomPath}: ${assessed.edits.length} connector edit(s) would apply.` +
      shared,
  };
}

/**
 * commitParentPom(assessed, ctx): the WRITE phase shared by both entry points. Stages the single
 * rewritten pom, commits + opens a PR, and returns the PR_OPEN result object. Throws on commit
 * failure (the caller maps that to a terminal status / non-zero exit).
 */
async function commitParentPom(assessed, ctx) {
  const { mode, environment, jiraTicketId, jiraBaseUrl, repoRoot, deps, jobId } = ctx;
  const doCommitApi = deps.commitApi ?? commitAndPrApi;
  const doCommitLocal = deps.commitLocal ?? commitAndPrLocal;

  const { msg: editSummary } = connectorSummary(assessed.edits);
  const changePlan = {
    headSha: assessed.headSha,
    targetRuntime: assessed.matrix.target?.runtime,
    targetJavaVersion: assessed.matrix.target?.javaVersion,
  };
  const stagedFiles = [{ path: assessed.pomPath, content: assessed.rewrite.text }];
  const warnings = [`Parent/BOM connector version upgrade ${editSummary}`, ...assessed.matrixWarnings];

  const commitArgs = {
    changePlan,
    stagedFiles,
    appName: assessed.appName,
    jobId,
    jiraTicketId,
    jiraBaseUrl,
    warnings,
  };
  const pr = await (mode === "local"
    ? doCommitLocal({
        ...commitArgs,
        repoRoot,
        defaultBranch: assessed.defaultBranch,
        coords: { owner: assessed.coords.owner, repo: assessed.coords.repo, defaultBranch: assessed.defaultBranch },
      })
    : doCommitApi({
        ...commitArgs,
        coords: { owner: assessed.coords.owner, repo: assessed.coords.repo, defaultBranch: assessed.defaultBranch },
        // reuse the client only if one was already built/injected; else let commitAndPrApi build its own.
        ...(assessed._api ? { api: assessed._api } : {}),
      }));

  const { conn, ver, parentRef } = connectorSummary(assessed.edits);
  return {
    result: {
      jobId,
      kind: "parentPomUpgrade",
      status: "PR_OPEN",
      upgraded: true,
      appName: assessed.appName,
      environment,
      pomPath: assessed.pomPath,
      coords: { owner: assessed.coords.owner, repo: assessed.coords.repo, defaultBranch: assessed.defaultBranch },
      branchName: pr.branchName,
      commitSha: pr.commitSha,
      prNumber: pr.prNumber ?? null,
      prUrl: pr.prUrl,
      edits: assessed.edits,
      inheritance: assessed.inheritance,
      jiraTicketId,
      jiraUrl: jiraUrlFor(jiraTicketId, jiraBaseUrl),
      matrixSource: assessed.matrixSource,
      warnings,
      message:
        `Opened PR pinning ${conn.length} connector(s) in ${assessed.pomPath}` +
        (parentRef ? `, repointing <parent> to ${parentRef.artifactId ?? "?"} ${parentRef.to ?? "?"}` : "") +
        (ver ? ` and bumping the own version to ${ver.to ?? "?"}.` : "."),
    },
    pr,
    warnings,
  };
}

/**
 * upgradeParentPom(opts) — the targeted one-shot: assess → NO_CHANGE (no edits) or commit+PR.
 * Takes NO lock, creates NO job. Returns a ParentPomUpgradeResult (unchanged public contract).
 *
 * @param {object} opts
 * @param {string} [opts.repoUrl]        e.g. https://github.com/o/r/tree/<branch>/<dir>
 * @param {string} [opts.owner]
 * @param {string} [opts.repo]
 * @param {string} [opts.pomPath]        default "pom.xml" (or URL-embedded sub-path)
 * @param {string} [opts.branch]         base branch; else URL branch; else repo default
 * @param {string} [opts.environment]    log-only
 * @param {string} [opts.jiraTicketId]
 * @param {string} [opts.jiraBaseUrl]
 * @param {"api"|"local"} [opts.mode="api"]
 * @param {string} [opts.repoRoot]       local clone root (local mode / local pom read)
 * @param {string} [opts.jobId]          default "parentpom-<hash>"; caller may pass one
 * @param {object} [opts.deps]           {resolveMatrix, commitApi, commitLocal, readPom, api}
 * @param {object} [opts.matrixOpts]     {noFetch, exchange} — forwarded to resolveMatrix
 * @param {boolean} [opts.detectOnly]    read-only: report what this pom inherits (parent/BOM) and stop
 * @param {object} [opts.parentRef]      repoint this pom's <parent> at a new BOM/parent version
 * @param {boolean} [opts.bumpOwnVersion] force an own-version bump even with no connector edits
 * @returns {Promise<object>}
 */
export async function upgradeParentPom(opts) {
  const {
    mode = "api",
    environment = null,
    jiraTicketId = null,
    jiraBaseUrl = process.env.JIRA_BASE_URL || "",
    repoRoot,
    deps = {},
  } = opts;
  const jobId =
    opts.jobId || `parentpom-${Math.abs(hashString(JSON.stringify({ ...opts, deps: undefined })))}`;

  const assessed = await assessParentPom(opts);
  const ctx = { mode, environment, jiraTicketId, jiraBaseUrl, repoRoot, deps, jobId };

  // Read-only: report inheritance + edit preview and stop (no commit) — used by the chained flow.
  if (opts.detectOnly) {
    return detectResult(assessed, { jobId, environment, jiraTicketId, jiraBaseUrl });
  }
  if (assessed.edits.length === 0) {
    return noChangeResult(assessed, { jobId, environment, jiraTicketId, jiraBaseUrl });
  }
  const { result } = await commitParentPom(assessed, ctx);
  return result;
}

/**
 * runParentPomJob(opts) — Tier 2b: the parent/BOM upgrade wrapped in the app-upgrade job/lock
 * pipeline. Same assess+commit phases as upgradeParentPom, but with a tracked single-flight job:
 *
 *   assess (read-only) ──► NO_CHANGE short-circuit (no lock, no job)
 *        │ edits exist
 *        ▼
 *   store.createJob (acquire lock; CONFLICT if held) ──► PROCESSING
 *        ▼ COMMITTING
 *   commit + open PR ──► PR_OPEN (+ branch→job index)
 *        ▼ on error
 *   FAILED_ASSESS (VALIDATION/STALE_PLAN/404) | FAILED_COMMIT (else) + release lock
 *
 * The lock is keyed on the repo (appName = coords.repo), so a parent-pom job and an app upgrade of
 * the same repo are mutually single-flighted — you can't open two competing PRs on one repo at once.
 *
 * @param {object} opts  same as upgradeParentPom (jobId is assigned by the store, not the caller)
 * @returns {Promise<object>}  a result object whose shape matches upgradeParentPom's, plus `jobId`
 *   from the store on the edits path. CONFLICT → {status:"CONFLICT", code:"UPGRADE_IN_PROGRESS", ...}.
 */
export async function runParentPomJob(opts) {
  const {
    mode = "api",
    environment = null,
    jiraTicketId = null,
    jiraBaseUrl = process.env.JIRA_BASE_URL || "",
    repoRoot,
    deps = {},
  } = opts;
  const jobStore = deps.store ?? store;

  // ── (1) assess FIRST (read-only, no lock) so NO_CHANGE never creates a job/lock ──────────
  const assessed = await assessParentPom(opts);

  // Read-only detect: report inheritance/edit preview and stop — never takes a lock or opens a PR.
  if (opts.detectOnly) {
    return detectResult(assessed, { jobId: null, environment, jiraTicketId, jiraBaseUrl });
  }

  if (assessed.edits.length === 0) {
    // NO_CHANGE: no job, no lock — mirrors the app upgrade's ALREADY_UPGRADED short-circuit.
    return noChangeResult(assessed, { jobId: null, environment, jiraTicketId, jiraBaseUrl });
  }

  // ── (2) acquire lock + persist a PROCESSING job (CONFLICT if THIS pom is already locked) ──
  // Lock per MODULE (repo::pomPath), not per repo, so a monorepo can have the BOM PR, the parent-pom
  // PR, and the app PR open at once — while two upgrades of the SAME pom still single-flight. Without
  // this a BOM and a parent-pom in one repo (both appName=repo) would falsely CONFLICT.
  const lockKey = `${assessed.coords.repo}::${assessed.pomPath}`;
  let jobId;
  try {
    const created = jobStore.createJob({
      appName: assessed.appName,
      lockKey,
      environment,
      jiraTicketId,
      coords: { owner: assessed.coords.owner, repo: assessed.coords.repo, defaultBranch: assessed.defaultBranch },
      changePlan: {
        kind: "parentPomUpgrade",
        pomPath: assessed.pomPath,
        headSha: assessed.headSha,
        targetRuntime: assessed.matrix.target?.runtime,
        targetJavaVersion: assessed.matrix.target?.javaVersion,
        edits: assessed.edits,
      },
    });
    jobId = created.jobId;
  } catch (e) {
    if (e.code === "CONFLICT") {
      const held = jobStore.getJob(e.existingJobId) ?? {};
      return {
        status: "CONFLICT",
        code: "UPGRADE_IN_PROGRESS",
        kind: "parentPomUpgrade",
        appName: assessed.appName,
        existingJobId: e.existingJobId,
        prUrl: held.prUrl ?? null,
        message:
          `A parent/BOM upgrade for "${assessed.pomPath}" in repo "${assessed.appName}" is already in ` +
          `progress (jobId=${e.existingJobId}).` +
          (held.prUrl ? ` PR: ${held.prUrl}.` : "") +
          ` Wait for it to complete or fail before starting another upgrade of the same pom.`,
      };
    }
    throw e;
  }

  // ── (3) commit phase — any throw ⇒ FAILED_* terminal + lock release ──────────────────────
  try {
    jobStore.setStatus(jobId, "COMMITTING");
    const ctx = { mode, environment, jiraTicketId, jiraBaseUrl, repoRoot, deps, jobId };
    const { result, pr } = await commitParentPom(assessed, ctx);

    jobStore.setStatus(jobId, "PR_OPEN", {
      branchName: pr.branchName,
      commitSha: pr.commitSha,
      prUrl: pr.prUrl,
      prNumber: pr.prNumber ?? null,
    });
    if (pr.branchName) jobStore.putBranchIndex(pr.branchName, jobId);

    return { ...result, jobId, nextPollSeconds: 0 };
  } catch (e) {
    const failureStatus =
      e.code === "VALIDATION" || e.code === "STALE_PLAN" || e.code === "APP_NOT_FOUND" || e.httpNotFound
        ? "FAILED_ASSESS"
        : "FAILED_COMMIT";
    jobStore.setStatus(jobId, failureStatus, { error: e.message });
    jobStore.releaseLock(lockKey);
    return {
      status: failureStatus,
      jobId,
      kind: "parentPomUpgrade",
      appName: assessed.appName,
      environment,
      pomPath: assessed.pomPath,
      error: e.message,
      jiraTicketId,
      message: `Parent-pom upgrade for ${assessed.appName} failed at ${failureStatus}: ${e.message}`,
    };
  }
}

/**
 * updateOpenPrParentRef(opts) — the FINAL chained step: bump the <parent> version reference INSIDE an
 * app's ALREADY-OPEN upgrade PR (e.g. point customer-web-eapi at the newly-released solutions-parent-pom).
 * Reads the app pom at the open PR's head branch, repoints its <parent>, and adds ONE commit onto that
 * SAME branch (GitHub auto-attaches it to the open PR). Records the amendment on the app job. Does NOT
 * open a new PR and does NOT change the app job's status.
 *
 * @param {object} opts
 * @param {string} opts.appJobId       the app's tracked job (must be PR_OPEN with a branch)
 * @param {{groupId?:string, artifactId?:string, toVersion:string}} opts.parentRef  new parent-pom ref
 * @param {string} [opts.pomPath]  the app's own pom path; OMIT to auto-derive it from the tracked job
 *   (the reliable default — see deriveAppPomPath). Only pass it to override an unusual layout.
 * @param {"api"|"local"} [opts.mode="api"]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.jiraTicketId]
 * @param {object} [opts.deps]  {store, api, readPom, commitToBranchApi, commitToBranchLocal}
 * @returns {Promise<object>}  PR_UPDATED | NO_CHANGE | throws VALIDATION
 */
export async function updateOpenPrParentRef(opts) {
  const {
    appJobId,
    parentRef,
    pomPath: pomPathOpt,
    mode = "api",
    repoRoot,
    jiraTicketId = null,
    deps = {},
  } = opts;
  const jobStore = deps.store ?? store;

  if (!appJobId) throw validationError("updateOpenPrParentRef requires appJobId (the app's open PR job).");
  if (!parentRef || parentRef.toVersion == null || String(parentRef.toVersion) === "") {
    throw validationError("updateOpenPrParentRef requires parentRef.toVersion.");
  }
  const rec = jobStore.getJob(appJobId);
  if (!rec) throw validationError(`No job found for jobId=${appJobId}.`);
  if (rec.status !== "PR_OPEN" || !rec.branchName) {
    throw validationError(
      `Job ${appJobId} has no open PR branch to update (status=${rec.status}, branch=${rec.branchName ?? "none"}).`
    );
  }
  const owner = rec.coords?.owner;
  const repo = rec.coords?.repo;
  if (!owner || !repo) throw validationError(`Job ${appJobId} is missing repo coords.`);
  const branchName = rec.branchName;
  // Resolve WHICH pom to edit. NEVER blindly default to the repo-root "pom.xml": in a multi-module
  // repo the app lives under a sub-dir (e.g. customer-web-eapi/pom.xml), and defaulting to the root
  // committed the parent-ref bump to the WRONG, redundant pom (the bug in PR #38). Derive the app's
  // OWN pom path from the tracked job's changePlan so the amendment always lands in the same file the
  // app PR itself edited. An explicit opts.pomPath still wins for genuinely unusual layouts.
  const pomPath = pomPathOpt ?? deriveAppPomPath(rec);

  // ── read the app pom at the OPEN PR's head branch ────────────────────────────────────────
  let _api = deps.api ?? null;
  let pomText;
  if (deps.readPom) {
    ({ pomText } = await deps.readPom({ owner, repo, pomPath, ref: branchName }));
  } else if (mode === "api") {
    _api ??= new GitHubApi();
    const resp = await _api.getContents(owner, repo, pomPath, branchName);
    if (typeof resp?.content !== "string" || resp.content === "") {
      throw validationError(`Could not read "${pomPath}" from ${owner}/${repo}@${branchName}.`);
    }
    pomText = Buffer.from(resp.content.replace(/[\r\n\t ]/g, ""), "base64").toString("utf-8");
  } else {
    if (!repoRoot) throw validationError("local mode requires repoRoot.");
    pomText = fs.readFileSync(path.join(repoRoot, pomPath), "utf-8");
  }

  // ── repoint the app pom's <parent> at the new parent-pom version ──────────────────────────
  const fromVersion = detectInheritance(pomText)?.parent?.version ?? null;
  const after = rewriteParentRefVersion(
    pomText,
    { groupId: parentRef.groupId, artifactId: parentRef.artifactId },
    String(parentRef.toVersion)
  );
  if (after === pomText) {
    return {
      status: "NO_CHANGE",
      jobId: appJobId,
      kind: "appParentRefUpdate",
      appName: rec.appName,
      coords: { owner, repo },
      branchName,
      prNumber: rec.prNumber ?? null,
      prUrl: rec.prUrl ?? null,
      pomPath,
      parentRef,
      message:
        `App pom <parent> in ${pomPath} already matches ${parentRef.toVersion} ` +
        `(or no <parent> matched ${parentRef.artifactId ?? "the given coords"}); nothing to update.`,
    };
  }

  // ── add ONE commit onto the open PR's branch (GitHub attaches it to the PR) ───────────────
  const message =
    `chore: bump ${parentRef.artifactId ?? "parent"} to ${parentRef.toVersion} (Java 17 chained upgrade)` +
    (jiraTicketId ? ` [${jiraTicketId}]` : "");
  const staged = [{ path: pomPath, content: after }];
  const doCommitApi = deps.commitToBranchApi ?? commitToExistingBranchApi;
  const doCommitLocal = deps.commitToBranchLocal ?? commitToExistingBranchLocal;
  const committed =
    mode === "local"
      ? doCommitLocal({ repoRoot, branchName, stagedFiles: staged, message })
      : await doCommitApi({
          coords: { owner, repo },
          branchName,
          stagedFiles: staged,
          message,
          ...(_api ? { api: _api } : {}),
        });

  // ── record the amendment on the app job (does NOT change status) ──────────────────────────
  const amendment = {
    kind: "parentRefBump",
    artifactId: parentRef.artifactId ?? null,
    groupId: parentRef.groupId ?? null,
    from: fromVersion,
    to: String(parentRef.toVersion),
    commitSha: committed.commitSha,
    at: nowUtc(),
  };
  jobStore.patchJob(appJobId, {
    amendments: [...(rec.amendments ?? []), amendment],
    commitSha: committed.commitSha,
  });

  return {
    status: "PR_UPDATED",
    jobId: appJobId,
    kind: "appParentRefUpdate",
    appName: rec.appName,
    coords: { owner, repo },
    branchName,
    commitSha: committed.commitSha,
    prNumber: rec.prNumber ?? null,
    prUrl: rec.prUrl ?? null,
    pomPath,
    parentRef: { ...parentRef, from: fromVersion },
    message:
      `Updated open PR${rec.prNumber ? ` #${rec.prNumber}` : ""} on ${branchName}: ` +
      `<parent> ${parentRef.artifactId ?? ""} ${fromVersion ?? "?"} -> ${parentRef.toVersion}.`,
  };
}

// Derive the app's OWN pom path from its tracked job, so the chained parent-ref amendment edits the
// SAME file the app upgrade PR edited (e.g. "customer-web-eapi/pom.xml"), never the repo-root pom.xml.
// Source of truth, in order:
//   1) the changePlan's pomVersion edit `file` — this IS the app's own <version> line (assess_engine
//      sets file = chain[0].path, the app pom), so it is exactly the pom whose <parent> we must bump;
//   2) any pom.xml among filesToChange / fileEdits (covers plans with no own-version bump);
//   3) changePlan.appPath / coords.appPath + "/pom.xml";
//   4) "pom.xml" only as a last resort (single-module repo at the root).
export function deriveAppPomPath(rec) {
  const cp = rec?.changePlan ?? {};
  const edits = Array.isArray(cp.fileEdits) ? cp.fileEdits : [];
  const verEdit = edits.find((e) => e?.kind === "pomVersion" && typeof e.file === "string" && e.file);
  if (verEdit) return verEdit.file;
  const files = (Array.isArray(cp.filesToChange) && cp.filesToChange.length
    ? cp.filesToChange
    : edits.map((e) => e?.file)
  ).filter((f) => typeof f === "string" && f);
  const pom = files.find((f) => /(^|\/)pom\.xml$/i.test(f));
  if (pom) return pom;
  const ap = cp.appPath ?? rec?.coords?.appPath ?? null;
  if (ap && ap !== ".") return `${String(ap).replace(/\/+$/, "")}/pom.xml`;
  return "pom.xml";
}

function jiraUrlFor(ticket, baseUrl) {
  if (!ticket || !baseUrl) return null;
  return `${baseUrl}/browse/${ticket}`;
}

// deterministic non-crypto hash (Date.now/random are unavailable in workflow scripts; keep the
// jobId stable + input-derived so re-runs of the same request reuse an id).
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}
