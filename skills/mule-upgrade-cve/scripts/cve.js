// cve.js — scan an app's declared Maven coordinates for known vulnerabilities, and say which ones the
// Java 17 upgrade already fixes.
//
// This is the shared entry point for both the MCP tool and the CLI. It reuses assess()'s repo→pom-chain
// plumbing (buildAppChain) so "which app, from which source" behaves identically to every other skill —
// a CVE scan that resolved sources differently from the assessment would eventually report on a
// different pom than the one being upgraded.

import { assess, buildAppChain } from "../../mule-upgrade-assess/scripts/assess.js";
import { OsvClient } from "./lib/osv.js";
import { collectDependencies, plannedVersions, buildCveReport } from "./lib/cve_engine.js";

/**
 * scanVulnerabilities — collect declared coordinates, ask OSV about them, classify against the plan.
 *
 * Source options are deliberately IDENTICAL to assess() — same names, same waterfall. A security scan
 * that resolved "which app" differently from the assessment would eventually report on a different pom
 * than the one being upgraded, and nobody would notice until the numbers disagreed.
 *
 * @param {object} opts
 * @param {"github"|"local"} [opts.source]
 * @param {string} [opts.repo]             local clone directory (source=local)
 * @param {string} [opts.repoUrl]          github URL (source=github)
 * @param {string} [opts.owner]
 * @param {string} [opts.repoName]
 * @param {string} [opts.branch]
 * @param {string} [opts.appPath]
 * @param {boolean} [opts.comparePlan]     also run assess() to mark vulns the upgrade resolves (default true)
 * @param {boolean} [opts.refresh]         bypass the OSV cache
 * @param {number} [opts.maxVulnDetails]
 * @param {typeof fetch} [opts.fetchImpl]  injected in tests
 * @param {any} [opts.osv]                 injected client in tests
 * @param {any} [opts.assessResult]        pre-computed assessment, to avoid a second chain walk
 */
export async function scanVulnerabilities(opts = {}) {
  const warnings = [];
  const { chain, appPath, located } = await buildAppChain(opts);

  const deps = collectDependencies({ chain });
  const queryable = deps.filter((d) => d.version);

  // The plan comparison is what makes this more than a generic scanner, but it costs a second pass over
  // the repo. Callers that already have an assessment pass it in; callers that don't want the cost can
  // turn it off and still get a plain vulnerability list.
  let planned = new Map();
  let planNote = null;
  let planCompared = false;
  if (opts.comparePlan !== false) {
    try {
      const assessed = opts.assessResult ?? (await assess({ ...opts }));
      // assess() WRAPS the assessment in `{ result, matrixSource, ... }`. Reading changePlan off the
      // wrapper yields undefined with no error, so "resolved-by-upgrade" would silently stay at zero
      // forever — hence the explicit unwrap, and the `?? assessed` so a caller may pass either shape.
      const result = assessed?.result ?? assessed;
      planned = plannedVersions(result?.changePlan);
      planCompared = true;
      planNote = `Compared against the upgrade plan for ${result?.appName ?? appPath}.`;
    } catch (e) {
      // A failed assessment must not sink the scan — the findings are still useful without the
      // "resolved-by-upgrade" split, they just can't be credited to the upgrade.
      warnings.push(
        `Upgrade-plan comparison unavailable (${e?.message ?? e}); every finding is reported as it stands today.`
      );
    }
  }

  const osv = opts.osv ?? OsvClient({ fetchImpl: opts.fetchImpl, refresh: opts.refresh, maxVulnDetails: opts.maxVulnDetails });
  if (!osv.configured?.()) {
    return {
      ok: false,
      appPath,
      reason: "No fetch implementation available; OSV cannot be queried.",
      ...buildCveReport({ deps, idsPerDep: [], vulns: new Map(), warnings, complete: false }),
    };
  }

  const batch = await osv.queryBatch(queryable.map((d) => ({ name: d.name, version: d.version })));
  if (!batch.ok) warnings.push(`OSV query was incomplete (${batch.reason}); results are partial.`);

  const allIds = batch.ids.flat();
  const { vulns, warnings: detailWarnings } = await osv.fetchVulns(allIds);
  warnings.push(...detailWarnings);

  const report = buildCveReport({
    deps: queryable,
    idsPerDep: batch.ids,
    vulns,
    planned,
    warnings,
    complete: batch.ok && detailWarnings.length === 0,
  });

  return {
    ok: true,
    appName: located?.appName ?? appPath,
    appPath,
    // Two different facts, deliberately not collapsed into one flag: whether the comparison RAN, and
    // whether the plan actually moves any dependency version. "The upgrade touches none of these
    // libraries" is real information; reporting it as "no plan was compared" would look like a failure.
    planCompared,
    plannedCoordinateCount: planned.size,
    ...(planNote ? { planNote } : {}),
    ...report,
    // Coordinates we could see but not query, so the gap is inspectable rather than just counted.
    unresolved: deps.filter((d) => !d.version).map((d) => ({ package: d.name, declaredIn: d.declaredIn })),
  };
}

export default scanVulnerabilities;
