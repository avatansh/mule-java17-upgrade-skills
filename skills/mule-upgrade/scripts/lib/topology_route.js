// lib/topology_route.js — Tier 2c: decide WHICH upgrade strategy an assessment needs.
//
// The assessor emits a ChangePlan carrying both `fileEdits` (edits the APP's OWN pom can make) and
// `connectorGaps` (connectors the app INHERITS from a parent/BOM at a version below the matrix — the
// app pom can't fix those, the shared parent/BOM must be bumped). The orchestrator has, until now,
// treated "no fileEdits" as ALREADY_UPGRADED — which is WRONG when the app is really blocked on an
// inherited connector gap: the app pom is clean, but the repo is not Java-17-ready until the BOM moves.
//
// routeUpgradeStrategy() reads the ChangePlan (topology + fileEdits + connectorGaps) and picks:
//   · "app-pom"    — the app pom carries edits → run the normal app pipeline (apply → commit → PR).
//   · "parent-pom" — no app edits, but inherited connector gaps exist → the parent/BOM must be bumped;
//                    hand off to the mule-upgrade-parent-pom job.
//   · "none"       — no edits and no gaps → genuinely ALREADY_UPGRADED.
//
// Pure + network-free: it's a decision over data the lean assess already produced. The orchestrator
// turns "parent-pom" into an actual mule-upgrade-parent-pom dispatch, so the two skills call each other.

/** @typedef {{topology?:string, fileEdits?:any[], connectorGaps?:any[]}} ChangePlanLike */

/**
 * parentPomPathsFromGaps(connectorGaps): the DISTINCT in-repo pom paths that manage the inherited
 * connector gaps (each gap's managedInPath, populated by the assess engine). Used to point the
 * parent-pom upgrade at the pom that actually manages the connector — a multi-module repo's shared
 * parent is often NOT the repo-root pom.xml (M5). Gaps with an unknown managing path are ignored.
 * @param {any[]} connectorGaps
 * @returns {string[]}
 */
export function parentPomPathsFromGaps(connectorGaps) {
  const paths = new Set();
  for (const g of connectorGaps ?? []) {
    if (g && typeof g.managedInPath === "string" && g.managedInPath) paths.add(g.managedInPath);
  }
  return [...paths];
}

/**
 * routeUpgradeStrategy(changePlan): choose the upgrade strategy from the assessment.
 * @param {ChangePlanLike|null|undefined} changePlan
 * @returns {{strategy:"app-pom"|"parent-pom"|"none", topology:string, reason:string,
 *   fileEditCount:number, connectorGapCount:number, connectorGaps:any[],
 *   parentPomPath:(string|null), parentPomPaths:string[]}}
 */
export function routeUpgradeStrategy(changePlan) {
  const topology = changePlan?.topology ?? "UNKNOWN";
  const fileEdits = changePlan?.fileEdits ?? [];
  const connectorGaps = changePlan?.connectorGaps ?? [];
  const fileEditCount = fileEdits.length;
  const connectorGapCount = connectorGaps.length;
  // Where the inherited connectors are actually managed (for the parent-pom route). A single distinct
  // path ⇒ dispatch the parent-pom job straight at it; multiple ⇒ surfaced for the caller to fan out.
  const parentPomPaths = parentPomPathsFromGaps(connectorGaps);
  const parentPomPath = parentPomPaths.length === 1 ? parentPomPaths[0] : null;

  // The app pom (or a shared file it directly edits) carries changes → the normal app pipeline. This
  // takes precedence: if the app declares its own connector versions we pin them here, and any
  // remaining inherited gaps are surfaced as warnings by assess (already in changePlan.warnings).
  if (fileEditCount > 0) {
    return {
      strategy: "app-pom",
      topology,
      reason: `${fileEditCount} file edit(s) apply to the app's own pom/build files.`,
      fileEditCount,
      connectorGapCount,
      connectorGaps,
      parentPomPath,
      parentPomPaths,
    };
  }

  // No app-pom edits, but the app inherits connector(s) below the matrix from a parent/BOM. The app
  // pom is clean; the fix must land on the shared parent. Route to the parent-pom job.
  if (connectorGapCount > 0) {
    return {
      strategy: "parent-pom",
      topology,
      reason:
        `The app pom needs no edits, but ${connectorGapCount} connector(s) are inherited from a ` +
        `parent/BOM below the Java-17 matrix (${connectorGaps
          .map((g) => `${g.artifactId} ${g.from ?? "?"}→${g.to ?? "?"}`)
          .join(", ")}). The shared parent/BOM must be bumped` +
        (parentPomPath ? ` (managed in ${parentPomPath}).` : "."),
      fileEditCount,
      connectorGapCount,
      connectorGaps,
      parentPomPath,
      parentPomPaths,
    };
  }

  // Nothing to change anywhere.
  return {
    strategy: "none",
    topology,
    reason: "No app-pom edits and no inherited connector gaps — already in the desired state.",
    fileEditCount,
    connectorGapCount,
    connectorGaps,
    parentPomPath,
    parentPomPaths,
  };
}
