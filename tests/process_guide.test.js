// tests/process_guide.test.js — the "Java 17 Upgrade Process Guide" baseline (Step 4).
//
// Two things under test:
//   1. scanTargets/scanFlags now see DataWeave + Mule XML, not just .java — without that, every
//      DataWeave-level check in the guide would silently report "clean" forever.
//   2. processGuideBaseline turns established facts into ok / will-fix / action / manual verdicts,
//      and never claims to have verified something it cannot see (Maven CLI, Studio, MUnit Recorder).

import test from "node:test";
import assert from "node:assert/strict";
import { processGuideBaseline, formatProcessGuide } from "../skills/mule-upgrade-assess/scripts/lib/process_guide.js";
import { scanFlags, scanTargets } from "../skills/mule-upgrade-assess/scripts/lib/assess_engine.js";

const MATRIX = {
  target: { runtime: "4.9.18", javaVersion: "17" },
  gating: {
    muleRuntime: { property: "app.runtime", min: "4.6.0", set: "4.9.18" },
    javaVersion: { property: "java.version", in: ["1.8", "8", "11"], set: "17" },
    muleMavenPlugin: { property: "mule.maven.plugin.version", min: "4.1.1", set: "4.10.0" },
    munit: { property: "munit.version", min: "3.6.3", set: "3.6.3" },
    munitExtPlugin: { property: "munit.extensions.maven.plugin.version", min: "1.2.0", set: "1.5.0" },
    weave: { property: "weave.version", min: "1.2.0", set: "1.5.0" },
  },
  manualReview: {
    dwErrorMuleMessage: { scanRegex: "error\\s*\\.\\s*muleMessage", warn: "error.muleMessage is removed" },
    setAccessible: { scanRegex: "setAccessible\\s*\\(", warn: "reflective setAccessible" },
    powermock: { scanRegex: "(?:org\\.powermock|powermock-)", warn: "PowerMock detected" },
    javaPojoInDw: { scanRegex: "as Object \\{ class:", warn: "POJO needs setters" },
    resourceBundle: { scanRegex: "ResourceBundle\\.getBundle", warn: "ResourceBundle" },
  },
  processGuide: { mavenMin: "3.9.6", studioMin: "7.17" },
};

const item = (b, id) => b.items.find((i) => i.id === id);

// ── 1. the scan corpus ────────────────────────────────────────────────────────────────────────

test("scanTargets includes .dwl and src/main/mule XML, not just .java", () => {
  const items = [
    { path: "src/main/java/Foo.java", type: "blob" },
    { path: "src/main/resources/dwl/map.dwl", type: "blob" },
    { path: "src/main/mule/api.xml", type: "blob" },
    { path: "src/main/resources/app.yaml", type: "blob" }, // not scanned
    { path: "src/main/mule", type: "tree" }, // directories never read
  ];
  const t = scanTargets(items);
  assert.deepEqual(t.paths.sort(), [
    "src/main/java/Foo.java",
    "src/main/mule/api.xml",
    "src/main/resources/dwl/map.dwl",
  ]);
});

test("scanTargets scopes .dwl/.xml to the app module but keeps .java repo-wide", () => {
  const items = [
    { path: "apps/orders/src/main/mule/orders.xml", type: "blob" },
    { path: "apps/orders/src/main/resources/dwl/o.dwl", type: "blob" },
    { path: "apps/payments/src/main/mule/payments.xml", type: "blob" },
    { path: "apps/payments/src/main/resources/dwl/p.dwl", type: "blob" },
    { path: "shared/src/main/java/Util.java", type: "blob" },
  ];
  const t = scanTargets(items, { appPath: "apps/orders" });
  assert.ok(t.paths.includes("apps/orders/src/main/mule/orders.xml"));
  assert.ok(t.paths.includes("apps/orders/src/main/resources/dwl/o.dwl"));
  assert.ok(!t.paths.some((p) => p.includes("payments")), "a sibling module's DataWeave is not scanned");
  assert.ok(t.paths.includes("shared/src/main/java/Util.java"), "custom Java anywhere still matters for a JDK bump");
});

test("scanTargets bounds the corpus and reports truncation", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ path: `src/main/resources/dwl/f${i}.dwl`, type: "blob" }));
  const t = scanTargets(items, { maxScanFiles: 4 });
  assert.equal(t.paths.length, 4);
  assert.equal(t.total, 10);
  assert.ok(t.truncated);
});

test("scanFlags finds error.muleMessage inside a .dwl file and reports the matched KEY", () => {
  const tree = { tree: [{ path: "src/main/resources/dwl/err.dwl", type: "blob" }] };
  const files = { "src/main/resources/dwl/err.dwl": '%dw 2.0\noutput application/json\n---\n{ msg: error.muleMessage }' };
  const flags = scanFlags(tree, "<project/>", {
    manualReview: MATRIX.manualReview,
    readFile: (p) => files[p] ?? null,
  });
  assert.ok(flags.matchedReviews.includes("dwErrorMuleMessage"));
  assert.ok(flags.warnings.some((w) => /error.muleMessage/.test(w)));
});

test("scanFlags finds error.muleMessage in an inline Mule XML expression", () => {
  const tree = { tree: [{ path: "src/main/mule/api.xml", type: "blob" }] };
  const files = { "src/main/mule/api.xml": '<logger message="#[error.muleMessage.payload]"/>' };
  const flags = scanFlags(tree, "<project/>", {
    manualReview: MATRIX.manualReview,
    readFile: (p) => files[p] ?? null,
  });
  assert.ok(flags.matchedReviews.includes("dwErrorMuleMessage"), "inline DW in Mule XML must be scanned too");
});

test("scanFlags stays clean when nothing matches, and reports no false keys", () => {
  const tree = { tree: [{ path: "src/main/resources/dwl/ok.dwl", type: "blob" }] };
  const flags = scanFlags(tree, "<project/>", {
    manualReview: MATRIX.manualReview,
    readFile: () => "%dw 2.0\n---\n{ msg: error.errorMessage }",
  });
  assert.deepEqual(flags.matchedReviews, []);
});

test("comments never trigger a manual-review flag (prose about a hazard is not the hazard)", () => {
  // A real false positive this guards: a pom whose comment says "Do NOT pass add-opens / add-exports
  // JVM flags via argLines here" was reported as HAVING JPMS argLines — the opposite of the truth.
  const mr = { munitJpmsFlags: { scanRegex: "add-(opens|exports|modules)", warn: "JPMS argLines present" } };
  const documented = scanFlags({ tree: [] }, "<!-- Do NOT pass add-opens / add-exports flags here -->", {
    manualReview: mr,
  });
  assert.deepEqual(documented.matchedReviews, [], "an XML comment must not raise the flag");

  const real = scanFlags({ tree: [] }, "<argLines><argLine>--add-opens=java.base/java.lang</argLine></argLines>", {
    manualReview: mr,
  });
  assert.deepEqual(real.matchedReviews, ["munitJpmsFlags"], "a genuine argLine still raises it");
});

test("block comments in Java/DataWeave are stripped too, but URLs survive", () => {
  const mr = { setAccessible: { scanRegex: "setAccessible\\s*\\(", warn: "reflection" } };
  const tree = { tree: [{ path: "src/main/java/A.java", type: "blob" }] };
  const commented = scanFlags(tree, "<project/>", {
    manualReview: mr,
    readFile: () => "/* legacy code used f.setAccessible(true) before the upgrade */",
  });
  assert.deepEqual(commented.matchedReviews, []);

  const live = scanFlags(tree, "<project/>", {
    manualReview: mr,
    readFile: () => "// see https://example.com/docs\nf.setAccessible(true);",
  });
  assert.deepEqual(live.matchedReviews, ["setAccessible"], "a // line comment must not swallow real code");
});

test("scanFlags warns when the corpus is capped", () => {
  const tree = { tree: Array.from({ length: 5 }, (_, i) => ({ path: `a/b/${i}.dwl`, type: "blob" })) };
  const flags = scanFlags(tree, "<project/>", {
    manualReview: MATRIX.manualReview,
    readFile: () => "clean",
    maxScanFiles: 2,
  });
  assert.ok(flags.warnings.some((w) => /capped at 2 source files/.test(w)));
});

// ── 2. the baseline verdicts ──────────────────────────────────────────────────────────────────

test("a pending bump reports will-fix with the from → to it will apply", () => {
  const b = processGuideBaseline({
    matrix: MATRIX,
    fileEdits: [
      { kind: "pomProperty", property: "app.runtime", from: "4.4.0", to: "4.9.18" },
      { kind: "pomProperty", property: "java.version", from: "8", to: "17" },
      { kind: "pomProperty", property: "munit.version", from: "3.1.0", to: "3.6.3" },
    ],
  });
  assert.equal(item(b, "muleRuntime").status, "will-fix");
  assert.match(item(b, "muleRuntime").detail, /4\.4\.0 → 4\.9\.18/);
  assert.equal(item(b, "javaVersion").status, "will-fix");
  assert.equal(item(b, "munit").status, "will-fix");
});

test("an already-compliant floor reports ok, not will-fix", () => {
  const b = processGuideBaseline({ matrix: MATRIX, fileEdits: [], currentRuntime: "4.9.18", currentJavaVersion: "17" });
  assert.equal(item(b, "muleRuntime").status, "ok");
  assert.equal(item(b, "munit").status, "ok");
  assert.equal(item(b, "muleMavenPlugin").status, "ok");
});

test("DataWeave error.muleMessage is ACTION — it is never auto-edited", () => {
  const b = processGuideBaseline({ matrix: MATRIX, matchedReviews: ["dwErrorMuleMessage"] });
  const i = item(b, "dwErrorMessage");
  assert.equal(i.status, "action");
  assert.match(i.detail, /muleMessage/);
});

test("reflection / PowerMock / POJO scans surface as ACTION when hit, ok when not", () => {
  const hit = processGuideBaseline({
    matrix: MATRIX,
    matchedReviews: ["setAccessible", "powermock", "javaPojoInDw", "resourceBundle"],
  });
  assert.equal(item(hit, "reflectiveAccess").status, "action");
  assert.equal(item(hit, "mockingFramework").status, "action");
  assert.equal(item(hit, "dwJavaPojo").status, "action");
  assert.equal(item(hit, "resourceBundles").status, "action");

  const clean = processGuideBaseline({ matrix: MATRIX, matchedReviews: [] });
  assert.equal(item(clean, "reflectiveAccess").status, "ok");
  assert.equal(item(clean, "mockingFramework").status, "ok");
});

test("connector gaps and matrix misses make the connector item ACTION and say why", () => {
  const b = processGuideBaseline({
    matrix: MATRIX,
    connectorGaps: [{ artifactId: "mule-http-connector", managedInPath: "parent/pom.xml" }],
    missingFromMatrix: [{ groupId: "g", artifactId: "a" }],
  });
  const i = item(b, "connectorVersions");
  assert.equal(i.status, "action");
  assert.match(i.detail, /pinned upstream/);
  assert.match(i.detail, /not covered by the matrix/);
});

test("a clean connector picture is ok", () => {
  const b = processGuideBaseline({ matrix: MATRIX, connectorGaps: [], missingFromMatrix: [] });
  assert.equal(item(b, "connectorVersions").status, "ok");
});

test("an extension project routes to the connector-upgrade path as ACTION", () => {
  const b = processGuideBaseline({ matrix: MATRIX, connectorProject: true });
  assert.equal(item(b, "customConnector").status, "action");
  assert.match(item(b, "customConnector").detail, /mule-sdk-api/);
});

test("CI without a setup-java workflow is MANUAL, not a false ok", () => {
  const b = processGuideBaseline({ matrix: MATRIX, fileEdits: [] });
  assert.equal(item(b, "ciJdk").status, "manual");
  const bumped = processGuideBaseline({ matrix: MATRIX, fileEdits: [{ kind: "ciWorkflow", from: "8", to: "17" }] });
  assert.equal(item(bumped, "ciJdk").status, "will-fix");
});

test("MUnit JPMS argLines: will-fix when editable, ACTION when only scanned", () => {
  const editable = processGuideBaseline({ matrix: MATRIX, fileEdits: [{ kind: "munitArgLines" }] });
  assert.equal(item(editable, "munitJpmsArgLines").status, "will-fix");
  const scannedOnly = processGuideBaseline({ matrix: MATRIX, matchedReviews: ["munitJpmsFlags"] });
  assert.equal(item(scannedOnly, "munitJpmsArgLines").status, "action");
  const clean = processGuideBaseline({ matrix: MATRIX });
  assert.equal(item(clean, "munitJpmsArgLines").status, "ok");
});

test("Maven floor: ok/action from the wrapper, MANUAL when there is no wrapper", () => {
  const noWrapper = processGuideBaseline({ matrix: MATRIX, readFile: () => null });
  assert.equal(item(noWrapper, "maven").status, "manual");
  assert.match(item(noWrapper, "maven").detail, /not knowable from here/);

  const old = processGuideBaseline({
    matrix: MATRIX,
    readFile: () => "distributionUrl=https://repo/apache-maven-3.8.1-bin.zip",
  });
  assert.equal(item(old, "maven").status, "action");
  assert.match(item(old, "maven").detail, /3\.8\.1/);

  const good = processGuideBaseline({
    matrix: MATRIX,
    readFile: () => "distributionUrl=https://repo/apache-maven-3.9.9-bin.zip",
  });
  assert.equal(item(good, "maven").status, "ok");
});

test("items that cannot be checked from a repo are reported MANUAL, never ok", () => {
  const b = processGuideBaseline({ matrix: MATRIX });
  for (const id of ["anypointStudio", "munitRecorder", "runtimeManagerJava"]) {
    assert.equal(item(b, id).status, "manual", `${id} must not claim verification it doesn't have`);
  }
});

test("API policies: ACTION when policies are known to exist, MANUAL when unread", () => {
  assert.equal(item(processGuideBaseline({ matrix: MATRIX, hasApiPolicies: true }), "apiPolicies").status, "action");
  assert.equal(item(processGuideBaseline({ matrix: MATRIX, hasApiPolicies: false }), "apiPolicies").status, "manual");
});

test("summary counts every item exactly once", () => {
  const b = processGuideBaseline({ matrix: MATRIX, matchedReviews: ["dwErrorMuleMessage"] });
  const { ok, willFix, action, manual } = b.summary;
  assert.equal(ok + willFix + action + manual, b.items.length);
  assert.equal(b.total, b.items.length);
  assert.equal(b.verified, ok + willFix);
});

test("the baseline never throws on an empty/absent matrix", () => {
  const b = processGuideBaseline();
  assert.ok(b.items.length > 0);
  assert.equal(b.summary.ok + b.summary.willFix + b.summary.action + b.summary.manual, b.items.length);
});

test("formatProcessGuide prints detail for the items that need a human", () => {
  const txt = formatProcessGuide(processGuideBaseline({ matrix: MATRIX, matchedReviews: ["dwErrorMuleMessage"] }));
  assert.match(txt, /Process Guide baseline/);
  assert.match(txt, /ACTION/);
  assert.equal(formatProcessGuide(null), "");
});
