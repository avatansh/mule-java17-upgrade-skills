// lib/osv.js — a small, cached, NON-FATAL client for OSV.dev (osv.dev/docs).
//
// Two endpoints, used the way the API intends:
//   POST /v1/querybatch  → for N (package, version) pairs, the vulnerability IDs affecting each. Cheap,
//                          one request per batch, and the response order is guaranteed to match input.
//   GET  /v1/vulns/{id}  → the full advisory (aliases/CVE, severity, fixed versions). One per ID.
//
// The split matters for cost: querybatch returns IDs only, and a single stale library can carry 60+ of
// them. Fetching every detail unbounded would turn one assessment into hundreds of requests, so details
// are pooled, capped, and cached HARD — an advisory's fixed-version list is effectively immutable, so a
// long TTL is correct rather than merely convenient. Batch results get a shorter TTL because new
// advisories land against unchanged versions all the time.
//
// EVERY failure is non-fatal and reported, never thrown: a CVE scan is advisory enrichment, and an
// OSV outage or an offline laptop must degrade to "not scanned" rather than fail an upgrade.

import { cached, readEntry, writeEntry } from "../../../../lib_shared/cache.js";
import { get } from "../../../../lib_shared/config.js";

/** Same read-with-fallback shape the other skills use, so config is optional but honoured. */
function cfg(dotted, fallback) {
  try {
    const v = get(dotted, undefined);
    return v === undefined || v === null || v === "" ? fallback : v;
  } catch {
    return fallback;
  }
}

const BASE = "https://api.osv.dev";
// Defaults, all overridable from config.yaml `cve:` so an operator can tune the scan without a code
// change — the same treatment batch.concurrency and the cache.*TtlSeconds knobs get.
const BATCH_TTL_MS = Number(cfg("cve.batchTtlSeconds", 21600)) * 1000; // 6h
const VULN_TTL_MS = Number(cfg("cve.vulnTtlSeconds", 604800)) * 1000; // 7d
const MAX_BATCH = 100; // OSV accepts more, but keep request bodies small and failures granular
const DEFAULT_MAX_VULN_DETAILS = Number(cfg("cve.maxVulnDetails", 250));
const DEFAULT_CONCURRENCY = Number(cfg("cve.concurrency", 8));

/** Maven coordinates → the OSV package name for the Maven ecosystem. */
export function osvPackageName(groupId, artifactId) {
  return `${String(groupId ?? "").trim()}:${String(artifactId ?? "").trim()}`;
}

/** Split a list into chunks of at most `size`. */
function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Normalise OSV severity into one bucket. GHSA advisories carry `database_specific.severity`
 * (CRITICAL/HIGH/MODERATE/LOW); other sources may only carry a CVSS vector, which is a STRING here, not
 * a number — so it can't be turned into a numeric score without a CVSS parser. Rather than invent a
 * score, an advisory with no stated severity is reported UNKNOWN, which is honest and still actionable.
 * @param {any} vuln
 * @returns {"CRITICAL"|"HIGH"|"MEDIUM"|"LOW"|"UNKNOWN"}
 */
export function severityOf(vuln) {
  const raw = String(vuln?.database_specific?.severity ?? "").toUpperCase();
  if (raw === "CRITICAL") return "CRITICAL";
  if (raw === "HIGH") return "HIGH";
  if (raw === "MODERATE" || raw === "MEDIUM") return "MEDIUM";
  if (raw === "LOW") return "LOW";
  return "UNKNOWN";
}

/** Rank for sorting/counting — higher is worse. */
export const SEVERITY_RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };

/**
 * Every `fixed` version an advisory lists for one Maven package, across ALL maintenance branches.
 *
 * An advisory can cover several packages, so entries are filtered by name; without that filter a
 * jackson-core advisory could contribute jackson-databind's fixed version.
 *
 * This is the "what fixes exist anywhere" list. It is NOT the answer to "what should THIS app upgrade
 * to" — see affectedIntervals() in cve_engine.js for why those differ.
 * @param {any} vuln
 * @param {string} pkgName  "groupId:artifactId"
 * @returns {string[]}
 */
export function fixedVersionsFor(vuln, pkgName) {
  const out = [];
  for (const aff of affectedEntriesFor(vuln, pkgName)) {
    for (const range of aff?.ranges ?? []) {
      for (const ev of range?.events ?? []) {
        if (ev?.fixed) out.push(String(ev.fixed));
      }
    }
  }
  return [...new Set(out)];
}

/**
 * The `affected` entries of an advisory that describe one Maven package.
 * @param {any} vuln
 * @param {string} pkgName
 * @returns {any[]}
 */
export function affectedEntriesFor(vuln, pkgName) {
  return (vuln?.affected ?? []).filter((aff) => {
    const name = String(aff?.package?.name ?? "");
    return !pkgName || !name || name === pkgName;
  });
}

/**
 * Create an OSV client.
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]  injected for tests
 * @param {boolean} [opts.refresh]         bypass the cache for this run
 * @param {number} [opts.maxVulnDetails]   cap on detail fetches (default config cve.maxVulnDetails, 250)
 * @param {number} [opts.concurrency]      detail fetches in flight (default config cve.concurrency, 8)
 */
export function OsvClient(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const refresh = opts.refresh === true;
  const maxVulnDetails = Number(opts.maxVulnDetails ?? DEFAULT_MAX_VULN_DETAILS);
  const concurrency = Math.max(1, Number(opts.concurrency ?? DEFAULT_CONCURRENCY));

  /** @returns {Promise<any>} */
  async function postJson(path, body) {
    const res = await fetchImpl(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OSV ${path} → ${res.status}`);
    return await res.json();
  }

  /** @returns {Promise<any>} */
  async function getJson(path) {
    const res = await fetchImpl(`${BASE}${path}`);
    if (!res.ok) throw new Error(`OSV ${path} → ${res.status}`);
    return await res.json();
  }

  return {
    configured() {
      return typeof fetchImpl === "function";
    },

    /**
     * IDs of the vulnerabilities affecting each (name, version) pair. Result order matches input.
     * Cached per PAIR, not per batch, so an app that shares libraries with the last app scanned reuses
     * those answers instead of re-querying — batch-level caching would miss on any change of set.
     * @param {Array<{name:string, version:string}>} pkgs
     * @returns {Promise<{ok:boolean, ids:string[][], reason?:string}>}
     */
    async queryBatch(pkgs) {
      const list = pkgs ?? [];
      if (!list.length) return { ok: true, ids: [] };
      const keyOf = (p) => `${p.name}@${p.version}`;
      /** @type {(string[]|null)[]} */
      const ids = new Array(list.length).fill(null);
      const misses = [];
      for (let i = 0; i < list.length; i++) {
        const hit = refresh ? undefined : readEntry("osv-batch", keyOf(list[i]), { ttlMs: BATCH_TTL_MS });
        if (Array.isArray(hit)) ids[i] = hit;
        else misses.push(i);
      }
      if (!misses.length) return { ok: true, ids: /** @type {string[][]} */ (ids) };

      try {
        for (const group of chunk(misses, MAX_BATCH)) {
          const json = await postJson("/v1/querybatch", {
            queries: group.map((i) => ({
              package: { ecosystem: "Maven", name: list[i].name },
              version: list[i].version,
            })),
          });
          const results = json?.results ?? [];
          for (let k = 0; k < group.length; k++) {
            const i = group[k];
            const found = (results[k]?.vulns ?? []).map((v) => String(v.id));
            ids[i] = found;
            // Cache per pair — including the empty "clean" answer, which is the common case and the most
            // valuable one not to re-ask. Per-pair (not per-batch) keying means a differently-composed
            // app still reuses every library it shares with the last scan.
            writeEntry("osv-batch", keyOf(list[i]), found, { ttlMs: BATCH_TTL_MS });
          }
        }
      } catch (e) {
        // Partial results are kept: pairs already answered (from cache or an earlier chunk) stay, the
        // rest read as empty, and ok:false tells the caller the picture is incomplete.
        return { ok: false, ids: ids.map((x) => x ?? []), reason: e?.message ?? String(e) };
      }
      return { ok: true, ids: ids.map((x) => x ?? []) };
    },

    /**
     * Full advisories for a set of IDs, bounded and pooled. Returns what it managed to fetch plus the
     * count it deliberately skipped, so the caller can say "showing 250 of 400" instead of quietly
     * under-reporting.
     * @param {string[]} idList
     * @returns {Promise<{vulns:Map<string,any>, skipped:number, warnings:string[]}>}
     */
    async fetchVulns(idList) {
      const unique = [...new Set((idList ?? []).filter(Boolean))];
      const take = unique.slice(0, maxVulnDetails);
      const skipped = unique.length - take.length;
      const vulns = new Map();
      const warnings = [];
      let next = 0;
      const worker = async () => {
        for (;;) {
          const i = next++;
          if (i >= take.length) return;
          const id = take[i];
          try {
            const v = /** @type {any} */ (
              await cached("osv-vuln", id, VULN_TTL_MS, () => getJson(`/v1/vulns/${encodeURIComponent(id)}`), {
                refresh,
                shouldCache: (x) => !!(/** @type {any} */ (x)?.id),
              })
            );
            if (v?.id) vulns.set(id, v);
          } catch (e) {
            warnings.push(`OSV detail fetch for ${id} failed: ${e?.message ?? e}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, take.length || 1) }, worker));
      if (skipped > 0) {
        warnings.push(
          `${unique.length} advisories matched but only the first ${take.length} were detailed ` +
            `(maxVulnDetails). Counts are complete; per-advisory detail is truncated.`
        );
      }
      return { vulns, skipped, warnings };
    },
  };
}
