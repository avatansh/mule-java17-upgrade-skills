// tests/matrix_memo.test.js — loadBundledMatrix() memoization + deep-copy isolation.
// The bundled matrix is parsed once and cached; every caller gets an independent deep copy so a
// mutation can never bleed into another caller. _resetMatrixCache() drops the memo (used after the
// matrix-update skill rewrites the YAML).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadBundledMatrix,
  _resetMatrixCache,
} from "../skills/mule-upgrade-assess/scripts/lib/matrix.js";

test("loadBundledMatrix returns a fully-populated matrix", () => {
  const m = loadBundledMatrix();
  assert.ok(m && typeof m === "object", "matrix is an object");
  assert.ok(Array.isArray(m.connectors) && m.connectors.length > 0, "has connectors");
  assert.ok(m.gating && typeof m.gating === "object", "has gating");
});

test("each call returns an independent deep copy (mutation does not leak)", () => {
  const a = loadBundledMatrix();
  const originalLen = a.connectors.length;
  // Mutate the returned copy aggressively.
  a.connectors.push({ artifactId: "__poison__", set: "9.9.9" });
  a.gating = { poisoned: true };

  const b = loadBundledMatrix();
  assert.equal(b.connectors.length, originalLen, "second copy is unaffected by first's push");
  assert.ok(!b.connectors.some((c) => c.artifactId === "__poison__"), "no poison connector leaked");
  assert.notDeepEqual(b.gating, { poisoned: true }, "gating not clobbered");
});

test("_resetMatrixCache re-reads but still yields an equivalent matrix", () => {
  const before = loadBundledMatrix();
  _resetMatrixCache();
  const after = loadBundledMatrix();
  assert.deepEqual(after, before, "reset then reload yields the same content");
});
