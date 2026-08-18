// lib/assess_engine.js — faithful port of dwl::assessment.
// Applies the compatibility matrix to a resolved pom inheritance chain and produces the
// AssessmentResult (with a ChangePlan.fileEdits[] consumable by mule-upgrade-apply).
//
// Every function is pure: the chain, matrix, and decoded file text are passed in explicitly.
// The chain is REHYDRATED from each entry's raw pomText so repeated <dependency>/<plugin> keys
// survive (see the rehydrate note in the Mule app) — otherwise connector pins and
// missing-from-matrix detection silently vanish.

import { parsePom, asArray } from "./pom_parse.js";
import { propOf, dependenciesOf, managedDependenciesOf, pluginsOf, managedPluginsOf } from "./pom_chain.js";
import { lt, bumpMinor, isRef, refName } from "../../../../lib_shared/semver.js";
import { javaLt, javaMajor, supportedJavaMajors } from "../../../../lib_shared/java_version.js";
import { processGuideBaseline } from "./process_guide.js";

// rehydrate(chain): rebuild each entry's parsed pom FROM ITS RAW TEXT.
export function rehydrate(chain) {
  return (chain ?? []).map((c) => ({
    path: c.path,
    pom: c.pomText ? parsePom(String(c.pomText)) : c.pom,
    pomText: c.pomText,
  }));
}

// rawProp(name): first non-null property value across the chain (nearest-first).
export function rawProp(chain, name) {
  for (const c of chain) {
    const v = propOf(c.pom, name);
    if (v != null) return v;
  }
  return null;
}

// resolveProp(name): rawProp following ONE level of ${property} indirection.
export function resolveProp(chain, name) {
  const v = rawProp(chain, name);
  if (v != null && /^\s*\$\{.+\}\s*$/.test(String(v))) {
    return rawProp(chain, String(v).trim().replace(/^\$\{/, "").replace(/\}$/, ""));
  }
  return v;
}

// ownerOfProp(name): path of the nearest chain pom declaring the property, else null.
export function ownerOfProp(chain, name) {
  const hit = chain.find((c) => propOf(c.pom, name) != null);
  return hit ? hit.path : null;
}

const asStr = (v) => (v == null ? "" : String(v));

// findDep(g,a): nearest chain entry declaring dependency g:a (deps or depMgmt) → {path, dep}.
export function findDep(chain, g, a) {
  for (const c of chain) {
    const all = [...dependenciesOf(c.pom), ...managedDependenciesOf(c.pom)];
    const hit = all.find((d) => asStr(d.groupId) === g && asStr(d.artifactId) === a);
    if (hit) return { path: c.path, dep: hit };
  }
  return null;
}

// findPlugin(g,a): nearest chain entry declaring plugin a (build or pluginMgmt) → {path, plugin}.
// groupId optional.
export function findPlugin(chain, g, a) {
  for (const c of chain) {
    const all = [...pluginsOf(c.pom), ...managedPluginsOf(c.pom)];
    const hit = all.find((p) => asStr(p.artifactId) === a && (g == null || asStr(p.groupId) === g));
    if (hit) return { path: c.path, plugin: hit };
  }
  return null;
}

// version accessor for a dep/plugin node: the OWN <version> (string) or null.
function versionOf(node) {
  if (!node || typeof node !== "object") return null;
  const v = node.version;
  if (v === undefined || v === null) return null;
  if (typeof v === "object") return null; // shouldn't happen for a leaf version
  return String(v);
}

// ── inPlace strategy (legacy) resolveRule + computePropEdits ──────────────────────────

function resolveInline(chain, r, ver, filePath, kind, coords) {
  if (ver == null) return { property: r.property, kind: null, file: null, installed: null };
  if (/^\s*\$\{.+\}\s*$/.test(String(ver))) {
    const pn = String(ver).trim().replace(/^\$\{/, "").replace(/\}$/, "");
    return {
      property: pn,
      kind: "pomProperty",
      file: ownerOfProp(chain, pn) ?? filePath,
      installed: rawProp(chain, pn),
    };
  }
  return { property: r.property, kind, file: filePath, installed: String(ver), ...coords };
}

export function resolveRule(chain, r) {
  const pOwner = ownerOfProp(chain, r.property);
  const depHit = r.groupId && r.artifactId ? findDep(chain, r.groupId, r.artifactId) : null;
  const plgHit = r.pluginArtifactId ? findPlugin(chain, r.pluginGroupId ?? null, r.pluginArtifactId) : null;
  if (pOwner != null) {
    return { property: r.property, kind: "pomProperty", file: pOwner, installed: rawProp(chain, r.property) };
  }
  if (depHit != null) {
    return resolveInline(chain, r, versionOf(depHit.dep), depHit.path, "depVersion", {
      groupId: r.groupId,
      artifactId: r.artifactId,
    });
  }
  if (plgHit != null) {
    return resolveInline(chain, r, versionOf(plgHit.plugin), plgHit.path, "pluginVersion", {
      pluginGroupId: r.pluginGroupId ?? null,
      pluginArtifactId: r.pluginArtifactId,
    });
  }
  return { property: r.property, kind: null, file: null, installed: null };
}

export function computePropEdits(chain, matrix) {
  const rules = [...Object.values(matrix.gating ?? {}), ...(matrix.connectors ?? [])];
  const out = [];
  for (const r of rules) {
    const res = resolveRule(chain, r);
    const installed = res.installed;
    let needs;
    if (installed == null || res.kind == null) needs = false;
    else if (r.in) needs = r.in.includes(installed);
    else needs = lt(installed, r.set);
    if (!needs) continue;
    const edit = { property: res.property, kind: res.kind, file: res.file };
    if (res.groupId !== undefined) edit.groupId = res.groupId;
    if (res.artifactId !== undefined) edit.artifactId = res.artifactId;
    if (res.pluginGroupId !== undefined) edit.pluginGroupId = res.pluginGroupId;
    if (res.pluginArtifactId !== undefined) edit.pluginArtifactId = res.pluginArtifactId;
    edit.from = installed;
    edit.to = r.set;
    edit.change = true;
    out.push(edit);
  }
  return out;
}

// ── appOverride strategy (default) ────────────────────────────────────────────────────

// needsBump(installed, r): unknown/external ⇒ pin; else honour in[]/semver.
/**
 * Does the installed value need bumping to satisfy rule `r`?
 *
 * Three comparison modes, in precedence order:
 *   compare:"java" → JAVA-MAJOR comparison against `set` ("1.8", "8" and "8.0.402" are all Java 8, and
 *                    all older than 17). This is what makes retargeting possible: staleness is DERIVED
 *                    from `installed < target`, so moving the target to 21 automatically starts
 *                    flagging 17 with no rule edit. The alternative — extending the `in` list by hand —
 *                    fails silently, producing a plan that simply skips the Java bump.
 *   in:[…]         → legacy explicit enumeration, still honoured for any rule that wants exact matching.
 *   (default)      → semver comparison against `set`.
 */
export function needsBump(installed, r) {
  if (installed == null) return true;
  if (r.compare === "java") return javaLt(String(installed), String(r.set));
  if (r.in) return r.in.includes(String(installed));
  return lt(String(installed), r.set);
}

function appPropEdit(appPath, property, from, to) {
  return { property, kind: "pomProperty", file: appPath, from, to, change: true, addIfAbsent: true };
}

// Pin one declared occurrence (dependency or plugin) inside the app pom.
function pinOccurrence(chain, appPath, r, ver, kind, coords, addIfAbsent) {
  if (isRef(ver)) {
    const p = refName(ver);
    const resolved = resolveProp(chain, p);
    return needsBump(resolved, r) ? [appPropEdit(appPath, p, resolved, r.set)] : [];
  }
  if (ver != null) {
    return needsBump(String(ver), r)
      ? [{ kind, file: appPath, from: String(ver), to: r.set, change: true, property: r.property, ...coords }]
      : [];
  }
  if (addIfAbsent) {
    return [{ kind, file: appPath, from: null, to: r.set, change: true, property: r.property, ...coords }];
  }
  return [];
}

function overrideEditsForRule(chain, r, isGating) {
  const appPath = chain[0].path;
  const depInApp = r.groupId && r.artifactId ? findDep([chain[0]], r.groupId, r.artifactId) : null;
  const plgInApp = r.pluginArtifactId
    ? findPlugin([chain[0]], r.pluginGroupId ?? null, r.pluginArtifactId)
    : null;

  if (depInApp == null && plgInApp == null) {
    // Not declared in the app pom as a dependency/plugin.
    if (isGating && !r.groupId && !r.pluginArtifactId) {
      const resolved = resolveProp(chain, r.property);
      return needsBump(resolved, r) ? [appPropEdit(appPath, r.property, resolved, r.set)] : [];
    }
    return []; // undeclared connector/plugin → never add
  }

  const edits = [];
  if (depInApp != null) {
    edits.push(
      ...pinOccurrence(
        chain,
        appPath,
        r,
        versionOf(depInApp.dep),
        "depVersion",
        {
          groupId: r.groupId,
          artifactId: r.artifactId,
        },
        isGating
      )
    );
  }
  if (plgInApp != null) {
    edits.push(
      ...pinOccurrence(
        chain,
        appPath,
        r,
        versionOf(plgInApp.plugin),
        "pluginVersion",
        {
          pluginGroupId: r.pluginGroupId ?? null,
          pluginArtifactId: r.pluginArtifactId,
        },
        isGating
      )
    );
  }
  return edits;
}

export function computePropEditsOverride(chain, matrix) {
  const gatingEdits = Object.values(matrix.gating ?? {}).flatMap((r) => overrideEditsForRule(chain, r, true));
  const connEdits = (matrix.connectors ?? []).flatMap((r) => overrideEditsForRule(chain, r, false));
  const seen = new Set();
  const out = [];
  for (const e of [...gatingEdits, ...connEdits]) {
    const key = `${e.kind ?? ""}|${e.property ?? ""}|${e.groupId ?? ""}|${e.artifactId ?? ""}|${e.pluginArtifactId ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

// ── Tier-0 hygiene: strip JPMS argLines from MUnit plugin blocks ──────────────────────

function isMunitPluginArtifact(a) {
  return ["munit-maven-plugin", "munit-extensions-maven-plugin"].includes(asStr(a));
}

function pluginArgLineValues(p) {
  const top = asArray(p?.configuration?.argLines?.argLine);
  const exe = asArray(p?.executions?.execution).flatMap((e) => asArray(e?.configuration?.argLines?.argLine));
  return [...top, ...exe].map((v) => asStr(v));
}

function pomHasMunitJpmsArgLine(pom, flags) {
  const all = [...pluginsOf(pom), ...managedPluginsOf(pom)];
  const vals = all.filter((p) => isMunitPluginArtifact(p.artifactId)).flatMap((p) => pluginArgLineValues(p));
  return vals.some((s) => (flags ?? []).some((f) => s.includes(String(f))));
}

export function computeMunitArgLineEdits(chain, matrix) {
  const flags = matrix.removeMunitJpmsFlags ?? [];
  if (flags.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const c of chain) {
    if (pomHasMunitJpmsArgLine(c.pom, flags) && !seen.has(c.path)) {
      seen.add(c.path);
      out.push({ kind: "munitArgLines", file: c.path, flags, change: true });
    }
  }
  return out;
}

// ── Missing-from-matrix detection ─────────────────────────────────────────────────────

function muleExtensionGroups() {
  return ["org.mule.connectors", "org.mule.modules", "com.mulesoft.connectors", "com.mulesoft.modules"];
}

function appDeclaredExtensions(chain) {
  return dependenciesOf(chain[0].pom)
    .filter((d) => asStr(d.classifier) === "mule-plugin")
    .map((d) => ({ groupId: asStr(d.groupId), artifactId: asStr(d.artifactId) }));
}

function matrixArtifactKeys(matrix) {
  return [...(matrix.connectors ?? []), ...Object.values(matrix.gating ?? {})]
    .filter((r) => r.groupId && r.artifactId)
    .map((r) => `${r.groupId}:${r.artifactId}`);
}

export function missingFromMatrix(chain, matrix, excludeArtifacts) {
  const covered = matrixArtifactKeys(matrix);
  const exclude = excludeArtifacts ?? [];
  const seen = new Set();
  const out = [];
  for (const e of appDeclaredExtensions(chain)) {
    if (!muleExtensionGroups().includes(e.groupId)) continue;
    if (covered.includes(`${e.groupId}:${e.artifactId}`)) continue;
    if (exclude.includes(e.artifactId)) continue;
    const key = `${e.groupId}:${e.artifactId}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

// ── Connector-gap detection (parent/BOM-managed connectors below target) ──────────────

function appDeclaresVersion(chain, g, a) {
  const d = findDep([chain[0]], g, a);
  return d != null && versionOf(d.dep) != null;
}

/**
 * effectiveVersionInfo(chain, r): the connector's effective version AND the chain pom path that
 * declares/manages it. A REAL declared or managed <dependency> occurrence is REQUIRED — a bare
 * parent <property> (e.g. a shared parent that predeclares `http.connector.version` for a connector
 * the app never actually uses) does NOT count, so it can no longer manufacture a phantom connector
 * gap (M3). Returns {version, path}; both null when the app neither declares nor inherits it.
 * @returns {{version:(string|null), path:(string|null)}}
 */
export function effectiveVersionInfo(chain, r) {
  let occ = null;
  let occPath = null;
  for (const c of chain) {
    const all = [...dependenciesOf(c.pom), ...managedDependenciesOf(c.pom)];
    const hit = all.find(
      (d) =>
        asStr(d.groupId) === String(r.groupId) &&
        asStr(d.artifactId) === String(r.artifactId) &&
        versionOf(d) != null
    );
    if (hit) {
      occ = hit;
      occPath = c.path ?? null;
      break;
    }
  }
  if (!occ) return { version: null, path: null };
  const raw = versionOf(occ);
  // A ${property} version resolves against the chain, but the MANAGING pom is still the one that
  // declared the dependency/managed entry (occPath) — that is the pom whose pin must be bumped.
  const version = isRef(raw) ? resolveProp(chain, refName(raw)) : raw == null ? null : String(raw);
  return { version, path: occPath };
}

function effectiveVersion(chain, r) {
  return effectiveVersionInfo(chain, r).version;
}

export function connectorGaps(chain, matrix) {
  const seen = new Set();
  const out = [];
  for (const r of matrix.connectors ?? []) {
    if (!(r.groupId && r.artifactId)) continue;
    if (appDeclaresVersion(chain, String(r.groupId), String(r.artifactId))) continue;
    const { version: from, path: managedInPath } = effectiveVersionInfo(chain, r);
    if (from == null) continue;
    if (!needsBump(String(from), { set: r.set })) continue;
    const key = `${r.groupId}:${r.artifactId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      groupId: String(r.groupId),
      artifactId: String(r.artifactId),
      from,
      to: String(r.set),
      // The chain pom that MANAGES this inherited connector (e.g. "parent-pom/pom.xml"). The parent-pom
      // upgrade must edit THIS file rather than a blind repo-root pom.xml (M5). null when unknown.
      managedInPath: managedInPath ?? null,
    });
  }
  return out;
}

/**
 * connectorsInApp(chain, matrix): the LEAN per-app connector view for the default assess output.
 *
 * Lists only the matrix connectors the app actually references — declared with its own <version> in
 * the app pom, OR inherited (effective) via a parent/BOM. Pure and network-free: derived entirely
 * from the pom chain + matrix, so it's safe to attach on every assess run (unlike connectorChoices,
 * which needs Exchange/release-notes fetches). The rich version MENU lives in resolve_versions.
 *
 * Each entry: { artifactId, groupId, current, matrixSet, declaredInApp, willChange }:
 *   - current       - the effective version resolved from the chain (declared or inherited); may be null
 *   - matrixSet     - the curated Java-17-safe pin
 *   - declaredInApp - the app pom declares its OWN <version> for this connector (so this PR can pin it)
 *   - willChange    - declaredInApp AND current is below the matrix pin ⇒ this assess emits an edit.
 *                     Inherited-but-below connectors are NOT willChange here — they surface as
 *                     connectorGaps (the parent/BOM must be bumped instead).
 */
export function connectorsInApp(chain, matrix) {
  const out = [];
  const seen = new Set();
  for (const r of matrix?.connectors ?? []) {
    if (!(r.groupId && r.artifactId)) continue;
    const g = String(r.groupId);
    const a = String(r.artifactId);
    const key = `${g}:${a}`;
    if (seen.has(key)) continue;
    const declaredInApp = appDeclaresVersion(chain, g, a);
    const current = effectiveVersion(chain, r);
    // App neither declares nor inherits this connector → it isn't "in" the app; skip.
    if (!declaredInApp && current == null) continue;
    seen.add(key);
    const willChange = declaredInApp && current != null && needsBump(String(current), r);
    out.push({
      artifactId: a,
      groupId: g,
      current: current ?? null,
      matrixSet: r.set ?? null,
      declaredInApp,
      willChange,
    });
  }
  return out;
}

/**
 * appConnectorScope(chain, matrix): derive the resolve_versions scoping args for THIS app from the
 * lean connectorsInApp[] view. Returns { only, currents } where `only` is the list of artifactIds the
 * app actually references (declared or inherited) and `currents` maps each to its effective current
 * version (null-safe: connectors with no resolvable current are omitted from `currents` but still
 * appear in `only`). Pure and network-free — the resolve_versions tool passes these straight into
 * resolveVersions() so the live menu is scoped to the app and each choice.current is populated.
 * @returns {{only: string[], currents: Object<string,string>}}
 */
export function appConnectorScope(chain, matrix) {
  const inApp = connectorsInApp(chain, matrix);
  const only = inApp.map((c) => c.artifactId);
  /** @type {Object<string,string>} */
  const currents = {};
  for (const c of inApp) if (c.current != null) currents[c.artifactId] = String(c.current);
  return { only, currents };
}

export function connectorGapWarning(chain, matrix, appName) {
  const gaps = connectorGaps(chain, matrix);
  if (gaps.length === 0) return [];
  const list = gaps.map((g) => `${g.artifactId} ${g.from ?? "unknown"} -> ${g.to}`).join("; ");
  return [
    `WARNING: ${appName ?? "this app"} inherits connector version(s) from a parent/BOM that are below the Java 17 target and were NOT changed by this app PR (only connectors already versioned in the app pom are pinned). Update the parent/BOM — or run the parent-pom upgrade — so these are bumped, otherwise MUnit/CI will fail on Java 17: ${list}.`,
  ];
}

// ── Repo scan flags (custom Java / lookup / truncation / Java-17 content hints) ─────────

/**
 * Run the matrix `manualReview` regex scans that need file CONTENT (not just paths):
 * setAccessible(), ResourceBundle.getBundle(), powermock, DataWeave POJO, MUnit JPMS flags.
 * Scans the app pom text plus (best-effort) every .java source via an injected readFile(path).
 * Each distinct `warn` is emitted at most once. Fully non-fatal: a readFile miss is skipped.
 *
 * @param {{tree:Array<{path,type}>, truncated?:boolean}} tree
 * @param {string} appPomText
 * @param {object} [opts]
 * @param {(relPath:string)=>(string|null)} [opts.readFile] read a repo-relative file (sync)
 * @param {object} [opts.manualReview] matrix.manualReview block (only scanRegex entries are used)
 * @param {string} [opts.appPath] scope the .dwl / Mule-XML corpus to this module (monorepos)
 * @param {number} [opts.maxScanFiles] cap on files read into the corpus (default 250)
 */
export function scanFlags(tree, appPomText, opts = {}) {
  const items = tree?.tree ?? [];
  const javaFiles = items.filter((i) => /.*\.java$/.test(i.path));
  const customJava = javaFiles.length > 0;
  const lookupInPom = (appPomText ?? "").includes("lookup(");
  const warnings = [];
  const matchedReviews = [];
  if (tree?.truncated) {
    warnings.push(
      "Repository tree was truncated by GitHub (>100k objects); some file paths may have been missed."
    );
  }
  if (customJava) {
    warnings.push(
      `Custom Java classes detected (${javaFiles.length} file(s)). Verify reflection and SecurityManager usage on JDK 17.`
    );
  }
  if (lookupInPom) {
    warnings.push(
      "lookup() reference found in pom text; scan Mule XMLs to confirm DataWeave POJO lookup usage requiring getter/setter validation."
    );
  }

  // Content-based manualReview scans (setAccessible / ResourceBundle / powermock / DW POJO / DataWeave
  // deprecations / etc.). The corpus is the pom text plus every readable source file the scans care
  // about: .java, .dwl, and Mule config XML under src/main/mule. DataWeave and Mule XML matter because
  // the Java-17 / Mule-4.9 breaking changes that bite hardest at RUNTIME (e.g. error.muleMessage, POJO
  // reflection) live in transformations and inline expressions, not in Java — scanning only .java left
  // the app's actual integration logic unexamined.
  //
  // The extra file kinds are APP-SCOPED (a monorepo shouldn't pull every sibling module's DataWeave)
  // and the total is BOUNDED, because the github source costs one API call per primed file.
  const mr = opts.manualReview ?? {};
  const readFile = typeof opts.readFile === "function" ? opts.readFile : null;
  const regexEntries = Object.entries(mr).filter(
    ([, e]) => e && typeof e.scanRegex === "string" && e.warn
  );
  if (regexEntries.length) {
    let corpus = stripComments(String(appPomText ?? ""));
    if (readFile) {
      const targets = scanTargets(items, opts);
      if (targets.truncated) {
        warnings.push(
          `Content scan was capped at ${targets.limit} source files (repo has ${targets.total}); ` +
            `some DataWeave/Java/Mule-XML files were not examined for manual-review flags.`
        );
      }
      for (const rel of targets.paths) {
        try {
          const txt = readFile(rel);
          if (txt) corpus += "\n" + stripComments(txt);
        } catch {
          /* unreadable file → skip, non-fatal */
        }
      }
    }
    const seen = new Set();
    for (const [key, e] of regexEntries) {
      if (seen.has(e.warn)) continue;
      let re;
      try {
        re = new RegExp(e.scanRegex);
      } catch {
        continue; // malformed pattern in matrix → ignore
      }
      if (re.test(corpus)) {
        seen.add(e.warn);
        warnings.push(e.warn);
        matchedReviews.push(key);
      }
    }
  }

  return {
    customJavaFound: customJava,
    lookupFound: lookupInPom,
    hasApiPolicies: false,
    // The manualReview KEYS that matched (not the prose) so downstream consumers — notably the
    // Process-Guide baseline — can key off a stable id instead of string-matching a warning.
    matchedReviews,
    warnings,
  };
}

/**
 * Remove XML (`<!-- -->`) and block (`/* *\/`) comments before a content scan.
 *
 * Without this, prose ABOUT a hazard reads as the hazard itself. A real example: an app pom carrying
 * the comment "Do NOT pass add-opens / add-exports JVM flags via argLines here" was flagged as having
 * JPMS argLines — the opposite of the truth. Documentation that names a pitfall is common in exactly
 * the poms and Mule XMLs most carefully prepared for Java 17, so the false-positive rate skews toward
 * the best-maintained apps.
 *
 * `//` line comments are deliberately NOT stripped: it is indistinguishable from the `//` in a URL
 * (namespace declarations, distributionUrl) without a real parser, and dropping the rest of those
 * lines would lose genuine content.
 */
export function stripComments(text) {
  return String(text ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** True when a repo-relative path sits inside the app module (whole repo when no appPath). */
function underAppPath(p, appPath) {
  if (!appPath || appPath === "." || appPath === "") return true;
  const pre = appPath.endsWith("/") ? appPath : `${appPath}/`;
  return p === appPath || p.startsWith(pre);
}

/**
 * The files a content scan should read: every .java in the repo (unchanged, repo-wide — custom Java
 * anywhere is relevant to a JDK bump), plus .dwl and src/main/mule/*.xml scoped to the app module.
 * Bounded by opts.maxScanFiles (default 250) because each primed file is one GitHub API call.
 */
export function scanTargets(items, opts = {}) {
  const appPath = opts.appPath ?? null;
  const limit = Number(opts.maxScanFiles ?? 250);
  const paths = [];
  const seen = new Set();
  const add = (p) => {
    if (!seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
  };
  for (const i of items) {
    if (i.type && i.type !== "blob") continue;
    if (/\.java$/i.test(i.path)) add(i.path);
  }
  for (const i of items) {
    if (i.type && i.type !== "blob") continue;
    if (!underAppPath(i.path, appPath)) continue;
    if (/\.dwl$/i.test(i.path)) add(i.path);
    else if (/(^|\/)src\/main\/mule\/.*\.xml$/i.test(i.path)) add(i.path);
  }
  const total = paths.length;
  return { paths: paths.slice(0, limit), total, limit, truncated: total > limit };
}

// ── retarget coherence (Java 17 → 21 → …) ─────────────────────────────────────────────

/**
 * Warn when the matrix's Java target is internally inconsistent.
 *
 * The engine reads its target Java from exactly one place (`target.javaVersion`), but a few other keys
 * MUST agree with it or the plan comes out half-migrated: `mule-artifact.json`'s
 * `javaSpecificationVersions` decides what the runtime will accept, and the `compare:"java"` gating
 * rules decide what the pom properties get set to. A retarget that updates `target.javaVersion` and
 * forgets one of those produces edits that look successful and deploy-fail later — the most expensive
 * possible place to find out. Cheap to check here, so we check.
 * @param {any} matrix
 * @returns {string[]}
 */
export function retargetWarnings(matrix) {
  const target = matrix?.target?.javaVersion;
  const t = javaMajor(target);
  if (t == null) {
    return [
      `WARNING: the compatibility matrix has no usable target.javaVersion (${JSON.stringify(target ?? null)}). ` +
        `The whole engine derives its Java target from that key — set it before relying on this plan.`,
    ];
  }
  const out = [];
  const specs = matrix?.muleArtifact?.javaSpecificationVersions ?? [];
  if (specs.length && !specs.some((s) => javaMajor(s) === t)) {
    out.push(
      `WARNING: matrix target.javaVersion is ${target} but muleArtifact.javaSpecificationVersions is ` +
        `[${specs.join(", ")}], which does not include it. The app would declare a descriptor the target ` +
        `runtime rejects at deploy time — add "${t}" to javaSpecificationVersions.`
    );
  }
  for (const [name, r] of Object.entries(matrix?.gating ?? {})) {
    if (r?.compare !== "java") continue;
    if (javaMajor(r.set) !== t) {
      out.push(
        `WARNING: matrix target.javaVersion is ${target} but gating.${name} sets "${r.set}". Java gating rules ` +
          `must set the target major, or the pom keeps a stale Java version while everything else moves.`
      );
    }
  }
  return out;
}

// ── CUSTOM_CONNECTOR detection + upgrade checklist ────────────────────────────────────

/**
 * True when the app pom is itself a Mule extension/connector project (packaging mule-extension,
 * or an extensions/module parent), rather than a deployable app. Such projects follow the
 * MuleSoft connector-upgrade path (mule-sdk-api + @JavaVersionSupport), not the app rewrite path.
 * @param {Array<{pom:any}>} chain
 */
export function isCustomConnector(chain) {
  const pom = chain?.[0]?.pom?.project;
  if (!pom) return false;
  const packaging = asStr(pom.packaging).toLowerCase();
  if (packaging === "mule-extension") return true;
  const parentArtifact = asStr(pom.parent?.artifactId).toLowerCase();
  return parentArtifact === "mule-modules-parent" || parentArtifact === "mule-java-extension-parent";
}

/**
 * The connector-upgrade checklist emitted as warnings when a CUSTOM_CONNECTOR is detected.
 * These are advisory (never auto-edited) because a connector's Java readiness is a code + metadata
 * change (setters, @JavaVersionSupport, parent-POM/mule-sdk-api bumps), not a pom pin.
 *
 * The target major is a parameter: the @JavaVersionSupport list a connector must declare grows with the
 * target, and telling someone targeting Java 21 to annotate JAVA_17 would produce a module the runtime
 * rejects at deploy time — the single most expensive way to discover a stale checklist.
 * @param {string} [appName]
 * @param {string|number} [targetJava]
 */
export function customConnectorWarnings(appName, targetJava = 17) {
  const who = appName ?? "this project";
  const majors = supportedJavaMajors(targetJava);
  const annotation = majors.map((m) => `JAVA_${m}`).join(", ");
  const target = majors[majors.length - 1];
  return [
    `NOTE: ${who} is a Mule extension/connector project (packaging mule-extension). It follows the connector-upgrade path, NOT the app rewrite path — these edits are advisory, not auto-applied:`,
    `  · Add @JavaVersionSupport({${annotation}}) on the @Extension class (Java SDK); XML SDK inherits Java ${target} automatically.`,
    "  · Add/upgrade org.mule.sdk:mule-sdk-api to 0.10.1 so Java-compatibility metadata is generated.",
    "  · Parent POM: mule-java-extension-parent (recommended, declare minMuleVersion yourself), or legacy mule-modules-parent >= 1.9.0 (auto-sets minMuleVersion 4.9.0).",
    `  · Bump libraries for Java ${target}: ByteBuddy 1.14.0 (replace CGLib), Jacoco 0.8.10, SLF4J 2.x; JDBC/Groovy/JRuby to Java-${target} builds.`,
    "  · API objects need setters (not just getters/constructors) so DataWeave can write without reflection; migrate PowerMock tests to current Mockito.",
    `  · Deploy-time is the final gate: Mule rejects modules lacking Java-${target} support ('Extension ... does not support Java ${target}. Supported versions are: [1.8, 11]').`,
  ];
}

/** first regex capture group #1 across text, or null. */
function firstCapture(text, re) {
  const m = (text ?? "").match(re);
  return m ? m[1] : null;
}

/**
 * Build the full AssessmentResult payload (port of buildAssessmentResult).
 */
export function buildAssessmentResult({
  matrix,
  chain: chain0,
  appPomText: appPomText0,
  muleArtifactCurrent,
  muleArtifactPath,
  ciWorkflowText,
  ciWorkflowPath,
  appName,
  topology,
  headSha,
  hasApiPolicies,
  customJavaFound,
  lookupFound,
  warnings,
  matchedReviews = [],
  readFile = null,
  pomEditStrategy = "appOverride",
  excludeArtifacts = [],
  parentRef = null,
}) {
  const m = matrix;
  const chain = rehydrate(chain0);

  const propEdits =
    pomEditStrategy === "inPlace" ? computePropEdits(chain, matrix) : computePropEditsOverride(chain, matrix);

  const appPomText = appPomText0 ?? "";

  // (1) MUnit <runtimeVersion> — literal only.
  const munitCur = firstCapture(appPomText, /<runtimeVersion>\s*([^<]+?)\s*<\/runtimeVersion>/);
  const munitPlaceholder = munitCur != null && /^\s*\$\{.+\}\s*$/.test(munitCur);
  const munitNeeds = munitCur != null && !munitPlaceholder && lt(String(munitCur), m.target.runtime);

  // (2) mule-artifact.json
  const maCur = muleArtifactCurrent;
  const maSpecs = maCur?.javaSpecificationVersions ?? [];
  const maMinNeeds = maCur != null && lt(String(maCur.minMuleVersion ?? "0"), m.muleArtifact.minMuleVersion);
  const maJavaOk = maSpecs.some((s) => !lt(String(s), m.target.javaVersion));
  const maJavaNeeds = maCur != null && !maJavaOk;
  const maNeeds = maMinNeeds || maJavaNeeds;
  const maToMin = maMinNeeds
    ? m.muleArtifact.minMuleVersion
    : (maCur?.minMuleVersion ?? m.muleArtifact.minMuleVersion);

  // (3) CI workflow
  const ciCur = firstCapture(ciWorkflowText ?? "", /java-version:\s*['"]?([^'"\s]+)['"]?/);
  const ciNeeds = ciCur != null && lt(String(ciCur), m.target.javaVersion);

  const appEdits = [];
  if (munitNeeds) {
    appEdits.push({ file: chain[0].path, kind: "munitRuntimeVersion", from: munitCur, to: m.target.runtime });
  }
  if (maNeeds) {
    appEdits.push({
      file: muleArtifactPath,
      kind: "muleArtifactJson",
      from: { minMuleVersion: maCur?.minMuleVersion ?? null, javaSpecificationVersions: maSpecs },
      to: { minMuleVersion: maToMin, javaSpecificationVersions: m.muleArtifact.javaSpecificationVersions },
    });
  }
  if (ciNeeds) {
    appEdits.push({ file: ciWorkflowPath, kind: "ciWorkflow", from: ciCur, to: m.target.javaVersion });
  }

  const argLineEdits = computeMunitArgLineEdits(chain, m);
  const coreEdits = [...propEdits, ...appEdits, ...argLineEdits];

  // (4) App pom own <version> minor bump — only when the upgrade changes something.
  const projArtifact = chain[0].pom?.project?.artifactId ?? null;
  const projVer = chain[0].pom?.project?.version ?? null;
  const projVerIsRef = projVer != null && /^\s*\$\{.+\}\s*$/.test(String(projVer));
  const versionEdit =
    coreEdits.length > 0 && projArtifact != null && projVer != null && !projVerIsRef
      ? [
          {
            file: chain[0].path,
            kind: "pomVersion",
            artifactId: String(projArtifact),
            from: String(projVer),
            to: bumpMinor(String(projVer)),
            change: true,
          },
        ]
      : [];

  // (5) Chained flow: repoint the app's OWN <parent> at a freshly-released parent-pom/BOM version so the
  // app PR's FIRST commit already points at it — no separate amend commit, and the dry-run preview lists
  // it. Emitted ONLY when a parentRef is supplied, the app actually has a matching <parent>, its version
  // is a literal (not a ${...} property), and that version actually differs from the target.
  const appParent = chain[0].pom?.project?.parent ?? null;
  const parentRefEdit = [];
  if (parentRef && parentRef.toVersion != null && String(parentRef.toVersion) !== "" && appParent) {
    const wantA = parentRef.artifactId != null ? String(parentRef.artifactId).trim() : "";
    const wantG = parentRef.groupId != null ? String(parentRef.groupId).trim() : "";
    const haveA = String(appParent.artifactId ?? "").trim();
    const haveG = String(appParent.groupId ?? "").trim();
    const haveV = appParent.version != null ? String(appParent.version).trim() : "";
    const artifactOk = wantA === "" || haveA === wantA;
    const groupOk = wantG === "" || haveG === wantG;
    const haveVIsRef = /^\s*\$\{.+\}\s*$/.test(haveV);
    if (artifactOk && groupOk && !haveVIsRef && haveV !== String(parentRef.toVersion).trim()) {
      parentRefEdit.push({
        file: chain[0].path,
        kind: "pomParentVersion",
        groupId: parentRef.groupId ?? haveG ?? null,
        artifactId: parentRef.artifactId ?? haveA ?? null,
        from: haveV || null,
        to: String(parentRef.toVersion),
        change: true,
      });
    }
  }

  const all = [...coreEdits, ...versionEdit, ...parentRefEdit];

  // Shared-file warning (only non-empty under inPlace strategy).
  const appPomPath = chain[0].path ?? "";
  const sharedPomFiles = [...new Set(propEdits.map((e) => e.file))].filter((f) => f !== appPomPath);
  const sharedFileWarnings =
    sharedPomFiles.length === 0
      ? []
      : [
          `WARNING: this upgrade edits shared build file(s) [${sharedPomFiles.join(", ")}] that are inherited by other modules in the repository. Approving it upgrades EVERY module that inherits from these files, not just ${appName ?? "this app"} — every inheriting module's build and MUnit tests must pass in CI. Review the wider impact before approving.`,
        ];

  const missingConns = missingFromMatrix(chain, m, excludeArtifacts);
  const missingKeys = missingConns.map((c) => `${c.groupId}:${c.artifactId}`);
  const missingWarnings =
    missingConns.length === 0
      ? []
      : [
          `WARNING: ${appName ?? "this app"} declares connector(s) not covered by the compatibility matrix [${missingKeys.join(", ")}]. They were NOT pinned for Java 17 — extend the matrix and re-run/reapply. This will be flagged in Slack and on the PR when the upgrade job is started.`,
        ];

  const gapWarnings = connectorGapWarning(chain, m, appName);

  // CUSTOM_CONNECTOR: if the "app" is actually a Mule extension/connector project, override the
  // topology and surface the connector-upgrade checklist (advisory; the pom-edit path still runs
  // for any gating/property it does declare, but the real work is code + @JavaVersionSupport).
  const connectorProject = isCustomConnector(chain);
  const effectiveTopology = connectorProject ? "CUSTOM_CONNECTOR" : topology;
  const connectorChecklist = connectorProject
    ? customConnectorWarnings(appName, m?.target?.javaVersion ?? 17)
    : [];

  const gaps = connectorGaps(chain, m);
  const resolvedRuntime =
    resolveProp(chain, "app.runtime") ?? resolveProp(chain, "app.runtime.semver") ?? "unknown";
  const resolvedJava =
    resolveProp(chain, "java.version") ??
    resolveProp(chain, "maven.compiler.source") ??
    resolveProp(chain, "maven.compiler.target") ??
    "unknown";

  // The official Process Guide checklist, evaluated against what we just established. Pure reporting —
  // it reads the finished edit list and cannot influence it.
  const processGuide = processGuideBaseline({
    matrix: m,
    fileEdits: all,
    currentRuntime: resolvedRuntime,
    currentJavaVersion: resolvedJava,
    matchedReviews,
    connectorGaps: gaps,
    missingFromMatrix: missingConns,
    connectorProject,
    hasApiPolicies: hasApiPolicies ?? false,
    readFile,
  });

  return {
    appName,
    currentRuntime: resolvedRuntime,
    currentJavaVersion: resolvedJava,
    // Process-Guide checklist verdicts (ok / will-fix / action / manual) — see lib/process_guide.js.
    processGuide,
    changePlan: {
      targetRuntime: m.target.runtime,
      targetJavaVersion: m.target.javaVersion,
      topology: effectiveTopology,
      headSha,
      fileEdits: all,
      filesToChange: [...new Set(all.map((e) => e.file))],
      hasApiPolicies: hasApiPolicies ?? false,
      hasCustomJavaCode: customJavaFound ?? false,
      hasLookupFunction: lookupFound ?? false,
      missingFromMatrix: missingConns,
      connectorGaps: gaps,
      // LEAN per-app connector view (pure, network-free) — always present. The rich version MENU
      // (options[], firstCompatible/latest) is opt-in via resolve_versions / includeVersions.
      connectorsInApp: connectorsInApp(chain, m),
    },
    warnings: [
      ...(warnings ?? []),
      ...retargetWarnings(m),
      ...connectorChecklist,
      ...sharedFileWarnings,
      ...missingWarnings,
      ...gapWarnings,
    ],
  };
}
