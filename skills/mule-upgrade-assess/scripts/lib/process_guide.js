// process_guide.js — the "Java 17 Upgrade Process Guide" BASELINE.
//
// The engine already computes what to EDIT. This module answers a different question the guide asks:
// "for each item on the official checklist, did we actually verify it, and what's the verdict?"
//
// Why this exists as its own report rather than more warnings: warnings only appear when something is
// wrong, which makes them useless for sign-off — you cannot tell "checked and fine" apart from "never
// checked". Several guide items are genuinely NOT machine-checkable from a repo (the Maven CLI on the
// engineer's laptop, the Studio version, whether MUnit Recorder was used). Silently omitting those
// would imply coverage the assessment does not have. So every item reports one of four verdicts:
//
//   ok        verified compliant — nothing to do
//   will-fix  non-compliant, and this upgrade's fileEdits already handle it
//   action    non-compliant and NOT auto-fixable — a human must change code/config
//   manual    not determinable from the repository — a human must confirm out-of-band
//
// Nothing here mutates the ChangePlan or gates the upgrade. It is a reporting layer over facts the
// assessment already established, so it cannot change what gets edited.

import { lt } from "../../../../lib_shared/semver.js";
import { javaMajor } from "../../../../lib_shared/java_version.js";

/** @typedef {{id:string,item:string,status:"ok"|"will-fix"|"action"|"manual",detail:string}} GuideItem */

/**
 * processGuideBaseline — evaluate the Process Guide checklist against one assessment.
 *
 * @param {object} [a]
 * @param {object} [a.matrix]              compatibility matrix (gating floors + processGuide block)
 * @param {Array<object>} [a.fileEdits]    changePlan.fileEdits (each gating edit carries `property`)
 * @param {string} [a.currentRuntime]
 * @param {string} [a.currentJavaVersion]
 * @param {string[]} [a.matchedReviews]    manualReview KEYS that matched the content scan
 * @param {Array<object>} [a.connectorGaps]
 * @param {Array<object>} [a.missingFromMatrix]
 * @param {boolean} [a.connectorProject]   the project is itself a Mule extension/connector
 * @param {boolean} [a.hasApiPolicies]
 * @param {(rel:string)=>(string|null)} [a.readFile]
 * @returns {{items:GuideItem[], summary:{ok:number,willFix:number,action:number,manual:number}, verified:number, total:number}}
 */
export function processGuideBaseline({
  matrix,
  fileEdits = [],
  currentRuntime,
  currentJavaVersion,
  matchedReviews = [],
  connectorGaps = [],
  missingFromMatrix = [],
  connectorProject = false,
  hasApiPolicies = false,
  readFile = null,
} = {}) {
  const gating = matrix?.gating ?? {};
  const guide = matrix?.processGuide ?? {};
  const edits = Array.isArray(fileEdits) ? fileEdits : [];
  const matched = new Set(matchedReviews ?? []);
  // Every "Java N" in this report reads the matrix target, so a retarget relabels the whole checklist.
  const java = javaMajor(matrix?.target?.javaVersion) ?? 17;

  /** Any edit that targets this Maven property (property edits, inline dep pins, plugin pins). */
  const editForProperty = (prop) => (prop ? edits.find((e) => e?.property === prop) : undefined);
  const editOfKind = (kind) => edits.find((e) => e?.kind === kind);

  /** @type {GuideItem[]} */
  const items = [];

  /**
   * A version-floor item: `will-fix` when the upgrade bumps it, else `ok` at the resolved value, else
   * `manual` when the app never declares it at all (nothing to read and nothing to change).
   */
  const floorItem = (id, item, rule, { absentIsOk = false, absentNote = "" } = {}) => {
    const prop = rule?.property;
    const edit = editForProperty(prop);
    if (edit) {
      items.push({
        id,
        item,
        status: "will-fix",
        detail: `${edit.from ?? "absent"} → ${edit.to} (${prop})`,
      });
      return;
    }
    items.push(
      absentIsOk
        ? { id, item, status: "ok", detail: absentNote || `already at or above the ${rule?.min ?? rule?.set} floor` }
        : { id, item, status: "ok", detail: `already at or above the ${rule?.min ?? rule?.set} floor` }
    );
  };

  // ── platform + build floors (all machine-verified from the pom chain) ─────────────────────────
  const runtimeEdit = editForProperty(gating.muleRuntime?.property) ?? editForProperty(gating.muleRuntimeSemver?.property);
  items.push({
    id: "muleRuntime",
    item: `Mule runtime >= ${gating.muleRuntime?.min ?? "4.6.0"} (target ${matrix?.target?.runtime ?? "4.9.18"})`,
    status: runtimeEdit ? "will-fix" : "ok",
    detail: runtimeEdit
      ? `${runtimeEdit.from ?? "absent"} → ${runtimeEdit.to}`
      : `already at ${currentRuntime ?? "the target"}`,
  });

  const javaEdit =
    editForProperty(gating.javaVersion?.property) ??
    editForProperty(gating.javaCompilerSource?.property) ??
    editForProperty(gating.javaCompilerTarget?.property);
  items.push({
    id: "javaVersion",
    item: `Java ${java} (java.version / maven.compiler.source+target)`,
    status: javaEdit ? "will-fix" : "ok",
    detail: javaEdit ? `${javaEdit.from ?? "absent"} → ${javaEdit.to}` : `already at ${currentJavaVersion ?? java}`,
  });

  floorItem("muleMavenPlugin", `mule-maven-plugin >= ${gating.muleMavenPlugin?.min ?? "4.1.1"} (Java-${java} packaging/deploy)`, gating.muleMavenPlugin);
  floorItem("munit", `MUnit >= ${gating.munit?.min ?? "3.6.3"} (embedded container starts on Java ${java})`, gating.munit);
  floorItem("munitExtensionsPlugin", `munit-extensions-maven-plugin >= ${gating.munitExtPlugin?.min ?? "1.2.0"}`, gating.munitExtPlugin);
  floorItem("dataweave", `DataWeave assertions/weave >= ${gating.weave?.min ?? "1.2.0"}`, gating.weave);

  const maEdit = editOfKind("muleArtifactJson");
  items.push({
    id: "muleArtifactJson",
    item: "mule-artifact.json declares minMuleVersion + javaSpecificationVersions",
    status: maEdit ? "will-fix" : "ok",
    detail: maEdit
      ? `minMuleVersion → ${maEdit.to?.minMuleVersion}, javaSpecificationVersions → [${(maEdit.to?.javaSpecificationVersions ?? []).join(", ")}]`
      : "already declares a Java-17-capable descriptor",
  });

  const ciEdit = editOfKind("ciWorkflow");
  items.push({
    id: "ciJdk",
    item: `CI builds on JDK ${java}`,
    status: ciEdit ? "will-fix" : "manual",
    detail: ciEdit
      ? `workflow java-version ${ciEdit.from} → ${ciEdit.to}`
      : `no setup-java workflow found in the repo — confirm the pipeline that builds this app uses JDK ${java}`,
  });

  const argLineEdit = editOfKind("munitArgLines");
  items.push({
    id: "munitJpmsArgLines",
    item: "No --add-opens/--add-exports argLines on the MUnit plugins",
    status: argLineEdit ? "will-fix" : matched.has("munitJpmsFlags") ? "action" : "ok",
    detail: argLineEdit
      ? "JPMS argLines will be stripped (the Mule 4.9 embedded container rejects them)"
      : matched.has("munitJpmsFlags")
        ? "JPMS flags found but not in an editable MUnit plugin block — remove them by hand"
        : "none present",
  });

  // ── connector coverage ───────────────────────────────────────────────────────────────────────
  const gapCount = connectorGaps?.length ?? 0;
  const missingCount = missingFromMatrix?.length ?? 0;
  items.push({
    id: "connectorVersions",
    item: `Connectors pinned to Java-${java}-compatible versions`,
    status: gapCount || missingCount ? "action" : "ok",
    detail:
      gapCount || missingCount
        ? [
            gapCount ? `${gapCount} pinned upstream in a parent/BOM pom (needs a parent-pom upgrade)` : null,
            missingCount ? `${missingCount} not covered by the matrix (extend it, then re-run)` : null,
          ]
            .filter(Boolean)
            .join("; ")
        : "every referenced connector resolves to a matrix-pinned version",
  });

  // ── code-level breaking changes (content scan) ────────────────────────────────────────────────
  const scanItem = (id, key, item, okDetail) => {
    const hit = matched.has(key);
    items.push({
      id,
      item,
      status: hit ? "action" : "ok",
      detail: hit
        ? String(guide?.[key]?.detail ?? matrix?.manualReview?.[key]?.warn ?? "flagged by the content scan — review before upgrading")
        : okDetail,
    });
  };
  scanItem(
    "dwErrorMessage",
    "dwErrorMuleMessage",
    "DataWeave: error.muleMessage replaced by error.errorMessage",
    "no error.muleMessage references found in DataWeave or Mule XML"
  );
  scanItem(
    "reflectiveAccess",
    "setAccessible",
    `No reflective setAccessible() into JDK internals (Java ${java} strong encapsulation)`,
    "no setAccessible() calls found"
  );
  scanItem(
    "resourceBundles",
    "resourceBundle",
    "ResourceBundle loading still resolves under JPMS",
    "no ResourceBundle.getBundle() calls found"
  );
  scanItem(
    "mockingFramework",
    "powermock",
    `No PowerMock (cannot mock JVM classes on Java ${java})`,
    "no PowerMock usage found"
  );
  scanItem(
    "dwJavaPojo",
    "javaPojoInDw",
    "DataWeave Java POJO mappings have setters, not just getters",
    "no `as Object { class: ... }` POJO coercions found"
  );

  // ── custom connector / extension path ────────────────────────────────────────────────────────
  items.push({
    id: "customConnector",
    item: `Custom connectors declare @JavaVersionSupport + a Java-${java} mule-sdk-api`,
    status: connectorProject ? "action" : "ok",
    detail: connectorProject
      ? "this project IS a Mule extension — follow the connector-upgrade checklist in the warnings (annotations, mule-sdk-api, parent POM, ByteBuddy/Jacoco/SLF4J)"
      : "not an extension project; any third-party connectors are covered by the matrix pins",
  });

  // ── toolchain: only assertable when the repo actually pins it ─────────────────────────────────
  items.push(mavenToolchainItem(readFile, guide));

  /** @type {Array<{id:string,item:string,detail:string}>} */
  const notDetectable = [
    {
      id: "anypointStudio",
      item: `Anypoint Studio >= ${guide?.studioMin ?? "7.17"}`,
      detail: "the IDE version is not in the repo — confirm with whoever opens this project locally",
    },
    {
      id: "munitRecorder",
      item: `MUnit Recorder not relied upon (no Java ${java} support)`,
      detail: "recorder usage leaves no reliable repo trace — confirm tests were not generated by the MUnit Recorder",
    },
    {
      id: "runtimeManagerJava",
      item: `Runtime Manager deployment set to Java ${java} after merge`,
      detail: "a deploy-time setting, not a repo setting — verify in Runtime Manager (or pass deployedApiName for a live check)",
    },
  ];
  for (const n of notDetectable) items.push({ ...n, status: "manual" });

  items.push({
    id: "apiPolicies",
    item: `API Manager policies re-validated on Java ${java}`,
    status: hasApiPolicies ? "action" : "manual",
    detail: hasApiPolicies
      ? `this API has policies applied — older policy versions can fail on Java ${java}; re-validate each one`
      : `policy state was not read (enable assess.apiPolicyCheck) — confirm any applied policies support Java ${java}`,
  });

  const summary = {
    ok: items.filter((i) => i.status === "ok").length,
    willFix: items.filter((i) => i.status === "will-fix").length,
    action: items.filter((i) => i.status === "action").length,
    manual: items.filter((i) => i.status === "manual").length,
  };
  return { items, summary, verified: summary.ok + summary.willFix, total: items.length };
}

/**
 * Maven floor. Only the Maven WRAPPER is in the repo; the CLI on the engineer's machine is not. So this
 * is `ok`/`will-fix`-style only when a wrapper pins a version, and honestly `manual` otherwise rather
 * than pretending the build tool was verified.
 * @param {((rel:string)=>(string|null))|null} readFile
 * @param {any} guide
 * @returns {GuideItem}
 */
function mavenToolchainItem(readFile, guide) {
  const min = String(guide?.mavenMin ?? "3.9.6");
  const item = `Maven >= ${min}`;
  if (typeof readFile !== "function") {
    return { id: "maven", item, status: "manual", detail: "run `mvn -v` on the build machine to confirm" };
  }
  let txt = null;
  try {
    txt = readFile(".mvn/wrapper/maven-wrapper.properties");
  } catch {
    txt = null;
  }
  if (!txt) {
    return {
      id: "maven",
      item,
      status: "manual",
      detail: "no Maven wrapper in the repo — the CLI version is not knowable from here; run `mvn -v` on the build machine",
    };
  }
  const m = txt.match(/apache-maven-([0-9]+(?:\.[0-9]+)*)/);
  if (!m) {
    return { id: "maven", item, status: "manual", detail: "Maven wrapper present but its version could not be parsed" };
  }
  const found = m[1];
  return lt(found, min)
    ? {
        id: "maven",
        item,
        status: "action",
        detail: `Maven wrapper pins ${found}, below the ${min} floor — update .mvn/wrapper/maven-wrapper.properties`,
      }
    : { id: "maven", item, status: "ok", detail: `Maven wrapper pins ${found}` };
}

/** Compact human-readable baseline for CLI / chat surfacing. */
export function formatProcessGuide(baseline) {
  if (!baseline?.items?.length) return "";
  const icon = { ok: "ok      ", "will-fix": "will-fix", action: "ACTION  ", manual: "manual  " };
  const lines = [
    `Process Guide baseline — ${baseline.summary.ok} ok, ${baseline.summary.willFix} auto-fixed, ` +
      `${baseline.summary.action} need action, ${baseline.summary.manual} to confirm manually`,
  ];
  for (const i of baseline.items) {
    lines.push(`  [${icon[i.status] ?? i.status}] ${i.item}`);
    if (i.status === "action" || i.status === "manual") lines.push(`               ${i.detail}`);
  }
  return lines.join("\n");
}
