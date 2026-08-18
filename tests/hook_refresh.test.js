// tests/hook_refresh.test.js - the gating policy behind the Cursor hooks that replace the inbound
// GitHub webhook.
//
// The hook runs on sessionStart and before EVERY prompt, and a reconcile sweep makes real GitHub calls,
// so the policy is the whole safety story. Invariants locked here:
//   - no jobs in flight -> no GitHub call at all (the steady state must be free)
//   - terminal jobs don't count as in flight (they can never change again)
//   - the debounce floor holds, so a chatty session cannot burn the rate limit
//   - first run is never debounced (lastRunMs = 0)
//   - disabled config (and the MULE_UPGRADE_HOOKS=off kill switch) short-circuits everything
//   - the stamp is written BEFORE the sweep, so two quick prompts can't both slip through
//   - beforeSubmitPrompt uses the tighter ceiling; sessionStart gets the generous one
//   - a hanging reconcile loses the race instead of stalling the prompt
//   - a throwing reconcile is reported, never propagated (a hook must not break a prompt)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldRefresh,
  inFlightJobs,
  runHookRefresh,
  formatHookOutcome,
  timeoutForEvent,
} from "../skills/mule-upgrade-job/scripts/lib/hook_refresh.js";

const NOW = 1_700_000_000_000;
const inflight = [{ jobId: "j1", status: "PR_OPEN" }];

/** In-memory state stubs so no test touches the real ~/.mule-upgrade. */
function stateStub(initial = 0) {
  let s = { lastRunMs: initial, lastResult: null };
  return {
    readState: () => s,
    writeState: (next) => {
      s = next;
      return true;
    },
    peek: () => s,
  };
}

// -- in-flight detection ------------------------------------------------------------------------
test("inFlightJobs counts only non-terminal jobs", () => {
  const jobs = [
    { jobId: "a", status: "PR_OPEN" },
    { jobId: "b", status: "DEPLOYING" },
    { jobId: "c", status: "DEPLOYED" }, // terminal
    { jobId: "d", status: "CLOSED" }, // terminal
    { jobId: "e", status: "FAILED_COMMIT" }, // terminal
    { jobId: "f", status: "MUNIT_FAILED" }, // parked but still movable
  ];
  assert.deepEqual(
    inFlightJobs(jobs).map((j) => j.jobId),
    ["a", "b", "f"]
  );
});

test("inFlightJobs tolerates junk records and an absent list", () => {
  assert.equal(inFlightJobs(undefined).length, 0);
  assert.equal(inFlightJobs([null, {}, { status: "" }]).length, 0);
});

// -- the gate -----------------------------------------------------------------------------------
test("no jobs in flight -> skip (the steady state costs nothing)", () => {
  const d = shouldRefresh({ jobs: [{ status: "DEPLOYED" }], nowMs: NOW });
  assert.equal(d.run, false);
  assert.match(d.reason, /no jobs in flight/);
});

test("in-flight job with no prior run -> refresh", () => {
  const d = shouldRefresh({ jobs: inflight, nowMs: NOW, lastRunMs: 0 });
  assert.equal(d.run, true);
  assert.equal(d.inFlight, 1);
});

test("debounce blocks a second refresh inside the floor and reports the wait", () => {
  const d = shouldRefresh({
    jobs: inflight,
    nowMs: NOW,
    lastRunMs: NOW - 10_000, // 10s ago, floor 45s
    minIntervalSeconds: 45,
  });
  assert.equal(d.run, false);
  assert.match(d.reason, /debounced/);
  assert.equal(d.waitSeconds, 35);
});

test("debounce releases once the floor has elapsed", () => {
  const d = shouldRefresh({
    jobs: inflight,
    nowMs: NOW,
    lastRunMs: NOW - 46_000,
    minIntervalSeconds: 45,
  });
  assert.equal(d.run, true);
});

test("minIntervalSeconds 0 disables the debounce without breaking the gate", () => {
  const d = shouldRefresh({
    jobs: inflight,
    nowMs: NOW,
    lastRunMs: NOW - 1,
    minIntervalSeconds: 0,
  });
  assert.equal(d.run, true);
});

test("disabled -> skip regardless of in-flight work", () => {
  const d = shouldRefresh({ jobs: inflight, nowMs: NOW, enabled: false });
  assert.equal(d.run, false);
  assert.match(d.reason, /disabled/);
});

// -- per-event timeout ceiling ------------------------------------------------------------------
test("beforeSubmitPrompt gets the tighter ceiling; other events get the generous one", () => {
  const s = { timeoutMs: 8000, promptTimeoutMs: 3000 };
  assert.equal(timeoutForEvent("beforeSubmitPrompt", s), 3000, "the user is waiting on their prompt");
  assert.equal(timeoutForEvent("sessionStart", s), 8000, "a one-off catch-up may take longer");
  assert.equal(timeoutForEvent(undefined, s), 8000);
});

test("timeoutForEvent falls back to timeoutMs when promptTimeoutMs is unset", () => {
  assert.equal(timeoutForEvent("beforeSubmitPrompt", { timeoutMs: 8000 }), 8000);
});

test("the prompt ceiling is actually applied by runHookRefresh", async () => {
  const st = stateStub(0);
  const r = await runHookRefresh({
    settings: {
      enabled: true,
      staleSeconds: 60,
      minIntervalSeconds: 0,
      timeoutMs: 60_000,
      promptTimeoutMs: 30,
    },
    event: "beforeSubmitPrompt",
    nowMs: NOW,
    listJobs: () => inflight,
    runReconcile: () => new Promise(() => {}),
    readState: st.readState,
    writeState: st.writeState,
  });
  assert.equal(r.timedOut, true);
  assert.match(r.reason, /30ms/, "must use the prompt ceiling, not the 60s sessionStart one");
});

// -- runHookRefresh: the safety properties that keep a prompt unblocked -------------------------
const settings = { enabled: true, staleSeconds: 60, minIntervalSeconds: 45, timeoutMs: 50 };

test("runs the sweep and reports what it advanced", async () => {
  const st = stateStub(0);
  const r = await runHookRefresh({
    settings,
    nowMs: NOW,
    listJobs: () => inflight,
    runReconcile: async () => ({ scanned: 3, fixed: 1, actions: [], checks: [] }),
    readState: st.readState,
    writeState: st.writeState,
  });
  assert.equal(r.ran, true);
  assert.equal(r.scanned, 3);
  assert.equal(r.fixed, 1);
  assert.match(formatHookOutcome(r), /refreshed - scanned 3, advanced 1/);
});

test("skips the sweep entirely when nothing is in flight", async () => {
  let called = false;
  const st = stateStub(0);
  const r = await runHookRefresh({
    settings,
    nowMs: NOW,
    listJobs: () => [{ jobId: "x", status: "DEPLOYED" }],
    runReconcile: async () => {
      called = true;
      return {};
    },
    readState: st.readState,
    writeState: st.writeState,
  });
  assert.equal(r.ran, false);
  assert.equal(called, false, "a terminal-only store must not trigger a GitHub call");
  assert.match(formatHookOutcome(r), /^skip - /);
});

test("stamps the state BEFORE sweeping, so a concurrent prompt is debounced out", async () => {
  const st = stateStub(0);
  let stampAtSweepTime = null;
  await runHookRefresh({
    settings,
    nowMs: NOW,
    listJobs: () => inflight,
    runReconcile: async () => {
      stampAtSweepTime = st.peek().lastRunMs; // what a second hook process would read right now
      return { scanned: 1, fixed: 0 };
    },
    readState: st.readState,
    writeState: st.writeState,
  });
  assert.equal(stampAtSweepTime, NOW, "the stamp must already be set while the sweep is running");
});

test("a hanging reconcile loses the race instead of stalling the prompt", async () => {
  const st = stateStub(0);
  const started = Date.now();
  const r = await runHookRefresh({
    settings, // timeoutMs: 50
    nowMs: NOW,
    listJobs: () => inflight,
    runReconcile: () => new Promise(() => {}), // never settles
    readState: st.readState,
    writeState: st.writeState,
  });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 2000, "must return on the timeout, not wait on the sweep");
  assert.match(formatHookOutcome(r), /partial - /);
});

test("a throwing reconcile is reported, never propagated", async () => {
  const st = stateStub(0);
  const r = await runHookRefresh({
    settings,
    nowMs: NOW,
    listJobs: () => inflight,
    runReconcile: async () => {
      throw new Error("bad credentials");
    },
    readState: st.readState,
    writeState: st.writeState,
  });
  assert.equal(r.ran, true);
  assert.equal(r.error, "bad credentials");
  assert.match(formatHookOutcome(r), /error - bad credentials/);
});

test("an unreadable job store degrades to a skip, not a throw", async () => {
  const st = stateStub(0);
  const r = await runHookRefresh({
    settings,
    nowMs: NOW,
    listJobs: () => {
      throw new Error("no store");
    },
    readState: st.readState,
    writeState: st.writeState,
  });
  assert.equal(r.ran, false);
  assert.match(r.reason, /store unavailable/);
});
