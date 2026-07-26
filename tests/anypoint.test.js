// tests/anypoint.test.js — Anypoint + Exchange client parity (system/anypoint.xml + reference-data.xml).
//   · token TTL-bucket cache (pf-get-anypoint-token)
//   · verifyDeployment / makeDeployVerifier (pf-verify-deployment)
//   · readDeployment (Batch A #1 pf-read-deployment)
//   · readApiPolicies (Batch A #6 pf-read-api-policies) — grouped + flat schemas, non-fatal
//   · ExchangeClient version resolution + connectorless safety-net (pf-load-matrix)
import { test } from "node:test";
import assert from "node:assert/strict";
import { AnypointClient, makeDeployVerifier } from "../skills/mule-upgrade/scripts/lib/anypoint.js";
import { ExchangeClient, highestSemver, parseMavenMetadata } from "../lib_shared/exchange.js";

// A fetch stub that dispatches on URL path SUFFIX → { json | text | status }. API URLs nest
// (".../environments/e/apis" contains "/environments"), so we match the ENDING path segment
// (after stripping any query string) rather than any substring — unambiguous for these endpoints.
function makeFetch(routes, log) {
  return async (url, init) => {
    if (log) log.push({ url, init });
    const pathOnly = String(url).split("?")[0];
    const hit = routes.find(([needle]) => pathOnly.endsWith(needle));
    if (!hit) throw new Error(`no route for ${url}`);
    const r = typeof hit[1] === "function" ? hit[1](url, init) : hit[1];
    const bodyText = r.text ?? JSON.stringify(r.json ?? {});
    return { status: r.status ?? 200, text: async () => bodyText };
  };
}

const CREDS = { clientId: "id", clientSecret: "sec", orgId: "org-1" };

// ── token caching ────────────────────────────────────────────────────────────────────────────
test("token fetched once per refresh window, reused within it", async () => {
  const log = [];
  let clock = 1_000_000; // ms
  const fetchImpl = makeFetch(
    [
      ["/oauth2/token", () => ({ json: { access_token: `tok-${Math.floor(clock / 1000)}` } })],
      ["/environments", { json: { data: [{ name: "Dev", id: "e1" }] } }],
      ["/deployments", { json: { items: [] } }],
    ],
    log
  );
  const c = new AnypointClient({ ...CREDS, fetchImpl, refreshSeconds: 3300, now: () => clock });
  await c.verifyDeployment({ app: "x", env: "Dev" });
  await c.verifyDeployment({ app: "x", env: "Dev" });
  const tokenCalls = log.filter((l) => l.url.includes("/oauth2/token")).length;
  assert.equal(tokenCalls, 1, "token cached within the same bucket");

  // advance past one refresh window → new fetch
  clock += 3300 * 1000 + 1;
  await c.verifyDeployment({ app: "x", env: "Dev" });
  const tokenCalls2 = log.filter((l) => l.url.includes("/oauth2/token")).length;
  assert.equal(tokenCalls2, 2, "token re-fetched in a new bucket");
});

test("not configured → verify skipped, never calls fetch", async () => {
  let called = false;
  const c = new AnypointClient({ clientId: "", clientSecret: "", orgId: "", fetchImpl: async () => (called = true) });
  const v = await c.verifyDeployment({ app: "x", env: "Dev" });
  assert.equal(v.verified, false);
  assert.equal(v.skipped, "anypoint not configured");
  assert.equal(called, false);
});

// ── verifyDeployment ───────────────────────────────────────────────────────────────────────────
test("verify healthy deployment", async () => {
  const fetchImpl = makeFetch([
    ["/oauth2/token", { json: { access_token: "t" } }],
    ["/environments", { json: { data: [{ name: "Production", id: "envP" }] } }],
    ["/deployments", { json: { items: [{ name: "my-app", application: { status: "RUNNING" }, target: { deploymentSettings: { runtimeVersion: "4.9.18:17-java" } } }] } }],
  ]);
  const c = new AnypointClient({ ...CREDS, fetchImpl });
  const v = await c.verifyDeployment({ app: "my-app", env: "Production" });
  assert.equal(v.verified, true);
  assert.equal(v.found, true);
  assert.equal(v.status, "RUNNING");
  assert.equal(v.healthy, true);
  assert.match(v.runtimeVersion, /17-java/);
});

test("verify: app not found but platform answered → verified true, found false", async () => {
  const fetchImpl = makeFetch([
    ["/oauth2/token", { json: { access_token: "t" } }],
    ["/environments", { json: { data: [{ name: "Dev", id: "e" }] } }],
    ["/deployments", { json: { items: [{ name: "other" }] } }],
  ]);
  const c = new AnypointClient({ ...CREDS, fetchImpl });
  const v = await c.verifyDeployment({ app: "my-app", env: "Dev" });
  assert.equal(v.verified, true);
  assert.equal(v.found, false);
  assert.equal(v.healthy, false);
});

test("verify: network error → unverified, non-fatal", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  const c = new AnypointClient({ ...CREDS, fetchImpl });
  const v = await c.verifyDeployment({ app: "x", env: "Dev" });
  assert.equal(v.verified, false);
  assert.equal(v.status, "UNKNOWN");
  assert.match(v.error, /ECONNREFUSED/);
});

test("makeDeployVerifier maps to healthy/unhealthy/unknown", async () => {
  const healthy = new AnypointClient({
    ...CREDS,
    fetchImpl: makeFetch([
      ["/oauth2/token", { json: { access_token: "t" } }],
      ["/environments", { json: { data: [{ name: "Dev", id: "e" }] } }],
      ["/deployments", { json: { items: [{ name: "a", status: "STARTED" }] } }],
    ]),
    healthyStatuses: "RUNNING,STARTED",
  });
  const verify = makeDeployVerifier(healthy);
  assert.equal((await verify({ appName: "a", environment: "Dev" })).status, "healthy");
});

// ── readDeployment (Batch A #1) ─────────────────────────────────────────────────────────────────
test("readDeployment normalises verify result", async () => {
  const c = new AnypointClient({
    ...CREDS,
    fetchImpl: makeFetch([
      ["/oauth2/token", { json: { access_token: "t" } }],
      ["/environments", { json: { data: [{ name: "Dev", id: "e" }] } }],
      ["/deployments", { json: { items: [{ name: "a", status: "RUNNING", currentRuntimeVersion: "4.6.0" }] } }],
    ]),
  });
  const d = await c.readDeployment({ app: "a", env: "Dev" });
  assert.equal(d.reachable, true);
  assert.equal(d.found, true);
  assert.equal(d.status, "RUNNING");
  assert.equal(d.runtimeVersion, "4.6.0");
});

// ── readApiPolicies (Batch A #6) ────────────────────────────────────────────────────────────────
test("api-policies: grouped schema, enabled policy → hasApiPolicies true", async () => {
  const c = new AnypointClient({
    ...CREDS,
    fetchImpl: makeFetch([
      ["/oauth2/token", { json: { access_token: "t" } }],
      ["/environments", { json: { data: [{ name: "Dev", id: "e" }] } }],
      ["/apis", { json: { assets: [{ assetId: "my-app", apis: [{ id: "api-9" }] }] } }],
      ["/policies", { json: { policies: [{ disabled: false }, { disabled: true }] } }],
    ]),
  });
  const r = await c.readApiPolicies({ app: "my-app", env: "Dev" });
  assert.equal(r.matched, true);
  assert.equal(r.hasApiPolicies, true);
  assert.equal(r.enabledCount, 1);
});

test("api-policies: flat instances schema, no enabled → false", async () => {
  const c = new AnypointClient({
    ...CREDS,
    fetchImpl: makeFetch([
      ["/oauth2/token", { json: { access_token: "t" } }],
      ["/environments", { json: { data: [{ name: "Dev", id: "e" }] } }],
      ["/apis", { json: { instances: [{ id: "i1", exchangeAssetName: "my-app" }] } }],
      ["/policies", { json: { policies: [{ disabled: true }] } }],
    ]),
  });
  const r = await c.readApiPolicies({ app: "my-app", env: "Dev" });
  assert.equal(r.matched, true);
  assert.equal(r.hasApiPolicies, false);
});

test("api-policies: no matching api instance → matched false, hasApiPolicies false", async () => {
  const c = new AnypointClient({
    ...CREDS,
    fetchImpl: makeFetch([
      ["/oauth2/token", { json: { access_token: "t" } }],
      ["/environments", { json: { data: [{ name: "Dev", id: "e" }] } }],
      ["/apis", { json: { assets: [{ assetId: "unrelated", apis: [{ id: "x" }] }] } }],
    ]),
  });
  const r = await c.readApiPolicies({ app: "my-app", env: "Dev" });
  assert.equal(r.matched, false);
  assert.equal(r.hasApiPolicies, false);
  assert.equal(r.checked, true);
});

test("api-policies: error → non-fatal off state", async () => {
  const c = new AnypointClient({
    ...CREDS,
    fetchImpl: async (url) => {
      if (url.includes("token")) return { status: 200, text: async () => JSON.stringify({ access_token: "t" }) };
      throw new Error("boom");
    },
  });
  const r = await c.readApiPolicies({ app: "x", env: "Dev" });
  assert.equal(r.hasApiPolicies, false);
  assert.equal(r.checked, false);
  assert.match(r.error, /boom/);
});

// ── Exchange helpers ───────────────────────────────────────────────────────────────────────────
test("highestSemver picks numerically-highest, not lexical", () => {
  assert.equal(highestSemver(["1.0.9", "1.0.10", "1.2.0", "1.0.4"]), "1.2.0");
  assert.equal(highestSemver([]), null);
});

test("parseMavenMetadata extracts versions + latest/release", () => {
  const xml = `<metadata><versioning><latest>1.2.0</latest><release>1.1.0</release>
    <versions><version>1.0.4</version><version>1.2.0</version></versions></versioning></metadata>`;
  const m = parseMavenMetadata(xml);
  assert.deepEqual(m.versions, ["1.0.4", "1.2.0"]);
  assert.equal(m.latest, "1.2.0");
  assert.equal(m.release, "1.1.0");
});

// ── ExchangeClient (needs the config-driven asset identity; drive via a fake anypoint) ───────────
function fakeAnypoint(fetchImpl, configured = true) {
  return {
    baseUrl: "https://anypoint.mulesoft.com",
    fetch: fetchImpl,
    configured: () => configured,
    _getToken: async () => "tok",
  };
}

test("ExchangeClient: not configured → ok:false", async () => {
  const ex = new ExchangeClient({ anypoint: fakeAnypoint(async () => ({}), false) });
  const r = await ex.fetchAsset("matrix");
  assert.equal(r.ok, false);
});

test("ExchangeClient: connectorless matrix → safety-net rejects (ok:false)", async () => {
  // MULE_UPGRADE_ENV=dev config has matrix.source=exchange-latest; supply metadata + a connectorless yaml.
  const fetchImpl = makeFetch([
    ["maven-metadata.xml", { text: "<metadata><versioning><versions><version>1.0.4</version></versions></versioning></metadata>" }],
    [".yaml", { text: "schemaVersion: 1\nconnectors: []\n" }],
  ]);
  const ex = new ExchangeClient({ anypoint: fakeAnypoint(fetchImpl) });
  const r = await ex.fetchAsset("matrix");
  assert.equal(r.ok, false);
  assert.match(r.reason, /empty connectors/);
});

test("ExchangeClient: healthy matrix asset → ok:true with parsed data + resolved version", async () => {
  const fetchImpl = makeFetch([
    ["maven-metadata.xml", { text: "<metadata><versioning><versions><version>1.0.4</version><version>1.2.0</version></versions></versioning></metadata>" }],
    [".yaml", { text: "schemaVersion: 1\nconnectors:\n  - artifactId: a\n    set: '1.0.0'\n" }],
  ]);
  const ex = new ExchangeClient({ anypoint: fakeAnypoint(fetchImpl) });
  const r = await ex.fetchAsset("matrix");
  assert.equal(r.ok, true);
  assert.equal(r.version, "1.2.0"); // highest semver, exchange-latest
  assert.equal(r.data.connectors.length, 1);
});
