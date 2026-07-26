// lib/matrix_fetch.js — dynamic connector-version sourcing with disk cache + YAML fallback.
//
// User decision: fetch the latest Java-17-supported connector versions from a release-notes
// page (default the MuleSoft connector release-notes index), cache the result to disk with a
// ~24h TTL, and reuse it across assess + upgrade in one run. On ANY failure — network error,
// unparseable HTML, empty connector set — fall back to the bundled YAML connector list.
//
// IMPORTANT scope note: only CONNECTOR versions are fetched. Gating rules (runtime/java/munit/
// plugins), hygiene lists and manualReview flags do NOT live on the connector release-notes page,
// so they always stay static/authoritative from the bundled matrix (see mergeConnectors()).
//
// The HTML parser here is best-effort and deliberately conservative: it maps release-notes rows
// to the 16 KNOWN connector artifactIds and extracts a version string. If MuleSoft restructures
// the page, extraction yields nothing → we log a warning and degrade to the bundled list.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadBundledMatrix, mergeConnectors } from "./matrix.js";
import { get } from "../../../../lib_shared/config.js";
import { ExchangeClient, configFor } from "../../../../lib_shared/exchange.js";
import { AnypointClient } from "../../../mule-upgrade/scripts/lib/anypoint.js";

// Read a config value, swallowing lookup/decrypt errors → fallback.
function cfg(dotted, fallback) {
  try {
    const v = get(dotted, undefined);
    return v === undefined || v === null || v === "" ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * Try the Anypoint Exchange matrix source (pf-load-matrix Exchange branch). Returns the parsed
 * FULL matrix (gating + connectors) when `matrix.source` is exchange* and the fetch succeeds, else
 * null (caller falls through to the release-notes/bundled chain). NEVER throws.
 * @param {object} [exchange] injectable ExchangeClient (tests); else built from AnypointClient.
 */
export async function tryExchangeMatrix(exchange) {
  const source = String(configFor("matrix").source ?? "classpath");
  if (!source.startsWith("exchange")) return null;
  try {
    const client = exchange ?? new ExchangeClient({ anypoint: new AnypointClient() });
    const r = await client.fetchAsset("matrix");
    return r.ok ? { matrix: r.data, version: r.version, source: r.source } : { error: r.reason };
  } catch (e) {
    return { error: e?.message ?? String(e) };
  }
}

export const DEFAULT_RELEASE_NOTES_URL =
  "https://docs.mulesoft.com/release-notes/connector/anypoint-connector-release-notes";

const CACHE_DIR = path.join(os.homedir(), ".mule-upgrade");
const CACHE_FILE = path.join(CACHE_DIR, "matrix-cache.json");
const TTL_MS = 24 * 60 * 60 * 1000; // ~24h

/** Read the disk cache if present and fresh; else null. */
function readCache(nowMs) {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.fetchedAtMs !== "number") return null;
    if (nowMs - obj.fetchedAtMs > TTL_MS) return null;
    return obj;
  } catch {
    return null;
  }
}

/** Persist a cache entry (best-effort; failure is non-fatal). */
function writeCache(entry) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(entry, null, 2));
  } catch {
    /* cache is an optimisation; ignore write failures */
  }
}

/**
 * Best-effort extraction of {artifactId, set} pairs from release-notes HTML.
 * Strategy: for each known artifactId in the bundled matrix, find the nearest version-looking
 * token (X.Y.Z) on the same line / table row as a link or heading mentioning that artifactId.
 * This is intentionally forgiving; anything not confidently matched is simply omitted (→ the
 * bundled version is kept for that connector via mergeConnectors).
 */
export function parseConnectorVersions(html, knownConnectors) {
  if (!html || typeof html !== "string") return [];
  const out = [];
  const text = html.replace(/\r/g, "");
  for (const c of knownConnectors ?? []) {
    const art = String(c.artifactId ?? "");
    if (!art) continue;
    // Look at a window around the artifactId mention and grab the first semver in it.
    const idx = text.indexOf(art);
    if (idx === -1) continue;
    const window = text.slice(idx, idx + 400);
    const m = window.match(/\b(\d+\.\d+\.\d+)\b/);
    if (m) out.push({ artifactId: art, set: m[1] });
  }
  return out;
}

/**
 * Fetch the release-notes page. Uses Node's global fetch (Node 18+). Returns HTML text or
 * throws. Kept separate so tests can stub it.
 */
export async function fetchReleaseNotesHtml(url, { timeoutMs = 15000 } = {}) {
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
 * Resolve the matrix for a run: bundled static core + dynamic connectors (cache → fetch →
 * fallback). Returns { matrix, source, warnings }.
 *
 * @param {object} opts
 * @param {string} [opts.releaseNotesUrl] override URL
 * @param {number} [opts.nowMs] injected clock (tests) — defaults to Date.now()
 * @param {boolean} [opts.noFetch] skip network entirely (use cache-or-bundled)
 * @param {(url:string)=>Promise<string>} [opts.fetchHtml] injectable fetcher (tests)
 */
export async function resolveMatrix(opts = {}) {
  const warnings = [];
  const bundled = loadBundledMatrix();
  const url = opts.releaseNotesUrl || DEFAULT_RELEASE_NOTES_URL;
  const nowMs = typeof opts.nowMs === "number" ? opts.nowMs : Date.now();
  const fetchHtml = opts.fetchHtml || fetchReleaseNotesHtml;

  // 0) Anypoint Exchange governed matrix (pf-load-matrix Exchange branch) — highest priority when
  // matrix.source is exchange*. Returns the FULL authoritative matrix (gating + connectors); the
  // connectorless safety-net lives in ExchangeClient.fetchAsset. Any failure is non-fatal → fall
  // through to the release-notes/bundled chain below.
  if (String(cfg("matrix.source", "classpath")).startsWith("exchange")) {
    const ex = await tryExchangeMatrix(opts.exchange);
    if (ex && ex.matrix) {
      return { matrix: ex.matrix, source: `exchange:${ex.version}`, warnings };
    }
    if (ex && ex.error) {
      warnings.push(`Exchange matrix source failed (${ex.error}); falling back to release-notes/bundled matrix.`);
    }
  }

  // 1) fresh disk cache?
  const cached = readCache(nowMs);
  if (cached && Array.isArray(cached.connectors) && cached.connectors.length > 0) {
    return {
      matrix: mergeConnectors(bundled, cached.connectors),
      source: "cache",
      warnings,
    };
  }

  // 2) live fetch (unless disabled)
  if (!opts.noFetch) {
    try {
      const html = await fetchHtml(url);
      const connectors = parseConnectorVersions(html, bundled.connectors);
      if (connectors.length > 0) {
        writeCache({ fetchedAtMs: nowMs, url, connectors });
        return {
          matrix: mergeConnectors(bundled, connectors),
          source: "fetch",
          warnings,
        };
      }
      warnings.push(
        `Release-notes fetch from ${url} yielded no recognizable connector versions; using bundled matrix. The page structure may have changed — update parseConnectorVersions().`
      );
    } catch (err) {
      warnings.push(
        `Release-notes fetch from ${url} failed (${err?.message ?? err}); using bundled matrix.`
      );
    }
  }

  // 3) fallback: bundled connectors verbatim
  return { matrix: bundled, source: "bundled", warnings };
}
