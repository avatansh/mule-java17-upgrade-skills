// lib/matrix_fetch.js — matrix sourcing: Anypoint Exchange governed matrix → bundled YAML fallback.
//
// The compatibility matrix is loaded from ONE of two sources, in priority order:
//   1. the Anypoint Exchange governed matrix (when matrix.source=exchange*) — the FULL authoritative
//      matrix (gating + connectors), fetched via ExchangeClient.fetchAsset. Any failure is non-fatal.
//   2. the bundled classpath YAML (loadBundledMatrix) — curated, Java-17-safe, always available.
//
// B3 (retired): earlier this module ALSO scraped the connector release-notes INDEX page and used a
// crude artifactId `indexOf` + nearest-semver heuristic to override connector `set` pins, cached to
// ~/.mule-upgrade/matrix-cache.json. That path was unreliable (the index page is relevance-ordered
// and carries no coordinates) and is now SUPERSEDED by resolve_versions.js, which resolves each
// connector's versions precisely via the Exchange Graph API + the curated connector-notes-map. The
// index scrape + disk cache have been removed; connector-version enrichment lives in resolveVersions.
//
// `fetchReleaseNotesHtml` remains here (a plain per-URL fetcher) because resolveVersions uses it to
// pull each connector's OWN release-notes compatibility table.
//
// DISK CACHE (matrix-cache.json, ~24h TTL): `fetchReleaseNotesCached` wraps the plain fetcher with a
// per-URL disk cache under the job-store home (~/.mule-upgrade/, MULE_UPGRADE_HOME override). This is
// PURELY a repeat-run latency optimisation (a multi-connector assess + a follow-up upgrade hit the
// same release-notes pages) — it is FULLY non-fatal: a missing/corrupt cache file, an unwritable dir,
// or a stale entry simply degrades to a live fetch. It is the disk cache the split plan called for;
// the earlier B3 index-scrape cache was retired, this replaces it around the surviving per-URL fetch.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadBundledMatrix } from "./matrix.js";
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

// Verbose fetch/parse diagnostics go to stderr ONLY when debugging (LOG_LEVEL=debug or
// MULE_UPGRADE_DEBUG set). User-facing `warnings` stays a single clean line — the raw YAML/HTML
// parser exception is noise in a chat transcript, useful only when actually debugging the parser.
function debugLog(msg) {
  const lvl = String(process.env.LOG_LEVEL || "").toLowerCase();
  if (lvl === "debug" || process.env.MULE_UPGRADE_DEBUG) {
    process.stderr.write(`[matrix_fetch] ${msg}\n`);
  }
}

/**
 * Try the Anypoint Exchange matrix source (pf-load-matrix Exchange branch). Returns the parsed
 * FULL matrix (gating + connectors) when `matrix.source` is exchange* and the fetch succeeds, else
 * null (caller falls through to the release-notes/bundled chain). NEVER throws.
 * @param {any} [exchange] injectable ExchangeClient (tests); else built from AnypointClient.
 * @returns {Promise<any>}
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

/**
 * Fetch a release-notes page. Uses Node's global fetch (Node 18+). Returns HTML text or throws.
 * Kept separate so tests can stub it and so resolve_versions.js can pull each connector's OWN
 * compatibility table (per the connector-notes-map).
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

// ── release-notes disk cache (matrix-cache.json, ~24h TTL) ──────────────────────────────────────
// A single JSON file keyed by URL: { entries: { <url>: { html, fetchedAt (epoch ms) } } }. Kept in
// the job-store home so it shares the run's ~/.mule-upgrade/ workspace and honours MULE_UPGRADE_HOME.
// Every operation is wrapped in try/catch → the cache can NEVER fail an assessment; on any error we
// behave as though the cache were empty/absent and fall back to a live fetch.

/** Default entry lifetime: 24h in ms. Release-notes pages change on the order of weeks. */
export const RELEASE_NOTES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Absolute path to the release-notes cache file (honours MULE_UPGRADE_HOME, like the job store). */
export function releaseNotesCachePath() {
  const home = process.env.MULE_UPGRADE_HOME || path.join(os.homedir(), ".mule-upgrade");
  return path.join(home, "matrix-cache.json");
}

/** Read the whole cache doc; non-fatal → {} on any missing/corrupt/unreadable file. */
function readCacheDoc() {
  try {
    const doc = JSON.parse(fs.readFileSync(releaseNotesCachePath(), "utf8"));
    return doc && typeof doc === "object" && doc.entries ? doc : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

/** Persist the cache doc atomically (temp + rename); non-fatal → swallow write errors. */
function writeCacheDoc(doc) {
  try {
    const file = releaseNotesCachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    debugLog(`release-notes cache write failed (non-fatal): ${e?.message ?? e}`);
  }
}

/**
 * fetchReleaseNotesCached(url, opts): the disk-cached front-end to fetchReleaseNotesHtml. Returns
 * cached HTML when a fresh (< ttlMs old) entry for `url` exists; otherwise fetches live, stores the
 * result, and returns it. FULLY non-fatal — a cache miss/expiry/error just triggers a live fetch, and
 * a live-fetch throw propagates exactly as the plain fetcher's would (callers already treat that as a
 * per-connector non-fatal degrade). `nowMs`/`fetch` are injectable for tests (no Date.now in prod path
 * is fine here — this is not a workflow script).
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.ttlMs]       entry lifetime (default 24h)
 * @param {number} [opts.timeoutMs]   forwarded to the live fetch
 * @param {number} [opts.nowMs]       clock override for tests (default Date.now())
 * @param {(url:string, o?:object)=>Promise<string>} [opts.fetchImpl]  live fetcher (default fetchReleaseNotesHtml)
 * @returns {Promise<string>}
 */
export async function fetchReleaseNotesCached(url, opts = {}) {
  const ttlMs = opts.ttlMs ?? RELEASE_NOTES_CACHE_TTL_MS;
  const now = opts.nowMs ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetchReleaseNotesHtml;

  const doc = readCacheDoc();
  const hit = doc.entries?.[url];
  if (hit && typeof hit.html === "string" && Number.isFinite(hit.fetchedAt) && now - hit.fetchedAt < ttlMs) {
    debugLog(`release-notes cache hit for ${url} (age ${Math.round((now - hit.fetchedAt) / 1000)}s)`);
    return hit.html;
  }

  const html = await fetchImpl(url, { timeoutMs: opts.timeoutMs });
  // Store on success only. Re-read before write so concurrent connectors don't clobber each other's
  // entries (last-writer-wins per URL is fine; we only ever ADD/refresh, never delete other keys).
  const fresh = readCacheDoc();
  fresh.entries = fresh.entries ?? {};
  fresh.entries[url] = { html, fetchedAt: now };
  writeCacheDoc(fresh);
  return html;
}

/**
 * Resolve the matrix for a run: Anypoint Exchange governed matrix (when configured) → bundled YAML.
 * Returns { matrix, source, warnings }. Connector-version ENRICHMENT (latest-in-major, first-Java-17)
 * is NOT done here — that lives in resolve_versions.js (Exchange Graph + connector-notes-map).
 *
 * @param {object} opts
 * @param {boolean} [opts.noFetch]   skip the Exchange source attempt (straight to bundled)
 * @param {any}     [opts.exchange]  injectable ExchangeClient (tests); else built from AnypointClient
 */
export async function resolveMatrix(opts = {}) {
  const warnings = [];
  const bundled = loadBundledMatrix();

  // Anypoint Exchange governed matrix (pf-load-matrix Exchange branch) — used when matrix.source is
  // exchange*. Returns the FULL authoritative matrix (gating + connectors); the connectorless
  // safety-net lives in ExchangeClient.fetchAsset. Any failure is non-fatal → fall back to bundled.
  // Verbose detail goes to debugLog (LOG_LEVEL=debug); the user-facing warning is one clean line.
  if (!opts.noFetch && String(cfg("matrix.source", "classpath")).startsWith("exchange")) {
    const ex = await tryExchangeMatrix(opts.exchange);
    if (ex && ex.matrix) {
      return { matrix: ex.matrix, source: `exchange:${ex.version}`, warnings };
    }
    if (ex && ex.error) {
      debugLog(`Exchange matrix source failed (${ex.error}); falling back to the bundled matrix.`);
      warnings.push(
        "Live matrix fetch unavailable — using the bundled compatibility matrix (curated, Java-17-safe). " +
          "Set LOG_LEVEL=debug for details."
      );
    }
  }

  return { matrix: bundled, source: "bundled", warnings };
}
