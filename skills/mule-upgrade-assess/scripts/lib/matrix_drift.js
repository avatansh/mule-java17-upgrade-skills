// lib/matrix_drift.js — ADVISORY drift check for the static gating versions.
//
// The compatibility matrix pins gating tool versions (runtime patch, mule-maven-plugin, MUnit
// plugins/runner, munit-extensions). Those are MINIMUMS REQUIRED for Java 17 — deliberately static,
// because "minimum required" is a policy decision, not "newest available". But they still ROT: a
// live audit against MuleSoft's Maven metadata showed our pins were already behind (runtime 4.9.18
// vs 4.9.19, mule-maven-plugin 4.10.0 vs 4.10.1, munit 3.6.3 vs 3.7.3, munit-extensions 1.5.0 vs
// 1.7.0).
//
// So this module does NOT change what the matrix means and NEVER auto-applies a version. It fetches
// each artifact's maven-metadata.xml, applies a POLICY FILTER (stay on the pinned LTS/train line,
// drop pre-release/snapshot and dated builds), and reports where the bundled matrix trails the
// latest published version — as `matrixDrift` advisories the operator can act on by bumping the YAML.
//
// WHY advisory and not live-authoritative (proven by the audit):
//   - maven-metadata latest/release spans ALL trains: the runtime's is 4.12.1, but a 4.9 LTS
//     upgrade must stay on 4.9.x. You cannot trust that tag; you must filter the versions list.
//   - Some artifacts version on an unrelated line (weave assertions vs the 2.x DataWeave runtime),
//     so "latest" would pin a nonsensical value.
//   - MUnit >=3.6.3 is a BUG-FIX FLOOR (JPMS container fix), not "latest" — that constraint lives in
//     a KB article, not in Maven metadata. Newer happens to satisfy it, but the rule is the floor.
// Everything here is NON-FATAL: any fetch/parse failure yields "unknown" for that artifact and a
// note, never a throw. Network can be skipped entirely with { noFetch:true }.

import { get } from "../../../../lib_shared/config.js";
import { lt } from "../../../../lib_shared/semver.js";

function cfg(dotted, fallback) {
  try {
    const v = get(dotted, undefined);
    return v === undefined || v === null || v === "" ? fallback : v;
  } catch {
    return fallback;
  }
}

const NEXUS = "https://repository.mulesoft.org/nexus/content/repositories/releases";

// The gating artifacts we can drift-check against Maven metadata. Each entry ties a matrix pin to
// its published maven-metadata.xml and a policy for choosing the comparable "latest" version.
//   matrixValue(matrix)  -> the currently-pinned version string (the `set` we'd compare against)
//   linePrefix(matrix)   -> optional: restrict candidates to versions starting with this (LTS/train
//                           line). Omit to consider the whole clean-semver list.
export const GATING_ARTIFACTS = [
  {
    key: "muleRuntime",
    label: "Mule runtime (LTS patch)",
    // mule-services-all lists every runtime patch; the release tag spans all trains so we MUST line-filter.
    metadataUrl: `${NEXUS}/org/mule/distributions/mule-services-all/maven-metadata.xml`,
    matrixValue: (m) => m?.target?.runtime,
    // stay on the pinned LTS minor line (e.g. "4.9.") — never jump 4.9 -> 4.12
    linePrefix: (m) => {
      const v = String(m?.target?.runtime ?? "");
      const parts = v.split(".");
      return parts.length >= 2 ? `${parts[0]}.${parts[1]}.` : null;
    },
  },
  {
    key: "muleMavenPlugin",
    label: "mule-maven-plugin",
    metadataUrl: `${NEXUS}/org/mule/tools/maven/mule-maven-plugin/maven-metadata.xml`,
    matrixValue: (m) => m?.gating?.muleMavenPlugin?.set,
  },
  {
    key: "munit",
    label: "munit-maven-plugin",
    metadataUrl: `${NEXUS}/com/mulesoft/munit/tools/munit-maven-plugin/maven-metadata.xml`,
    matrixValue: (m) => m?.gating?.munit?.set,
  },
  {
    key: "munitExtPlugin",
    label: "munit-extensions-maven-plugin",
    metadataUrl: `${NEXUS}/com/mulesoft/munit/munit-extensions-maven-plugin/maven-metadata.xml`,
    matrixValue: (m) => m?.gating?.munitExtPlugin?.set,
  },
];

/** A version is "clean" (release) if it has no pre-release / snapshot / dated qualifier. */
export function isCleanRelease(v) {
  const s = String(v ?? "").trim();
  if (!s) return false;
  // reject any qualifier: -rc, -SNAPSHOT, -BETA, -M1, -ea, -hf, -support, dated builds (2.13.0-20260706)
  if (/-/.test(s)) return false;
  // require at least major.minor(.patch) numeric
  return /^\d+(\.\d+){1,3}$/.test(s);
}

/**
 * Parse the versions list out of a maven-metadata.xml string.
 * Returns { versions: string[], latest: string|null, release: string|null }.
 */
export function parseMavenMetadata(xml) {
  if (!xml || typeof xml !== "string") return { versions: [], latest: null, release: null };
  const versions = [];
  const re = /<version>\s*([^<\s]+)\s*<\/version>/g;
  let m;
  while ((m = re.exec(xml)) !== null) versions.push(m[1]);
  const latest = (/<latest>\s*([^<\s]+)\s*<\/latest>/.exec(xml) || [])[1] ?? null;
  const release = (/<release>\s*([^<\s]+)\s*<\/release>/.exec(xml) || [])[1] ?? null;
  return { versions, latest, release };
}

/**
 * Pick the highest CLEAN release from a versions list, optionally restricted to a line prefix.
 * Uses the project's own semver `lt` for ordering (tolerant of non-numeric tails).
 */
export function highestClean(versions, linePrefix = null) {
  let best = null;
  for (const v of versions ?? []) {
    if (linePrefix && !String(v).startsWith(linePrefix)) continue;
    if (!isCleanRelease(v)) continue;
    if (best === null || lt(best, v)) best = v;
  }
  return best;
}

/** Fetch a maven-metadata.xml (Node 18+ global fetch). Separated so tests can stub it. */
export async function fetchMetadataXml(url, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * checkMatrixDrift(matrix, opts): compare the bundled gating pins against live Maven metadata.
 * @param {object} matrix  the (merged/bundled) matrix
 * @param {object} [opts]
 * @param {boolean} [opts.noFetch]  skip network entirely (returns unchecked results)
 * @param {(url:string)=>Promise<string>} [opts.fetchXml]  injectable fetcher (tests)
 * @param {object[]} [opts.artifacts]  override GATING_ARTIFACTS (tests)
 * @returns {Promise<{checked:boolean, results:object[], warnings:string[], driftCount:number}>}
 *   Each result: { key, label, pinned, latest, drift, unknown?, note? }. NEVER throws.
 */
export async function checkMatrixDrift(matrix, opts = {}) {
  const enabled = String(cfg("matrix.driftCheck", "true")) !== "false";
  const artifacts = opts.artifacts ?? GATING_ARTIFACTS;
  const fetchXml = opts.fetchXml ?? fetchMetadataXml;
  const results = [];
  const warnings = [];

  if (opts.noFetch || !enabled) {
    for (const a of artifacts) {
      results.push({ key: a.key, label: a.label, pinned: a.matrixValue(matrix) ?? null, latest: null, drift: false, unknown: true, note: opts.noFetch ? "drift check skipped (noFetch)" : "drift check disabled" });
    }
    return { checked: false, results, warnings, driftCount: 0 };
  }

  let driftCount = 0;
  for (const a of artifacts) {
    const pinned = a.matrixValue(matrix) ?? null;
    const linePrefix = a.linePrefix ? a.linePrefix(matrix) : null;
    try {
      const xml = await fetchXml(a.metadataUrl);
      const { versions } = parseMavenMetadata(xml);
      const latest = highestClean(versions, linePrefix);
      if (!latest) {
        results.push({ key: a.key, label: a.label, pinned, latest: null, drift: false, unknown: true, note: `no clean release found${linePrefix ? ` on the ${linePrefix}x line` : ""}` });
        continue;
      }
      const drift = pinned != null && lt(pinned, latest);
      if (drift) {
        driftCount += 1;
        warnings.push(`Matrix drift: ${a.label} pins ${pinned}, latest published is ${latest}${linePrefix ? ` (on the ${linePrefix}x line)` : ""}. Consider bumping the bundled matrix.`);
      }
      results.push({ key: a.key, label: a.label, pinned, latest, drift });
    } catch (err) {
      results.push({ key: a.key, label: a.label, pinned, latest: null, drift: false, unknown: true, note: `fetch failed (${err?.message ?? err})` });
    }
  }

  return { checked: true, results, warnings, driftCount };
}

/** One-line-per-artifact human summary for CLI. */
export function formatDrift(report) {
  const lines = [];
  lines.push(report.checked ? `Matrix drift check — ${report.driftCount} version(s) behind:` : "Matrix drift check: not run.");
  for (const r of report.results) {
    if (r.unknown) lines.push(`  ? ${r.label}: pinned ${r.pinned ?? "?"} — ${r.note}`);
    else if (r.drift) lines.push(`  ! ${r.label}: pinned ${r.pinned} < latest ${r.latest}`);
    else lines.push(`  ✓ ${r.label}: pinned ${r.pinned} is current (latest ${r.latest})`);
  }
  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && process.argv[1].endsWith("matrix_drift.js");
if (isMain) {
  const { loadBundledMatrix } = await import("./matrix.js");
  const args = process.argv.slice(2);
  const report = await checkMatrixDrift(loadBundledMatrix(), { noFetch: args.includes("--no-fetch") });
  if (args.includes("--json")) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else process.stdout.write(formatDrift(report) + "\n");
}
