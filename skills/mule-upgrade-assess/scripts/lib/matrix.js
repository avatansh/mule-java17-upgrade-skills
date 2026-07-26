// lib/matrix.js — load the bundled compatibility matrix YAML.
// The matrix is the tunable "rules engine" data: target runtime/java, gating rules, connector
// versions, hygiene lists, manualReview flags, and the mule-artifact.json target.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the bundled matrix YAML (references/compatibility-matrix.yaml). */
export function bundledMatrixPath() {
  return path.resolve(__dirname, "..", "..", "references", "compatibility-matrix.yaml");
}

/** Load + parse the bundled matrix YAML into an object. */
export function loadBundledMatrix() {
  const text = fs.readFileSync(bundledMatrixPath(), "utf8");
  return yaml.load(text);
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
