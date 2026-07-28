// tests/anypoint.test.js — Anypoint + Exchange client parity (system/anypoint.xml + reference-data.xml).
//   · token TTL-bucket cache (pf-get-anypoint-token)
//   · verifyDeployment / makeDeployVerifier (pf-verify-deployment)
//   · readDeployment (Batch A #1 pf-read-deployment)
//   · readApiPolicies (Batch A #6 pf-read-api-policies) — grouped + flat schemas, non-fatal
//   · ExchangeClient version resolution + connectorless safety-net (pf-load-matrix)
import { test } from "node:test";
import assert from "node:assert/strict";
import { AnypointClient, makeDeployVerifier } from "../skills/mule-upgrade/scripts/lib/anypoint.js";
import {
  ExchangeClient,
  highestSemver,
  parseMavenMetadata,
  parsePomDependencies,
} from "../lib_shared/exchange.js";

// These are RAW-client unit tests: they assert exact network behaviour (token bucket refetch, matrix
// version resolution, listVersions pagination) with injected fetch + fake clocks. The cross-process
// disk cache (lib_shared/cache.js) would short-circuit those network calls and use real wall-clock
// TTLs, so disable it for this file. node --test runs each file in its own process → no leakage.
process.env.MULE_UPGRADE_CACHE = "off";

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
  const c = new AnypointClient({
    clientId: "",
    clientSecret: "",
    orgId: "",
    fetchImpl: async () => (called = true),
  });
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
    [
      "/deployments",
      {
        json: {
          items: [
            {
              name: "my-app",
              application: { status: "RUNNING" },
              target: { deploymentSettings: { runtimeVersion: "4.9.18:17-java" } },
            },
          ],
        },
      },
    ],
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

test("makeDeployVerifier batches one platform read per env across jobs, reset re-reads", async () => {
  const log = [];
  const client = new AnypointClient({
    ...CREDS,
    fetchImpl: makeFetch(
      [
        ["/oauth2/token", { json: { access_token: "t" } }],
        ["/environments", { json: { data: [{ name: "Dev", id: "e" }] } }],
        [
          "/deployments",
          {
            json: {
              items: [
                { name: "a", status: "RUNNING" },
                { name: "b", status: "STOPPED" },
              ],
            },
          },
        ],
      ],
      log
    ),
    healthyStatuses: "RUNNING,STARTED",
  });
  const verify = makeDeployVerifier(client);
  const deployHits = () => log.filter((l) => String(l.url).split("?")[0].endsWith("/deployments")).length;

  // Three jobs, same env → the env's deployment list is fetched exactly ONCE (N+1 → 1-per-env).
  assert.equal((await verify({ appName: "a", environment: "Dev" })).status, "healthy");
  assert.equal((await verify({ appName: "b", environment: "Dev" })).status, "unhealthy");
  assert.equal((await verify({ appName: "missing", environment: "Dev" })).status, "unknown");
  assert.equal(deployHits(), 1, "one deployment read for three same-env jobs");

  // A new sweep resets the per-env cache → the platform is read again for fresh state.
  verify.reset();
  assert.equal((await verify({ appName: "a", environment: "Dev" })).status, "healthy");
  assert.equal(deployHits(), 2, "reset() forces a fresh read on the next sweep");
});

// ── readDeployment (Batch A #1) ─────────────────────────────────────────────────────────────────
test("readDeployment normalises verify result", async () => {
  const c = new AnypointClient({
    ...CREDS,
    fetchImpl: makeFetch([
      ["/oauth2/token", { json: { access_token: "t" } }],
      ["/environments", { json: { data: [{ name: "Dev", id: "e" }] } }],
      [
        "/deployments",
        { json: { items: [{ name: "a", status: "RUNNING", currentRuntimeVersion: "4.6.0" }] } },
      ],
    ]),
  });
  const d = await c.readDeployment({ app: "a", env: "Dev" });
  assert.equal(d.reachable, true);
  assert.equal(d.found, true);
  assert.equal(d.status, "RUNNING");
  assert.equal(d.runtimeVersion, "4.6.0");
});

// ── describeDeployment (EPIC C, verbatim name) ───────────────────────────────────────────────────
test("describeDeployment: exact-name hit returns runtime/Java/status/replicas/last-deploy", async () => {
  const c = new AnypointClient({
    ...CREDS,
    fetchImpl: makeFetch([
      ["/oauth2/token", { json: { access_token: "t" } }],
      ["/environments", { json: { data: [{ name: "Production", id: "envP" }] } }],
      [
        "/deployments",
        {
          json: {
            items: [
              { name: "other-app", status: "RUNNING" },
              {
                name: "orders-api",
                application: { status: "RUNNING" },
                target: { deploymentSettings: { runtimeVersion: "4.6.0:8-java" }, replicas: 3 },
                lastModifiedDate: "2026-05-01T10:00:00Z",
              },
            ],
          },
        },
      ],
    ]),
  });
  const d = await c.describeDeployment({ app: "orders-api", env: "Production" });
  assert.equal(d.found, true);
  assert.equal(d.name, "orders-api");
  assert.equal(d.status, "RUNNING");
  assert.equal(d.runtimeVersion, "4.6.0:8-java");
  assert.equal(d.muleVersion, "4.6.0");
  assert.equal(d.javaVersion, 8);
  assert.equal(d.replicas, 3);
  assert.equal(d.lastDeploy, "2026-05-01T10:00:00Z");
  assert.equal(d.environment, "Production");
});

test("describeDeployment: name matched VERBATIM (no fuzzy/contains match)", async () => {
  const c = new AnypointClient({
    ...CREDS,
    fetchImpl: makeFetch([
      ["/oauth2/token", { json: { access_token: "t" } }],
      ["/environments", { json: { data: [{ name: "Dev", id: "e" }] } }],
      ["/deployments", { json: { items: [{ name: "orders-api-v2", status: "RUNNING" }] } }],
    ]),
  });
  const d = await c.describeDeployment({ app: "orders-api", env: "Dev" });
  assert.equal(d.found, false);
  assert.match(d.reason, /no deployment named "orders-api" in environment "Dev"/);
});

test("describeDeployment: no name → skip-with-reason, never calls fetch", async () => {
  let called = false;
  const c = new AnypointClient({ ...CREDS, fetchImpl: async () => (called = true) });
  const d = await c.describeDeployment({ app: "  ", env: "Dev" });
  assert.equal(d.found, false);
  assert.match(d.reason, /no deployed application name/);
  assert.equal(called, false);
});

test("describeDeployment: not configured → skip-with-reason", async () => {
  const c = new AnypointClient({ clientId: "", clientSecret: "", orgId: "" });
  const d = await c.describeDeployment({ app: "x", env: "Dev" });
  assert.equal(d.found, false);
  assert.match(d.reason, /not configured/);
});

test("describeDeployment: environment not found → reason", async () => {
  const c = new AnypointClient({
    ...CREDS,
    fetchImpl: makeFetch([
      ["/oauth2/token", { json: { access_token: "t" } }],
      ["/environments", { json: { data: [{ name: "Dev", id: "e" }] } }],
    ]),
  });
  const d = await c.describeDeployment({ app: "x", env: "Sandbox" });
  assert.equal(d.found, false);
  assert.match(d.reason, /environment "Sandbox" not found/);
});

test("describeDeployment: network error → non-fatal skip-with-reason", async () => {
  const c = new AnypointClient({
    ...CREDS,
    fetchImpl: async () => {
      throw new Error("ETIMEDOUT");
    },
  });
  const d = await c.describeDeployment({ app: "x", env: "Dev" });
  assert.equal(d.found, false);
  assert.match(d.reason, /lookup failed: ETIMEDOUT/);
});

// ── findDeploymentAcrossEnvs (cross-env safety net for a correct name + wrong/blank env) ──────────
test("findDeploymentAcrossEnvs: locates the app in whichever env actually runs it", async () => {
  const c = new AnypointClient({
    ...CREDS,
    fetchImpl: makeFetch([
      ["/oauth2/token", { json: { access_token: "t" } }],
      ["/environments", { json: { data: [{ name: "Sandbox", id: "eSbx" }, { name: "DEV", id: "eDev" }] } }],
      [
        "/deployments",
        (url) =>
          url.includes("/eDev/")
            ? { json: { items: [{ name: "lead-to-contacts-demo-api", application: { status: "RUNNING" }, target: { deploymentSettings: { runtimeVersion: "4.9.19:17" } } } ] } }
            : { json: { items: [{ name: "something-else", status: "RUNNING" }] } },
      ],
    ]),
  });
  const d = await c.findDeploymentAcrossEnvs({ app: "lead-to-contacts-demo-api" });
  assert.equal(d.found, true);
  assert.equal(d.environment, "DEV");
  assert.equal(d.javaVersion, 17);
});

test("findDeploymentAcrossEnvs: absent everywhere → found:false lists the envs searched", async () => {
  const c = new AnypointClient({
    ...CREDS,
    fetchImpl: makeFetch([
      ["/oauth2/token", { json: { access_token: "t" } }],
      ["/environments", { json: { data: [{ name: "Sandbox", id: "eSbx" }, { name: "DEV", id: "eDev" }] } }],
      ["/deployments", { json: { items: [{ name: "other", status: "RUNNING" }] } }],
    ]),
  });
  const d = await c.findDeploymentAcrossEnvs({ app: "ghost" });
  assert.equal(d.found, false);
  assert.deepEqual(d.searched, ["Sandbox", "DEV"]);
  assert.match(d.reason, /Sandbox, DEV/);
});

test("findDeploymentAcrossEnvs: not configured → skip-with-reason", async () => {
  const c = new AnypointClient({ clientId: "", clientSecret: "", orgId: "" });
  const d = await c.findDeploymentAcrossEnvs({ app: "x" });
  assert.equal(d.found, false);
  assert.match(d.reason, /not configured/);
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
      if (url.includes("token"))
        return { status: 200, text: async () => JSON.stringify({ access_token: "t" }) };
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

// C: highestSemver now delegates to semver.lt. The retired vnum() packing capped each segment at
// ~1000, so a >999 minor/patch could be mis-ordered; lt() compares segment-by-segment with no cap.
test("highestSemver: large segments order correctly (no vnum overflow) + qualifier tolerance", () => {
  assert.equal(highestSemver(["1.9.0", "1.1000.0", "1.11.3"]), "1.1000.0");
  assert.equal(highestSemver(["2.0.0", "10.0.0", "9.9.9"]), "10.0.0");
  // qualifiers are stripped by semver.toNums, so a -SNAPSHOT ties its release core; the higher
  // release still wins over a lower one regardless of qualifier.
  assert.equal(highestSemver(["1.1.9", "1.2.0-SNAPSHOT"]), "1.2.0-SNAPSHOT");
  assert.equal(highestSemver([null, "", "1.0.0"]), "1.0.0"); // blanks filtered
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
    [
      "maven-metadata.xml",
      { text: "<metadata><versioning><versions><version>1.0.4</version></versions></versioning></metadata>" },
    ],
    [".yaml", { text: "schemaVersion: 1\nconnectors: []\n" }],
  ]);
  const ex = new ExchangeClient({ anypoint: fakeAnypoint(fetchImpl) });
  const r = await ex.fetchAsset("matrix");
  assert.equal(r.ok, false);
  assert.match(r.reason, /empty connectors/);
});

test("ExchangeClient: healthy matrix asset → ok:true with parsed data + resolved version", async () => {
  const fetchImpl = makeFetch([
    [
      "maven-metadata.xml",
      {
        text: "<metadata><versioning><versions><version>1.0.4</version><version>1.2.0</version></versions></versioning></metadata>",
      },
    ],
    [".yaml", { text: "schemaVersion: 1\nconnectors:\n  - artifactId: a\n    set: '1.0.0'\n" }],
  ]);
  const ex = new ExchangeClient({ anypoint: fakeAnypoint(fetchImpl) });
  const r = await ex.fetchAsset("matrix");
  assert.equal(r.ok, true);
  assert.equal(r.version, "1.2.0"); // highest semver, exchange-latest
  assert.equal(r.data.connectors.length, 1);
});

// C: timeoutMs is now APPLIED to fetches via an AbortController (previously stored, never used). A
// hung host aborts at the deadline and the error degrades non-fatally (fetchPom → { ok:false }).
test("ExchangeClient: a hung fetch is aborted at timeoutMs and degrades non-fatally", async () => {
  // fetch that never resolves on its own — only the injected abort signal ends it.
  const hangUntilAbort = (_url, init) =>
    new Promise((_resolve, reject) => {
      const sig = init?.signal;
      if (sig) sig.addEventListener("abort", () => reject(new Error("The operation was aborted")));
    });
  const ex = new ExchangeClient({ anypoint: fakeAnypoint(hangUntilAbort), timeoutMs: 20 });
  const r = await ex.fetchPom("g", "a", "1.0.0"); // fully non-fatal wrapper
  assert.equal(r.ok, false, "aborted fetch surfaces as a non-fatal ok:false");
  assert.match(r.reason, /abort/i);
});

test("ExchangeClient: timeoutMs=0 disables the deadline (no signal injected)", async () => {
  let sawSignal = "unset";
  const fetchImpl = async (_url, init) => {
    sawSignal = init && "signal" in init ? "present" : "absent";
    return { status: 200, headers: { get: () => "text/plain" }, text: async () => "<project></project>" };
  };
  const ex = new ExchangeClient({ anypoint: fakeAnypoint(fetchImpl), timeoutMs: 0 });
  await ex.fetchPom("g", "a", "1.0.0");
  assert.equal(sawSignal, "absent", "no AbortController wiring when timeout disabled");
});

// ── listVersions (Graph-backed, paginated) ───────────────────────────────────────────────────────
// A fake GraphQL fetch that serves pages of assets rows keyed off the offset in the query body.
// Records queries so we can assert pagination stops on a short page. Pure in-memory; no network.
function makeGraphFetch(rowsByOffset, calls) {
  return async (_url, init) => {
    const parsed = JSON.parse(init.body);
    if (calls) calls.push(parsed.query);
    const off = Number(/offset:\s*(\d+)/.exec(parsed.query)?.[1] ?? 0);
    const rows = rowsByOffset[off] ?? [];
    return {
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ data: { assets: rows } }),
    };
  };
}

test("listVersions: paginates searchTerm, keeps exact assetId, reaches true latest", async () => {
  // Page 0 is relevance-ranked and misses the newest; page 1 carries it. Foreign assetId rows and a
  // groupId mismatch must be discarded.
  const calls = [];
  const rows = {
    0: [
      { groupId: "org.mule.connectors", assetId: "mule-http-connector", version: "1.5.15" },
      { groupId: "org.mule.connectors", assetId: "mule-http-connector", version: "1.5.14" },
      { groupId: "com.other", assetId: "mule-http-connector", version: "9.9.9" }, // wrong group → drop
      { groupId: "org.mule.connectors", assetId: "some-other-connector", version: "3.0.0" }, // wrong asset → drop
      ...Array.from({ length: 96 }, (_, i) => ({
        groupId: "org.mule.connectors",
        assetId: "mule-http-connector",
        version: `1.4.${i}`,
      })),
    ],
    100: [{ groupId: "org.mule.connectors", assetId: "mule-http-connector", version: "1.11.3" }], // short page → stop
  };
  const ex = new ExchangeClient({ anypoint: fakeAnypoint(makeGraphFetch(rows, calls)) });
  const r = await ex.listVersions("org.mule.connectors", "mule-http-connector");
  assert.equal(r.ok, true);
  assert.equal(r.latest, "1.11.3", "full pagination reaches the true latest");
  assert.ok(r.versions.includes("1.5.15") && r.versions.includes("1.11.3"));
  assert.ok(!r.versions.includes("9.9.9"), "groupId mismatch dropped");
  assert.equal(calls.length, 2, "stops after the short second page");
});

test("listVersions: not configured → ok:false", async () => {
  const ex = new ExchangeClient({ anypoint: fakeAnypoint(async () => ({}), false) });
  const r = await ex.listVersions("g", "a");
  assert.equal(r.ok, false);
  assert.match(r.reason, /not configured/);
});

test("listVersions: no matching rows → ok:false, non-fatal", async () => {
  const ex = new ExchangeClient({ anypoint: fakeAnypoint(makeGraphFetch({ 0: [] })) });
  const r = await ex.listVersions("g", "mule-missing-connector");
  assert.equal(r.ok, false);
  assert.match(r.reason, /no versions/i);
});

test("listVersions: GraphQL errors array → ok:false with the message (non-fatal)", async () => {
  const fetchImpl = async () => ({
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify({ errors: [{ message: "unknown field groupId" }] }),
  });
  const ex = new ExchangeClient({ anypoint: fakeAnypoint(fetchImpl) });
  const r = await ex.listVersions("g", "a");
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown field/);
});

test("listVersions: HTML response (auth redirect) → ok:false, guarded", async () => {
  const fetchImpl = async () => ({
    status: 200,
    headers: { get: () => "text/html" },
    text: async () => "<!doctype html><html><body>login</body></html>",
  });
  const ex = new ExchangeClient({ anypoint: fakeAnypoint(fetchImpl) });
  const r = await ex.listVersions("g", "a");
  assert.equal(r.ok, false);
  assert.match(r.reason, /HTML/);
});

// ── parsePomDependencies (B12) ─────────────────────────────────────────────────────────────────
const SAMPLE_POM = `<?xml version="1.0"?>
<project>
  <groupId>com.mulesoft.connectors</groupId>
  <artifactId>mule-salesforce-connector</artifactId>
  <version>10.19.2</version>
  <properties>
    <objectstore.version>1.0.0</objectstore.version>
    <mule.version>4.6.0</mule.version>
  </properties>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.mule.runtime</groupId>
        <artifactId>mule-api-bom</artifactId>
        <version>1.5.0</version>
        <type>pom</type>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.mule.connectors</groupId>
      <artifactId>mule-objectstore-connector</artifactId>
      <version>\${objectstore.version}</version>
      <classifier>mule-plugin</classifier>
    </dependency>
    <dependency>
      <groupId>com.mulesoft.connectors</groupId>
      <artifactId>mule-connector-commons</artifactId>
      <version>1.3.0</version>
    </dependency>
    <dependency>
      <groupId>org.mule.sdk</groupId>
      <artifactId>mule-sdk-api</artifactId>
    </dependency>
  </dependencies>
</project>`;

test("parsePomDependencies: classifies property / literal / BOM-managed versions, ignores dependencyManagement", () => {
  const { properties, dependencies } = parsePomDependencies(SAMPLE_POM);
  assert.equal(properties["objectstore.version"], "1.0.0");
  assert.equal(properties["mule.version"], "4.6.0");
  // Only the 3 top-level deps — the mule-api-bom under dependencyManagement is excluded.
  assert.equal(dependencies.length, 3);
  const os = dependencies.find((d) => d.artifactId === "mule-objectstore-connector");
  assert.deepEqual(os, {
    groupId: "org.mule.connectors",
    artifactId: "mule-objectstore-connector",
    version: null,
    versionRef: "objectstore.version",
    managed: false,
  });
  const commons = dependencies.find((d) => d.artifactId === "mule-connector-commons");
  assert.equal(commons.version, "1.3.0");
  assert.equal(commons.versionRef, null);
  assert.equal(commons.managed, false);
  const sdk = dependencies.find((d) => d.artifactId === "mule-sdk-api");
  assert.equal(sdk.managed, true); // no <version> → BOM/parent-managed
  assert.equal(sdk.version, null);
});

test("parsePomDependencies: empty / junk input → empty shape (non-fatal)", () => {
  assert.deepEqual(parsePomDependencies(""), { properties: {}, dependencies: [] });
  assert.deepEqual(parsePomDependencies("<project></project>"), { properties: {}, dependencies: [] });
  assert.deepEqual(parsePomDependencies(null), { properties: {}, dependencies: [] });
});

// ── fetchPom (B12) ─────────────────────────────────────────────────────────────────────────────
test("fetchPom: downloads + parses a connector POM from the flat maven facade path", async () => {
  let seenPath = null;
  const fetchImpl = async (url) => {
    seenPath = url;
    return { status: 200, headers: { get: () => "application/xml" }, text: async () => SAMPLE_POM };
  };
  const ex = new ExchangeClient({ anypoint: fakeAnypoint(fetchImpl) });
  const r = await ex.fetchPom("com.mulesoft.connectors", "mule-salesforce-connector", "10.19.2");
  assert.equal(r.ok, true);
  assert.match(
    seenPath,
    /\/api\/v3\/maven\/com\.mulesoft\.connectors\/mule-salesforce-connector\/10\.19\.2\/mule-salesforce-connector-10\.19\.2\.pom$/
  );
  assert.equal(r.dependencies.length, 3);
  assert.equal(r.properties["objectstore.version"], "1.0.0");
});

test("fetchPom: not configured / missing coords / non-POM body → ok:false (non-fatal)", async () => {
  const notCfg = new ExchangeClient({ anypoint: fakeAnypoint(async () => ({}), false) });
  assert.equal((await notCfg.fetchPom("g", "a", "1.0.0")).ok, false);

  const ex = new ExchangeClient({ anypoint: fakeAnypoint(async () => ({})) });
  assert.match((await ex.fetchPom("g", "a")).reason, /required/); // no version

  const htmlEx = new ExchangeClient({
    anypoint: fakeAnypoint(async () => ({
      status: 200,
      headers: { get: () => "text/html" },
      text: async () => "<html>login</html>",
    })),
  });
  const r = await htmlEx.fetchPom("g", "a", "1.0.0");
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a Maven POM/);
});

// ── graphDependencies (B13, one-level) ───────────────────────────────────────────────────────────
test("graphDependencies: returns the exact-version row's DIRECT edges (no transitive recursion)", async () => {
  const rows = {
    0: [
      {
        groupId: "com.mulesoft.connectors",
        assetId: "mule-salesforce-connector",
        version: "10.19.2",
        dependencies: [
          { groupId: "org.mule.connectors", assetId: "mule-objectstore-connector", version: "1.0.0" },
          { groupId: "com.mulesoft.connectors", assetId: "mule-connector-commons", version: "1.3.0" },
        ],
      },
      {
        groupId: "com.mulesoft.connectors",
        assetId: "mule-salesforce-connector",
        version: "9.4.5",
        dependencies: [{ groupId: "x", assetId: "old-dep", version: "0.1.0" }],
      },
    ],
  };
  const ex = new ExchangeClient({ anypoint: fakeAnypoint(makeGraphFetch(rows)) });
  const r = await ex.graphDependencies("com.mulesoft.connectors", "mule-salesforce-connector", "10.19.2");
  assert.equal(r.ok, true);
  assert.equal(r.version, "10.19.2"); // matched the requested exact version, not the first row
  assert.deepEqual(
    r.dependencies.map((d) => `${d.assetId}@${d.version}`),
    ["mule-objectstore-connector@1.0.0", "mule-connector-commons@1.3.0"]
  );
});

test("graphDependencies: no version arg → first assetId match; not-found → ok:false", async () => {
  const rows = {
    0: [
      {
        groupId: "com.mulesoft.connectors",
        assetId: "mule-salesforce-connector",
        version: "10.19.2",
        dependencies: [],
      },
    ],
  };
  const ex = new ExchangeClient({ anypoint: fakeAnypoint(makeGraphFetch(rows)) });
  const hit = await ex.graphDependencies(null, "mule-salesforce-connector");
  assert.equal(hit.ok, true);
  assert.equal(hit.version, "10.19.2");

  const miss = await ex.graphDependencies("g", "mule-salesforce-connector", "99.0.0");
  assert.equal(miss.ok, false);
  assert.match(miss.reason, /not found/i);
});

test("graphDependencies: not configured → ok:false", async () => {
  const ex = new ExchangeClient({ anypoint: fakeAnypoint(async () => ({}), false) });
  const r = await ex.graphDependencies("g", "a", "1.0.0");
  assert.equal(r.ok, false);
  assert.match(r.reason, /not configured/);
});
