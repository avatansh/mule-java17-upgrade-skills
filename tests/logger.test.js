// tests/logger.test.js — structured logging + correlation-context (MDC-style) propagation.
// Asserts: JSON-lines shape, level filtering, correlationId threading through async scopes via
// withContext/bindContext, and that a supplied id is preserved.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  logger,
  log,
  withContext,
  bindContext,
  currentContext,
  newCorrelationId,
} from "../server/lib/logger.js";

// Capture stderr writes for the duration of a test.
let lines;
let originalWrite;
let savedLevel;
let savedFormat;

beforeEach(() => {
  lines = [];
  originalWrite = process.stderr.write;
  // @ts-ignore - test shim
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  savedLevel = process.env.LOG_LEVEL;
  savedFormat = process.env.LOG_FORMAT;
  delete process.env.LOG_FORMAT; // default JSON mode
});

afterEach(() => {
  process.stderr.write = originalWrite;
  if (savedLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = savedLevel;
  if (savedFormat === undefined) delete process.env.LOG_FORMAT;
  else process.env.LOG_FORMAT = savedFormat;
});

function parsed() {
  return lines.map((l) => JSON.parse(l.trim()));
}

test("emits one JSON line per record with ts/level/msg", () => {
  process.env.LOG_LEVEL = "debug";
  logger.info("hello", { a: 1 });
  const recs = parsed();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].level, "info");
  assert.equal(recs[0].msg, "hello");
  assert.equal(recs[0].a, 1);
  assert.match(recs[0].ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("level floor filters lower-severity lines", () => {
  process.env.LOG_LEVEL = "warn";
  logger.debug("skip me");
  logger.info("skip me too");
  logger.warn("keep");
  logger.error("keep");
  const recs = parsed();
  assert.deepEqual(
    recs.map((r) => r.msg),
    ["keep", "keep"]
  );
});

test("withContext threads correlationId into every log inside the scope (incl. async)", async () => {
  process.env.LOG_LEVEL = "info";
  const cid = "req_test-123";
  await withContext({ correlationId: cid }, async () => {
    logger.info("first");
    await Promise.resolve();
    logger.info("after await");
  });
  const recs = parsed();
  assert.equal(recs.length, 2);
  assert.ok(recs.every((r) => r.correlationId === cid));
});

test("bindContext enriches the current scope for subsequent lines", () => {
  process.env.LOG_LEVEL = "info";
  withContext({ correlationId: "c1" }, () => {
    logger.info("before"); // no tool yet
    bindContext({ tool: "assess_app" });
    logger.info("after");
  });
  const recs = parsed();
  assert.equal(recs[0].tool, undefined);
  assert.equal(recs[1].tool, "assess_app");
  assert.ok(recs.every((r) => r.correlationId === "c1"));
});

test("context does not leak outside its scope", () => {
  process.env.LOG_LEVEL = "info";
  withContext({ correlationId: "scoped" }, () => logger.info("inside"));
  logger.info("outside");
  const recs = parsed();
  assert.equal(recs[0].correlationId, "scoped");
  assert.equal(recs[1].correlationId, undefined);
  assert.deepEqual(currentContext(), {});
});

test("nested withContext merges parent + child context", () => {
  process.env.LOG_LEVEL = "info";
  withContext({ correlationId: "c", a: 1 }, () => {
    withContext({ b: 2 }, () => logger.info("nested"));
  });
  const rec = parsed()[0];
  assert.equal(rec.correlationId, "c");
  assert.equal(rec.a, 1);
  assert.equal(rec.b, 2);
});

test("LOG_FORMAT=text emits a human line carrying the correlation id", () => {
  process.env.LOG_LEVEL = "info";
  process.env.LOG_FORMAT = "text";
  withContext({ correlationId: "abc" }, () => log("info", "readable", { k: "v" }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[abc\]/);
  assert.match(lines[0], /readable/);
  assert.match(lines[0], /k=v/);
});

test("newCorrelationId is unique and prefixed", () => {
  const a = newCorrelationId();
  const b = newCorrelationId();
  assert.notEqual(a, b);
  assert.match(a, /^req_/);
  assert.match(newCorrelationId("job"), /^job_/);
});
