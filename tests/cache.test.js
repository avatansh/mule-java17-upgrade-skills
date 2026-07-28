// tests/cache.test.js — lib_shared/cache.js: the cross-process file-per-key disk cache backing the
// Anypoint token, Exchange matrix asset, and per-connector listVersions. Isolated under a temp
// MULE_UPGRADE_HOME so it never touches the real ~/.mule-upgrade/cache.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cached,
  readEntry,
  writeEntry,
  cacheEnabled,
  cacheDir,
  _cacheFileFor,
} from "../lib_shared/cache.js";

let tmpHome;
const NS = "unit";
const T0 = 1_000_000_000_000;

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mule-cache-"));
  process.env.MULE_UPGRADE_HOME = tmpHome;
});
after(() => {
  delete process.env.MULE_UPGRADE_HOME;
  delete process.env.MULE_UPGRADE_CACHE;
  delete process.env.MULE_UPGRADE_REFRESH;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
beforeEach(() => {
  // Clean slate + default (enabled, no forced refresh) before each case.
  delete process.env.MULE_UPGRADE_CACHE;
  delete process.env.MULE_UPGRADE_REFRESH;
  try {
    fs.rmSync(cacheDir(), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test("cacheDir honours MULE_UPGRADE_HOME", () => {
  assert.equal(cacheDir(), path.join(tmpHome, "cache"));
});

test("cached: miss runs fn + stores; hit within TTL returns cached without re-running", async () => {
  let calls = 0;
  const fn = async () => (++calls, { ok: true, n: calls });

  const a = await cached(NS, "k1", 10_000, fn, { now: T0 });
  assert.deepEqual(a, { ok: true, n: 1 });
  assert.equal(calls, 1);

  const b = await cached(NS, "k1", 10_000, fn, { now: T0 + 9_999 });
  assert.deepEqual(b, { ok: true, n: 1 }, "served from cache");
  assert.equal(calls, 1, "fn not re-run");
});

test("cached: entry past TTL re-runs fn", async () => {
  let calls = 0;
  const fn = async () => (++calls, { ok: true, n: calls });
  await cached(NS, "k2", 1_000, fn, { now: T0 });
  const again = await cached(NS, "k2", 1_000, fn, { now: T0 + 1_001 });
  assert.equal(calls, 2);
  assert.deepEqual(again, { ok: true, n: 2 });
});

test("cached: refresh:true bypasses the read but writes a fresh entry", async () => {
  let calls = 0;
  const fn = async () => (++calls, { ok: true, n: calls });
  await cached(NS, "k3", 10_000, fn, { now: T0 });
  const forced = await cached(NS, "k3", 10_000, fn, { now: T0 + 1, refresh: true });
  assert.equal(calls, 2, "refresh forced a live call");
  assert.deepEqual(forced, { ok: true, n: 2 });
  // The forced value is now the cached one:
  const next = await cached(NS, "k3", 10_000, fn, { now: T0 + 2 });
  assert.equal(calls, 2);
  assert.deepEqual(next, { ok: true, n: 2 });
});

test("cached: shouldCache=false result is NOT stored → next call re-runs", async () => {
  let calls = 0;
  const fn = async () => (++calls, { ok: false, reason: "transient" });
  const opts = { now: T0, shouldCache: (v) => v?.ok === true };
  await cached(NS, "k4", 10_000, fn, opts);
  await cached(NS, "k4", 10_000, fn, { ...opts, now: T0 + 1 });
  assert.equal(calls, 2, "failed result never pinned");
  assert.equal(fs.existsSync(_cacheFileFor(NS, "k4")), false);
});

test("cached: a throw in fn propagates and nothing is cached", async () => {
  const boom = async () => {
    throw new Error("network down");
  };
  await assert.rejects(() => cached(NS, "k5", 10_000, boom, { now: T0 }), /network down/);
  assert.equal(fs.existsSync(_cacheFileFor(NS, "k5")), false);
});

test("disabled via MULE_UPGRADE_CACHE=off: no read, no write", async () => {
  process.env.MULE_UPGRADE_CACHE = "off";
  assert.equal(cacheEnabled(), false);
  let calls = 0;
  const fn = async () => (++calls, { ok: true, n: calls });
  await cached(NS, "k6", 10_000, fn, { now: T0 });
  await cached(NS, "k6", 10_000, fn, { now: T0 + 1 });
  assert.equal(calls, 2, "every call is live when disabled");
  assert.equal(fs.existsSync(_cacheFileFor(NS, "k6")), false, "nothing written");
});

test("MULE_UPGRADE_REFRESH=1: reads are bypassed for every call", async () => {
  let calls = 0;
  const fn = async () => (++calls, { ok: true, n: calls });
  await cached(NS, "k7", 10_000, fn, { now: T0 }); // writes
  process.env.MULE_UPGRADE_REFRESH = "1";
  await cached(NS, "k7", 10_000, fn, { now: T0 + 1 }); // bypass read
  assert.equal(calls, 2);
});

test("readEntry: corrupt cache file is non-fatal (treated as a miss)", () => {
  const file = _cacheFileFor(NS, "k8");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not valid json");
  assert.equal(readEntry(NS, "k8", { ttlMs: 10_000, now: T0 }), undefined);
});

test("writeEntry/readEntry round-trip stores arbitrary JSON values", () => {
  writeEntry(NS, "k9", { versions: ["1.0.0", "1.1.0"], latest: "1.1.0" }, { ttlMs: 10_000, now: T0 });
  const v = readEntry(NS, "k9", { ttlMs: 10_000, now: T0 + 5 });
  assert.deepEqual(v, { versions: ["1.0.0", "1.1.0"], latest: "1.1.0" });
});

test("secret write is owner-only (0600) on POSIX", () => {
  if (process.platform === "win32") return; // NTFS has no POSIX mode bits
  writeEntry("anypoint-token", "kX", "bearer-abc", { ttlMs: 10_000, now: T0, secret: true });
  const mode = fs.statSync(_cacheFileFor("anypoint-token", "kX")).mode & 0o777;
  assert.equal(mode, 0o600);
});
