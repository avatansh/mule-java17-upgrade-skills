// apply_edits.js — port of dwl::applyEdits.
// Applies a file's approved edit list to its raw text, running each rewrite module in the same
// fixed order used by the Mule app:
//   depVersion -> pluginVersion -> pomProperty -> munitRuntimeVersion -> muleArtifactJson
//   -> ciWorkflow -> munitArgLines -> pomVersion
//
// Also usable as a CLI:
//   node apply_edits.js --change-plan plan.json --repo /path/to/clone [--write]
// which groups fileEdits by file, applies them, and writes (or prints staged blobs as JSON).

import fs from "node:fs";
import path from "node:path";
import { rewritePomProperties } from "./rewrites/pom_properties.js";
import { rewriteDepVersions } from "./rewrites/dep_versions.js";
import { rewritePluginVersions } from "./rewrites/plugin_versions.js";
import { rewriteMunitRuntime } from "./rewrites/munit_runtime.js";
import { rewriteMuleArtifact } from "./rewrites/mule_artifact.js";
import { rewriteCiWorkflow } from "./rewrites/ci_workflow.js";
import { rewriteMunitArgLines } from "./rewrites/munit_arglines.js";
import { rewritePomVersion } from "./rewrites/pom_version.js";
import { rewriteParentRefVersion } from "./rewrites/parent_pom.js";

/**
 * Apply one file's edit list to its raw text.
 * @param {string} rawText the file's current text
 * @param {Array<object>} edits edit objects (mixed kinds) for THIS file
 * @returns {string} rewritten text
 */
export function applyEdits(rawText, edits) {
  let text = rawText ?? "";

  const depEdits = edits.filter((e) => e.kind === "depVersion");
  if (depEdits.length) text = rewriteDepVersions(text, depEdits);

  const plgEdits = edits.filter((e) => e.kind === "pluginVersion");
  if (plgEdits.length) text = rewritePluginVersions(text, plgEdits);

  const propEdits = edits.filter((e) => e.kind === "pomProperty");
  if (propEdits.length) text = rewritePomProperties(text, propEdits);

  const munitEdit = edits.find((e) => e.kind === "munitRuntimeVersion");
  if (munitEdit) text = rewriteMunitRuntime(text, String(munitEdit.to));

  const maEdit = edits.find((e) => e.kind === "muleArtifactJson");
  if (maEdit) {
    text = rewriteMuleArtifact(text, String(maEdit.to.minMuleVersion), maEdit.to.javaSpecificationVersions);
  }

  const ciEdit = edits.find((e) => e.kind === "ciWorkflow");
  if (ciEdit) text = rewriteCiWorkflow(text, String(ciEdit.to));

  const argEdit = edits.find((e) => e.kind === "munitArgLines");
  if (argEdit) text = rewriteMunitArgLines(text, argEdit.flags);

  const verEdit = edits.find((e) => e.kind === "pomVersion");
  if (verEdit) text = rewritePomVersion(text, String(verEdit.artifactId ?? ""), String(verEdit.to ?? ""));

  // pomParentVersion: repoint the app's own <parent> block at a new parent-pom/BOM version. Used by the
  // chained flow so the app PR's FIRST commit already points at the freshly-released parent — no second
  // amend commit. Targets ONLY the <parent> block (rewritePomVersion above targets the project's own
  // <version> outside <parent>), so the two never collide regardless of order.
  const parentRefEdit = edits.find((e) => e.kind === "pomParentVersion");
  if (parentRefEdit && parentRefEdit.to != null) {
    text = rewriteParentRefVersion(
      text,
      { groupId: parentRefEdit.groupId, artifactId: parentRefEdit.artifactId },
      String(parentRefEdit.to)
    );
  }

  return text;
}

/**
 * Group a flat fileEdits[] list by file path.
 * @param {Array<{file:string}>} fileEdits
 * @returns {Map<string, Array>}
 */
export function groupByFile(fileEdits) {
  const map = new Map();
  for (const e of fileEdits ?? []) {
    if (!e.file) continue;
    if (!map.has(e.file)) map.set(e.file, []);
    map.get(e.file).push(e);
  }
  return map;
}

/**
 * Apply a whole ChangePlan; returns staged files [{path, content}].
 *
 * The `readFile` reader may be SYNC (local clone: default fs reader) or ASYNC (api mode: a GitHub
 * Contents reader) — the result is awaited either way, so a caller with no local clone (opts.repoRoot
 * === undefined) MUST supply a reader. Without one, the default fs reader runs path.join(undefined, p)
 * and throws 'The "path" argument must be of type string. Received undefined' — the api-mode commit
 * failure this guards against.
 *
 * @param {object} changePlan  the ChangePlan (must carry fileEdits[])
 * @param {string} [repoRoot]  local clone root (required only when no readFile is given)
 * @param {(p:string)=>(string|Promise<string>)} [readFile]  reader (defaults to local fs)
 * @returns {Promise<Array<{path:string, content:string}>>}
 */
export async function applyChangePlan(changePlan, repoRoot, readFile) {
  const read = readFile || ((p) => fs.readFileSync(path.join(repoRoot, p), "utf8"));
  const grouped = groupByFile(changePlan.fileEdits);
  const staged = [];
  for (const [file, edits] of grouped) {
    const before = await read(file);
    const after = applyEdits(before, edits);
    staged.push({ path: file, content: after });
  }
  return staged;
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────
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

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("apply_edits.js")) {
  const args = parseArgs(process.argv.slice(2));
  if (args["change-plan"] && args.repo) {
    const plan = JSON.parse(fs.readFileSync(args["change-plan"], "utf8"));
    const changePlan = plan.changePlan ?? plan; // accept full AssessmentResult or bare ChangePlan
    const staged = await applyChangePlan(changePlan, args.repo);
    if (args.write) {
      for (const f of staged) {
        fs.writeFileSync(path.join(args.repo, f.path), f.content);
        console.error(`wrote ${f.path}`);
      }
      console.error(`Applied ${staged.length} file(s).`);
    } else {
      process.stdout.write(JSON.stringify(staged, null, 2));
    }
  } else {
    console.error("Usage: node apply_edits.js --change-plan <plan.json> --repo <clone-dir> [--write]");
    process.exit(2);
  }
}
