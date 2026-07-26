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

test("exchange-latest healthy → resolveMatrix returns exchange matrix, no fetch", async () => {
  writeSource("exchange-latest");
  let htmlFetched = false;
  const { matrix, source, warnings } = await resolveMatrix({
    noFetch: false,
    fetchHtml: async () => ((htmlFetched = true), "<html/>"),
    exchange: fakeExchange({ ok: true, version: "2.3.0", source: "exchange-latest", data: { connectors: [{ artifactId: "x", set: "1.0.0" }], gating: [] } }),
  });
  assert.equal(source, "exchange:2.3.0");
  assert.equal(matrix.connectors.length, 1);
  assert.equal(htmlFetched, false, "exchange short-circuits the release-notes fetch");
  assert.equal(warnings.length, 0);
});

test("exchange failure → warns and falls back to bundled/release-notes chain", async () => {
  writeSource("exchange");
  const { source, warnings } = await resolveMatrix({
    noFetch: true, // skip network; forces bundled fallback after exchange miss
    exchange: fakeExchange({ ok: false, reason: "empty connectors block" }),
  });
  assert.equal(source, "bundled");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Exchange matrix source failed \(empty connectors block\)/);
});
