// tests/notify.test.js — Slack + Jira notifications (skills/mule-upgrade/scripts/lib/notify.js).
//
// Every notify fn is NON-FATAL + env-gated: absent creds → { skipped }, HTTP failure → { error },
// never a throw. We inject fetchImpl + creds so nothing touches the network, and assert BOTH the
// happy path (correct URL / method / auth / body shape) and the guard/degrade paths. The prebuilt
// message builders are pure string assembly and checked verbatim.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  slackNotify,
  jiraComment,
  jiraCreateIssue,
  prOpenedSlackText,
  failureSlackText,
} from "../skills/mule-upgrade/scripts/lib/notify.js";

// A fetch spy that records the last call and returns a canned Response-like object.
function fetchSpy({ ok = true, status = 200, text = "{}" } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, text: async () => text };
  };
  impl.calls = calls;
  return impl;
}

// ── slackNotify ──────────────────────────────────────────────────────────────────────────────────
test("slackNotify: no webhook url → cleanly skipped, no fetch", async () => {
  const fetchImpl = fetchSpy();
  const r = await slackNotify("hi", { fetchImpl, webhookUrl: "" });
  assert.deepEqual(r, { sent: false, skipped: "no SLACK_WEBHOOK_URL" });
  assert.equal(fetchImpl.calls.length, 0);
});

test("slackNotify: posts { text } to the webhook, or { channel, text } when a channel is set", async () => {
  // channel:"" pins the no-channel branch (the layered config may otherwise supply a default channel).
  const plain = fetchSpy();
  assert.deepEqual(await slackNotify("hello", { fetchImpl: plain, webhookUrl: "https://hook", channel: "" }), {
    sent: true,
  });
  assert.equal(plain.calls[0].url, "https://hook");
  assert.equal(plain.calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(plain.calls[0].init.body), { text: "hello" });

  const chan = fetchSpy();
  await slackNotify("hey", { fetchImpl: chan, webhookUrl: "https://hook", channel: "#ops" });
  assert.deepEqual(JSON.parse(chan.calls[0].init.body), { channel: "#ops", text: "hey" });
});

test("slackNotify: an HTTP failure is caught → { sent:false, error }", async () => {
  const fetchImpl = fetchSpy({ ok: false, status: 500, text: "boom" });
  const r = await slackNotify("x", { fetchImpl, webhookUrl: "https://hook" });
  assert.equal(r.sent, false);
  assert.match(r.error, /500/);
});

// ── jiraComment ──────────────────────────────────────────────────────────────────────────────────
test("jiraComment: skips with no ticket, and with no creds", async () => {
  const fetchImpl = fetchSpy();
  assert.deepEqual(await jiraComment("", "note", null, { fetchImpl, baseUrl: "https://j", email: "e", token: "t" }), {
    sent: false,
    skipped: "no jiraTicketId",
  });
  assert.deepEqual(await jiraComment("J-1", "note", null, { fetchImpl, baseUrl: "", email: "", token: "" }), {
    sent: false,
    skipped: "no Jira creds",
  });
  assert.equal(fetchImpl.calls.length, 0, "guarded — never hits the network");
});

test("jiraComment: posts an ADF comment with basic auth to the issue comment endpoint", async () => {
  const fetchImpl = fetchSpy({ text: "{}" });
  const r = await jiraComment("PROJ-9", "Upgrade ready", "https://pr/1", {
    fetchImpl,
    baseUrl: "https://acme.atlassian.net",
    email: "bot@acme.com",
    token: "sekret",
  });
  assert.deepEqual(r, { sent: true });
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, "https://acme.atlassian.net/rest/api/3/issue/PROJ-9/comment");
  assert.match(init.headers.Authorization, /^Basic /);
  assert.equal(Buffer.from(init.headers.Authorization.slice(6), "base64").toString(), "bot@acme.com:sekret");
  const body = JSON.parse(init.body);
  assert.equal(body.body.type, "doc");
  // link appended as a marked text node
  const flat = JSON.stringify(body);
  assert.match(flat, /Upgrade ready/);
  assert.match(flat, /https:\/\/pr\/1/);
});

// ── jiraCreateIssue ──────────────────────────────────────────────────────────────────────────────
test("jiraCreateIssue: off unless autoCreate + creds + projectKey are all present", async () => {
  const fetchImpl = fetchSpy();
  assert.deepEqual(await jiraCreateIssue({ appName: "a", jobId: "j" }, { fetchImpl, autoCreate: false }), {
    created: false,
    skipped: "autoCreate off",
  });
  assert.deepEqual(
    await jiraCreateIssue(
      { appName: "a", jobId: "j" },
      { fetchImpl, autoCreate: true, baseUrl: "https://j", email: "e", token: "t", projectKey: "" }
    ),
    { created: false, skipped: "no Jira creds/projectKey" }
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("jiraCreateIssue: creates an issue and returns its key", async () => {
  const fetchImpl = fetchSpy({ text: JSON.stringify({ key: "MIG-42" }) });
  const r = await jiraCreateIssue(
    { appName: "payments-api", jobId: "job-1" },
    {
      fetchImpl,
      autoCreate: true,
      baseUrl: "https://acme.atlassian.net",
      email: "e@acme.com",
      token: "tok",
      projectKey: "MIG",
      issueType: "Task",
    }
  );
  assert.deepEqual(r, { created: true, key: "MIG-42" });
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, "https://acme.atlassian.net/rest/api/3/issue");
  const body = JSON.parse(init.body);
  assert.equal(body.fields.project.key, "MIG");
  assert.equal(body.fields.issuetype.name, "Task");
  assert.match(body.fields.summary, /payments-api/);
});

// ── prebuilt message bodies ──────────────────────────────────────────────────────────────────────
test("prOpenedSlackText: includes app, PR url, job, Jira link and warnings", () => {
  const t = prOpenedSlackText({
    appName: "payments-api",
    prUrl: "https://github.com/acme/x/pull/7",
    jobId: "job-1",
    jiraTicketId: "MIG-42",
    jiraBaseUrl: "https://acme.atlassian.net",
    warnings: ["setAccessible used", "custom DW POJO"],
  });
  assert.match(t, /payments-api/);
  assert.match(t, /pull\/7/);
  assert.match(t, /job-1/);
  assert.match(t, /MIG-42/);
  assert.match(t, /setAccessible used/);
  assert.match(t, /custom DW POJO/);
});

test("failureSlackText: includes status, error and an optional rollback PR", () => {
  const t = failureSlackText({
    appName: "orders",
    jobId: "job-9",
    status: "FAILED_DEPLOY",
    error: "health check timed out",
    jiraTicketId: "MIG-9",
    jiraBaseUrl: "https://acme.atlassian.net",
    revertPrUrl: "https://github.com/acme/x/pull/8",
  });
  assert.match(t, /FAILED_DEPLOY/);
  assert.match(t, /health check timed out/);
  assert.match(t, /Rollback PR: .*pull\/8/);
  // no revert url → no rollback line
  const t2 = failureSlackText({ appName: "orders", jobId: "job-9", status: "FAILED_ASSESS", error: "x" });
  assert.doesNotMatch(t2, /Rollback PR/);
});
