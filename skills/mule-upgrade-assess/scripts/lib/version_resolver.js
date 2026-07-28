// lib/version_resolver.js — EPIC B: live connector-version resolution + version CHOICE.
//
// Two trusted signals feed the version CHOICE offered to the operator:
//   1. Each connector's release-notes page carries a per-version Compatibility TABLE whose
//      "OpenJDK" row states the supported JDKs ("8 and 11" -> "8, 11, and 17"). Parsing that cell
//      is the ONLY machine-readable, MuleSoft-authored statement of Java-17 compatibility per
//      version. parseOpenJdkTable() extracts { version, jdks:[8,11,17] } rows from that table, from
//      which we derive firstJava17Version (the MINIMUM compatible version) and latest.
//   2. The Exchange Maven facade (exchange.listVersions) enumerates every PUBLISHED version, so we
//      can offer "latest-in-major" (highest patch within the matrix pin's major, never crossing a
//      breaking major) and "latest overall".
//
// The bundled matrix `set` stays AUTHORITATIVE for the compatibility floor: "latest published" is
// deliberately NOT auto-adopted (it may be a breaking major or not yet Java-17-verified). Live data
// only drives the CHOICE menu + a staleness advisory. All functions here are pure and offline; the
// caller injects HTML + version lists (fetched via matrix_fetch/exchange, both non-fatal).

import { lt } from "../../../../lib_shared/semver.js";

/** majorOf("10.19.2") -> 10 ; tolerant of qualifiers/short forms. Returns null when unparseable. */
export function majorOf(v) {
  const m = String(v ?? "").match(/^\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Tokenise an OpenJDK compatibility cell ("8 and 11", "8, 11, and 17", "11, 17") into the sorted
 * numeric JDK majors it names. Only 8/11/17/21 are recognised (1.8 normalised to 8). Anything else
 * is ignored so stray numbers in prose never leak in.
 * @param {string} cell
 * @returns {number[]}
 */
export function parseJdkCell(cell) {
  const text = String(cell ?? "").replace(/1\.8/g, "8");
  const found = new Set();
  for (const m of text.matchAll(/\b(8|11|17|21)\b/g)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

/**
 * Parse a connector release-notes HTML page's per-version Compatibility table(s) into full rows.
 * MuleSoft's Antora pages render each release's compatibility as an HTML <table> whose rows are
 * label/value pairs — an "OpenJDK" (sometimes "Java"/"JDK") row listing supported JDKs, AND a "Mule"
 * (sometimes "Mule Runtime") row stating the minimum runtime (e.g. "4.1.1 and later"). The version a
 * table belongs to appears in the nearest preceding heading (e.g. "1.7.3", "Version 1.7.3").
 *
 * This is a forgiving, structure-light extractor: it walks each <table>, reads the OpenJDK row and
 * the Mule-runtime row, and associates them with the closest version token seen BEFORE that table.
 * Tables without a recognisable version OR a JDK cell are skipped (the JDK statement is the anchor).
 * Returns entries in document order; a version seen more than once keeps the first (nearest) reading.
 * @param {string} html
 * @returns {Array<{version:string, jdks:number[], muleRuntime:(string|null)}>}
 */
export function parseCompatibilityTable(html) {
  if (!html || typeof html !== "string") return [];
  const text = html.replace(/\r/g, "");
  const out = [];
  const seen = new Set();

  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let m;
  let lastIndex = 0;
  while ((m = tableRe.exec(text)) !== null) {
    const tableHtml = m[0];
    const preceding = text.slice(lastIndex, m.index);
    lastIndex = tableRe.lastIndex;

    const rowRe = /<tr[\s\S]*?<\/tr>/gi;
    let jdks = null;
    let muleRuntime = null;
    let r;
    while ((r = rowRe.exec(tableHtml)) !== null) {
      const rowText = r[0];
      const cells = [...rowText.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
        c[1]
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .trim()
      );
      if (cells.length < 2) continue;
      const label = cells[0].toLowerCase();
      const value = cells.slice(1).join(" ").trim();
      if (jdks === null && /\bopenjdk\b|\bjdk\b|\bjava\b/.test(label)) {
        const parsed = parseJdkCell(value);
        if (parsed.length) jdks = parsed; // first JDK row of the table wins
      } else if (muleRuntime === null && /\bmule\b/.test(label) && !/\bmulesoft\b/.test(label)) {
        // "Mule" or "Mule Runtime" row — capture the raw requirement text (e.g. "4.1.1 and later").
        if (value) muleRuntime = value;
      }
    }
    if (!jdks) continue; // JDK statement is the anchor; a table without it isn't a compat table

    const versionMatches = [...preceding.matchAll(/(?:version\s+)?\b(\d+\.\d+\.\d+)\b/gi)].map((v) => v[1]);
    const version = versionMatches.length ? versionMatches[versionMatches.length - 1] : null;
    if (!version || seen.has(version)) continue;
    seen.add(version);
    out.push({ version, jdks, muleRuntime });
  }
  return out;
}

/**
 * parseOpenJdkTable(html): back-compat view of parseCompatibilityTable that returns only
 * { version, jdks } rows (drops the Mule-runtime column). Existing callers that only need the JDK
 * statement keep working unchanged.
 * @param {string} html
 * @returns {Array<{version:string, jdks:number[]}>}
 */
export function parseOpenJdkTable(html) {
  return parseCompatibilityTable(html).map(({ version, jdks }) => ({ version, jdks }));
}

/**
 * muleRuntimeFor(entries, version): the Mule-runtime requirement string the compatibility table
 * states for a specific connector version, or null if unknown.
 * @param {Array<{version:string, muleRuntime?:string|null}>} entries
 * @param {string} version
 * @returns {string|null}
 */
export function muleRuntimeFor(entries, version) {
  if (!version) return null;
  const hit = (entries ?? []).find((e) => e.version === version);
  return hit?.muleRuntime ?? null;
}

/** firstJava17Version(entries): the LOWEST version whose OpenJDK cell includes 17, else null. */
export function firstJava17Version(entries) {
  const compatible = (entries ?? []).filter((e) => Array.isArray(e.jdks) && e.jdks.includes(17));
  if (!compatible.length) return null;
  return compatible.reduce((lo, e) => (lt(e.version, lo) ? e.version : lo), compatible[0].version);
}

/** highestVersion(versions): the numerically highest semver in the list, or null. */
export function highestVersion(versions) {
  const list = (versions ?? []).map(String).filter(Boolean);
  if (!list.length) return null;
  return list.reduce((hi, v) => (lt(hi, v) ? v : hi), list[0]);
}

/**
 * latestInMajor(versions, major): highest published version whose major === `major`. Keeps us on
 * patch/minor updates WITHIN the matrix pin's major so we never silently cross a breaking major
 * (e.g. Slack 1.x -> 2.x). Returns null if none match.
 * @param {string[]} versions
 * @param {number} major
 */
export function latestInMajor(versions, major) {
  const inMajor = (versions ?? []).map(String).filter((v) => majorOf(v) === major);
  return highestVersion(inMajor);
}

/**
 * Build the version CHOICE record for ONE connector. Pure: caller supplies the matrix pin, the live
 * published version list (from exchange.listVersions, may be empty on failure), and the parsed
 * OpenJDK-table entries (from the connector's release-notes page, may be empty).
 *
 * Returns { artifactId, groupId, current, matrixSet, firstCompatible, latest, latestInMajor,
 *           recommended, options[], staleness }:
 *   - matrixSet       - the curated, Java-17-safe pin (authoritative floor)
 *   - firstCompatible - lowest version the OpenJDK table marks Java-17-compatible (min upgrade)
 *   - latest          - highest published version overall (may be a breaking major -> advisory only)
 *   - latestInMajor   - highest published version within the matrix pin's major (safe patch bump)
 *   - recommended     - default pick = matrixSet (curated floor); NEVER auto-jumps to latest
 *   - options[]       - the labelled menu the agent renders: {strategy, version, label}
 *   - staleness       - advisory string when a newer in-major version exists beyond matrixSet, else null
 *
 * @param {object} o
 * @param {string} o.artifactId
 * @param {string} [o.groupId]
 * @param {string} [o.current]                 currently-declared/effective version in the app (if any)
 * @param {string} o.matrixSet                 the bundled matrix `set` pin (required)
 * @param {string[]} [o.liveVersions]          published versions from exchange.listVersions
 * @param {Array<{version,jdks:number[]}>} [o.jdkEntries]  parsed OpenJDK-table rows
 */
export function buildConnectorChoice({
  artifactId,
  groupId,
  current = null,
  matrixSet,
  liveVersions = [],
  jdkEntries = [],
}) {
  const major = majorOf(matrixSet);
  const firstCompatible = firstJava17Version(jdkEntries);
  const latest = highestVersion(liveVersions);
  const inMajor = major == null ? null : latestInMajor(liveVersions, major);
  // B6: the Mule-runtime requirement the release-notes table states for the key versions. jdkEntries
  // may be the JDK-only shape (no muleRuntime) — muleRuntimeFor tolerates that and returns null.
  const muleRuntime = {
    matrixSet: muleRuntimeFor(jdkEntries, matrixSet),
    firstCompatible: firstCompatible ? muleRuntimeFor(jdkEntries, firstCompatible) : null,
  };

  // Options menu (deduped by version, matrixSet first = the recommended default).
  const rawOptions = [
    { strategy: "min", version: matrixSet, label: "Curated Java-17-safe pin (recommended)" },
    firstCompatible
      ? {
          strategy: "first-compatible",
          version: firstCompatible,
          label: "First version marked Java-17-compatible (minimum upgrade)",
        }
      : null,
    // Never OFFER a live-derived option that sits BELOW the curated floor (a partial/stale Exchange
    // list can make latest-in-major or latest lower than matrixSet). The floor pin stays the default.
    inMajor && inMajor !== matrixSet && !lt(inMajor, matrixSet)
      ? { strategy: "in-major", version: inMajor, label: `Latest in ${major}.x (safe patch bump)` }
      : null,
    latest && latest !== matrixSet && !lt(latest, matrixSet)
      ? {
          strategy: "latest",
          version: latest,
          label: "Latest published (may be a breaking major — verify)",
        }
      : null,
  ].filter(Boolean);
  const options = [];
  const seenVer = new Set();
  for (const o of rawOptions) {
    if (seenVer.has(o.version)) continue;
    seenVer.add(o.version);
    options.push(o);
  }

  // Staleness advisory: matrix pin is trailing the latest published version WITHIN its own major.
  const staleness =
    inMajor && lt(matrixSet, inMajor)
      ? `Matrix pins ${artifactId} ${matrixSet}; ${inMajor} is now published in the ${major}.x line — consider bumping the matrix (not auto-adopted).`
      : null;

  return {
    artifactId,
    groupId: groupId ?? null,
    current: current ?? null,
    matrixSet,
    firstCompatible,
    latest,
    latestInMajor: inMajor,
    recommended: matrixSet, // curated floor is always the default; live data is advisory
    muleRuntime, // B6: { matrixSet, firstCompatible } runtime requirement strings (null when unknown)
    options,
    staleness,
  };
}

/**
 * Resolve the concrete pin for a connector given a chosen strategy. Used by start_upgrade when the
 * operator picks a versionStrategy (or a per-connector connectorSelections override).
 *   min              -> choice.matrixSet                    (the curated Java-17-safe pin; recommended default)
 *   first-compatible -> choice.firstCompatible ?? matrixSet (minimum version the OpenJDK table marks 17-safe)
 *   in-major         -> choice.latestInMajor ?? matrixSet   (highest patch within the pin's major)
 *   latest           -> choice.latest ?? matrixSet          (highest published overall)
 *   manual           -> the explicit `override` version     (falls back to matrixSet if absent)
 *   (default)        -> choice.matrixSet
 *
 * Every live-derived strategy falls back to matrixSet when its value is missing, so a strategy can
 * never yield a pin BELOW the curated floor — except "first-compatible", which is explicitly the
 * minimum-upgrade option and may sit below matrixSet by the operator's choice.
 * @param {ReturnType<typeof buildConnectorChoice>} choice
 * @param {string} [strategy]
 * @param {string} [override]  explicit version for manual strategy
 * @returns {string}
 */
export const VERSION_STRATEGIES = ["min", "first-compatible", "in-major", "latest", "manual"];

// Clamp a live-derived candidate to the curated matrix floor. The plain `??` only guards ABSENCE,
// not a LOWER value — a partial/stale Exchange list could make latestInMajor/latest sit BELOW
// matrixSet and yield a DOWNGRADE, contradicting pickVersion's documented contract (M4). Returns the
// floor when the candidate is missing OR below it.
function atLeastFloor(candidate, floor) {
  return candidate != null && !lt(String(candidate), String(floor)) ? String(candidate) : floor;
}

export function pickVersion(choice, strategy, override) {
  if (!choice) return override ?? null;
  switch (strategy) {
    // in-major / latest are floor-guaranteed → never below matrixSet.
    case "latest":
      return atLeastFloor(choice.latest, choice.matrixSet);
    case "in-major":
      return atLeastFloor(choice.latestInMajor, choice.matrixSet);
    // first-compatible is the deliberate exception: the minimum-upgrade option, may be below matrixSet.
    case "first-compatible":
      return choice.firstCompatible ?? choice.matrixSet;
    case "manual":
      return override ?? choice.matrixSet;
    case "min":
    default:
      return choice.matrixSet;
  }
}
