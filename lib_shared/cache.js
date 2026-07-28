// lib_shared/cache.js — a tiny, cross-process, file-per-key disk cache.
//
// WHY: the interactive/agent paths repeat the SAME expensive network reads on every CLI run and every
// Vibes turn — the Anypoint bearer token, the Exchange compatibility-matrix asset, and (worst of all)
// one Exchange GraphQL `listVersions` pagination per connector. In-memory memoisation only helps the
// long-lived MCP server; a fresh `node …` process (CLI + Vibes skills) starts cold every time. This
// backs those reads with a small JSON file per key under ~/.mule-upgrade/cache so the SECOND run — in
// ANY process — is a local file read instead of a round-trip.
//
// DESIGN CHOICES:
//   • FILE-PER-KEY (not one big JSON doc). Concurrent writers (Promise.all over connectors) never do a
//     read-modify-write on a shared file, so entries can't clobber each other — the race that made the
//     old single-doc release-notes cache lose entries and re-fetch them next run.
//   • FULLY NON-FATAL. Every fs op is wrapped: a miss/expiry/corrupt-file/unwritable-dir just behaves
//     as "no cache" → live fetch. The cache can NEVER fail a caller.
//   • ONLY the caller decides what to store (shouldCache). We never cache a failed `{ok:false}` result,
//     so a transient outage doesn't get pinned for the whole TTL.
//   • CONTROLLABLE. `MULE_UPGRADE_CACHE=off` (or config `cache.enabled:false`) disables reads+writes;
//     `MULE_UPGRADE_REFRESH=1` (or a per-call `refresh:true`) bypasses reads for one forced refresh.
//   • Honours MULE_UPGRADE_HOME, exactly like the job store, so tests isolate it with a temp home.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { get } from "./config.js";

/** Read a config value, swallowing any decrypt/lookup error → fallback (matches the other libs). */
function cfg(dotted, fallback) {
  try {
    const v = get(dotted, undefined);
    return v === undefined || v === null || v === "" ? fallback : v;
  } catch {
    return fallback;
  }
}

const OFF_RE = /^(0|off|false|no)$/i;
const ON_RE = /^(1|on|true|yes)$/i;

/** Master switch: env `MULE_UPGRADE_CACHE=off` wins, else config `cache.enabled` (default true). */
export function cacheEnabled() {
  const envv = process.env.MULE_UPGRADE_CACHE;
  if (envv != null && OFF_RE.test(String(envv))) return false;
  if (envv != null && ON_RE.test(String(envv))) return true;
  return String(cfg("cache.enabled", "true")) !== "false";
}

/** Global one-shot refresh: `MULE_UPGRADE_REFRESH=1` forces a live fetch (writes fresh entries). */
function globalRefresh() {
  return ON_RE.test(String(process.env.MULE_UPGRADE_REFRESH ?? ""));
}

/** Cache root: config `cache.dir`, else <MULE_UPGRADE_HOME|~/.mule-upgrade>/cache. */
export function cacheDir() {
  const configured = cfg("cache.dir", "");
  if (configured) return String(configured);
  const home = process.env.MULE_UPGRADE_HOME || path.join(os.homedir(), ".mule-upgrade");
  return path.join(home, "cache");
}

/** Stable, filesystem-safe filename for a (namespace,key) pair — key is hashed so secrets/URLs stay opaque. */
function keyFile(ns, key) {
  const safeNs = String(ns).replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40);
  const h = crypto.createHash("sha256").update(`${ns}\u0000${key}`).digest("hex").slice(0, 32);
  return path.join(cacheDir(), `${safeNs}-${h}.json`);
}

/**
 * readEntry(ns, key, {now, ttlMs}) → the cached value, or undefined on miss/expiry/disabled/error.
 * TTL precedence: explicit `ttlMs` arg wins, else the ttl stored with the entry. A non-finite maxAge
 * means "never expires" (rare — every caller passes a ttl).
 * @param {string} ns
 * @param {string} key
 * @param {{now?:number, ttlMs?:number}} [opts]
 */
export function readEntry(ns, key, { now = Date.now(), ttlMs } = {}) {
  if (!cacheEnabled() || globalRefresh()) return undefined;
  try {
    const doc = JSON.parse(fs.readFileSync(keyFile(ns, key), "utf8"));
    if (!doc || typeof doc !== "object" || !Number.isFinite(doc.fetchedAt)) return undefined;
    const maxAge = Number.isFinite(ttlMs) ? ttlMs : doc.ttlMs;
    if (Number.isFinite(maxAge) && now - doc.fetchedAt >= maxAge) return undefined;
    return doc.value;
  } catch {
    return undefined;
  }
}

/**
 * writeEntry(ns, key, value, {now, ttlMs, secret}) — persist atomically (temp + rename). `secret:true`
 * writes owner-only (0600) so a cached bearer token isn't world-readable. Non-fatal (swallows errors).
 * @param {string} ns
 * @param {string} key
 * @param {any} value
 * @param {{now?:number, ttlMs?:number, secret?:boolean}} [opts]
 */
export function writeEntry(ns, key, value, { now = Date.now(), ttlMs, secret = false } = {}) {
  if (!cacheEnabled()) return;
  try {
    const dir = cacheDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = keyFile(ns, key);
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const mode = secret ? 0o600 : 0o644;
    fs.writeFileSync(tmp, JSON.stringify({ ns, fetchedAt: now, ttlMs, value }), { mode });
    fs.renameSync(tmp, file);
    if (secret) {
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* best-effort on platforms without POSIX perms */
      }
    }
  } catch {
    /* non-fatal — a failed write just means the next run re-fetches */
  }
}

/**
 * cached(ns, key, ttlMs, fn, opts) — the high-level helper: return a fresh cached value, else run
 * `fn()` (live), store it, and return it. A live-fetch throw propagates unchanged (callers already
 * treat that as a per-item non-fatal degrade). `shouldCache(value)` gates what gets persisted — pass
 * `v => v?.ok === true` to never cache a failed result.
 *
 * @template T
 * @param {string} ns
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => Promise<T>} fn
 * @param {{refresh?:boolean, now?:number, secret?:boolean, shouldCache?:(v:T)=>boolean}} [opts]
 * @returns {Promise<T>}
 */
export async function cached(ns, key, ttlMs, fn, opts = {}) {
  const now = opts.now ?? Date.now();
  if (!opts.refresh) {
    const hit = readEntry(ns, key, { now, ttlMs });
    if (hit !== undefined) return hit;
  }
  const value = await fn();
  if (!opts.shouldCache || opts.shouldCache(value)) {
    writeEntry(ns, key, value, { now, ttlMs, secret: opts.secret });
  }
  return value;
}

/** Test/diagnostic hook: absolute path of the file backing a (namespace,key). */
export function _cacheFileFor(ns, key) {
  return keyFile(ns, key);
}
