// tests/ci_ingest.test.js — CI/CD result state machine parity (mf-impl-post-cd-result).
//   · stage=test: failure→MUNIT_FAILED, success resume→PR_OPEN, success while PR_OPEN→munit.passed
//   · stage=dependency-guard: failure→DEP_GUARD_FAILED (+report), success resume→PR_OPEN
//   · stage=deploy: success→DEPLOYED (verify) / FAILED_DEPLOY (discrepancy); failure→FAILED_DEPLOY
//   · idempotency (already parked/terminal), 400 on bad result, 404 on missing job, lock release
import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestCiResult } from "../skills/mule-upgrade-job/scripts/ci_ingest.js";

// In-memory store fake mirroring the jobstore surface ci_ingest uses.
function makeStore(initial) {
  const jobs = new Map(Object.entries(initial ?? {}));
  const released = [];
  return {
    jobs,
    released,
    getJob: (id) => jobs.get(id) ?? null,
    setStatus(id, status, extra = {}) {
      const rec = jobs.get(id);
      if (!rec) return null;
      const updated = { ...rec, ...extra, status };
      jobs.set(id, updated);
      return updated;
    },
    patchJob(id, fields = {}) {
      const rec = jobs.get(id);
      if (!rec) return null;
      const updated = { ...rec, ...fields };
      jobs.set(id, updated);
      return updated;
    },
    releaseLock(app) {
      released.push(app);
      return true;
    },
  };
}

// ── stage=test ────────────────────────────────────────────────────────────────────────────
test("test failure → MUNIT_FAILED (lock NOT released)", async () => {
  const store = makeStore({ j1: { jobId: "j1", appName: "a", status: "PR_OPEN" } });
  const events = [];
  const r = await ingestCiResult(
    { jobId: "j1", stage: "test", result: "failure" },
    { store, notify: (e) => events.push(e) }
  );
  assert.equal(r.statusCode, 200);
  assert.equal(store.getJob("j1").status, "MUNIT_FAILED");
  assert.deepEqual(store.released, []); // lock retained mid-upgrade
  assert.deepEqual(events, ["MUNIT_FAILED"]);
});

test("test failure idempotent when already parked", async () => {
  const store = makeStore({ j1: { jobId: "j1", appName: "a", status: "MUNIT_FAILED" } });
  const r = await ingestCiResult({ jobId: "j1", stage: "test", result: "failure" }, { store });
  assert.equal(r.response.idempotent, true);
  assert.equal(r.response.status, "MUNIT_FAILED");
});

test("test success resumes MUNIT_FAILED → PR_OPEN", async () => {
  const store = makeStore({ j1: { jobId: "j1", appName: "a", status: "MUNIT_FAILED", error: "boom" } });
  const r = await ingestCiResult({ jobId: "j1", stage: "test", result: "success" }, { store });
  assert.equal(r.response.resumed, true);
  assert.equal(store.getJob("j1").status, "PR_OPEN");
  assert.equal(store.getJob("j1").error, null);
});

test("test success while PR_OPEN marks munit.passed sub-stage (status unchanged)", async () => {
  const store = makeStore({ j1: { jobId: "j1", appName: "a", status: "PR_OPEN" } });
  const r = await ingestCiResult({ jobId: "j1", stage: "test", result: "success" }, { store });
  assert.equal(r.response.munit, "passed");
  assert.equal(store.getJob("j1").status, "PR_OPEN");
  assert.equal(store.getJob("j1").munit.result, "passed");
});

test("test unknown result → 400", async () => {
  const store = makeStore({ j1: { jobId: "j1", status: "PR_OPEN" } });
  const r = await ingestCiResult({ jobId: "j1", stage: "test", result: "weird" }, { store });
  assert.equal(r.statusCode, 400);
});

// ── stage=dependency-guard ──────────────────────────────────────────────────────────────────
test("dep-guard failure → DEP_GUARD_FAILED with report", async () => {
  const store = makeStore({ j1: { jobId: "j1", appName: "a", status: "PR_OPEN" } });
  const report = [{ groupId: "com.x", artifactId: "y", resolvedVersion: "1.0.0", requiredVersion: "2.0.0" }];
  const r = await ingestCiResult({ jobId: "j1", stage: "dependency-guard", result: "failure", report }, { store });
  assert.equal(store.getJob("j1").status, "DEP_GUARD_FAILED");
  assert.deepEqual(store.getJob("j1").depGuard.report, report);
  assert.equal(r.response.violations, 1);
  assert.deepEqual(store.released, []);
});

test("dep-guard success resumes DEP_GUARD_FAILED → PR_OPEN", async () => {
  const store = makeStore({ j1: { jobId: "j1", appName: "a", status: "DEP_GUARD_FAILED" } });
  const r = await ingestCiResult({ jobId: "j1", stage: "dependency-guard", result: "success" }, { store });
  assert.equal(r.response.resumed, true);
  assert.equal(store.getJob("j1").status, "PR_OPEN");
  assert.equal(store.getJob("j1").depGuard.result, "passed");
});

test("dep-guard success note-only when not parked", async () => {
  const store = makeStore({ j1: { jobId: "j1", appName: "a", status: "PR_OPEN" } });
  const r = await ingestCiResult({ jobId: "j1", stage: "dependency-guard", result: "success" }, { store });
  assert.equal(r.response.note, "dependency-guard success noted");
  assert.equal(store.getJob("j1").status, "PR_OPEN");
});

// ── stage=deploy ──────────────────────────────────────────────────────────────────────────
test("deploy success + no verifier → DEPLOYED (trust CI); lock released", async () => {
  const store = makeStore({ j1: { jobId: "j1", appName: "a", status: "DEPLOYING" } });
  const r = await ingestCiResult({ jobId: "j1", stage: "deploy", result: "success", deployUrl: "u" }, { store });
  assert.equal(store.getJob("j1").status, "DEPLOYED");
  assert.equal(store.getJob("j1").platformVerified, false);
  assert.deepEqual(store.released, ["a"]);
  assert.equal(r.response.status, "DEPLOYED");
});

test("deploy success + verifier healthy → DEPLOYED verified", async () => {
  const store = makeStore({ j1: { jobId: "j1", appName: "a", status: "DEPLOYING" } });
  const verifyDeploy = () => ({ status: "healthy", platform: { status: "RUNNING" } });
  await ingestCiResult({ jobId: "j1", stage: "deploy", result: "success" }, { store, verifyDeploy });
  assert.equal(store.getJob("j1").status, "DEPLOYED");
  assert.equal(store.getJob("j1").platformVerified, true);
  assert.equal(store.getJob("j1").platformStatus, "RUNNING");
});

test("deploy success + verifier unhealthy → FAILED_DEPLOY (discrepancy)", async () => {
  const store = makeStore({ j1: { jobId: "j1", appName: "a", status: "DEPLOYING" } });
  const verifyDeploy = () => ({ status: "unhealthy", platform: { status: "UNDEPLOYED" } });
  await ingestCiResult({ jobId: "j1", stage: "deploy", result: "success" }, { store, verifyDeploy });
  assert.equal(store.getJob("j1").status, "FAILED_DEPLOY");
  assert.match(store.getJob("j1").error, /platform status=UNDEPLOYED/);
  assert.deepEqual(store.released, ["a"]);
});

test("deploy failure → FAILED_DEPLOY + rolledBack; lock released", async () => {
  const store = makeStore({ j1: { jobId: "j1", appName: "a", status: "DEPLOYING" } });
  await ingestCiResult({ jobId: "j1", stage: "deploy", result: "failure", error: "boom" }, { store });
  assert.equal(store.getJob("j1").status, "FAILED_DEPLOY");
  assert.equal(store.getJob("j1").rolledBack, true);
  assert.equal(store.getJob("j1").error, "boom");
  assert.deepEqual(store.released, ["a"]);
});

test("deploy idempotent when already DEPLOYED", async () => {
  const store = makeStore({ j1: { jobId: "j1", appName: "a", status: "DEPLOYED" } });
  const r = await ingestCiResult({ jobId: "j1", stage: "deploy", result: "success" }, { store });
  assert.equal(r.response.idempotent, true);
  assert.deepEqual(store.released, []); // no double release
});

test("default stage is deploy", async () => {
  const store = makeStore({ j1: { jobId: "j1", appName: "a", status: "DEPLOYING" } });
  await ingestCiResult({ jobId: "j1", result: "success" }, { store });
  assert.equal(store.getJob("j1").status, "DEPLOYED");
});

// ── guards ──────────────────────────────────────────────────────────────────────────────────
test("missing jobId → 400", async () => {
  const store = makeStore({});
  const r = await ingestCiResult({ result: "success" }, { store });
  assert.equal(r.statusCode, 400);
});

test("unknown jobId → 404", async () => {
  const store = makeStore({});
  const r = await ingestCiResult({ jobId: "nope", result: "success" }, { store });
  assert.equal(r.statusCode, 404);
});
