// tests/scan_notify.test.js — the proactive push: diff-against-remembered-state and the
// change-driven Slack notification. scanFleet, slackNotify, and the state load/save are all injected
// so nothing touches the real platform, Slack, or disk.
import { test } from "node:test";
import assert from "node:assert/strict";

import { diffAgainst, scanAndNotify } from "../skills/mule-upgrade-scan/scripts/scan_notify.js";

// candidate factory
function cand(appName, reasons, extra = {}) {
  return { appName, reasons, needsCoordinates: true, owner: null, repo: null, environments: ["Production"], ...extra };
}
function reportOf(candidates, extra = {}) {
  return {
    configured: true,
    coverage: "amc",
    totalApps: candidates.length + 5,
    staleApps: candidates.length,
    environmentsScanned: ["Production"],
    candidates,
    warnings: [],
    ...extra,
  };
}

// in-memory state + notify capture
function harness({ initialKnown = {}, report, notifySent = true }) {
  const store = { known: initialKnown, lastRun: null };
  const sent = [];
  const deps = {
    scan: async () => report,
    notify: async (msg) => { sent.push(msg); return { sent: notifySent }; },
    load: () => store,
    save: (s) => { harness._saved = s; store.known = s.known; store.lastRun = s.lastRun; return true; },
    now: () => "2026-07-26T00:00:00Z",
  };
  return { deps, sent, store };
}

// ── diffAgainst ──────────────────────────────────────────────────────────────────────────────
test("diffAgainst partitions new / changed / resolved / stillStale", () => {
  const known = {
    "orders-api": { sig: "orders-api::Mule 4.4.0 is older than 4.5.0", reasons: ["Mule 4.4.0 is older than 4.5.0"] },
    "gone-app": { sig: "gone-app::x", reasons: ["x"] },
  };
  const candidates = [
    cand("orders-api", ["Mule 4.4.0 is older than 4.5.0"]),           // unchanged → stillStale
    cand("new-app", ["Java 8 is older than 17"]),                      // never seen → newlyStale
    cand("orders-api-2", ["Java 11 is older than 17"]),                // never seen → newlyStale
  ];
  const d = diffAgainst(known, candidates);
  assert.deepEqual(d.newlyStale.map((c) => c.appName).sort(), ["new-app", "orders-api-2"]);
  assert.deepEqual(d.stillStale.map((c) => c.appName), ["orders-api"]);
  assert.deepEqual(d.resolved, ["gone-app"]);
  assert.equal(d.changed.length, 0);
});

test("diffAgainst detects a changed staleness reason", () => {
  const known = { "app": { sig: "app::Java 11 is older than 17", reasons: ["Java 11 is older than 17"] } };
  const candidates = [cand("app", ["Mule 4.4.0 is older than 4.5.0", "Java 8 is older than 17"])];
  const d = diffAgainst(known, candidates);
  assert.equal(d.changed.length, 1);
  assert.equal(d.newlyStale.length, 0);
  assert.equal(d.stillStale.length, 0);
});

// ── scanAndNotify: first run pushes everything ─────────────────────────────────────────────────
test("scanAndNotify: first run (empty state) notifies all stale apps and persists baseline", async () => {
  const report = reportOf([cand("orders-api", ["Mule 4.4.0 is older than 4.5.0"]), cand("billing", ["Java 8 is older than 17"])]);
  const { deps, sent, store } = harness({ report });
  const r = await scanAndNotify({ deps });
  assert.equal(r.configured, true);
  assert.equal(r.notified, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(r.delta.newlyStale.sort(), ["billing", "orders-api"]);
  // baseline persisted with both apps
  assert.deepEqual(Object.keys(store.known).sort(), ["billing", "orders-api"]);
  assert.equal(store.known["orders-api"].firstSeen, "2026-07-26T00:00:00Z");
});

// ── scanAndNotify: no change → no push ─────────────────────────────────────────────────────────
test("scanAndNotify: identical findings on a re-run do NOT re-notify", async () => {
  const candidates = [cand("orders-api", ["Mule 4.4.0 is older than 4.5.0"])];
  const report = reportOf(candidates);
  const initialKnown = {
    "orders-api": { sig: "orders-api::Mule 4.4.0 is older than 4.5.0", reasons: ["Mule 4.4.0 is older than 4.5.0"], firstSeen: "2026-07-01T00:00:00Z" },
  };
  const { deps, sent } = harness({ initialKnown, report });
  const r = await scanAndNotify({ deps });
  assert.equal(r.hasChange, false);
  assert.equal(r.notified, false);
  assert.equal(sent.length, 0);
});

// ── scanAndNotify: --always-notify sends full digest even with no change ───────────────────────
test("scanAndNotify: alwaysNotify pushes the full list even when nothing changed", async () => {
  const candidates = [cand("orders-api", ["Mule 4.4.0 is older than 4.5.0"])];
  const report = reportOf(candidates);
  const initialKnown = {
    "orders-api": { sig: "orders-api::Mule 4.4.0 is older than 4.5.0", reasons: ["Mule 4.4.0 is older than 4.5.0"], firstSeen: "2026-07-01T00:00:00Z" },
  };
  const { deps, sent } = harness({ initialKnown, report });
  const r = await scanAndNotify({ deps, alwaysNotify: true });
  assert.equal(r.notified, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /fleet scan/i);
});

// ── scanAndNotify: resolved apps are announced and dropped from the baseline ────────────────────
test("scanAndNotify: an upgraded app is announced resolved and removed from state", async () => {
  const report = reportOf([]); // nothing stale anymore
  const initialKnown = {
    "orders-api": { sig: "orders-api::Mule 4.4.0 is older than 4.5.0", reasons: ["Mule 4.4.0 is older than 4.5.0"], firstSeen: "2026-07-01T00:00:00Z" },
  };
  const { deps, sent, store } = harness({ initialKnown, report });
  const r = await scanAndNotify({ deps });
  assert.deepEqual(r.delta.resolved, ["orders-api"]);
  assert.equal(r.notified, true);
  assert.match(sent[0], /Resolved since last scan/i);
  assert.deepEqual(Object.keys(store.known), []); // dropped so it can re-alert if it regresses
});

// ── scanAndNotify: not configured → clean no-op, no notify, no clobber ─────────────────────────
test("scanAndNotify: unconfigured platform is a clean no-op", async () => {
  const report = { configured: false, note: "Anypoint is not configured.", candidates: [], totalApps: 0, staleApps: 0 };
  const { deps, sent } = harness({ report });
  const r = await scanAndNotify({ deps });
  assert.equal(r.configured, false);
  assert.equal(r.notified, false);
  assert.equal(sent.length, 0);
});

// ── scanAndNotify: dry-run computes the message but neither sends nor persists ─────────────────
test("scanAndNotify: dryRun builds the message but does not send or persist", async () => {
  const report = reportOf([cand("orders-api", ["Mule 4.4.0 is older than 4.5.0"])]);
  const { deps, sent, store } = harness({ report });
  const r = await scanAndNotify({ deps, dryRun: true });
  assert.equal(r.notified, false);
  assert.equal(r.notifyResult.skipped, "dry-run");
  assert.ok(r.message && r.message.length > 0);
  assert.equal(sent.length, 0);
  assert.deepEqual(Object.keys(store.known), []); // untouched
});
