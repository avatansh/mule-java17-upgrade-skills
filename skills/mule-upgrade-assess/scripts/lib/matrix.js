// lib/matrix.js — load the bundled compatibility matrix YAML.
// The matrix is the tunable "rules engine" data: target runtime/java, gating rules, connector
// versions, hygiene lists, manualReview flags, and the mule-artifact.json target.

import fs from "node:fs";
import yaml from "js-yaml";
import { resolveTargetFile, _resetTargetCache } from "./matrix_targets.js";

/**
 * Absolute path to a bundled matrix YAML.
 *
 * With no argument this is the DEFAULT target (references/compatibility-matrix.yaml) — which is
 * exactly what every pre-existing caller gets, so adding targets changed no behaviour. Passing a
 * Java major selects that target's file and THROWS if it is absent or not yet curated; see
 * matrix_targets.resolveTargetFile for why refusing beats silently falling back.
 *
 * @param {string|number} [targetJava]
 */
export function bundledMatrixPath(targetJava) {
  return resolveTargetFile(targetJava).file;
}

// A matrix file never changes during a process's lifetime, yet loadBundledMatrix() is called on
// every resolveMatrix/resolveVersions/drift path — each one re-reading the file and re-parsing YAML.
// Cache the PARSED object per FILE and hand every caller an independent deep copy (structuredClone),
// so a caller that mutates its matrix (applyVersionStrategy/mergeConnectors return fresh objects, but
// this keeps the invariant even for ad-hoc in-place edits) can never corrupt the shared template.
// Keyed by resolved path rather than by target so two names for the same file share one entry. The
// matrix-update skill, which rewrites the YAML, calls _resetMatrixCache() after a write so a
// long-lived process re-reads the new contents.
/** @type {Map<string, any>} */
const _cachedMatrices = new Map();

/**
 * Load + parse a bundled matrix YAML (memoized; returns a fresh deep copy each call).
 * @param {string|number} [targetJava] omit for the default target
 */
export function loadBundledMatrix(targetJava) {
  const file = bundledMatrixPath(targetJava);
  if (!_cachedMatrices.has(file)) {
    _cachedMatrices.set(file, yaml.load(fs.readFileSync(file, "utf8")));
  }
  return structuredClone(_cachedMatrices.get(file));
}

/**
 * Drop the memoized matrices so the next loadBundledMatrix() re-reads the YAML (used after a write /
 * in tests). Also drops the target registry, because a write can add a target file or clear a
 * `status: uncurated` flag and a long-lived process has to see that.
 */
export function _resetMatrixCache() {
  _cachedMatrices.clear();
  _resetTargetCache();
}

/**
 * Merge a dynamic connectors[] list into a base matrix, keeping all static gating/hygiene.
 * Only the `set` version of a matching connector (by artifactId) is overridden; connectors the
 * dynamic source doesn't mention keep their bundled version. Connectors present dynamically but
 * absent from the bundled list are appended (best-effort: they need groupId/property too).
 * @param {object} base bundled matrix
 * @param {Array<{artifactId, set, groupId?, property?}>} dynamicConnectors
 * @returns {object} merged matrix
 */
export function mergeConnectors(base, dynamicConnectors) {
  if (!Array.isArray(dynamicConnectors) || dynamicConnectors.length === 0) return base;
  const byArtifact = new Map();
  for (const c of dynamicConnectors) {
    if (c && c.artifactId) byArtifact.set(String(c.artifactId), c);
  }
  const merged = (base.connectors ?? []).map((c) => {
    const hit = byArtifact.get(String(c.artifactId));
    if (hit && hit.set) {
      byArtifact.delete(String(c.artifactId));
      return { ...c, set: String(hit.set) };
    }
    return c;
  });
  // Append dynamic-only connectors that carry enough coordinates to be actionable.
  for (const c of byArtifact.values()) {
    if (c.groupId && c.property && c.set) {
      merged.push({ property: c.property, set: String(c.set), groupId: c.groupId, artifactId: c.artifactId });
    }
  }
  return { ...base, connectors: merged };
}
