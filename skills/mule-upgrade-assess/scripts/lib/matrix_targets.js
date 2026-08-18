// lib/matrix_targets.js — the registry behind "one compatibility matrix file per Java target".
//
// LAYOUT (see references/MATRIX.md for the full rationale):
//   references/compatibility-matrix.yaml          the DEFAULT target, whatever Java it targets
//   references/compatibility-matrix-java<N>.yaml  every other target
//
// `compatibility-matrix.yaml` being the default is an invariant worth keeping: when Java 17 is
// retired the Java 21 content moves into that filename and the old file is deleted — no code, no
// config, no caller changes. Discovery is a glob, so adding Java 25 is a file drop.
//
// WHY SEPARATE FILES AND NOT ONE FILE WITH OVERLAYS: the Java-dependent and Java-neutral fields are
// interleaved at FIELD level (a connector is {property, groupId, artifactId, set} and only `set`
// moves), so there is no clean seam to overlay on — it would mean re-keying `connectors` from a list
// to a map plus merge-precedence rules, in the one artifact whose whole job is to be read
// top-to-bottom as the authoritative safety judgment. The cost is duplicated identity fields, and
// that cost is paid mechanically rather than by discipline: `identityOf` + the parity test make
// drift a loud test failure, and `scaffoldTarget` generates new files so identity is never
// hand-copied.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { javaMajor } from "../../../../lib_shared/java_version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The folder holding every matrix file. */
export function referencesDir() {
  return path.resolve(__dirname, "..", "..", "references");
}

/** The default target's filename — always this, regardless of which Java it currently targets. */
export const DEFAULT_MATRIX_FILE = "compatibility-matrix.yaml";

/** Filename convention for a non-default target. */
export function targetFileName(major) {
  return `compatibility-matrix-java${javaMajor(major)}.yaml`;
}

/** Parse a matrix file; returns null when it is missing or unparseable (callers decide severity). */
function loadFile(file) {
  try {
    return yaml.load(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * A target is CURATED unless it says otherwise. A scaffolded file carries `status: uncurated`
 * until a human has filled in the version-bearing fields; the engine refuses to run against it
 * rather than emitting a plan built from a different Java version's floors.
 */
export function isCurated(matrix) {
  return String(matrix?.status ?? "curated").toLowerCase() !== "uncurated";
}

// The registry is on the hot path: bundledMatrixPath() resolves through it on every
// loadBundledMatrix() call, and re-globbing plus re-parsing every target file each time would undo
// the memoization that lives one layer up in matrix.js. Cache it, and let _resetTargetCache() (which
// matrix.js's _resetMatrixCache calls) drop it after a write — a matrix_update run can add a file or
// clear a `status: uncurated` flag, and a long-lived process has to see that.
/** @type {ReturnType<typeof scanTargets>|null} */
let _cachedTargets = null;

/** Drop the memoized target registry so the next listTargets() re-scans the folder. */
export function _resetTargetCache() {
  _cachedTargets = null;
}

/**
 * Every matrix file present, oldest-Java first. This is the single source for both loading and for
 * the assistant's "which Java do you want?" menu, so the menu can never offer a target the engine
 * cannot honour.
 * @returns {Array<{javaVersion:string, major:number, file:string, isDefault:boolean, curated:boolean, runtime:string|undefined}>}
 */
export function listTargets() {
  if (_cachedTargets === null) _cachedTargets = scanTargets();
  return _cachedTargets;
}

function scanTargets() {
  const dir = referencesDir();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^compatibility-matrix.*\.ya?ml$/i.test(n));
  } catch {
    return [];
  }

  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const m = loadFile(file);
    const jv = m?.target?.javaVersion;
    if (jv == null) continue; // not a target file (or corrupt) — skip rather than fail the run
    out.push({
      javaVersion: String(jv),
      major: javaMajor(jv),
      file,
      isDefault: name === DEFAULT_MATRIX_FILE,
      curated: isCurated(m),
      runtime: m?.target?.runtime,
    });
  }
  return out.sort((a, b) => a.major - b.major);
}

/** The default target's descriptor (whatever Java compatibility-matrix.yaml currently targets). */
export function defaultTarget() {
  return listTargets().find((t) => t.isDefault) ?? null;
}

/**
 * Resolve a requested Java target to a matrix file.
 *
 * Passing null/undefined means "the default", which keeps every existing caller on exactly today's
 * behaviour. A requested target that exists but is uncurated is REFUSED here rather than silently
 * downgraded to the default — quietly assessing against Java 17 floors while the user believes they
 * asked for Java 21 is the single worst failure this module could have.
 *
 * @param {string|number|null} [target]
 * @returns {{file:string, target:object}}
 */
export function resolveTargetFile(target) {
  const targets = listTargets();
  if (targets.length === 0) {
    throw new Error(`No compatibility matrix found in ${referencesDir()}`);
  }

  if (target == null || target === "") {
    const def = targets.find((t) => t.isDefault) ?? targets[0];
    return { file: def.file, target: def };
  }

  const want = javaMajor(target);
  if (!Number.isFinite(want)) {
    throw new Error(`Unrecognised Java target "${target}".`);
  }

  const hit = targets.find((t) => t.major === want);
  if (!hit) {
    const have = targets.map((t) => t.major).join(", ");
    throw new Error(
      `No compatibility matrix for Java ${want}. Available: ${have}. ` +
        `Add one with "matrix scaffold ${want}", then curate it (see references/MATRIX.md).`
    );
  }
  if (!hit.curated) {
    throw new Error(
      `The Java ${want} compatibility matrix exists but is not curated yet ` +
        `(${path.basename(hit.file)} is marked status: uncurated). Its connector pins and tool ` +
        `floors are placeholders, so any plan built from it would be fabricated. ` +
        `Curate it against the release notes and drop the status flag — see references/MATRIX.md.`
    );
  }
  return { file: hit.file, target: hit };
}

// ── parity: the guard that makes duplicated identity fields safe ────────────────────────────────

/**
 * The Java-NEUTRAL fingerprint of a matrix: the fields that identify *what* a rule points at, as
 * opposed to *which version* is safe. These must be identical in every target file — a connector's
 * Maven property and coordinates do not change because you moved to a newer JDK. Add a connector to
 * one file and forget the other and this fingerprint diverges, which the parity test turns into a
 * named failure instead of a silently incomplete upgrade plan.
 */
export function identityOf(matrix) {
  const connectors = (matrix?.connectors ?? [])
    .map((c) => `${c?.property ?? ""}|${c?.groupId ?? ""}|${c?.artifactId ?? ""}`)
    .sort();

  const gating = Object.entries(matrix?.gating ?? {})
    .map(([key, r]) =>
      [
        key,
        r?.property ?? "",
        r?.groupId ?? "",
        r?.artifactId ?? "",
        r?.pluginGroupId ?? "",
        r?.pluginArtifactId ?? "",
        r?.compare ?? "",
      ].join("|")
    )
    .sort();

  const manualReview = Object.entries(matrix?.manualReview ?? {})
    .map(([key, r]) => [key, r?.scanRegex ?? "", (r?.scanGlobs ?? []).join(","), r?.source ?? ""].join("|"))
    .sort();

  return { connectors, gating, manualReview };
}

/**
 * Compare the identity fingerprints of two matrices. Returns a per-section list of what only one
 * side has, which is what the parity test prints so the fix is obvious without diffing by eye.
 * @returns {{section:string, onlyInA:string[], onlyInB:string[]}[]}
 */
export function identityDrift(a, b) {
  const fa = identityOf(a);
  const fb = identityOf(b);
  const out = [];
  for (const section of /** @type {const} */ (["connectors", "gating", "manualReview"])) {
    const sa = new Set(fa[section]);
    const sb = new Set(fb[section]);
    const onlyInA = fa[section].filter((x) => !sb.has(x));
    const onlyInB = fb[section].filter((x) => !sa.has(x));
    if (onlyInA.length || onlyInB.length) out.push({ section, onlyInA, onlyInB });
  }
  return out;
}

// ── diff: what actually differs between two targets ─────────────────────────────────────────────

/**
 * The version-level delta between two targets. This is the one thing an overlay layout would have
 * given for free, recovered on demand so the layout does not have to pay merge semantics for it.
 * @returns {{key:string, a:string|undefined, b:string|undefined}[]}
 */
export function versionDelta(a, b) {
  /** @param {any} m */
  const flat = (m) => {
    /** @type {Record<string,string|undefined>} */
    const f = {};
    f["target.runtime"] = m?.target?.runtime;
    f["target.javaVersion"] = m?.target?.javaVersion;
    f["muleArtifact.minMuleVersion"] = m?.muleArtifact?.minMuleVersion;
    f["muleArtifact.javaSpecificationVersions"] = (m?.muleArtifact?.javaSpecificationVersions ?? []).join(
      ","
    );
    for (const [k, r] of Object.entries(m?.gating ?? {})) {
      const rule = /** @type {any} */ (r);
      if (rule?.min !== undefined) f[`gating.${k}.min`] = String(rule.min);
      if (rule?.set !== undefined) f[`gating.${k}.set`] = String(rule.set);
    }
    for (const c of m?.connectors ?? []) {
      if (c?.property) f[`connectors.${c.property}`] = c?.set === undefined ? undefined : String(c.set);
    }
    return f;
  };

  const fa = flat(a);
  const fb = flat(b);
  const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort();
  return keys.filter((k) => fa[k] !== fb[k]).map((k) => ({ key: k, a: fa[k], b: fb[k] }));
}

// ── scaffolding: generate a new target so identity is never hand-copied ─────────────────────────

/** Placeholder written into every version-bearing field of a scaffolded target. */
export const SCAFFOLD_PLACEHOLDER = "TODO";

/**
 * Build a new target file from an existing one by TEXT transformation rather than parse-and-dump.
 *
 * js-yaml's dump() would discard every comment and collapse the inline flow style, and those
 * comments are the curator's working notes ("MUnit 3.6.3+ is REQUIRED on Mule 4.9 / Java 17 …") —
 * losing them would gut the readability that motivated per-target files. So we rewrite values in
 * place: identity fields are copied byte-for-byte by construction, version fields are blanked, and
 * the result is parsed at the end to prove it is still valid YAML.
 *
 * @param {string} sourceText  raw YAML of the target to scaffold from
 * @param {string|number} toMajor  the new Java major
 * @returns {string} the new file's YAML text
 */
export function scaffoldTarget(sourceText, toMajor) {
  const major = javaMajor(toMajor);
  const q = SCAFFOLD_PLACEHOLDER;

  let text = sourceText;

  // Blank every version-bearing scalar. These patterns are anchored on the `key: "value"` shape the
  // matrix uses throughout, so prose inside comments is untouched.
  text = text.replace(/(\bset:\s*)"[^"]*"/g, `$1"${q}"`);
  text = text.replace(/(\bmin:\s*)"[^"]*"/g, `$1"${q}"`);
  text = text.replace(/(\bminMuleVersion:\s*)"[^"]*"/g, `$1"${q}"`);
  text = text.replace(/(\bruntime:\s*)"[^"]*"/g, `$1"${q}"`);

  // The Java target itself is known, not a TODO.
  text = text.replace(/(\bjavaVersion:\s*)"[^"]*"/g, `$1"${major}"`);
  text = text.replace(/(\bjavaSpecificationVersions:\s*)\[[^\]]*\]/g, `$1["${major}"]`);

  // `compare: "java"` rules carry the target major in `set`; restore it after the blanket blanking.
  text = text.replace(/(compare:\s*"java",\s*set:\s*)"[^"]*"/g, `$1"${major}"`);

  // Replace the default file's header with one that says loudly that this is not ready.
  const header = [
    `# Java ${major} upgrade rules - NOT YET CURATED.`,
    `#`,
    `# Scaffolded from the default target. Identity fields (connector properties and coordinates,`,
    `# gating coordinates, manualReview patterns) were copied verbatim and MUST stay in sync with`,
    `# every other target file - the parity test enforces this.`,
    `#`,
    `# Every version-bearing field below is "${q}". While status is "uncurated" the engine REFUSES`,
    `# to run against this target, so these placeholders can never reach a plan.`,
    `#`,
    `# TO CURATE: replace each "${q}" with the value verified for Java ${major} (release notes, the`,
    `# MuleSoft Java-compatible connector KB, runtime support matrices), then delete the status line.`,
    `# See ./MATRIX.md section 5.`,
  ].join("\n");

  const schemaAt = text.search(/^schemaVersion:/m);
  if (schemaAt === -1) throw new Error("Source matrix has no schemaVersion key — refusing to scaffold.");
  text = `${header}\n${text.slice(schemaAt)}`;

  // `status` sits immediately after schemaVersion so it is the first thing an editor sees.
  text = text.replace(
    /^(schemaVersion:.*)$/m,
    `$1\nstatus: "uncurated"   # delete this line once every ${q} above is filled in`
  );

  const parsed = yaml.load(text);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Scaffolded matrix did not parse as YAML — aborting rather than writing it.");
  }
  return text;
}
