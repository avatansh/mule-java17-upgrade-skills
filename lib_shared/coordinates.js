// coordinates.js — port of `pf-resolve-coordinates` (system/reference-data.xml).
//
// Resolves owner/repo/appPath/orgId/branch for an appName using a 3-tier precedence waterfall:
//   Tier 1  registry entry (app-registry.yaml)
//   Tier 2  explicit request override (owner/repo/appPath/orgId/branch)
//   Tier 3  convention (config: github.defaultOwner, naming.repoEqualsAppName → repo=appName,
//           naming.appPathAtRoot → appPath=".", anypoint.defaultOrgId, github.defaultBranch)
//
// Governance: when registry.enforceAllowList === "true", an appName absent from the registry is
// rejected up front (VALIDATION / APP_NOT_REGISTERED). After resolution, owner+repo MUST be
// non-null or the same VALIDATION is raised.
//
// Branch is special: request.branch → request.defaultBranch (legacy alias) → registry.defaultBranch
// → LIVE GitHub default_branch discovery (GET /repos/{owner}/{repo}) → config github.defaultBranch.
// Discovery is best-effort: any error falls back to the config default. Results are memoized per
// owner/repo for the life of the process (mirrors the Mule repoBranchCachingStrategy).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { get } from "./config.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REGISTRY = path.join(
  REPO_ROOT,
  "skills",
  "mule-upgrade-assess",
  "references",
  "app-registry.yaml"
);

function validationError(message, extra = {}) {
  const e = new Error(message);
  e.code = "VALIDATION";
  e.errorType = "APP_NOT_REGISTERED";
  e.category = "USER_INPUT";
  e.retryable = false;
  Object.assign(e, extra);
  return e;
}

/** Load the registry `apps` map (classpath fallback copy). Missing/empty → {}. */
export function loadRegistry(registryPath = DEFAULT_REGISTRY) {
  try {
    const doc = yaml.load(fs.readFileSync(registryPath, "utf8")) ?? {};
    return doc.apps && typeof doc.apps === "object" ? doc.apps : {};
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
}

const _branchCache = new Map(); // `${owner}/${repo}` → branch

/**
 * Resolve coordinates for an app.
 *
 * @param {object} args
 * @param {string} args.appName                (required)
 * @param {object} [args.request]              explicit overrides {owner,repo,appPath,orgId,branch,defaultBranch}
 * @param {object} [args.registry]             pre-loaded apps map (else loaded from disk)
 * @param {string} [args.registryPath]
 * @param {object} [args.deps]                 {getRepo?: async(owner,repo)=>{default_branch}, cfg?: (dotted,fallback)=>v}
 * @param {boolean} [args.discoverBranch=true] allow the live GitHub default-branch call
 * @returns {Promise<{appName,owner,repo,appPath,orgId,defaultBranch,fromRegistry}>}
 */
export async function resolveCoordinates(args) {
  const { appName } = args;
  if (!appName || typeof appName !== "string") {
    throw validationError("appName is required.", { invalidFields: ["appName"] });
  }
  const request = args.request ?? {};
  const cfg = args.deps?.cfg ?? ((k, fb) => get(k, fb));
  const registry = args.registry ?? loadRegistry(args.registryPath);
  const entry = registry[appName] ?? null;

  // ── governance: allow-list enforcement (BEFORE resolution) ──────────────────────────────────
  const enforce = String(cfg("registry.enforceAllowList", "false")) === "true";
  if (enforce && !entry) {
    throw validationError(
      `App "${appName}" is not in the allow-list registry. Add an entry to app-registry.yaml ` +
        `or set registry.enforceAllowList=false.`,
      { invalidFields: ["appName"] }
    );
  }

  // ── tier 3 convention values ────────────────────────────────────────────────────────────────
  const conventionRepo = String(cfg("naming.repoEqualsAppName", "true")) === "true" ? appName : null;
  const conventionAppPath = String(cfg("naming.appPathAtRoot", "true")) === "true" ? "." : null;

  // ── 3-tier waterfall per field (registry → request → convention) ────────────────────────────
  const owner = entry?.owner ?? request.owner ?? cfg("github.defaultOwner", null);
  const repo = entry?.repo ?? request.repo ?? conventionRepo;
  const appPath = entry?.appPath ?? request.appPath ?? conventionAppPath;
  const orgId = entry?.orgId ?? request.orgId ?? cfg("anypoint.defaultOrgId", null);

  // ── post-resolution validation: owner+repo required ─────────────────────────────────────────
  if (!owner || !repo) {
    throw validationError(
      `Cannot resolve repo coordinates for app "${appName}". Provide owner and repo by adding an ` +
        `entry to app-registry.yaml or including owner/repo in the request.`,
      { invalidFields: ["owner", "repo"] }
    );
  }

  // ── branch: request → legacy alias → registry → live discovery → config default ─────────────
  let defaultBranch = request.branch || request.defaultBranch || entry?.defaultBranch || null;
  if (!defaultBranch) {
    defaultBranch = await discoverDefaultBranch(owner, repo, {
      getRepo: args.deps?.getRepo,
      configDefault: cfg("github.defaultBranch", "main"),
      allow: args.discoverBranch !== false,
    });
  }

  return { appName, owner, repo, appPath, orgId, defaultBranch, fromRegistry: !!entry };
}

/**
 * Live default-branch discovery with per-repo memoization + config fallback (never throws).
 * @param {string} owner
 * @param {string} repo
 * @param {object} [opts]
 * @param {Function} [opts.getRepo] - async function to fetch repo info
 * @param {string} [opts.configDefault]
 * @param {boolean} [opts.allow]
 */
export async function discoverDefaultBranch(
  owner,
  repo,
  { getRepo, configDefault = "main", allow = true } = {}
) {
  const cacheKey = `${owner}/${repo}`;
  if (_branchCache.has(cacheKey)) return _branchCache.get(cacheKey);
  let branch = configDefault;
  if (allow && typeof getRepo === "function") {
    try {
      const info = await getRepo(owner, repo);
      branch = (info && info.default_branch) || configDefault;
    } catch {
      branch = configDefault; // any error → config fallback (non-fatal)
    }
  }
  _branchCache.set(cacheKey, branch);
  return branch;
}

/** Reset the per-repo branch cache (tests). */
export function _resetBranchCache() {
  _branchCache.clear();
}
