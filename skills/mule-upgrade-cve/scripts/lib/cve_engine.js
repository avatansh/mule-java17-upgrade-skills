// lib/cve_engine.js — pure logic for "what is vulnerable, and does the upgrade fix it?"
//
// The engine answers ONE question the assessment can't: an upgrade moves connector and plugin versions
// forward, so some known vulnerabilities disappear as a side effect — and some don't. Knowing which is
// which turns "we upgraded to Java 17" into "we upgraded and closed 7 of 9 known CVEs, here are the 2
// that still need a decision".
//
// No I/O here: dependency collection is text-in, and vulnerability classification is data-in. The OSV
// client is the only network piece and it lives next door.

import { resolveProp } from "../../../mule-upgrade-assess/scripts/lib/assess_engine.js";
import { dependenciesOf, managedDependenciesOf, pluginsOf, managedPluginsOf } from "../../../mule-upgrade-assess/scripts/lib/pom_chain.js";
import { osvPackageName, severityOf, fixedVersionsFor, affectedEntriesFor, SEVERITY_RANK } from "./osv.js";

// ── version comparison ──────────────────────────────────────────────────────────────────────────

// lib_shared/semver.js `lt` deliberately compares only major.minor.patch, which is right for runtime
// and connector pins but WRONG here: OSV fixes routinely land on a 4th segment (jackson-databind's fix
// for CVE-2020-11619 is 2.9.10.4). A 3-segment compare would rate 2.9.10 as "not less than 2.9.10.4"
// and report a live vulnerability as resolved. A false "resolved" is the one error mode this feature
// must never have, so CVE work gets its own full-length comparison.

/** Split a Maven version into numeric segments plus a trailing qualifier. */
function parseVersion(v) {
  const s = String(v ?? "").trim();
  const core = s.split("-")[0];
  const qualifier = s.includes("-") ? s.slice(s.indexOf("-") + 1).toLowerCase() : "";
  const nums = core
    .split(".")
    .map((seg) => seg.replace(/[^0-9].*/, ""))
    .map((seg) => (seg === "" ? 0 : Number(seg)));
  return { nums, qualifier };
}

/**
 * compareVersions(a,b) → -1 | 0 | 1 over ALL numeric segments, then qualifier.
 * Missing segments count as 0, so "2.9.10" < "2.9.10.4" and "1.0" === "1.0.0". A qualifier makes a
 * version EARLIER than the same core release ("1.0.0-SNAPSHOT" < "1.0.0"), matching Maven.
 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  const len = Math.max(x.nums.length, y.nums.length);
  for (let i = 0; i < len; i++) {
    const xi = x.nums[i] ?? 0;
    const yi = y.nums[i] ?? 0;
    if (Number.isNaN(xi) || Number.isNaN(yi)) continue;
    if (xi !== yi) return xi < yi ? -1 : 1;
  }
  if (x.qualifier === y.qualifier) return 0;
  if (x.qualifier === "") return 1; // a release outranks any pre-release of the same core
  if (y.qualifier === "") return -1;
  return x.qualifier < y.qualifier ? -1 : 1;
}

// ── affected ranges: why "at or above a fixed version" is the wrong question ─────────────────────
//
// Maintainers backport security fixes to several maintenance branches at once, and OSV models each
// branch as its own range. CVE-2021-44228 (Log4Shell) is fixed in 2.3.1, 2.12.2 AND 2.15.0, because
// those close the 2.0/2.4/2.13 branches respectively.
//
// So "is my version >= some published fix?" gives two wrong answers for an app on log4j 2.14.1:
//   - 2.14.1 >= 2.3.1, so the app looks PATCHED while it is fully exposed to Log4Shell.
//   - the advice becomes "upgrade to 2.3.1", which is a DOWNGRADE and still vulnerable.
// The same applies to jackson 2.9.0, whose real fix is 2.9.7 rather than the lowest-listed 2.7.9.5.
//
// The correct question is containment: does the version fall inside a half-open [introduced, fixed)
// interval? That makes the fix for a given version the one closing ITS branch, and makes
// "does the upgrade resolve this?" simply "is the planned version outside every affected interval?".

/**
 * The half-open version intervals in which a package is vulnerable.
 *
 * `fixed` is exclusive (the fix itself is safe). `lastAffected` is inclusive and means the branch was
 * never fixed. Neither present means the branch is affected without an upper bound.
 *
 * @param {any} vuln
 * @param {string} pkgName
 * @returns {Array<{introduced:string, fixed:string|null, lastAffected:string|null}>}
 */
export function affectedIntervals(vuln, pkgName) {
  const intervals = [];
  for (const aff of affectedEntriesFor(vuln, pkgName)) {
    for (const range of aff?.ranges ?? []) {
      // SEMVER and ECOSYSTEM ranges are version-comparable; GIT ranges are commit hashes and must not
      // be fed to a version comparison.
      const type = String(range?.type ?? "ECOSYSTEM").toUpperCase();
      if (type === "GIT") continue;

      const events = [];
      for (const ev of range?.events ?? []) {
        if (ev?.introduced != null) events.push({ kind: "introduced", v: String(ev.introduced) });
        else if (ev?.fixed != null) events.push({ kind: "fixed", v: String(ev.fixed) });
        else if (ev?.last_affected != null) events.push({ kind: "last_affected", v: String(ev.last_affected) });
      }
      // The spec says events within a range are ordered, but sorting makes the sweep independent of
      // producer behaviour. At the same version an `introduced` opens before a bound closes.
      events.sort((a, b) => compareVersions(a.v, b.v) || (a.kind === "introduced" ? -1 : 1));

      let open = null;
      for (const e of events) {
        if (e.kind === "introduced") {
          if (open === null) open = e.v;
        } else if (open !== null) {
          intervals.push({
            introduced: open,
            fixed: e.kind === "fixed" ? e.v : null,
            lastAffected: e.kind === "last_affected" ? e.v : null,
          });
          open = null;
        }
      }
      if (open !== null) intervals.push({ introduced: open, fixed: null, lastAffected: null });
    }
  }
  return intervals;
}

/** True when `version` falls inside one affected interval. */
export function isVersionAffected(version, intervals) {
  if (!version || !intervals?.length) return false;
  return intervals.some((iv) => {
    if (compareVersions(version, iv.introduced) < 0) return false;
    if (iv.fixed) return compareVersions(version, iv.fixed) < 0; // `fixed` is exclusive
    if (iv.lastAffected) return compareVersions(version, iv.lastAffected) <= 0; // inclusive
    return true; // open-ended branch
  });
}

/**
 * The smallest upgrade that fixes `version`: the `fixed` bound of the interval containing it. Staying on
 * the app's own maintenance branch is the minimal change, so this is the version to recommend.
 * Returns null when the containing branch has no published fix (or the version isn't affected at all).
 */
export function fixForVersion(version, intervals) {
  const candidates = (intervals ?? [])
    .filter((iv) => {
      if (!iv.fixed) return false;
      if (compareVersions(version, iv.introduced) < 0) return false;
      return compareVersions(version, iv.fixed) < 0;
    })
    .map((iv) => iv.fixed);
  if (!candidates.length) return null;
  return candidates.sort(compareVersions)[0];
}

// ── dependency collection ───────────────────────────────────────────────────────────────────────

/**
 * Every Maven coordinate declared across the pom chain, with `${property}` versions resolved.
 *
 * SCOPE, stated plainly: this reads DECLARED coordinates from pom text — direct dependencies, managed
 * versions, and build plugins. It does NOT resolve the transitive graph, because that requires a real
 * Maven run (`dependency:tree`) against configured repositories, which this toolchain deliberately
 * avoids. Most real CVE exposure in a Mule app is transitive, so these findings are a FLOOR, never a
 * clean bill of health — every consumer of this data is required to say so.
 *
 * @param {{chain: Array<{path:string, pom:any}>}} args
 * @returns {Array<{name:string, groupId:string, artifactId:string, version:string, origin:string, declaredIn:string}>}
 */
export function collectDependencies({ chain }) {
  const out = new Map(); // name@version → entry (deduped; first declaration wins)
  const add = (dep, origin, declaredIn) => {
    const groupId = String(dep?.groupId ?? "").trim();
    const artifactId = String(dep?.artifactId ?? "").trim();
    if (!groupId || !artifactId) return;
    let version = dep?.version == null ? "" : String(dep.version).trim();
    if (/^\$\{.+\}$/.test(version)) {
      const prop = version.replace(/^\$\{/, "").replace(/\}$/, "");
      version = String(resolveProp(chain, prop) ?? "").trim();
    }
    // An unresolved or absent version can't be queried — OSV needs a concrete point to test. Skipping
    // is correct, but the caller surfaces the count so the gap is visible rather than silent.
    if (!version || /[${}]/.test(version)) {
      out.set(`${groupId}:${artifactId}@?`, {
        name: osvPackageName(groupId, artifactId),
        groupId,
        artifactId,
        version: "",
        origin,
        declaredIn,
      });
      return;
    }
    const name = osvPackageName(groupId, artifactId);
    const key = `${name}@${version}`;
    if (!out.has(key)) out.set(key, { name, groupId, artifactId, version, origin, declaredIn });
  };

  for (const link of chain ?? []) {
    for (const d of dependenciesOf(link.pom)) add(d, "dependency", link.path);
    for (const d of managedDependenciesOf(link.pom)) add(d, "dependencyManagement", link.path);
    for (const p of pluginsOf(link.pom)) add(p, "plugin", link.path);
    for (const p of managedPluginsOf(link.pom)) add(p, "pluginManagement", link.path);
  }
  return [...out.values()];
}

/**
 * The versions an upgrade plan would move each coordinate TO, as a `groupId:artifactId` → version map.
 *
 * Only edits carrying BOTH a groupId and an artifactId count — which is what excludes the plan's
 * `pomVersion` edit. That edit bumps the app's OWN version (`orders-api 1.0.0 → 1.1.0`) and has an
 * artifactId but no groupId; keying on artifactId alone would enter the app itself into the dependency
 * map and let its own version bump "resolve" someone else's advisory.
 */
export function plannedVersions(changePlan) {
  const map = new Map();
  for (const e of changePlan?.fileEdits ?? []) {
    if (e?.groupId && e?.artifactId && e?.to) {
      map.set(osvPackageName(e.groupId, e.artifactId), String(e.to));
    }
  }
  return map;
}

/**
 * Classify one advisory against a dependency and the planned upgrade.
 *
 * - `resolved-by-upgrade` — the planned version falls OUTSIDE every affected interval. A free win.
 * - `action-required`     — a fix exists for the app's branch but the plan doesn't escape the interval.
 *                           Reported with `minimumFix`, the smallest upgrade that actually works.
 * - `no-fix-available`    — the app's branch has no published fix. Never presented as fixable; if other
 *                           branches were fixed, `fixedVersions` shows them so switching branches can be
 *                           considered deliberately.
 *
 * @returns {{status:"resolved-by-upgrade"|"action-required"|"no-fix-available", fixedVersions:string[], plannedVersion:string|null, minimumFix:string|null, fixedOnOtherBranchOnly?:boolean}}
 */
export function classifyVuln({ vuln, dep, plannedVersion }) {
  const fixedVersions = fixedVersionsFor(vuln, dep.name);
  const intervals = affectedIntervals(vuln, dep.name);
  const minimumFix = fixForVersion(dep.version, intervals);
  const planned = plannedVersion ?? null;

  // The upgrade resolves the advisory exactly when the version it lands on is no longer in an affected
  // range — which is branch-aware for free, and never fooled by a fix backported to an older branch.
  if (planned && !isVersionAffected(planned, intervals)) {
    return { status: "resolved-by-upgrade", fixedVersions, plannedVersion: planned, minimumFix };
  }

  if (!minimumFix) {
    return {
      status: "no-fix-available",
      fixedVersions,
      plannedVersion: planned,
      minimumFix: null,
      // Fixes exist, just not for the branch this app is on: a real but different decision from
      // "nobody has fixed this yet", so it is labelled rather than merged into one bucket.
      ...(fixedVersions.length ? { fixedOnOtherBranchOnly: true } : {}),
    };
  }
  return { status: "action-required", fixedVersions, plannedVersion: planned, minimumFix };
}

/** Sort findings worst-first: severity, then status urgency, then name — stable and predictable. */
const STATUS_RANK = { "action-required": 2, "no-fix-available": 1, "resolved-by-upgrade": 0 };
export function sortFindings(findings) {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      STATUS_RANK[b.status] - STATUS_RANK[a.status] ||
      a.package.localeCompare(b.package) ||
      a.id.localeCompare(b.id)
  );
}

/**
 * Build the report from collected deps + fetched advisories. Pure: all network work happens before it.
 *
 * @param {object} args
 * @param {Array<{name:string,version:string,origin:string,declaredIn:string}>} args.deps
 * @param {string[][]} args.idsPerDep            vulnerability IDs aligned to `deps`
 * @param {Map<string,any>} args.vulns           id → full advisory
 * @param {Map<string,string>} [args.planned]    name → version the upgrade moves to
 * @param {string[]} [args.warnings]
 * @param {boolean} [args.complete]              false when OSV data is known-partial
 */
export function buildCveReport({ deps, idsPerDep, vulns, planned = new Map(), warnings = [], complete = true }) {
  const findings = [];
  const seen = new Set(); // one finding per (advisory, coordinate)
  for (let i = 0; i < deps.length; i++) {
    const dep = deps[i];
    for (const id of idsPerDep[i] ?? []) {
      const vuln = vulns.get(id);
      if (!vuln) continue; // detail fetch was capped or failed — counted in warnings, not invented here
      const key = `${id}\u0000${dep.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cls = classifyVuln({ vuln, dep, plannedVersion: planned.get(dep.name) });
      findings.push({
        id,
        cve: (vuln.aliases ?? []).filter((a) => String(a).startsWith("CVE-")),
        package: dep.name,
        currentVersion: dep.version,
        origin: dep.origin,
        declaredIn: dep.declaredIn,
        severity: severityOf(vuln),
        summary: String(vuln.summary ?? vuln.details ?? "").slice(0, 300),
        ...cls,
      });
    }
  }
  const sorted = sortFindings(findings);
  const count = (pred) => sorted.filter(pred).length;
  const unversioned = deps.filter((d) => !d.version).length;

  return {
    scanned: {
      dependencies: deps.filter((d) => d.version).length,
      unresolvedVersions: unversioned,
      source: "declared-coordinates-only",
    },
    summary: {
      total: sorted.length,
      critical: count((f) => f.severity === "CRITICAL"),
      high: count((f) => f.severity === "HIGH"),
      medium: count((f) => f.severity === "MEDIUM"),
      low: count((f) => f.severity === "LOW"),
      unknown: count((f) => f.severity === "UNKNOWN"),
      resolvedByUpgrade: count((f) => f.status === "resolved-by-upgrade"),
      actionRequired: count((f) => f.status === "action-required"),
      noFixAvailable: count((f) => f.status === "no-fix-available"),
    },
    findings: sorted,
    complete,
    // Repeated in the payload (not only in prose) so a consumer reading JSON cannot mistake this for a
    // full software composition analysis.
    limitations: [
      "Only DECLARED coordinates are scanned (direct dependencies, dependencyManagement and plugins). " +
        "Transitive dependencies are NOT resolved — that needs a real Maven build. Treat findings as a " +
        "lower bound, not a clean bill of health.",
      "MuleSoft's own connectors are largely absent from public advisory databases, so an empty result " +
        "for a connector means 'no public advisory', not 'audited and safe'.",
      ...(unversioned > 0
        ? [`${unversioned} coordinate(s) had no resolvable version and could not be queried.`]
        : []),
    ],
    warnings,
  };
}
