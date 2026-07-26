// lib/topology.js — port of dwl::treeAnalysis.
// Derives file locations from a recursive tree and classifies the pom inheritance topology.

import { parsePom } from "./pom_parse.js";
import { propOf } from "./pom_chain.js";

/**
 * Locate the app pom, mule-artifact.json and CI workflow within the recursive tree, and build
 * the list of every property name the assessment cares about (for ownerByProperty).
 *
 * @param {{tree:Array<{path,type}>, truncated?:boolean}} tree recursive tree
 * @param {string|null} appPath0 optional app subpath (defaults to ".")
 * @param {object} gating matrix.gating (object of rules)
 * @param {Array} connectors matrix.connectors
 */
export function analyzeTree(tree, appPath0, gating, connectors) {
  const appPath = appPath0 ?? ".";
  const nominalPom = appPath === "." ? "pom.xml" : appPath + "/pom.xml";
  const items = tree?.tree ?? [];
  const treePaths = items.map((i) => i.path);

  let appPomPath = null;
  if (treePaths.includes(nominalPom)) {
    appPomPath = nominalPom;
  } else {
    const firstPom = items.find(
      (i) => i.type === "blob" && /(?:^|\/)pom\.xml$/.test(i.path)
    );
    appPomPath = firstPom ? firstPom.path : null;
  }

  const maPath = appPath === "." ? "mule-artifact.json" : appPath + "/mule-artifact.json";
  const maExists = treePaths.includes(maPath);

  const ci = items.find((i) => /\.github\/workflows\/[^/]+\.ya?ml$/.test(i.path));
  const ciPath = ci ? ci.path : null;

  const allProps = [
    ...Object.values(gating ?? {}).map((r) => r.property),
    ...(connectors ?? []).map((r) => r.property),
  ];

  return {
    appPomPath,
    muleArtifactExists: maExists,
    muleArtifactPath: maExists ? maPath : null,
    ciWorkflowPath: ciPath,
    allProps,
  };
}

/**
 * Classify topology from the chain shape and build a property→ownerPomPath map.
 * Re-reads each pom from its raw text to keep repeated keys intact (rehydrate).
 * @param {Array<{path,pom,pomText}>} chain0 nearest-first
 * @param {string[]} allProps property names to map to their owning pom
 */
export function classifyTopology(chain0, allProps) {
  const chain = (chain0 ?? []).map((c) => ({
    path: c.path,
    pom: c.pomText ? parsePom(String(c.pomText)) : c.pom,
  }));
  const n = chain.length;
  const topIsBom = n > 0 && chain[n - 1].pom?.project?.dependencyManagement != null;
  let topology;
  if (n >= 3 && topIsBom) topology = "BOM_PARENT_APP";
  else if (n === 2) topology = "PARENT_APP";
  else if (n === 1) topology = "APP_STANDALONE";
  else topology = "MULTI_LEVEL";

  const ownerOf = (prop) => {
    const hit = chain.find((c) => propOf(c.pom, prop) != null);
    return (hit ? hit.path : undefined) ?? chain[0]?.path;
  };

  const ownerByProperty = {};
  for (const p of allProps) ownerByProperty[p] = ownerOf(p);

  return { topology, appPomPath: chain[0]?.path, ownerByProperty };
}
