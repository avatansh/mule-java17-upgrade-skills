// tests/health.test.js — health & metrics snapshots over an injected job store.
// Deterministic: listJobs / nowMs / startMs are injected so no real store or clock is touched.
import { test } from "node:test";
import assert from "node:assert/strict";

import { healthSnapshot, metricsSnapshot } from "../server/lib/health.js";

const SAMPLE = [
  {
    jobId: "j1",
    status: "PROCESSING",
    environment: "dev",
    createdAt: "2026-07-26T11:00:00Z",
    updatedAt: "2026-07-26T11:00:00Z",
  },
  { jobId: "j2", status: "PR_OPEN", environment: "dev", updatedAt: "2026-07-26T11:30:00Z" },
  { jobId: "j3", status: "DEPLOYED", environment: "prod", updatedAt: "2026-07-26T10:00:00Z" },
  { jobId: "j4", status: "DEPLOYING", environment: "prod", updatedAt: "2026-07-26T11:50:00Z" },
];
const NOW = Date.parse("2026-07-26T12:00:00Z");
const START = Date.parse("2026-07-26T11:00:00Z");

test("healthSnapshot: ok + total/active job counts", () => {
  const h = healthSnapshot({ listJobs: () => SAMPLE, nowMs: NOW, startMs: START });
  assert.equal(h.ok, true);
  assert.ok(h.service);
  assert.ok(h.version);
  assert.equal(h.jobs.total, 4);
  // active = non-terminal: PROCESSING (j1) + DEPLOYING (j4). PR_OPEN & DEPLOYED are terminal.
  assert.equal(h.jobs.active, 2);
  assert.equal(h.uptimeSeconds, 3600);
});

test("healthSnapshot: store error → zero counts, still ok", () => {
  const h = healthSnapshot({
    listJobs: () => {
      throw new Error("store unreadable");
    },
    nowMs: NOW,
    startMs: START,
  });
  assert.equal(h.ok, true);
  assert.equal(h.jobs.total, 0);
  assert.equal(h.jobs.active, 0);
});

test("metricsSnapshot: status histogram + environment breakdown + oldest active age", () => {
  const m = metricsSnapshot({ listJobs: () => SAMPLE, nowMs: NOW, startMs: START });
  assert.deepEqual(m.metrics.byStatus, {
    PROCESSING: 1,
    PR_OPEN: 1,
    DEPLOYED: 1,
    DEPLOYING: 1,
  });
  assert.deepEqual(m.metrics.byEnvironment, { dev: 2, prod: 2 });
  // oldest active = j1 @ 11:00:00 (PROCESSING); j4 is 11:50. NOW=12:00 → 3600s.
  assert.equal(m.metrics.oldestActiveAgeSeconds, 3600);
  // carries the health fields too
  assert.equal(m.jobs.total, 4);
});

test("metricsSnapshot: no active jobs → oldestActiveAgeSeconds null", () => {
  const m = metricsSnapshot({
    listJobs: () => [
      { jobId: "x", status: "DEPLOYED", environment: "dev", updatedAt: "2026-07-26T10:00:00Z" },
    ],
    nowMs: NOW,
    startMs: START,
  });
  assert.equal(m.metrics.oldestActiveAgeSeconds, null);
});

test("metricsSnapshot: empty store → empty histograms, total 0", () => {
  const m = metricsSnapshot({ listJobs: () => [], nowMs: NOW, startMs: START });
  assert.deepEqual(m.metrics.byStatus, {});
  assert.deepEqual(m.metrics.byEnvironment, {});
  assert.equal(m.metrics.oldestActiveAgeSeconds, null);
  assert.equal(m.jobs.total, 0);
});

// ── B5: MUNIT_FAILED / DEP_GUARD_FAILED are resumable PARK states → counted ACTIVE, not terminal ──
test("healthSnapshot: parked MUNIT_FAILED/DEP_GUARD_FAILED count as active (resumable)", () => {
  const parked = [
    { jobId: "p1", status: "MUNIT_FAILED", environment: "dev", updatedAt: "2026-07-26T11:10:00Z" },
    { jobId: "p2", status: "DEP_GUARD_FAILED", environment: "dev", updatedAt: "2026-07-26T11:20:00Z" },
    { jobId: "p3", status: "DEPLOYED", environment: "dev", updatedAt: "2026-07-26T10:00:00Z" }, // terminal
  ];
  const h = healthSnapshot({ listJobs: () => parked, nowMs: NOW, startMs: START });
  assert.equal(h.jobs.total, 3);
  assert.equal(h.jobs.active, 2, "both park states are in-flight; DEPLOYED is terminal");
  // and the oldest-active smell test sees the parked job, not just fresh work.
  const m = metricsSnapshot({ listJobs: () => parked, nowMs: NOW, startMs: START });
  assert.equal(m.metrics.oldestActiveAgeSeconds, 3000, "oldest active = MUNIT_FAILED @ 11:10");
});
