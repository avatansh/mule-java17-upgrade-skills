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
      results.push({
        key: a.key,
        label: a.label,
        pinned: a.matrixValue(matrix) ?? null,
        latest: null,
        drift: false,
        unknown: true,
        note: opts.noFetch ? "drift check skipped (noFetch)" : "drift check disabled",
      });
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
        results.push({
          key: a.key,
          label: a.label,
          pinned,
          latest: null,
          drift: false,
          unknown: true,
          note: `no clean release found${linePrefix ? ` on the ${linePrefix}x line` : ""}`,
        });
        continue;
      }
      const drift = pinned != null && lt(pinned, latest);
      if (drift) {
        driftCount += 1;
        warnings.push(
          `Matrix drift: ${a.label} pins ${pinned}, latest published is ${latest}${linePrefix ? ` (on the ${linePrefix}x line)` : ""}. Consider bumping the bundled matrix.`
        );
      }
      results.push({ key: a.key, label: a.label, pinned, latest, drift });
    } catch (err) {
      results.push({
        key: a.key,
        label: a.label,
        pinned,
        latest: null,
        drift: false,
        unknown: true,
        note: `fetch failed (${err?.message ?? err})`,
      });
    }
  }

  return { checked: true, results, warnings, driftCount };
}

/**
 * checkConnectorDrift({ matrix, choices }): ADVISORY drift check for the CONNECTOR pins (G5).
 *
 * The matrix pins each connector to a curated Java-17-SAFE `set` — the authoritative floor. This does
 * NOT change that: it compares each pin against the latest PUBLISHED version WITHIN THE SAME MAJOR
 * (never across a breaking major) and reports where the pin trails. Input is the connector CHOICES
 * already produced by resolveVersions() (which carry `latestInMajor` / `latest` from Exchange Graph),
 * so this adds NO network — it's a pure reduction. NEVER writes the matrix; the operator bumps the
 * YAML themselves (or feeds the candidate matrix below to a review).
 *
 * @param {{matrix?:object, choices?:Array}} [o]  o.matrix: the (merged/bundled) matrix — source of the
 *   connector list + pins; o.choices: connector choices from resolveVersions(), absent/empty → all "unknown".
 * @returns {{checked:boolean, results:object[], warnings:string[], driftCount:number}}
 *   Each result: { artifactId, groupId, pinned, latestInMajor, latest, drift, unknown?, note? }.
 */
export function checkConnectorDrift({ matrix, choices } = {}) {
  const byArtifact = new Map((choices ?? []).map((c) => [c.artifactId, c]));
  const results = [];
  const warnings = [];
  let driftCount = 0;

  for (const conn of matrix?.connectors ?? []) {
    const artifactId = conn.artifactId;
    if (!artifactId) continue;
    const pinned = conn.set ?? null;
    const choice = byArtifact.get(artifactId);
    // No live data for this connector (Exchange failed / matrix-only run) → unknown, non-fatal.
    if (!choice || (!choice.latestInMajor && !choice.latest)) {
      results.push({
        artifactId,
        groupId: conn.groupId ?? null,
        pinned,
        latestInMajor: null,
        latest: choice?.latest ?? null,
        drift: false,
        unknown: true,
        note: "no live version data (matrix-only)",
      });
      continue;
    }
    const latestInMajor = choice.latestInMajor ?? null;
    const drift = pinned != null && latestInMajor != null && lt(pinned, latestInMajor);
    if (drift) {
      driftCount += 1;
      const majorNote =
        choice.latest && choice.latest !== latestInMajor
          ? ` (${choice.latest} exists in a newer major — verify separately)`
          : "";
      warnings.push(
        `Connector drift: ${artifactId} pins ${pinned}, latest in-major is ${latestInMajor}${majorNote}. Advisory only — the curated pin stays the Java-17-safe floor.`
      );
    }
    results.push({
      artifactId,
      groupId: conn.groupId ?? null,
      pinned,
      latestInMajor,
      latest: choice.latest ?? null,
      drift,
    });
  }

  return { checked: byArtifact.size > 0, results, warnings, driftCount };
}

/**
 * candidateMatrix(matrix, connectorReport): produce a PROPOSED matrix (a NEW object) whose drifting
 * connector `set` pins are bumped to their latest-in-major. This is a REVIEW ARTIFACT ONLY — it is
 * returned, never written to disk, and the curated matrix stays authoritative until a human adopts it.
 * Connectors with no drift (or unknown) are left untouched.
 * @param {object} matrix
 * @param {{results:object[]}} connectorReport  output of checkConnectorDrift
 * @returns {{matrix:object, proposed:Array<{artifactId,from,to}>}}
 */
export function candidateMatrix(matrix, connectorReport) {
  const bumpTo = new Map(
    (connectorReport?.results ?? [])
      .filter((r) => r.drift && r.latestInMajor)
      .map((r) => [r.artifactId, r.latestInMajor])
  );
  const proposed = [];
  const connectors = (matrix?.connectors ?? []).map((c) => {
    const to = bumpTo.get(c.artifactId);
    if (to && to !== c.set) {
      proposed.push({ artifactId: c.artifactId, from: c.set ?? null, to });
      return { ...c, set: to };
    }
    return c;
  });
  return { matrix: { ...matrix, connectors }, proposed };
}

/** One-line-per-connector human summary for CLI. */
export function formatConnectorDrift(report) {
  const lines = [];
  lines.push(
    report.checked
      ? `Connector drift check — ${report.driftCount} connector(s) behind (advisory, matrix stays authoritative):`
      : "Connector drift check: no live data."
  );
  for (const r of report.results) {
    if (r.unknown) lines.push(`  ? ${r.artifactId}: pinned ${r.pinned ?? "?"} — ${r.note}`);
    else if (r.drift) lines.push(`  ! ${r.artifactId}: pinned ${r.pinned} < latest-in-major ${r.latestInMajor}`);
    else lines.push(`  ✓ ${r.artifactId}: pinned ${r.pinned} is current in-major`);
  }
  return lines.join("\n");
}

/** One-line-per-artifact human summary for CLI. */
export function formatDrift(report) {
  const lines = [];
  lines.push(
    report.checked
      ? `Matrix drift check — ${report.driftCount} version(s) behind:`
      : "Matrix drift check: not run."
  );
  for (const r of report.results) {
    if (r.unknown) lines.push(`  ? ${r.label}: pinned ${r.pinned ?? "?"} — ${r.note}`);
    else if (r.drift) lines.push(`  ! ${r.label}: pinned ${r.pinned} < latest ${r.latest}`);
    else lines.push(`  ✓ ${r.label}: pinned ${r.pinned} is current (latest ${r.latest})`);
  }
  return lines.join("\n");
}

/**
 * runDriftCheck(opts): the Full Split's ③ check_drift — the on-demand / scheduled ADVISORY that audits
 * whether the bundled matrix YAML is trailing. Runs the gating drift (runtime patch, mule-maven-plugin,
 * MUnit plugins vs live Maven metadata) and, when includeConnectors, the connector staleness (each pin
 * vs its latest-in-major from Exchange Graph). Builds the live Exchange + release-notes sources itself
 * (unconfigured Anypoint → matrix-only, non-fatal). NEVER writes the matrix; the curated pins stay the
 * Java-17-safe floor. Shared by the CLI and the check_drift MCP/REST tool so both behave identically.
 * @param {object} [opts]
 * @param {object} [opts.matrix]            pre-loaded matrix; else the bundled matrix is loaded
 * @param {boolean}[opts.noFetch]           skip ALL network → gating "unchecked", connectors "unknown"
 * @param {boolean}[opts.includeConnectors] also run the connector-staleness check (default true)
 * @param {boolean}[opts.candidate]         also produce a PROPOSED candidate matrix (review artifact)
 * @param {any}    [opts.exchange]          injectable ExchangeClient (tests)
 * @param {(url:string)=>Promise<string>} [opts.fetchHtml]  injectable release-notes fetcher (tests)
 * @returns {Promise<{gating:object, connectors:(object|null), candidate:(object|null), warnings:string[]}>}
 */
export async function runDriftCheck(opts = {}) {
  const { loadBundledMatrix } = await import("./matrix.js");
  const matrix = opts.matrix ?? loadBundledMatrix();
  const noFetch = opts.noFetch === true;
  const includeConnectors = opts.includeConnectors !== false; // default on
  const gating = await checkMatrixDrift(matrix, { noFetch });
  const warnings = [...(gating.warnings ?? [])];

  let connectors = null;
  let candidate = null;
  if (includeConnectors) {
    const { resolveVersions } = await import("./resolve_versions.js");
    let choices = [];
    try {
      // Build the same Exchange + release-notes live sources assess.js wires, so the staleness check
      // gets real latest-in-major data (not matrix-only). Non-fatal: unconfigured Anypoint → matrix-only.
      let exchange = opts.exchange ?? null;
      let fetchHtml = opts.fetchHtml ?? null;
      if (!noFetch && exchange == null && fetchHtml == null) {
        const { AnypointClient } = await import("../../../mule-upgrade/scripts/lib/anypoint.js");
        const { ExchangeClient } = await import("../../../../lib_shared/exchange.js");
        const { fetchReleaseNotesCached } = await import("./matrix_fetch.js");
        const anypoint = new AnypointClient();
        exchange = anypoint.configured?.() ? new ExchangeClient({ anypoint }) : null;
        fetchHtml = fetchReleaseNotesCached;
      }
      const rv = await resolveVersions({ matrix, exchange, fetchHtml, noFetch });
      choices = rv.choices;
    } catch {
      /* advisory; degrade to no live data */
    }
    connectors = checkConnectorDrift({ matrix, choices });
    if (connectors.warnings?.length) warnings.push(...connectors.warnings);
    if (opts.candidate) candidate = candidateMatrix(matrix, connectors);
  }
  return { gating, connectors, candidate, warnings };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && process.argv[1].endsWith("matrix_drift.js");
if (isMain) {
  const args = process.argv.slice(2);
  const noFetch = args.includes("--no-fetch");
  // --connectors / --candidate opt into the connector-staleness half; default is gating-only.
  const includeConnectors = args.includes("--connectors") || args.includes("--candidate");
  const { gating: report, connectors: connectorReport, candidate } = await runDriftCheck({
    noFetch,
    includeConnectors,
    candidate: args.includes("--candidate"),
  });

  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify({ gating: report, connectors: connectorReport, candidate }, null, 2) + "\n");
  } else {
    process.stdout.write(formatDrift(report) + "\n");
    if (connectorReport) process.stdout.write("\n" + formatConnectorDrift(connectorReport) + "\n");
    if (candidate?.proposed?.length)
      process.stdout.write(
        `\nProposed connector bumps (candidate matrix — NOT written):\n` +
          candidate.proposed.map((p) => `  ${p.artifactId}: ${p.from} -> ${p.to}`).join("\n") +
          "\n"
      );
  }
}
