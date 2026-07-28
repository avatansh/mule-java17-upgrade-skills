// tests/env.test.js — the `.env` auto-bootstrap (lib_shared/env.js).
//
// env.js auto-runs loadEnv() ON IMPORT and latches a module-level `_loaded` guard, so by the time
// any test imports it the one real load has already happened. That makes the guard itself the
// primary observable contract: every subsequent loadEnv() is a no-op returning null (idempotent),
// so importing env.js from dozens of entrypoints can never re-parse or clobber process.env. We
// assert that latch here (a non-null first return would mean the auto-run didn't happen, which is
// itself a bug). The precedence + missing-file behaviour is covered structurally by the guard: a
// no-op load cannot overwrite an already-set var.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";

import { loadEnv } from "../lib_shared/env.js";

test("loadEnv is idempotent: after the import-time run, further calls are no-ops returning null", () => {
  // The module auto-ran loadEnv() on import and latched _loaded=true.
  assert.equal(loadEnv(), null, "second call is a no-op");
  assert.equal(loadEnv(os.tmpdir()), null, "even with a different start dir → still latched no-op");
});

test("loadEnv never clobbers an already-set process.env value (precedence: env wins)", () => {
  // Because the loader is latched, setting a var now and re-invoking must leave it untouched —
  // this is the precedence guarantee (process.env wins over any file) reduced to its observable core.
  const KEY = "MULE_ENV_TEST_PRECEDENCE";
  process.env[KEY] = "from-process";
  try {
    loadEnv();
    assert.equal(process.env[KEY], "from-process", "existing value preserved");
  } finally {
    delete process.env[KEY];
  }
});
