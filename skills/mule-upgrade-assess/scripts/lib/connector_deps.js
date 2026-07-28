// lib/connector_deps.js — B12/B13 enrichment for connectorGaps.
//
// A connectorGap means: the app inherits a connector version (from a parent/BOM) that is BELOW the
// Java-17 matrix pin, and the app pom does NOT declare its own <version> for it — so this PR can't
// bump it in-place. Before advising the operator, two live (non-fatal) enrichments make the warning
// actionable:
//
//   • B12 — fetch the TARGET version's POM (exchange.fetchPom) and classify HOW its own dependency
//     versions are declared: hard-coded literals, `${property}` refs, or BOM/parent-managed. This
//     tells the operator whether bumping the connector also drags in property/BOM changes.
//   • B13 — fetch the connector's ONE-LEVEL (direct) dependency edges at the target version
//     (exchange.graphDependencies). LOCKED at connector-level: a single expansion, NOT a full
//     transitive Maven tree. Surfaces the immediate sub-connectors/modules the bump pulls in.
//
// FULLY NON-FATAL: with no ExchangeClient, an unconfigured Anypoint, or any lookup failure, each gap
// is returned UNENRICHED (its live fields null) and a note is pushed to warnings — assessment never
// fails over this.

/**
 * enrichConnectorGaps({ gaps, exchange }): return a NEW array of gap objects, each augmented with
 * `dependencies` (one-level Graph edges at the target version) and `pom` (property/BOM version
 * classification from the target POM). Also returns collected warnings.
 *
 * @param {{gaps?:Array<{groupId?,artifactId?,from?,to?}>, exchange?:any, concurrency?:number}} [o]
 *   o.gaps: connectorGaps from the assessment engine; o.exchange: ExchangeClient (fetchPom +
 *   graphDependencies), absent → no enrichment; o.concurrency (default 4): parallelism cap over gaps.
 * @returns {Promise<{gaps:Array, warnings:string[]}>}
 */
export async function enrichConnectorGaps({ gaps, exchange, concurrency = 4 } = {}) {
  const warnings = [];
  const input = Array.isArray(gaps) ? gaps : [];
  if (!input.length) return { gaps: [], warnings };
  // No usable client → return the gaps untouched (live fields null), never throw.
  if (!exchange?.configured?.() || !exchange.graphDependencies) {
    return { gaps: input.map((g) => ({ ...g, dependencies: null, pom: null })), warnings };
  }

  const out = new Array(input.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, input.length)) }, async () => {
    while (cursor < input.length) {
      const i = cursor++;
      out[i] = await enrichOne(input[i], exchange, warnings);
    }
  });
  await Promise.all(workers);
  return { gaps: out, warnings };
}

/** Enrich a single gap; both live lookups are independent and non-fatal. */
async function enrichOne(gap, exchange, warnings) {
  const { groupId, artifactId, to } = gap;
  const enriched = { ...gap, dependencies: null, pom: null };

  // B13 — one-level direct dependency edges at the target version.
  if (exchange.graphDependencies) {
    try {
      const r = await exchange.graphDependencies(groupId, artifactId, to);
      if (r?.ok) enriched.dependencies = r.dependencies;
      else warnings.push(`connector deps for ${artifactId}@${to} unavailable: ${r?.reason ?? "unknown"}`);
    } catch (e) {
      warnings.push(`connector deps for ${artifactId}@${to} threw: ${e?.message ?? e}`);
    }
  }

  // B12 — how the target POM declares its own dependency versions (literal / ${prop} / BOM-managed).
  if (exchange.fetchPom) {
    try {
      const p = await exchange.fetchPom(groupId, artifactId, to);
      if (p?.ok) {
        enriched.pom = classifyPom(p);
      } else {
        warnings.push(`connector POM for ${artifactId}@${to} unavailable: ${p?.reason ?? "unknown"}`);
      }
    } catch (e) {
      warnings.push(`connector POM for ${artifactId}@${to} threw: ${e?.message ?? e}`);
    }
  }

  return enriched;
}

/**
 * classifyPom(pom): reduce a fetchPom() result to the version-management summary connectorGaps cares
 * about — counts of literal / property-ref / BOM-managed deps, and the resolved property-backed
 * versions (so a caller can show "objectstore.version = 1.0.0" without a second lookup).
 * @param {{properties:Object<string,string>, dependencies:Array}} pom
 */
export function classifyPom(pom) {
  const deps = Array.isArray(pom?.dependencies) ? pom.dependencies : [];
  const properties = pom?.properties ?? {};
  const propertyVersioned = [];
  let literal = 0;
  let managed = 0;
  for (const d of deps) {
    if (d.versionRef) {
      propertyVersioned.push({
        groupId: d.groupId,
        artifactId: d.artifactId,
        versionRef: d.versionRef,
        resolved: properties[d.versionRef] ?? null, // null when the prop is inherited, not in this pom
      });
    } else if (d.managed) {
      managed++;
    } else {
      literal++;
    }
  }
  return {
    depCount: deps.length,
    literal,
    managed,
    propertyVersioned,
    // Convenience flag for the warning text: does bumping this connector touch property/BOM plumbing?
    hasManagedVersions: managed > 0 || propertyVersioned.length > 0,
  };
}
