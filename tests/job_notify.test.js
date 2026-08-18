// tests/job_notify.test.js — makeJobNotifier: fire Slack + Jira on every job STATE CHANGE, once,
// and ONLY for a job whose operator opted in.
//
// This is the notifier wired into reconcile / get_job_status auto-refresh / the webhook, so a
// transition that surfaces only when someone "checks status" still pushes a Slack alert + Jira
// comment. Key invariants locked here:
//   · OPT-IN: a job with no notifyPrefs is silent — credentials are capability, not consent
//   · each channel is gated independently (slack only / jira only)
//   · fires Slack (+ Jira when a ticket exists) on a genuine status change, and records notifiedStatus
//   · exactly-once per distinct status — a repeat call at the same status is silent (no re-spam)
//   · re-reads the AUTHORITATIVE record from the store, so a stale/pre-transition rec arg still works
//   · fast-transient early stages (PROCESSING/COMMITTING/…) are never alerted
//   · no Jira ticket → Slack still fires, Jira is skipped
//   · never throws — a Slack/Jira outage must not break the sweep

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeJobNotifier,
  jobTransitionSlackText,
  resolveNotifyPrefs,
} from "../skills/mule-upgrade/scripts/lib/notify.js";

/** The opt-in every pre-existing test assumes: both channels on for this job. */
const OPTED_IN = { slack: true, jira: "comment" };

/** A tiny in-memory job store exposing just getJob/patchJob, matching the real jobstore surface. */
function fakeStore(initial = {}) {
  const jobs = { ...initial };
  return {
    jobs,
    getJob: (id) => jobs[id],
    patchJob: (id, fields) => {
      jobs[id] = { ...(jobs[id] ?? {}), ...fields };
      return jobs[id];
    },
  };
}

function collector() {
  const slack = [];
  const jira = [];
  return {
    slack,
    jira,
    slackFn: async (text) => {
      slack.push(text);
      return { sent: true };
    },
    jiraFn: async (ticket, text, url) => {
      jira.push({ ticket, text, url });
      return { sent: true };
    },
  };
}

// ── opt-in gate ──────────────────────────────────────────────────────────────────────────────────
test("a job with NO notifyPrefs is silent — credentials are not consent", async () => {
  const store = fakeStore({
    j1: { jobId: "j1", status: "DEPLOYED", appName: "orders-api", jiraTicketId: "MUL-9" },
  });
  const c = collector();
  const notify = makeJobNotifier({ ...store, slack: c.slackFn, jira: c.jiraFn });

  await notify("DEPLOYING->DEPLOYED", { jobId: "j1" });

  assert.equal(c.slack.length, 0, "no Slack for a run that never opted in");
  assert.equal(c.jira.length, 0, "a linked ticket is not permission to comment on it");
  assert.equal(
    store.jobs.j1.notifiedStatus,
    undefined,
    "the dedupe slot stays free, so opting in later still alerts on the next change"
  );
});

test("explicit opt-out ({slack:false, jira:'none'}) is silent", async () => {
  const store = fakeStore({
    j1: {
      jobId: "j1",
      status: "FAILED_DEPLOY",
      appName: "a",
      jiraTicketId: "MUL-1",
      notifyPrefs: { slack: false, jira: "none" },
    },
  });
  const c = collector();
  const notify = makeJobNotifier({ ...store, slack: c.slackFn, jira: c.jiraFn });

  await notify("DEPLOYING->FAILED_DEPLOY", { jobId: "j1" });

  assert.equal(c.slack.length, 0);
  assert.equal(c.jira.length, 0);
});

test("channels are gated independently — Slack only, and Jira only", async () => {
  const slackOnly = fakeStore({
    j1: { jobId: "j1", status: "DEPLOYED", appName: "a", jiraTicketId: "MUL-9", notifyPrefs: { slack: true } },
  });
  const c1 = collector();
  await makeJobNotifier({ ...slackOnly, slack: c1.slackFn, jira: c1.jiraFn })("x->DEPLOYED", { jobId: "j1" });
  assert.equal(c1.slack.length, 1, "Slack opted in");
  assert.equal(c1.jira.length, 0, "Jira left at the default 'none' despite a linked ticket");
  assert.equal(slackOnly.jobs.j1.notifiedStatus, "DEPLOYED");

  const jiraOnly = fakeStore({
    j1: { jobId: "j1", status: "DEPLOYED", appName: "a", jiraTicketId: "MUL-9", notifyPrefs: { jira: "comment" } },
  });
  const c2 = collector();
  await makeJobNotifier({ ...jiraOnly, slack: c2.slackFn, jira: c2.jiraFn })("x->DEPLOYED", { jobId: "j1" });
  assert.equal(c2.slack.length, 0, "Slack left at the default false");
  assert.equal(c2.jira.length, 1, "Jira comment opted in");
  assert.equal(jiraOnly.jobs.j1.notifiedStatus, "DEPLOYED");
});

test("resolveNotifyPrefs: default-denies anything absent or malformed", () => {
  assert.deepEqual(resolveNotifyPrefs(undefined), { slack: false, jira: "none" });
  assert.deepEqual(resolveNotifyPrefs(null), { slack: false, jira: "none" });
  assert.deepEqual(resolveNotifyPrefs("yes please"), { slack: false, jira: "none" });
  // Truthy-but-not-true and an unrecognised jira mode both fall back to silent.
  assert.deepEqual(resolveNotifyPrefs({ slack: "true", jira: "everything" }), { slack: false, jira: "none" });
  assert.deepEqual(resolveNotifyPrefs({ slack: true, jira: "create" }), { slack: true, jira: "create" });
});

test("fires Slack + Jira on a real transition and records notifiedStatus", async () => {
  const store = fakeStore({
    j1: {
      jobId: "j1",
      status: "DEPLOYED",
      appName: "orders-api",
      prUrl: "https://gh/pr/1",
      jiraTicketId: "MUL-9",
      notifyPrefs: OPTED_IN,
    },
  });
  const c = collector();
  const notify = makeJobNotifier({ ...store, slack: c.slackFn, jira: c.jiraFn, jiraBaseUrl: "https://jira" });

  await notify("DEPLOYING->DEPLOYED", { jobId: "j1" });

  assert.equal(c.slack.length, 1);
  assert.match(c.slack[0], /orders-api/);
  assert.match(c.slack[0], /DEPLOYED/);
  assert.match(c.slack[0], /https:\/\/gh\/pr\/1/);
  assert.equal(c.jira.length, 1);
  assert.equal(c.jira[0].ticket, "MUL-9");
  assert.match(c.jira[0].text, /DEPLOYED/);
  assert.equal(store.jobs.j1.notifiedStatus, "DEPLOYED");
  assert.ok(store.jobs.j1.lastNotifiedAt);
});

test("exactly-once per status — a repeat call at the same status is silent", async () => {
  const store = fakeStore({
    j1: { jobId: "j1", status: "CLOSED", appName: "a", notifiedStatus: "CLOSED", notifyPrefs: OPTED_IN },
  });
  const c = collector();
  const notify = makeJobNotifier({ ...store, slack: c.slackFn, jira: c.jiraFn });

  await notify("PR_OPEN->CLOSED", { jobId: "j1" });

  assert.equal(c.slack.length, 0, "already-notified status must not re-alert");
  assert.equal(c.jira.length, 0);
});

test("re-reads the store — a pre-transition rec arg still reports the CURRENT status", async () => {
  // Caller passes the OLD record (status PR_OPEN, as applyPrOutcome does), but the store already holds
  // the new status. The notifier must alert on the store's truth (DEPLOYING), not the arg.
  const store = fakeStore({
    j1: { jobId: "j1", status: "DEPLOYING", appName: "a", notifiedStatus: "PR_OPEN", notifyPrefs: OPTED_IN },
  });
  const c = collector();
  const notify = makeJobNotifier({ ...store, slack: c.slackFn, jira: c.jiraFn });

  await notify("PR_OPEN->DEPLOYING", { jobId: "j1", status: "PR_OPEN" });

  assert.equal(c.slack.length, 1);
  assert.match(c.slack[0], /DEPLOYING/);
  assert.equal(store.jobs.j1.notifiedStatus, "DEPLOYING");
});

test("fast-transient early stages are never alerted", async () => {
  const store = fakeStore({ j1: { jobId: "j1", status: "COMMITTING", appName: "a", notifyPrefs: OPTED_IN } });
  const c = collector();
  const notify = makeJobNotifier({ ...store, slack: c.slackFn, jira: c.jiraFn });

  await notify("x->COMMITTING", { jobId: "j1" });

  assert.equal(c.slack.length, 0);
  assert.equal(store.jobs.j1.notifiedStatus, undefined, "silent statuses don't consume the dedupe slot");
});

test("no Jira ticket → Slack fires, Jira is skipped", async () => {
  const store = fakeStore({ j1: { jobId: "j1", status: "MUNIT_FAILED", appName: "a", notifyPrefs: OPTED_IN } });
  const c = collector();
  const notify = makeJobNotifier({ ...store, slack: c.slackFn, jira: c.jiraFn });

  await notify("PR_OPEN->MUNIT_FAILED", { jobId: "j1" });

  assert.equal(c.slack.length, 1);
  assert.equal(c.jira.length, 0);
});

test("never throws — a Slack outage is swallowed and the dedupe slot is NOT consumed", async () => {
  const store = fakeStore({
    j1: { jobId: "j1", status: "FAILED_DEPLOY", appName: "a", error: "boom", notifyPrefs: OPTED_IN },
  });
  const notify = makeJobNotifier({
    ...store,
    slack: async () => {
      throw new Error("slack down");
    },
    jira: async () => ({ sent: true }),
  });

  await assert.doesNotReject(() => notify("DEPLOYING->FAILED_DEPLOY", { jobId: "j1" }));
  // Send failed before the patch, so a later sweep can retry the alert.
  assert.equal(store.jobs.j1.notifiedStatus, undefined);
});

test("missing jobId → no-op (no throw, no sends)", async () => {
  const c = collector();
  const notify = makeJobNotifier({ ...fakeStore(), slack: c.slackFn, jira: c.jiraFn });
  await assert.doesNotReject(() => notify("evt", {}));
  await assert.doesNotReject(() => notify("evt", undefined));
  assert.equal(c.slack.length, 0);
});

test("jobTransitionSlackText: failure line includes the error; unknown status falls back", () => {
  const t = jobTransitionSlackText({ status: "FAILED_DEPLOY", appName: "a", jobId: "j", error: "nope" });
  assert.match(t, /FAILED_DEPLOY/);
  assert.match(t, /Error: nope/);
  const u = jobTransitionSlackText({ status: "WHATEVER", appName: "a", jobId: "j" });
  assert.match(u, /status WHATEVER/);
});
