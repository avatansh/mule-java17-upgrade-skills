// lib/resolve_versions.js — EPIC B orchestration: turn the bundled matrix's connector list into a
// set of version CHOICES, enriched with LIVE data from two non-fatal sources:
//
//   • Exchange Maven facade  (exchange.listVersions(groupId, artifactId)) → every published version,
//     used for "latest-in-major" and "latest overall".
//   • the connector's release-notes page (per-connector OpenJDK compatibility table) → the MINIMUM
//     Java-17-compatible version (firstCompatible).
//
// The curated matrix `set` stays the AUTHORITATIVE floor + default (recommended). Live data only
// widens the menu and raises a staleness advisory; it is NEVER silently adopted as the pin. EVERY
// live lookup is wrapped so a network/auth/parse failure degrades that connector to matrix-only
// (choice with just the "min" option) — resolve_versions never throws for a network reason.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { buildConnectorChoice, pickVersion } from "./version_resolver.js";
import { parseCompatibilityTable } from "./version_resolver.js";
import { loadBundledMatrix } from "./matrix.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Base of the per-connector release-notes pages (fallback root only). The AUTHORITATIVE source of a
// connector's release-notes URL is the curated connector-notes-map.yaml — a slug can't be derived by
// formula (MuleSoft uses ≥3 conventions + a separate runtime-modules section), so we look it up.
export const RELEASE_NOTES_BASE = "https://docs.mulesoft.com/release-notes/connector";

/** Absolute path to the bundled connector-notes map (references/connector-notes-map.yaml). */
export function notesMapPath() {
  return path.resolve(__dirname, "..", "..", "references", "connector-notes-map.yaml");
}

let _notesMapCache; // { byArtifact: Map<artifactId, url> } | null  (null = load failed)
/**
 * loadNotesMap(): parse the bundled connector-notes-map.yaml into a Map keyed by artifactId. Cached
 * for the process. NON-FATAL: a missing/invalid file yields an empty map (callers degrade to no
 * release-notes enrichment for that connector), never a throw.
 * @returns {{byArtifact: Map<string,string>}}
 */
export function loadNotesMap() {
  if (_notesMapCache !== undefined) return _notesMapCache;
  const byArtifact = new Map();
  try {
    const doc = yaml.load(fs.readFileSync(notesMapPath(), "utf8"));
    for (const c of doc?.connectors ?? []) {
      if (c?.artifactId && c?.url) byArtifact.set(String(c.artifactId), String(c.url));
    }
  } catch {
    /* non-fatal: no map → no release-notes enrichment */
  }
  _notesMapCache = { byArtifact };
  return _notesMapCache;
}

/** Test/rebuild hook: clear the memoised notes-map so the next load re-reads from disk. */
export function _resetNotesMapCache() {
  _notesMapCache = undefined;
}

/**
 * connectorReleaseNotesUrl(artifactId, opts): the release-notes URL for a connector, looked up in the
 * curated notes-map. Returns null when the connector isn't mapped (→ no release-notes enrichment).
 * @param {string} artifactId
 * @param {object|Map} [opts]  a preloaded byArtifact Map, or {notesMap: Map}; defaults to loadNotesMap()
 */
export function connectorReleaseNotesUrl(artifactId, opts) {
  const map = opts instanceof Map ? opts : opts?.notesMap ?? loadNotesMap().byArtifact;
  const url = map.get(String(artifactId ?? ""));
  return url ?? null;
}

/**
 * Resolve version CHOICES for every connector in the matrix.
 *
 * FULLY NON-FATAL and offline-friendly: with noFetch (or no configured Exchange/fetcher) every
 * connector still yields a choice built from the matrix pin alone. Injectables keep it testable:
 *   @param {object} opts
 *   @param {object} [opts.matrix]        pre-loaded matrix; else the bundled matrix is loaded
 *   @param {any}    [opts.exchange]      ExchangeClient (listVersions); absent → no live versions
 *   @param {(url:string)=>Promise<string>} [opts.fetchHtml]  release-notes fetcher; absent → no jdk table
 *   @param {boolean}[opts.noFetch]       skip ALL network (Exchange + release-notes)
 *   @param {string[]}[opts.only]         restrict to these artifactIds (default: all matrix connectors)
 *                                        — the Full Split scopes this to the APP's connectors so the
 *                                        live menu isn't computed for the entire matrix.
 *   @param {Map<string,string>|Object<string,string>} [opts.currents] artifactId→current app version,
 *                                        surfaced as choice.current so the menu shows where the app is
 *                                        today relative to the pin (built by the resolve_versions tool
 *                                        from the app's pom chain; absent → choice.current stays null).
 *   @param {Map<string,string>} [opts.notesMap] injected artifactId→URL map (default: bundled notes-map)
 *   @returns {Promise<{choices:Array, warnings:string[], source:string}>}
 */
export async function resolveVersions(opts = {}) {
  const warnings = [];
  const matrix = opts.matrix ?? loadBundledMatrix();
  const connectors = (matrix.connectors ?? []).filter((c) => !opts.only || opts.only.includes(c.artifactId));
  const canFetch = !opts.noFetch;
  const exchange = canFetch ? opts.exchange : null;
  const fetchHtml = canFetch ? opts.fetchHtml : null;
  const notesMap = opts.notesMap ?? loadNotesMap().byArtifact;
  // Normalise currents (Map or plain object) to a lookup fn. Absent → every current is null.
  const currentsMap =
    opts.currents instanceof Map
      ? opts.currents
      : opts.currents
        ? new Map(Object.entries(opts.currents))
        : null;
  const currentOf = (artifactId) => currentsMap?.get(String(artifactId)) ?? null;

  const choices = await Promise.all(
    connectors.map(async (c) => {
      let liveVersions = [];
      let jdkEntries = [];

      // 1) published versions from Exchange (non-fatal).
      if (exchange?.listVersions && c.groupId && c.artifactId) {
        try {
          const r = await exchange.listVersions(c.groupId, c.artifactId);
          if (r?.ok && Array.isArray(r.versions)) liveVersions = r.versions;
          else if (r && !r.ok)
            warnings.push(`listVersions(${c.artifactId}) failed: ${r.reason ?? "unknown"}`);
        } catch (e) {
          warnings.push(`listVersions(${c.artifactId}) threw: ${e?.message ?? e}`);
        }
      }

      // 2) OpenJDK compatibility table from the connector's release-notes page (non-fatal).
      if (fetchHtml) {
        const url = connectorReleaseNotesUrl(c.artifactId, notesMap);
        if (url) {
          try {
            const html = await fetchHtml(url);
            // B6: full compatibility rows ({version, jdks, muleRuntime}) — buildConnectorChoice reads
            // both the Java-17 signal and the Mule-runtime requirement from these.
            jdkEntries = parseCompatibilityTable(html);
          } catch (e) {
            warnings.push(`release-notes fetch for ${c.artifactId} failed: ${e?.message ?? e}`);
          }
        }
      }

      return buildConnectorChoice({
        artifactId: c.artifactId,
        groupId: c.groupId,
        current: currentOf(c.artifactId),
        matrixSet: c.set,
        liveVersions,
        jdkEntries,
      });
    })
  );

  // Bubble each connector's staleness advisory up into the run-level warnings so the operator sees
  // "matrix trails the published X.x line" even when they only read the summary.
  for (const ch of choices) if (ch.staleness) warnings.push(ch.staleness);

  const source = !canFetch ? "matrix-only" : exchange || fetchHtml ? "live" : "matrix-only";
  return { choices, warnings, source };
}

/**
 * Apply an operator-chosen version strategy to a matrix, returning a NEW matrix whose connector
 * `set` pins reflect the strategy. Used by start_upgrade so the assess engine emits edits to the
 * chosen versions instead of the curated defaults.
 *
 * The curated matrix pin remains the SAFE FLOOR: pickVersion() falls back to matrixSet whenever the
 * requested strategy has no live-derived value (e.g. Exchange failed, or a manual selection is
 * absent), so a bad/empty live signal can never produce a pin BELOW the curated version.
 *
 * @param {object} o
 * @param {object} o.matrix               the resolved matrix to rewrite (bundled + merged connectors)
 * @param {Array}  o.choices              connector choices from resolveVersions()
 * @param {"min"|"first-compatible"|"in-major"|"latest"|"manual"} [o.strategy="min"]
 * @param {Object<string,string>} [o.selections]  per-artifactId overrides (manual strategy)
 * @returns {{matrix:object, applied:Array<{artifactId,from,to,strategy}>}}
 */
export function applyVersionStrategy({ matrix, choices, strategy = "min", selections = {} }) {
  const byArtifact = new Map((choices ?? []).map((c) => [c.artifactId, c]));
  const applied = [];
  const connectors = (matrix.connectors ?? []).map((c) => {
    const choice = byArtifact.get(c.artifactId);
    if (!choice) return c;
    const override = selections?.[c.artifactId];
    // For "manual", a per-connector selection takes precedence; connectors without an explicit
    // selection keep the curated pin (pickVersion → matrixSet).
    const picked = pickVersion(choice, strategy, override);
    if (picked && picked !== c.set) {
      applied.push({ artifactId: c.artifactId, from: c.set, to: picked, strategy });
      return { ...c, set: String(picked) };
    }
    return c;
  });
  return { matrix: { ...matrix, connectors }, applied };
}
