// parent_pom.js — SKILL 4: upgrade a SHARED parent/BOM pom.xml (port of pf-upgrade-parent-pom).
//
// Pins the connector versions a parent/BOM MANAGES so they meet the Java-17 matrix, then (if any
// were pinned) minor-bumps the parent's OWN version, and opens a PR — reusing SKILL 2's rewrite
// (rewriteParentPom) and SKILL 3's commit+PR. Unlike the app upgrade this touches ONE pom and has
// no lock/assess pipeline; it is a targeted "make this BOM Java-17-ready" operation.
//
// Two modes:
//   api   — read the pom via the GitHub Contents API @ {ref}, rewrite, commit+PR via Git Data API.
//   local — read the pom from a local clone, rewrite, commit+PR via git/gh.
//
// Coordinate resolution mirrors the Mule fix: repoUrl (if present) is ALWAYS parsed for
// owner/repo/branch/pomPath; explicit owner/repo override only owner/repo, so a
// /tree/<branch>/<dir> URL keeps its branch + sub-path.

import fs from "node:fs";
import path from "node:path";
import { resolveMatrix } from "../../mule-upgrade-assess/scripts/lib/matrix_fetch.js";
import { rewriteParentPom } from "../../mule-upgrade-apply/scripts/rewrites/parent_pom.js";
import { commitAndPrApi, commitAndPrLocal } from "../../mule-upgrade-pr/scripts/commit_pr.js";
import { GitHubApi } from "../../mule-upgrade-pr/scripts/lib/gh_api.js";
import { resolveRepoCoords, resolvePomPath } from "./lib/repo_url.js";

function validationError(message) {
  const e = new Error(message);
  e.code = "VALIDATION";
  return e;
}

function connectorSummary(edits) {
  const conn = edits.filter((e) => (e.kind ?? "") !== "pomVersion");
  const ver = edits.find((e) => (e.kind ?? "") === "pomVersion");
  let msg = `pinning ${conn.length} connector(s): ${conn
    .map((e) => `${e.artifactId ?? "?"} ${e.from ?? "unknown"} -> ${e.to ?? "?"}`)
    .join("; ")}`;
  if (ver) msg += `; parent version ${ver.from ?? "?"} -> ${ver.to ?? "?"}`;
  return { conn, ver, msg };
}

/**
 * upgradeParentPom(opts) — resolve coords → load matrix → read pom → rewriteParentPom →
 * NO_CHANGE (no edits) or commit+PR. Returns a ParentPomUpgradeResult.
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
 * @param {string} [opts.jobId]          default "parentpom-<uuid>"-ish; caller may pass one
 * @param {object} [opts.deps]           {resolveMatrix, commitApi, commitLocal, readPom, api}
 * @param {object} [opts.matrixOpts]     {releaseNotesUrl, noFetch, nowMs, fetchHtml}
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
    matrixOpts = {},
  } = opts;
  const jobId = opts.jobId || `parentpom-${Math.abs(hashString(JSON.stringify({ ...opts, deps: undefined })))}`;

  const doResolveMatrix = deps.resolveMatrix ?? resolveMatrix;
  const doCommitApi = deps.commitApi ?? commitAndPrApi;
  const doCommitLocal = deps.commitLocal ?? commitAndPrLocal;
  // Lazily construct the GitHub client only when api mode actually needs it, so coordinate
  // validation (and any injected readPom) can run without a GITHUB_TOKEN.
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
  }

  // ── (5) rewrite ──────────────────────────────────────────────────────────────────────────
  const rewrite = rewriteParentPom(pomText, matrix, pomPath);
  const edits = rewrite.edits ?? [];

  if (edits.length === 0) {
    return {
      jobId,
      kind: "parentPomUpgrade",
      status: "NO_CHANGE",
      upgraded: false,
      appName,
      environment,
      pomPath,
      coords: { owner: coords.owner, repo: coords.repo, defaultBranch },
      edits: [],
      jiraTicketId,
      jiraUrl: jiraUrlFor(jiraTicketId, jiraBaseUrl),
      matrixSource,
      warnings: matrixWarnings,
      message: `Parent/BOM already meets the Java 17 matrix; nothing to change in ${pomPath}.`,
    };
  }

  // ── (6) stage the single rewritten pom + commit + open PR ─────────────────────────────────
  const { msg: editSummary } = connectorSummary(edits);
  const changePlan = {
    headSha,
    targetRuntime: matrix.target?.runtime,
    targetJavaVersion: matrix.target?.javaVersion,
  };
  const stagedFiles = [{ path: pomPath, content: rewrite.text }];
  const warnings = [`Parent/BOM connector version upgrade ${editSummary}`, ...matrixWarnings];

  const commitArgs = {
    changePlan,
    stagedFiles,
    appName,
    jobId,
    jiraTicketId,
    jiraBaseUrl,
    warnings,
  };
  const pr =
    mode === "local"
      ? doCommitLocal({ ...commitArgs, repoRoot, defaultBranch })
      : await doCommitApi({
          ...commitArgs,
          coords: { owner: coords.owner, repo: coords.repo, defaultBranch },
          // reuse the client only if one was already built/injected; else let commitAndPrApi
          // build its own (so an injected commitApi test needs no GITHUB_TOKEN).
          ...(_api ? { api: _api } : {}),
        });

  const { conn, ver } = connectorSummary(edits);
  return {
    jobId,
    kind: "parentPomUpgrade",
    status: "PR_OPEN",
    upgraded: true,
    appName,
    environment,
    pomPath,
    coords: { owner: coords.owner, repo: coords.repo, defaultBranch },
    branchName: pr.branchName,
    commitSha: pr.commitSha,
    prNumber: pr.prNumber ?? null,
    prUrl: pr.prUrl,
    edits,
    jiraTicketId,
    jiraUrl: jiraUrlFor(jiraTicketId, jiraBaseUrl),
    matrixSource,
    warnings,
    message:
      `Opened PR pinning ${conn.length} connector(s) in ${pomPath}` +
      (ver ? ` and bumping the parent version to ${ver.to ?? "?"}.` : "."),
  };
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
