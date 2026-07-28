// tests/matrix_cache.test.js — release-notes disk cache (matrix-cache.json, ~24h TTL).
//   The split plan called for a "fetch once per run, cache to disk (~24h TTL)" mechanism around the
//   surviving per-URL release-notes fetcher. fetchReleaseNotesCached wraps fetchReleaseNotesHtml with
//   a per-URL JSON cache under the job-store home. It is PURELY a repeat-run latency optimisation and
//   is FULLY non-fatal — every failure mode degrades to a live fetch. These tests assert:
//     · a cold URL fetches live and persists the entry;
//     · a warm (fresh) URL is served from disk without hitting the network;
//     · an expired entry (older than ttl) re-fetches;
//     · a distinct URL is a separate key (no cross-clobber);
//     · a corrupt/absent cache file degrades to a live fetch (never throws);
//     · a live-fetch error propagates (callers already treat it as a per-connector non-fatal degrade)
//       and does NOT write a cache entry.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  fetchReleaseNotesCached,
  releaseNotesCachePath,
  RELEASE_NOTES_CACHE_TTL_MS,
} from "../skills/mule-upgrade-assess/scripts/lib/matrix_fetch.js";

let tmpHome;
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mule-cache-"));
  process.env.MULE_UPGRADE_HOME = tmpHome;
});
afterEach(() => {
  delete process.env.MULE_UPGRADE_HOME;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// A counting fake fetcher so we can assert exactly how many live fetches happened.
function counter(html = "<html>notes</html>") {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    return `${html}#${url}`;
  };
  return { fetchImpl, calls: () => calls };
}

const URL_A = "https://docs.mulesoft.com/release-notes/connector/http-connector-release-notes";
const URL_B = "https://docs.mulesoft.com/release-notes/connector/db-connector-release-notes";
const T0 = 1_700_000_000_000; // fixed epoch ms; clock is injected, so no Date.now dependence

test("cold URL fetches live and writes the cache file", async () => {
  const c = counter();
  const html = await fetchReleaseNotesCached(URL_A, { fetchImpl: c.fetchImpl, nowMs: T0 });
  assert.match(html, /notes/);
  assert.equal(c.calls(), 1);

  // the cache file now exists and holds the entry keyed by URL
  const doc = JSON.parse(fs.readFileSync(releaseNotesCachePath(), "utf8"));
  assert.ok(doc.entries[URL_A]);
  assert.equal(doc.entries[URL_A].fetchedAt, T0);
  assert.match(doc.entries[URL_A].html, /notes/);
});

test("warm (fresh) URL is served from disk without a live fetch", async () => {
  const c = counter();
  await fetchReleaseNotesCached(URL_A, { fetchImpl: c.fetchImpl, nowMs: T0 });
  assert.equal(c.calls(), 1);

  // second call, still inside the TTL window → cache hit, no second live fetch
  const again = await fetchReleaseNotesCached(URL_A, {
    fetchImpl: c.fetchImpl,
    nowMs: T0 + RELEASE_NOTES_CACHE_TTL_MS - 1,
  });
  assert.equal(c.calls(), 1, "no second live fetch within TTL");
  assert.match(again, /notes/);
});

test("expired entry (older than TTL) re-fetches live", async () => {
  const c = counter();
  await fetchReleaseNotesCached(URL_A, { fetchImpl: c.fetchImpl, nowMs: T0 });
  assert.equal(c.calls(), 1);

  // now past the TTL boundary → miss → re-fetch, and the entry is refreshed
  await fetchReleaseNotesCached(URL_A, {
    fetchImpl: c.fetchImpl,
    nowMs: T0 + RELEASE_NOTES_CACHE_TTL_MS + 1,
  });
  assert.equal(c.calls(), 2, "expired entry triggers a fresh fetch");
  const doc = JSON.parse(fs.readFileSync(releaseNotesCachePath(), "utf8"));
  assert.equal(doc.entries[URL_A].fetchedAt, T0 + RELEASE_NOTES_CACHE_TTL_MS + 1);
});

test("distinct URLs are independent keys — no cross-clobber", async () => {
  const c = counter();
  await fetchReleaseNotesCached(URL_A, { fetchImpl: c.fetchImpl, nowMs: T0 });
  await fetchReleaseNotesCached(URL_B, { fetchImpl: c.fetchImpl, nowMs: T0 });
  assert.equal(c.calls(), 2);

  const doc = JSON.parse(fs.readFileSync(releaseNotesCachePath(), "utf8"));
  assert.ok(doc.entries[URL_A] && doc.entries[URL_B], "both URLs cached side by side");

  // both are now warm → zero further live fetches
  await fetchReleaseNotesCached(URL_A, { fetchImpl: c.fetchImpl, nowMs: T0 + 5 });
  await fetchReleaseNotesCached(URL_B, { fetchImpl: c.fetchImpl, nowMs: T0 + 5 });
  assert.equal(c.calls(), 2, "both served from disk");
});

test("a custom ttlMs is honoured", async () => {
  const c = counter();
  await fetchReleaseNotesCached(URL_A, { fetchImpl: c.fetchImpl, nowMs: T0, ttlMs: 1000 });
  // 999ms later: still fresh
  await fetchReleaseNotesCached(URL_A, { fetchImpl: c.fetchImpl, nowMs: T0 + 999, ttlMs: 1000 });
  assert.equal(c.calls(), 1);
  // 1001ms later: expired
  await fetchReleaseNotesCached(URL_A, { fetchImpl: c.fetchImpl, nowMs: T0 + 1001, ttlMs: 1000 });
  assert.equal(c.calls(), 2);
});

test("a corrupt cache file degrades to a live fetch (never throws)", async () => {
  // seed garbage at the cache path
  fs.mkdirSync(path.dirname(releaseNotesCachePath()), { recursive: true });
  fs.writeFileSync(releaseNotesCachePath(), "{ this is not json");

  const c = counter();
  const html = await fetchReleaseNotesCached(URL_A, { fetchImpl: c.fetchImpl, nowMs: T0 });
  assert.match(html, /notes/);
  assert.equal(c.calls(), 1);
  // the write path rewrote the file into a valid doc
  const doc = JSON.parse(fs.readFileSync(releaseNotesCachePath(), "utf8"));
  assert.ok(doc.entries[URL_A]);
});

test("a live-fetch error propagates and writes NO cache entry", async () => {
  const boom = async () => {
    throw new Error("HTTP 503");
  };
  await assert.rejects(
    () => fetchReleaseNotesCached(URL_A, { fetchImpl: boom, nowMs: T0 }),
    /HTTP 503/
  );
  // no cache file (or no entry) was written for the failed URL
  let doc = { entries: {} };
  try {
    doc = JSON.parse(fs.readFileSync(releaseNotesCachePath(), "utf8"));
  } catch {
    /* no file at all is also acceptable */
  }
  assert.ok(!doc.entries[URL_A], "failed fetch must not be cached");
});

test("an unwritable home does not fail the fetch (write is non-fatal)", async () => {
  // point the home at a path whose PARENT is a file → mkdir/write will fail, fetch must still return
  const filePath = path.join(tmpHome, "not-a-dir");
  fs.writeFileSync(filePath, "x");
  process.env.MULE_UPGRADE_HOME = path.join(filePath, "sub"); // parent is a file → EEXIST/ENOTDIR

  const c = counter();
  const html = await fetchReleaseNotesCached(URL_A, { fetchImpl: c.fetchImpl, nowMs: T0 });
  assert.match(html, /notes/, "fetch succeeds even though the cache could not be written");
  assert.equal(c.calls(), 1);
});
