# B12/B13 findings — connector POM + one-level Graph deps — 2026-07-28

Shipped:
- `lib_shared/exchange.js` — `parsePomDependencies(xml)`, `ExchangeClient.fetchPom(g,a,v)` (B12),
  `ExchangeClient.graphDependencies(g,a,v)` (B13, one-level only — LOCKED, not a full tree).
- `skills/mule-upgrade-assess/scripts/lib/connector_deps.js` — `enrichConnectorGaps` + `classifyPom`.
- `skills/mule-upgrade-assess/scripts/assess.js` — hoisted the shared `ExchangeClient`; enriches
  `result.changePlan.connectorGaps` after the result is built (gated on `exchange.configured()`).
- Tests: `tests/connector_deps.test.js` (8) + fetchPom/graphDependencies/parsePomDependencies in
  `tests/anypoint.test.js`. Full suite 279 pass, 0 lint errors.

## Probe-confirmed primitives (deps_probe.mjs, deps_probe2.mjs)
- **POM fetch path (facade, FLAT groupId layout):**
  `GET maven.anypoint.mulesoft.com/api/v3/maven/{groupId}/{artifactId}/{version}/{artifactId}-{version}.pom`
  → 200, real `<project>` POM. This is a DIFFERENT layout from the org-scoped asset path used by
  `fetchAsset` (`/organizations/{org}/maven/{org}/…`). Both premium (com.mulesoft.connectors) and OSS
  (org.mule.connectors) connectors resolve.
- **Graph `dependencies` field = ONE LEVEL, versions resolved.** `assets{ dependencies{ groupId
  assetId version } }` returns direct edges with concrete versions, per-version row. It does NOT nest
  (introspecting the `Dependency` type returns null — it's an inline field, not recursible). This is
  exactly the connector-level scope the user locked; we do not recurse.
- Dependencies differ by version ROW: salesforce 9.4.x → objectstore **1.0.0**, salesforce 10.19.2 →
  objectstore **1.2.2**. So `graphDependencies` MUST match the exact target version (it does).

## Live end-to-end verification (verify_b12_b13.mjs — SHIPPED code, real Exchange)
```
[B13] graphDependencies(salesforce@10.19.2): OK  → mule-objectstore-connector@1.2.2
[B12] fetchPom(salesforce@10.19.2): OK  → deps:2 literal:0 ${prop}:2 BOM:0  props:15
        sample prop-versioned: munit-runner=${munit.version}, munit-tools=${munit.version}
```

## Design decisions
- **B13 locked at one level.** `graphDependencies` returns only the direct edges Graph reports for the
  matched version; no transitive walk. Matches the user's "connector-level (recommended one), not
  whole tree" decision.
- **B12 classifies, does not rewrite.** `parsePomDependencies` tags each top-level dep as literal /
  `${property}`-ref / BOM-managed, and captures `<properties>` so a `${prop}` can be resolved locally.
  `<dependencyManagement>` is deliberately excluded (those versions govern OTHER poms). This makes the
  connectorGap warning actionable ("bumping X also touches property/BOM plumbing") without editing.
- **Advisory + non-fatal everywhere.** No Exchange / unconfigured Anypoint / any lookup failure → the
  gap is returned with `dependencies:null, pom:null` and a warning; assessment never fails over it.
- **connectorGaps only.** Enrichment runs solely for the inherited-below-target connectors (the gaps),
  not every matrix connector — keeps the live lookups bounded (concurrency pool of 4).
