// assess.js — SKILL 1 driver: assess a MuleSoft app for the Java-17 upgrade.
//
// Faithful port of the Mule app's assess pipeline: build a recursive tree of the local clone,
// locate the app pom / mule-artifact.json / CI workflow (treeAnalysis), walk the pom inheritance
// chain (pomChain), resolve the compatibility matrix (bundled gating + dynamic connectors with
// disk cache + YAML fallback), and produce an AssessmentResult whose changePlan.fileEdits[] is
// directly consumable by mule-upgrade-apply.
//
// Usage (local clone):
//   node assess.js --repo /path/to/clone [--app-path sub/dir] [--app-name my-app] ...
// Usage (github, NO clone):
//   node assess.js --source github --repo-url https://github.com/owner/repo[/tree/branch/sub] ...
//   node assess.js --source github --owner o --repo-name r [--branch b] [--app-path sub/dir] ...
//
// Prints the AssessmentResult JSON to stdout (and writes it to --out when given), plus a
// human-readable summary to stderr.

import fs from "node:fs";
import path from "node:path";
import { analyzeTree, classifyTopology } from "./lib/topology.js";
import { initChain, appendParent } from "./lib/pom_chain.js";
import { resolveMatrix, fetchReleaseNotesCached } from "./lib/matrix_fetch.js";
import { checkMatrixDrift, checkConnectorDrift } from "./lib/matrix_drift.js";
import { buildAssessmentResult, scanFlags, scanTargets, appConnectorScope } from "./lib/assess_engine.js";
import { localSource, githubSource } from "./lib/repo_source.js";
import { resolveVersions, applyVersionStrategy } from "./lib/resolve_versions.js";
import { enrichConnectorGaps } from "./lib/connector_deps.js";
import { resolveRepoCoords, resolvePomPath } from "../../mule-upgrade-parent-pom/scripts/lib/repo_url.js";
import { GitHubApi } from "../../mule-upgrade-pr/scripts/lib/gh_api.js";
import { get, requireEnv } from "../../../lib_shared/config.js";
import { AnypointClient } from "../../mule-upgrade/scripts/lib/anypoint.js";
import { ExchangeClient } from "../../../lib_shared/exchange.js";

// Directories never worth walking in a local clone (mirror of repo_source.js IGNORE_DIRS).
const IGNORE_DIRS = new Set([".git", "node_modules", "target", ".idea", ".vscode"]);

/**
 * Build a { tree:[{path,type}], truncated:false } object from a local directory.
 * Retained as a synchronous helper for callers/tests that pass a pre-built tree to assess().
 */
export function buildLocalTree(repoRoot) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && IGNORE_DIRS.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(abs, e.name);
      if (e.isDirectory()) {
        out.push({ path: childRel, type: "tree" });
        walk(childAbs, childRel);
      } else if (e.isFile()) {
        out.push({ path: childRel, type: "blob" });
      }
    }
  };
  walk(repoRoot, "");
  return { tree: out, truncated: false };
}

/**
 * Resolve opts into a repo source (local | github). The github source reads over the GitHub REST
 * API with NO local clone. Accepts either a repoUrl (parsed for owner/repo/branch/sub-path) or
 * explicit owner/repo/branch.
 * @returns {{source:any, appPathHint:(string|null)}} appPathHint is a sub-path pulled from a
 *   /tree/<branch>/<sub> repoUrl, used as the app-path default when the caller didn't pass one.
 */
export function resolveSource(opts) {
  const kind = opts.source ?? (opts.repoUrl || opts.owner ? "github" : "local");
  if (kind === "local") {
    if (!opts.repo) throw new Error("local source requires --repo <clone-dir>");
    return { source: localSource(opts.repo), appPathHint: null };
  }
  if (kind === "github") {
    const coords = resolveRepoCoords({
      repoUrl: opts.repoUrl ?? null,
      owner: opts.owner ?? null,
      repo: opts.repoName ?? opts.repo ?? null,
    });
    if (!coords.owner || !coords.repo) {
      throw new Error("github source requires --repo-url or --owner + --repo-name");
    }
    const ref = opts.branch ?? coords.urlBranch ?? null;
    const gh = opts.gh ?? new GitHubApi();
    // A /tree/<branch>/<sub-dir> URL implies the app lives in <sub-dir>; derive an app-path hint
    // by stripping a trailing /pom.xml (resolvePomPath appends it for directory URLs).
    let appPathHint = null;
    if (coords.urlPomPath) {
      const pomPath = resolvePomPath(null, coords);
      appPathHint = pomPath.replace(/\/?pom\.xml$/, "") || ".";
    }
    return { source: githubSource({ owner: coords.owner, repo: coords.repo, ref, gh }), appPathHint };
  }
  throw new Error(`unknown repo source: ${kind}`);
}

/**
 * Files the assess engine will read: every pom.xml, the content-scan corpus (.java repo-wide, plus
 * .dwl and src/main/mule/*.xml scoped to the app module), the located mule-artifact/CI paths, and the
 * Maven wrapper (Process-Guide toolchain floor).
 *
 * Priming matters because the github source costs ONE API call per file and serves readSync from that
 * cache — a file that isn't primed reads as null, which would silently turn a content scan into a
 * false "clean" result. scanTargets() is the same function the scan itself uses, so the primed set and
 * the scanned set cannot drift apart.
 */
function filesToPrime(tree, located, appPath) {
  const paths = new Set();
  for (const t of tree.tree ?? []) {
    if (t.type !== "blob") continue;
    if (t.path.endsWith("pom.xml")) paths.add(t.path);
  }
  for (const rel of scanTargets(tree.tree ?? [], { appPath }).paths) paths.add(rel);
  if (located?.appPomPath) paths.add(located.appPomPath);
  if (located?.muleArtifactPath) paths.add(located.muleArtifactPath);
  if (located?.ciWorkflowPath) paths.add(located.ciWorkflowPath);
  paths.add(".mvn/wrapper/maven-wrapper.properties");
  return [...paths];
}

/**
 * Walk the pom inheritance chain from the app pom up to the outermost in-repo parent.
 * @param {(rel:string)=>(string|null)} readFile synchronous repo-relative reader
 * @returns {Array<{path,pom,pomText}>}
 */
export function buildChain(readFile, appPomPath, treePaths) {
  const appText = readFile(appPomPath);
  if (appText == null) throw new Error(`app pom not found at ${appPomPath}`);
  /** @type {{appPomText?:any, chain:Array<{path:any,pom:any,pomText:any}>, nextParentPath:any}} */
  let state = initChain(appText, appPomPath, treePaths);
  const guard = new Set([appPomPath]);
  while (state.nextParentPath && !guard.has(state.nextParentPath)) {
    const p = state.nextParentPath;
    guard.add(p);
    const parentText = readFile(p);
    if (parentText == null) break;
    state = appendParent(parentText, p, state.chain, treePaths);
  }
  return state.chain;
}

/** Parse mule-artifact.json (returns null when absent/invalid). */
function readMuleArtifact(readFile, maPath) {
  const text = readFile(maPath);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// cfg(): read a config value, swallowing lookup/decrypt errors → fallback.
function cfg(dotted, fallback) {
  try {
    const v = get(dotted, undefined);
    return v === undefined || v === null || v === "" ? fallback : v;
  } catch {
    return fallback;
  }
}

// Compare two runtime versions by their dotted components (build qualifier after ":" ignored).
// Returns true when a SHARED component differs — i.e. a real mismatch. A prefix/startsWith test is
// wrong here: "4.9.18".startsWith("4.9.1") is true yet 4.9.1 ≠ 4.9.18 (L5). "4.9" vs "4.9.1" is NOT a
// mismatch (the shared "4","9" parts match), so a coarser deployed version never false-alarms.
function runtimeBaseMismatch(a, b) {
  const parts = (v) => String(v).split(":")[0].split(".").map((s) => s.trim());
  const pa = parts(a);
  const pb = parts(b);
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    if (pa[i] !== pb[i]) return true;
  }
  return false;
}

/**
 * batchACrossChecks — port of the two live Anypoint cross-checks the assess flow runs (ADR Batch A):
 *   #1 pf-read-deployment  (assess.armCrossCheck)  → warn when the deployed runtime differs from the
 *      source pom's target runtime, and surface the real deployed status/version.
 *   #6 pf-read-api-policies (assess.apiPolicyCheck) → set changePlan.hasApiPolicies from the app's
 *      applied API Manager policies (overrides the source-scan placeholder when it runs).
 *
 * BOTH are OFF by default (config toggles) and FULLY NON-FATAL: any auth/network/schema error is
 * swallowed and the assessment falls back to the source-only result. Injectable `client` for tests.
 * Returns { hasApiPolicies?, deployedState?, warnings:[] } — only keys that were actually resolved.
 * @param {object} [opts]
 * @param {string} [opts.appName]
 * @param {string} [opts.environment]
 * @param {string} [opts.orgId]
 * @param {any} [opts.result]
 * @param {any} [opts.client]
 */
export async function batchACrossChecks({ appName, environment, orgId, result, client } = {}) {
  const armOn = String(cfg("assess.armCrossCheck", "false")) === "true";
  const apiOn = String(cfg("assess.apiPolicyCheck", "false")) === "true";
  const out = { warnings: [] };
  if (!armOn && !apiOn) return out;

  const anypoint = client ?? new AnypointClient(orgId ? { orgId } : {});
  if (!anypoint.configured()) return out; // creds absent → silently source-only

  const env = environment || cfg("anypoint.environmentName", "") || "Development";
  if (armOn) {
    try {
      const d = await anypoint.readDeployment({ app: appName, env });
      out.deployedState = d;
      const targetRuntime = result?.changePlan?.targetRuntime;
      if (d.found && d.runtimeVersion && targetRuntime) {
        const deployedBase = String(d.runtimeVersion).split(":")[0]; // "4.6.0:..." → "4.6.0"
        // Compare by version COMPONENTS, not startsWith: "4.9.18".startsWith("4.9.1") is true and would
        // HIDE a real 4.9.1 ≠ 4.9.18 mismatch (L5). runtimeBaseMismatch flags any differing shared part.
        if (deployedBase && runtimeBaseMismatch(deployedBase, targetRuntime)) {
          out.warnings.push(
            `Deployed runtime (${d.runtimeVersion}, status ${d.status}) differs from the source pom target ${targetRuntime}. ` +
              `Verify the running app matches source before upgrading.`
          );
        }
      }
    } catch {
      /* non-fatal */
    }
  }
  if (apiOn) {
    try {
      const p = await anypoint.readApiPolicies({ app: appName, env });
      if (p.checked) out.hasApiPolicies = p.hasApiPolicies;
    } catch {
      /* non-fatal */
    }
  }
  return out;
}

/**
 * checkDeployedState — EPIC C: an explicit, operator-driven VERBATIM deployed-state check.
 *
 * The operator supplies the exact deployed application name (`deployedApiName`); we query Anypoint
 * Runtime Manager for that name EXACTLY in the given environment and, when found, surface the running
 * runtime / Java / status / replicas / last-deploy alongside the source assessment. This is distinct
 * from the Batch-A ARM cross-check (which auto-matches on the app name): here the name is provided and
 * matched verbatim, and the check is ALWAYS reported — including WHY it was skipped:
 *   - no name provided                → skipped, reason "no deployed application name provided"
 *   - anypoint not configured         → skipped, reason (credentials absent)
 *   - name given but not found in env → skipped, reason "no deployment named … in environment …"
 *   - found                           → { checked:true, deployedState:{…} }
 *
 * Fully NON-FATAL: any network/auth error degrades to a skip-with-reason (describeDeployment swallows
 * it). ARM does NOT expose deployed connector versions, so this informs the runtime/Java picture only.
 *
 * @param {object} [opts]
 * @param {string} [opts.deployedApiName]  the exact deployed app name to look up (verbatim)
 * @param {string} [opts.environment]
 * @param {string} [opts.orgId]
 * @param {any}    [opts.client]           injectable AnypointClient (tests)
 * @returns {Promise<{checked:boolean, reason?:string, deployedState?:object, note?:string}>}
 */
export async function checkDeployedState({ deployedApiName, environment, orgId, client } = {}) {
  const name = String(deployedApiName ?? "").trim();
  if (!name) {
    return {
      checked: false,
      reason: "No deployed application name provided — skipped the live deployed-state check.",
    };
  }
  const anypoint = client ?? new AnypointClient(orgId ? { orgId } : {});
  if (!anypoint.configured()) {
    return {
      checked: false,
      reason: `Anypoint not configured (credentials absent) — skipped the deployed-state check for "${name}".`,
    };
  }
  // Prefer the caller's env, else the config-declared Anypoint env NAME for this environment, else
  // try every environment. The old hard-coded "Development" default silently missed orgs whose env is
  // named "DEV"/"Sandbox"/etc. — the #1 cause of a "not found" on a NAME the operator copied correctly.
  const env = environment || cfg("anypoint.environmentName", "") || null;
  let namedReason = null;
  if (env) {
    const d = await anypoint.describeDeployment({ app: name, env });
    if (d.found) return { checked: true, deployedState: d };
    namedReason = d.reason;
  }
  // Cross-env safety net: a correct app name with a wrong/blank env label still resolves, reporting
  // the environment where the app actually runs. Guarded so an injected client without the method
  // still degrades cleanly to the named-env reason rather than throwing.
  if (typeof anypoint.findDeploymentAcrossEnvs === "function") {
    const across = await anypoint.findDeploymentAcrossEnvs({ app: name });
    if (across.found) {
      return {
        checked: true,
        deployedState: across,
        note: env
          ? `"${name}" was not in "${env}" but was found in "${across.environment}".`
          : `"${name}" was found in "${across.environment}" (no environment label was supplied).`,
      };
    }
    return {
      checked: false,
      reason: `Deployed-state check skipped: ${across.reason ?? `"${name}" not found in any environment`}.`,
    };
  }
  return {
    checked: false,
    reason: `Deployed-state check skipped: ${namedReason ?? `"${name}" not found in "${env ?? "any"}"`}.`,
  };
}

/**
 * buildAppChain — the network-free repo→pom-chain prefix shared by assess() and resolveVersionsForApp().
 * Resolves the source, loads the matrix (for connector/gating coordinates used by tree analysis),
 * locates the app pom, and walks the inheritance chain. Returns everything a caller needs to reason
 * about the app's connectors WITHOUT running the full ChangePlan build.
 * @param {object} opts  same source/appPath opts as assess() (incl. optional targetJava)
 * @returns {Promise<{source:any, matrix:any, matrixSource:any, matrixWarnings:string[], tree:any, located:any, chain:any[], readFile:(relPath:string)=>string, appPath:string}>}
 */
export async function buildAppChain(opts) {
  const { source, appPathHint } = opts.repoSource
    ? { source: opts.repoSource, appPathHint: null }
    : resolveSource(opts);
  const appPath = opts.appPath ?? appPathHint ?? ".";

  // targetJava selects WHICH compatibility matrix this run is judged against. Omitted (the default
  // for every caller that predates multi-target support) means the default target file, so behaviour
  // is unchanged. An unknown or uncurated target throws out of here rather than degrading.
  const {
    matrix,
    source: matrixSource,
    warnings: matrixWarnings,
  } = await resolveMatrix({ noFetch: opts.noFetch, exchange: opts.exchange, targetJava: opts.targetJava });

  const tree = opts.tree ?? (await source.listTree());
  const treePaths = tree.tree.map((t) => t.path);
  const located = analyzeTree(tree, appPath, matrix.gating, matrix.connectors);
  if (!located.appPomPath) throw new Error("app pom not found in repository tree");
  await source.prime(filesToPrime(tree, located, appPath));
  const readFile = (rel) => source.readSync(rel);
  const chain = buildChain(readFile, located.appPomPath, treePaths);
  return { source, matrix, matrixSource, matrixWarnings, tree, located, chain, readFile, appPath };
}

/**
 * resolveVersionsForApp — the SCOPED, live version resolver behind the resolve_versions tool (A2).
 *
 * Walks the app's pom chain (network-free), derives the set of connectors the app actually references
 * plus each one's current effective version, then runs resolveVersions() restricted to THOSE
 * connectors with `current` populated. This is the Full Split's ② resolve_versions: the rich menu
 * (options[], firstCompatible/latestInMajor/latest, staleness) for ONLY the app's connectors, not the
 * whole matrix. Builds a live ExchangeClient + release-notes fetcher unless opts.noFetch (then
 * matrix-only, but still scoped + current-populated). FULLY NON-FATAL.
 * @param {object} opts  source/appPath opts (as assess) + {noFetch, exchange, fetchConnectorHtml}
 * @returns {Promise<{choices:any[], warnings:string[], source:string, matrixSource:any, scope:{only:string[], currents:Object<string,string>}, repoLabel:string}>}
 */
export async function resolveVersionsForApp(opts = {}) {
  const { source, matrix, matrixSource, chain } = await buildAppChain(opts);
  const { only, currents } = appConnectorScope(chain, matrix);

  // Build the live enrichment sources unless offline. Only attach an ExchangeClient when Anypoint is
  // actually configured (else listVersions floods warnings); release-notes fetch needs no creds.
  const enrich = !opts.noFetch;
  let exchange = opts.exchange;
  if (exchange === undefined && enrich) {
    const anypoint = opts.anypointClient ?? new AnypointClient();
    exchange = anypoint.configured?.() ? new ExchangeClient({ anypoint }) : null;
  }
  const fetchHtml = opts.fetchConnectorHtml ?? (enrich ? fetchReleaseNotesCached : null);

  const { choices, warnings, source: rvSource } = await resolveVersions({
    matrix,
    only,
    currents,
    exchange,
    fetchHtml,
    noFetch: opts.noFetch,
  });
  return {
    choices,
    warnings,
    source: rvSource,
    matrixSource,
    scope: { only, currents },
    repoLabel: source.label,
  };
}

/**
 * Run the full assessment against a repository — a LOCAL clone or a GITHUB repo (no clone).
 * The source is chosen by opts.source ("local" | "github"), or inferred: repoUrl/owner ⇒ github,
 * else local. A pre-built opts.tree/opts.source object short-circuits source resolution (tests).
 *
 * LEAN BY DEFAULT (the Full Split): assess emits the network-free changePlan (fileEdits, topology,
 * connectorGaps, missingFromMatrix, connectorsInApp[]) + deployed-state + warnings. The rich connector
 * version MENU (connectorChoices[]) is OPT-IN via opts.includeVersions (or an active non-"min"
 * opts.versionStrategy, which start_upgrade uses); the gating matrixDrift advisory is opt-in via
 * opts.includeDrift. opts.noFetch forces lean (matrix-only, no live enrichment). Callers wanting the
 * menu should prefer resolve_versions; callers wanting drift should prefer check_drift.
 * @param {object} opts
 * @param {"local"|"github"} [opts.source] repo source ("local" clone | "github" API); else inferred
 * @param {string} [opts.repo] local clone root (source "local")
 * @param {string} [opts.repoUrl] github repo URL (source "github")
 * @param {string} [opts.owner] github owner (source "github")
 * @param {string} [opts.repoName] github repo name (source "github")
 * @param {string} [opts.branch] github branch (source "github")
 * @param {string} [opts.appPath] sub-directory of the app within the repo
 * @param {object} [opts.tree] pre-built tree object, short-circuits source resolution (tests)
 * @param {object} [opts.repoSource] injected repo-source reader (tests)
 * @param {boolean} [opts.includeVersions] compute the connector version MENU (connectorChoices[])
 * @param {boolean} [opts.includeDrift] compute the gating matrix-drift advisory (matrixDrift)
 * @param {string} [opts.jiraTicketId] optional Jira ticket reference, echoed back on the result
 * @param {boolean} [opts.noFetch] force lean/offline (matrix-only, no live Exchange/release-notes fetch)
 * @param {string|number} [opts.targetJava] Java target to assess against; omit for the default target.
 *   Selects the per-target compatibility matrix. Unknown/uncurated targets throw (never silently fall back).
 * @param {(url:string)=>Promise<string>} [opts.fetchDriftXml] injected Maven-metadata fetcher for the drift advisory (tests)
 * @param {string} [opts.appName] override the derived app name
 * @param {"min"|"first-compatible"|"in-major"|"latest"|"manual"} [opts.versionStrategy] pin strategy
 * @param {object|null} [opts.exchange] injected ExchangeClient (else built from anypointClient when enriching)
 * @param {object} [opts.anypointClient] injected AnypointClient (Exchange + ARM + API Manager)
 * @param {(url:string)=>Promise<string>} [opts.fetchConnectorHtml] injected release-notes HTML fetcher (tests)
 * @param {object} [opts.connectorSelections] per-connector explicit version picks for "manual" strategy
 * @param {string} [opts.headSha] repo HEAD at assess time (stale-plan anchor, echoed on the plan)
 * @param {string} [opts.strategy] pom edit strategy (default "appOverride")
 * @param {Array} [opts.excludeArtifacts] artifactIds to exclude from edits
 * @param {{groupId?:string, artifactId?:string, toVersion:string}} [opts.parentRef] chained flow: repoint
 *   the app's own <parent> at this version in the SAME app PR commit (adds a pomParentVersion edit shown
 *   in the preview) — only when the app's <parent> matches and its literal version differs
 * @param {string} [opts.environment] Anypoint environment name for deployed-state cross-checks
 * @param {string} [opts.anypointEnv] alias for opts.environment
 * @param {string} [opts.orgId] Anypoint org id for deployed-state cross-checks
 * @param {string} [opts.deployedApiName] verbatim deployed app name for the EPIC-C deployed-state check
 * @returns {Promise<{result:any, matrixSource:any, matrixWarnings:any, matrixDrift:any, connectorDrift:any, located:any, repoLabel:string, connectorChoices:any[], versionSelections:any[], deployedStateCheck:any}>}
 */
export async function assess(opts) {
  // Build the network-free repo → matrix → pom-chain prefix. buildAppChain() resolves the source
  // (honouring an injected opts.repoSource / opts.tree for tests), loads the matrix, locates the app
  // pom + mule-artifact + CI workflow, primes the source cache, and walks the inheritance chain — the
  // exact prefix resolveVersionsForApp() also uses, so the two paths can never drift apart.
  const { source, matrix, matrixSource, matrixWarnings, tree, located, chain, readFile, appPath } =
    await buildAppChain(opts);

  // The Full Split: the default assess is LEAN. The gating drift advisory (runtime patch,
  // mule-maven-plugin, MUnit plugins vs live Maven metadata) is opt-in via includeDrift (or the
  // standalone check_drift tool), NOT run on every assess. Non-fatal; degrades to "unknown".
  // Runs after buildAppChain and appends to the shared matrixWarnings array (order is irrelevant —
  // drift only adds advisory warnings, it never affects the chain or located files).
  const wantDrift = !opts.noFetch && opts.includeDrift === true;
  let matrixDrift = null;
  if (wantDrift) {
    try {
      matrixDrift = await checkMatrixDrift(matrix, { noFetch: opts.noFetch, fetchXml: opts.fetchDriftXml });
      if (matrixDrift?.warnings?.length) matrixWarnings.push(...matrixDrift.warnings);
    } catch {
      /* drift check is advisory-only; never fail assessment over it */
    }
  }

  const { topology } = classifyTopology(chain, located.allProps);

  const appPomText = chain[0].pomText;
  const flags = scanFlags(tree, appPomText, {
    manualReview: matrix.manualReview,
    readFile,
    // Scope the DataWeave / Mule-XML corpus to the app module so a monorepo doesn't drag in every
    // sibling's transformations (and their API-call cost) on a single-app assessment.
    appPath,
  });
  const muleArtifactCurrent = readMuleArtifact(readFile, located.muleArtifactPath);
  const ciWorkflowText = readFile(located.ciWorkflowPath);

  const appName = opts.appName ?? chain[0].pom?.project?.artifactId ?? deriveAppName(source, opts);

  // EPIC B — connector version CHOICES. For every matrix connector, offer the operator the curated
  // pin (recommended), the first Java-17-compatible version (from the release-notes OpenJDK table),
  // the latest-in-major, and the latest published (from Exchange). FULLY NON-FATAL and honours
  // noFetch: with no live sources every connector still yields a matrix-only choice. Surfaced on the
  // result as connectorChoices[] so the interactive agent can render a menu.
  let connectorChoices = [];
  const versionWarnings = [];
  // The Full Split: the rich version CHOICE menu (options[], firstCompatible/latestInMajor/latest,
  // staleness) is OPT-IN. It is computed only when the caller asks for it via includeVersions, OR when
  // a non-"min" versionStrategy is active (start_upgrade rewrites pins from these choices, so it needs
  // them regardless of the lean default). Otherwise assess stays lean — the per-app connectorsInApp[]
  // view in the changePlan is the network-free default; callers wanting the menu use resolve_versions.
  const wantVersions =
    opts.includeVersions === true || (opts.versionStrategy != null && opts.versionStrategy !== "min");
  // Shared ExchangeClient for the CHOICE menu (versions + release-notes) AND the B12/B13 connectorGap
  // enrichment below. Built once here so both paths reuse the same token/client. Hoisted to the
  // function scope (not the try) so gap enrichment can reuse it after the result is assembled.
  const enrich = wantVersions && !opts.noFetch;
  let exchange = opts.exchange;
  if (exchange === undefined && enrich) {
    const anypoint = opts.anypointClient ?? new AnypointClient();
    // Only attach an ExchangeClient when Anypoint is actually configured — otherwise every connector's
    // listVersions() returns "not configured" and floods versionWarnings. Release-notes fetch needs no
    // creds, so it's attached whenever enriching. Both remain fully overridable by injected opts.
    exchange = anypoint.configured?.() ? new ExchangeClient({ anypoint }) : null;
  }
  if (wantVersions) {
    try {
      // Wire the two live enrichment sources for REAL runs (previously only tests injected them, so the
      // version CHOICE menu was matrix-only for every CLI caller):
      //   • exchange.listVersions() → published versions (Exchange GraphQL) for latest / latest-in-major
      //   • fetchConnectorHtml       → the connector's release-notes compatibility table (firstJava17 + runtime)
      // An UNconfigured Anypoint yields listVersions ok:false (non-fatal) → matrix-only choices. noFetch
      // still yields matrix-only choices (needed so an offline versionStrategy can rewrite pins).
      const fetchHtml = opts.fetchConnectorHtml ?? (enrich ? fetchReleaseNotesCached : null);
      // Scope the menu to the connectors THIS app actually references and thread each one's current
      // (effective) version in — identical to the resolve_versions tool (resolveVersionsForApp).
      // Without this the menu spanned the WHOLE matrix and every choice.current was null: the app's
      // real "from" version was missing, and 12 connectors the app doesn't use were listed as noise.
      const { only, currents } = appConnectorScope(chain, matrix);
      const rv = await resolveVersions({
        matrix,
        only,
        currents,
        exchange,
        fetchHtml,
        noFetch: opts.noFetch,
      });
      connectorChoices = rv.choices;
      if (rv.warnings?.length) versionWarnings.push(...rv.warnings);
    } catch {
      /* version resolution is advisory; never fail assessment over it */
    }
  }

  // If the operator chose a versionStrategy (min|first-compatible|in-major|latest|manual), rewrite the matrix's
  // connector pins to the picked versions BEFORE producing the ChangePlan, so the emitted edits
  // target the chosen versions. Default (no strategy / "min") keeps the curated pins untouched.
  let effectiveMatrix = matrix;
  let versionSelections = [];
  if (opts.versionStrategy && opts.versionStrategy !== "min" && connectorChoices.length) {
    const { matrix: m2, applied } = applyVersionStrategy({
      matrix,
      choices: connectorChoices,
      strategy: opts.versionStrategy,
      selections: opts.connectorSelections ?? {},
    });
    effectiveMatrix = m2;
    versionSelections = applied;
    for (const a of applied) {
      versionWarnings.push(
        `Connector ${a.artifactId} pinned to ${a.to} (was matrix ${a.from}) via versionStrategy="${a.strategy}".`
      );
    }
  }

  const result = buildAssessmentResult({
    matrix: effectiveMatrix,
    chain,
    appPomText,
    muleArtifactCurrent,
    muleArtifactPath: located.muleArtifactPath,
    ciWorkflowText,
    ciWorkflowPath: located.ciWorkflowPath,
    appName,
    topology,
    headSha: opts.headSha ?? null,
    hasApiPolicies: flags.hasApiPolicies,
    customJavaFound: flags.customJavaFound,
    lookupFound: flags.lookupFound,
    warnings: [...flags.warnings, ...matrixWarnings, ...versionWarnings],
    // Process-Guide baseline inputs: the manualReview keys the content scan actually matched (stable
    // ids, not prose) and a reader for the Maven-wrapper toolchain floor.
    matchedReviews: flags.matchedReviews,
    readFile,
    pomEditStrategy: opts.strategy ?? "appOverride",
    excludeArtifacts: opts.excludeArtifacts ?? [],
    // Chained flow: repoint the app's own <parent> at a freshly-released parent-pom/BOM version in the
    // SAME (first) app PR commit, and surface it in the dry-run preview.
    parentRef: opts.parentRef ?? null,
  });

  // Carry an optional Jira ticket reference through the assessment so a downstream start_upgrade /
  // PR body can cite it (mirrors the Mule assess_app accepting jiraTicketId). Assessment itself is
  // read-only; this is purely an annotation echoed back on the result.
  if (opts.jiraTicketId != null) result.jiraTicketId = opts.jiraTicketId;

  // Batch A — live Anypoint cross-checks (env-gated, non-fatal). Enriches the source-only result
  // with the REAL deployed runtime (ARM) and REAL applied API policies (API Manager) when enabled.
  const batchA = await batchACrossChecks({
    appName,
    environment: opts.environment ?? opts.anypointEnv,
    orgId: opts.orgId,
    result,
    client: opts.anypointClient,
  });
  if (batchA.hasApiPolicies !== undefined) result.changePlan.hasApiPolicies = batchA.hasApiPolicies;
  if (batchA.deployedState) result.deployedState = batchA.deployedState;
  if (batchA.warnings.length) result.warnings = [...result.warnings, ...batchA.warnings];

  // EPIC C — explicit VERBATIM deployed-state check. The operator supplies the exact deployed app
  // name (opts.deployedApiName); we look it up in ARM for the given environment and ALWAYS report the
  // outcome on result.deployedStateCheck — including a human reason when it was skipped (no name /
  // not configured / name-not-found). Non-fatal; found state also populates result.deployedState.
  const deployedCheck = await checkDeployedState({
    deployedApiName: opts.deployedApiName,
    environment: opts.environment ?? opts.anypointEnv,
    orgId: opts.orgId,
    client: opts.anypointClient,
  });
  result.deployedStateCheck = deployedCheck;
  if (deployedCheck.checked && deployedCheck.deployedState) {
    result.deployedState = deployedCheck.deployedState; // verbatim lookup wins over the Batch-A auto-match
  } else if (deployedCheck.reason) {
    result.warnings = [...result.warnings, deployedCheck.reason];
  }

  // B12/B13 — enrich each connectorGap with its target version's one-level (direct) Graph
  // dependencies and its POM version-management shape (literal / ${property} / BOM-managed). Advisory
  // and non-fatal: with no configured Exchange the gaps are returned unenriched (live fields null).
  if (result.changePlan?.connectorGaps?.length && exchange?.configured?.()) {
    try {
      const { gaps: enrichedGaps, warnings: gapWarnings } = await enrichConnectorGaps({
        gaps: result.changePlan.connectorGaps,
        exchange,
      });
      result.changePlan.connectorGaps = enrichedGaps;
      if (gapWarnings.length) result.warnings = [...result.warnings, ...gapWarnings];
    } catch {
      /* connector-gap enrichment is advisory; never fail assessment over it */
    }
  }

  // G5 — ADVISORY connector drift: reduce the CHOICE menu (which already carries latest-in-major from
  // Exchange) into a per-connector "matrix trails the published X.x line" report. Pure, no extra
  // network. NEVER writes the matrix; the curated pin stays the Java-17-safe floor. Surfaced on the
  // result + folded into warnings so the operator sees it in the summary.
  let connectorDrift = null;
  if (wantVersions && connectorChoices.length) {
    try {
      connectorDrift = checkConnectorDrift({ matrix: effectiveMatrix, choices: connectorChoices });
      // resolveVersions already bubbles per-connector staleness into versionWarnings, so we do NOT
      // duplicate connectorDrift.warnings into result.warnings — we only attach the structured report.
    } catch {
      /* connector drift is advisory; never fail assessment over it */
    }
  }
  if (connectorDrift) result.connectorDrift = connectorDrift;

  // Surface the connector CHOICE menu + any applied strategy selections on the result so the
  // interactive agent (and the REST/MCP caller) can render them — only when versions were requested.
  // Lean default: connectorChoices/connectorDrift are absent; callers use resolve_versions instead.
  if (wantVersions) result.connectorChoices = connectorChoices;
  if (versionSelections.length) result.versionSelections = versionSelections;

  return {
    result,
    matrixSource,
    matrixWarnings,
    // Lean default: matrixDrift/connectorDrift/connectorChoices are null/[] unless opted in via
    // includeDrift / includeVersions (or an active versionStrategy). versionSelections is populated
    // only when a strategy actually rewrote a pin.
    matrixDrift,
    connectorDrift,
    located,
    repoLabel: source.label,
    connectorChoices,
    versionSelections,
    deployedStateCheck: deployedCheck,
  };
}

/** Fallback app name when neither --app-name nor the pom artifactId is available. */
function deriveAppName(source, opts) {
  if (source?.kind === "local" && opts.repo) return path.basename(path.resolve(opts.repo));
  // github label is "github:owner/repo@ref" → use "repo".
  const m = /github:[^/]+\/([^@]+)/.exec(source?.label ?? "");
  return m ? m[1] : "app";
}

// ── summary ───────────────────────────────────────────────────────────────────────────
function summarize(result, matrixSource) {
  const cp = result.changePlan;
  const lines = [];
  lines.push(`App: ${result.appName}`);
  lines.push(`Current runtime: ${result.currentRuntime}   Java: ${result.currentJavaVersion}`);
  lines.push(`Target: runtime ${cp.targetRuntime} / Java ${cp.targetJavaVersion}   Topology: ${cp.topology}`);
  lines.push(`Matrix source: ${matrixSource}`);
  lines.push(`File edits: ${cp.fileEdits.length} across ${cp.filesToChange.length} file(s)`);
  for (const e of cp.fileEdits) {
    const coord = e.artifactId || e.pluginArtifactId || e.property || "";
    const from = e.from == null ? "∅" : typeof e.from === "string" ? e.from : JSON.stringify(e.from);
    lines.push(`  · [${e.kind}] ${e.file} ${coord ? `(${coord}) ` : ""}${from} -> ${JSON.stringify(e.to)}`);
  }
  if (cp.connectorGaps.length) lines.push(`Connector gaps: ${cp.connectorGaps.length}`);
  if (cp.missingFromMatrix.length) lines.push(`Missing from matrix: ${cp.missingFromMatrix.length}`);
  // EPIC C — always report the deployed-state check outcome (found details, or WHY it was skipped).
  const dsc = result.deployedStateCheck;
  if (dsc?.checked && dsc.deployedState) {
    const d = dsc.deployedState;
    lines.push(
      `Deployed (${d.environment}): ${d.name} — runtime ${d.runtimeVersion ?? "?"} / Java ${d.javaVersion ?? "?"}, ` +
        `status ${d.status}${d.replicas != null ? `, ${d.replicas} replica(s)` : ""}` +
        `${d.lastDeploy ? `, last deploy ${d.lastDeploy}` : ""}`
    );
    if (dsc.note) lines.push(`  (${dsc.note})`);
  } else if (dsc?.reason) {
    lines.push(`Deployed-state check: not done — ${dsc.reason}`);
  }
  if (result.warnings.length) {
    lines.push("Warnings:");
    for (const w of result.warnings) lines.push(`  ! ${w}`);
  }
  return lines.join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      a[k] = v;
    }
  }
  return a;
}

const isMain = process.argv[1] && process.argv[1].endsWith("assess.js");
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const str = (k) => (typeof args[k] === "string" ? args[k] : undefined);
  const wantsGithub = str("source") === "github" || str("repo-url") || str("owner");
  const haveTarget = args.repo || wantsGithub;
  if (!haveTarget) {
    console.error(
      "Usage (local):  node assess.js --repo <clone-dir> --env <dev|local|prod> [--app-path sub/dir] [--app-name x]\n" +
        "Usage (github): node assess.js --source github --repo-url <github url> --env <...>\n" +
        "                node assess.js --source github --owner <o> --repo-name <r> [--branch b] [--app-path sub/dir] --env <...>\n" +
        "  common: [--head-sha sha] [--no-fetch] [--strategy appOverride|inPlace] [--out plan.json]\n" +
        "  java target: [--target-java 17|21]  which compatibility matrix to judge against (default: the\n" +
        "                     default target). An uncurated target is refused, never silently downgraded.\n" +
        "  versions (opt-in): [--versions] adds the connector version MENU (connectorChoices[]); default is LEAN\n" +
        "                     (changePlan.connectorsInApp[] only). --no-fetch implies lean. Prefer resolve_versions.\n" +
        "  drift (opt-in):    [--drift] adds the matrix-drift advisory (matrixDrift). Prefer check_drift.\n" +
        "  output: [--quiet | --format json]  JSON only, no human summary (use this for LLM/agent callers)\n" +
        "  deployed-state (EPIC C): [--deployed-api-name <exact ARM app name>] [--env-name <Anypoint env>]  (needs Anypoint creds)\n" +
        "  --env is REQUIRED (or set MULE_UPGRADE_ENV) — no default, mirrors Mule's -Denv\n" +
        "  github mode reads via the GitHub REST API with NO local clone (needs GITHUB_TOKEN for private repos)"
    );
    process.exit(2);
  }
  try {
    requireEnv(args.env); // mandatory: --env or MULE_UPGRADE_ENV, no default. Pins it for this run.
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  assess({
    source: /** @type {"local"|"github"} */ (str("source") ?? (wantsGithub ? "github" : "local")),
    repo: str("repo"),
    repoUrl: str("repo-url"),
    owner: str("owner"),
    repoName: str("repo-name"),
    branch: str("branch"),
    appPath: str("app-path"),
    appName: str("app-name"),
    headSha: str("head-sha"),
    noFetch: !!args["no-fetch"],
    targetJava: str("target-java"),
    strategy: str("strategy"),
    includeVersions: !!args.versions,
    includeDrift: !!args.drift,
    environment: str("env-name") ?? str("anypoint-env"),
    deployedApiName: str("deployed-api-name"),
    // Chained flow preview: show the app's <parent> repoint in the plan (pomParentVersion edit).
    parentRef: str("parent-ref-version")
      ? {
          groupId: str("parent-ref-group") || undefined,
          artifactId: str("parent-ref-artifact") || undefined,
          toVersion: str("parent-ref-version"),
        }
      : undefined,
  })
    .then(({ result, matrixSource }) => {
      const json = JSON.stringify(result, null, 2);
      // --quiet / --format json → JSON only, no human summary. This is what an LLM-driven agent
      // (Vibes) should use: it consumes the JSON and writes its OWN prose, so the pre-baked
      // summarize() block is redundant and would otherwise be echoed as a duplicate warning list.
      // Terminal users get the summary by default (omit the flag).
      const quiet = args.quiet === true || String(args.format).toLowerCase() === "json";
      if (typeof args.out === "string") {
        fs.writeFileSync(args.out, json);
        console.error(`Wrote ${args.out}`);
      } else {
        process.stdout.write(json + "\n");
      }
      if (!quiet) console.error("\n" + summarize(result, matrixSource));
    })
    .catch((err) => {
      console.error(`ASSESS ERROR: ${err?.message ?? err}`);
      process.exit(1);
    });
}
