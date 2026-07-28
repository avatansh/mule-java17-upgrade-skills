// tests/matrix_exchange.test.js — resolveMatrix's Anypoint Exchange source branch (pf-load-matrix).
// When matrix.source=exchange*, the governed Exchange matrix takes priority; ANY failure is
// non-fatal and falls through to the release-notes/bundled chain with a warning.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveMatrix, tryExchangeMatrix } from "../skills/mule-upgrade-assess/scripts/lib/matrix_fetch.js";
import { _resetConfigCache } from "../lib_shared/config.js";

let tmpCfg;
function writeSource(source) {
  fs.writeFileSync(path.join(tmpCfg, "config.yaml"), "app:\n  name: t\n");
  fs.writeFileSync(
    path.join(tmpCfg, "config-test.yaml"),
    `matrix:\n  source: "${source}"\n  exchange:\n    orgId: "o"\n    assetId: "a"\n    version: "1.0.0"\n`
  );
  _resetConfigCache();
}
beforeEach(() => {
  tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), "mule-cfg-"));
  process.env.MULE_CONFIG_DIR = tmpCfg;
  process.env.MULE_UPGRADE_ENV = "test";
});
afterEach(() => {
  delete process.env.MULE_CONFIG_DIR;
  delete process.env.MULE_UPGRADE_ENV;
  _resetConfigCache();
  try {
    fs.rmSync(tmpCfg, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// A fake ExchangeClient whose fetchAsset returns a canned result.
function fakeExchange(result) {
  return { fetchAsset: async () => result };
}

test("classpath source → tryExchangeMatrix returns null (branch skipped)", async () => {
  writeSource("classpath");
  const r = await tryExchangeMatrix(fakeExchange({ ok: true }));
  assert.equal(r, null);
});

test("exchange-latest healthy → resolveMatrix returns the exchange matrix", async () => {
  writeSource("exchange-latest");
  const { matrix, source, warnings } = await resolveMatrix({
    noFetch: false,
    exchange: fakeExchange({
      ok: true,
      version: "2.3.0",
      source: "exchange-latest",
      data: { connectors: [{ artifactId: "x", set: "1.0.0" }], gating: [] },
    }),
  });
  assert.equal(source, "exchange:2.3.0");
  assert.equal(matrix.connectors.length, 1);
  assert.equal(warnings.length, 0);
});

test("exchange failure → warns and falls back to the bundled matrix", async () => {
  writeSource("exchange");
  // Injected fake exchange (no real network) returns ok:false → the source attempt fails.
  const { source, warnings } = await resolveMatrix({
    exchange: fakeExchange({ ok: false, reason: "empty connectors block" }),
  });
  assert.equal(source, "bundled");
  assert.equal(warnings.length, 1);
  // The verbose exception detail is now debug-only (stderr under LOG_LEVEL=debug); the user-facing
  // warning collapses to a single clean line whenever a live source was attempted and failed.
  assert.match(warnings[0], /Live matrix fetch unavailable — using the bundled compatibility matrix/);
});

test("noFetch skips the Exchange source entirely → bundled, no warning", async () => {
  writeSource("exchange");
  let attempted = false;
  const { source, warnings } = await resolveMatrix({
    noFetch: true,
    exchange: { fetchAsset: async () => ((attempted = true), { ok: false, reason: "x" }) },
  });
  assert.equal(source, "bundled");
  assert.equal(attempted, false, "noFetch means no network — the Exchange source is not attempted");
  assert.equal(warnings.length, 0);
});
