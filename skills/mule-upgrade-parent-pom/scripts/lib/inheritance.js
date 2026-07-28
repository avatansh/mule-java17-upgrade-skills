// lib/inheritance.js — read-only detection of what a parent/BOM pom ITSELF inherits.
//
// The chained upgrade flow must, BEFORE touching anything, tell the user when the pom they asked to
// upgrade sits on top of ANOTHER shared pom — either via a <parent> block or a <dependencyManagement>
// BOM import (<scope>import</scope>). The agent surfaces this so the user can choose to upgrade the
// deeper pom (the BOM) first. Pure: takes raw pom text, returns a plain, serialisable report.

import { parsePom, asArray } from "../../../mule-upgrade-assess/scripts/lib/pom_parse.js";

function strOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Coordinate label "g:a:v" (skips missing segments) for human-readable messages. */
export function coordLabel(c) {
  return [c?.groupId, c?.artifactId, c?.version].filter(Boolean).join(":");
}

/** <dependencyManagement> entries declared with <scope>import</scope> (i.e. imported BOMs). */
function managedImports(pom) {
  const deps = asArray(pom?.project?.dependencyManagement?.dependencies?.dependency);
  return deps
    .filter((d) => String(d?.scope ?? "").trim() === "import")
    .map((d) => ({
      groupId: strOrNull(d.groupId),
      artifactId: strOrNull(d.artifactId),
      version: strOrNull(d.version),
      type: strOrNull(d.type) ?? "pom",
    }));
}

/**
 * detectInheritance(pomText): report the pom's OWN parents/BOMs without editing.
 * @returns {{parent: (null|{groupId,artifactId,version,relativePath}), importedBoms: Array,
 *   inheritsFromShared: boolean}}
 */
export function detectInheritance(pomText) {
  const pom = parsePom(pomText);
  const p = pom?.project?.parent;
  const parent =
    p && typeof p === "object" && (p.groupId || p.artifactId)
      ? {
          groupId: strOrNull(p.groupId),
          artifactId: strOrNull(p.artifactId),
          version: strOrNull(p.version),
          relativePath: strOrNull(p.relativePath),
        }
      : null;

  const importedBoms = managedImports(pom);
  return {
    parent,
    importedBoms,
    inheritsFromShared: Boolean(parent) || importedBoms.length > 0,
  };
}

/** One-line human summary the agent can read out. "" when the pom stands alone. */
export function inheritanceSummary(inh) {
  if (!inh || !inh.inheritsFromShared) return "";
  const parts = [];
  if (inh.parent) parts.push(`inherits from parent ${coordLabel(inh.parent)}`);
  for (const b of inh.importedBoms) parts.push(`imports BOM ${coordLabel(b)}`);
  return parts.join("; ");
}
