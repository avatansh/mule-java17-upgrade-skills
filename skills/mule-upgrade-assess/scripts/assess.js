// assess.js — SKILL 1 driver: assess a MuleSoft app for the Java-17 upgrade.
//
// Faithful port of the Mule app's assess pipeline: build a recursive tree of the local clone,
// locate the app pom / mule-artifact.json / CI workflow (treeAnalysis), walk the pom inheritance
// chain (pomChain), resolve the compatibility matrix (bundled gating + dynamic connectors with
// disk cache + YAML fallback), and produce an AssessmentResult whose changePlan.fileEdits[] is
// directly consumable by mule-upgrade-apply.
//
// Usage:
//   node assess.js --repo /path/to/clone [--app-path sub/dir] [--app-name my-app]
//                  [--head-sha <sha>] [--release-notes-url <url>] [--no-fetch]
//                  [--strategy appOverride|inPlace] [--out plan.json]
//
// Prints the AssessmentResult JSON to stdout (and writes it to --out when given), plus a
// human-readable summary to stderr.

import fs from "node:fs";
import path from "node:path";
import { analyzeTree, classifyTopology } from "./lib/topology.js";
import { initChain, appendParent } from "./lib/pom_chain.js";
import { resolveMatrix } from "./lib/matrix_fetch.js";
import { checkMatrixDrift } from "./lib/matrix_drift.js";
import { buildAssessmentResult, scanFlags } from "./lib/assess_engine.js";
import { get } from "../../../lib_shared/config.js";
import { AnypointClient } from "../../mule-upgrade/scripts/lib/anypoint.js";

// ── local-clone tree (mirrors the GitHub recursive tree shape) ────────────────────────
const IGNORE_DIRS = new Set([".git", "node_modules", "target", ".idea", ".vscode"]);

/** Build a { tree:[{path,type}], truncated:false } object from a local directory. */
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

/** Read a repo-relative file as UTF-8, or null if missing. */
function readRel(repoRoot, rel) {
  if (!rel) return null;
  try {
    return fs.readFileSync(path.join(repoRoot, rel), "utf8");
  } catch {
    return null;
  }
}

/**
 * Walk the pom inheritance chain from the app pom up to the outermost in-repo parent.
 * @returns {Array<{path,pom,pomText}>}
 */
export function buildChain(repoRoot, appPomPath, treePaths) {
  const appText = readRel(repoRoot, appPomPath);
  if (appText == null) throw new Error(`app pom not found at ${appPomPath}`);
  let state = initChain(appText, appPomPath, treePaths);
  const guard = new Set([appPomPath]);
  while (state.nextParentPath && !guard.has(state.nextParentPath)) {
    const p = state.nextParentPath;
    guard.add(p);
    const parentText = readRel(repoRoot, p);
    if (parentText == null) break;
    state = appendParent(parentText, p, state.chain, treePaths);
  }
  return state.chain;
}

/** Parse mule-artifact.json (returns null when absent/invalid). */
function readMuleArtifact(repoRoot, maPath) {
  const text = readRel(repoRoot, maPath);
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
 */
export async function batchACrossChecks({ appName, environment, orgId, result, client } = {}) {
  const armOn = String(cfg("assess.armCrossCheck", "false")) === "true";
  const apiOn = String(cfg("assess.apiPolicyCheck", "false")) === "true";
  const out = { warnings: [] };
  if (!armOn && !apiOn) return out;

  const anypoint =
    client ?? new AnypointClient(orgId ? { orgId } : {});
  if (!anypoint.configured()) return out; // creds absent → silently source-only

  const env = environment || "Development";
  if (armOn) {
    try {
      const d = await anypoint.readDeployment({ app: appName, env });
      out.deployedState = d;
      const targetRuntime = result?.changePlan?.targetRuntime;
      if (d.found && d.runtimeVersion && targetRuntime) {
        const deployedBase = String(d.runtimeVersion).split(":")[0]; // "4.6.0:..." → "4.6.0"
        if (deployedBase && !String(targetRuntime).startsWith(deployedBase) && deployedBase !== targetRuntime) {
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
 * Run the full assessment against a local clone.
 * @param {object} opts
 * @returns {Promise<{result, matrixSource, matrixWarnings}>}
 */
export async function assess(opts) {
  const repoRoot = opts.repo;
  const appPath = opts.appPath ?? ".";

  const { matrix, source: matrixSource, warnings: matrixWarnings } = await resolveMatrix({
    releaseNotesUrl: opts.releaseNotesUrl,
    noFetch: opts.noFetch,
    fetchHtml: opts.fetchHtml,
  });

  // Advisory: compare the STATIC gating pins (runtime patch, mule-maven-plugin, MUnit plugins)
  // against live Maven metadata and surface drift as warnings. This never changes the matrix or
  // auto-applies a version — it just tells the operator the bundled YAML is trailing. Non-fatal;
  // honours noFetch and the matrix.driftCheck config flag. Failures degrade to "unknown" silently.
  let matrixDrift = null;
  try {
    matrixDrift = await checkMatrixDrift(matrix, { noFetch: opts.noFetch, fetchXml: opts.fetchDriftXml });
    if (matrixDrift?.warnings?.length) matrixWarnings.push(...matrixDrift.warnings);
  } catch {
    /* drift check is advisory-only; never fail assessment over it */
  }

  const tree = opts.tree ?? buildLocalTree(repoRoot);
  const treePaths = tree.tree.map((t) => t.path);

  const located = analyzeTree(tree, appPath, matrix.gating, matrix.connectors);
  if (!located.appPomPath) throw new Error("app pom not found in repository tree");

  const chain = buildChain(repoRoot, located.appPomPath, treePaths);
  const { topology } = classifyTopology(chain, located.allProps);

  const appPomText = chain[0].pomText;
  const flags = scanFlags(tree, appPomText);
  const muleArtifactCurrent = readMuleArtifact(repoRoot, located.muleArtifactPath);
  const ciWorkflowText = readRel(repoRoot, located.ciWorkflowPath);

  const appName =
    opts.appName ?? chain[0].pom?.project?.artifactId ?? path.basename(path.resolve(repoRoot));

  const result = buildAssessmentResult({
    matrix,
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
    warnings: [...flags.warnings, ...matrixWarnings],
    pomEditStrategy: opts.strategy ?? "appOverride",
    excludeArtifacts: opts.excludeArtifacts ?? [],
  });

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

  return { result, matrixSource, matrixWarnings, matrixDrift, located };
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
  if (!args.repo) {
    console.error(
      "Usage: node assess.js --repo <clone-dir> [--app-path sub/dir] [--app-name x] " +
        "[--head-sha sha] [--release-notes-url url] [--no-fetch] [--strategy appOverride|inPlace] [--out plan.json]"
    );
    process.exit(2);
  }
  assess({
    repo: args.repo,
    appPath: typeof args["app-path"] === "string" ? args["app-path"] : undefined,
    appName: typeof args["app-name"] === "string" ? args["app-name"] : undefined,
    headSha: typeof args["head-sha"] === "string" ? args["head-sha"] : undefined,
    releaseNotesUrl: typeof args["release-notes-url"] === "string" ? args["release-notes-url"] : undefined,
    noFetch: !!args["no-fetch"],
    strategy: typeof args.strategy === "string" ? args.strategy : undefined,
  })
    .then(({ result, matrixSource }) => {
      const json = JSON.stringify(result, null, 2);
      if (typeof args.out === "string") {
        fs.writeFileSync(args.out, json);
        console.error(`Wrote ${args.out}`);
      } else {
        process.stdout.write(json + "\n");
      }
      console.error("\n" + summarize(result, matrixSource));
    })
    .catch((err) => {
      console.error(`ASSESS ERROR: ${err?.message ?? err}`);
      process.exit(1);
    });
}
