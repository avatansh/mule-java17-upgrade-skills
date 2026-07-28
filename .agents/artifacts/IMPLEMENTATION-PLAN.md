# Implementation Plan — Catalog-wide live version + compatibility (EPIC G/H)

Status: APPROVED 2026-07-27. Build in dependency order. Matrix stays authoritative for the
Java-17 floor; live data enriches (versions + firstCompatible) and advises (drift). All live paths
NON-FATAL with bundled fallback.

## Locked decisions
- **G2 scope = ALL connectors** (full catalog notes-map, not just the pinned 16).
- **B13 scope = connector-level** one-level Graph dependency expansion (NOT a full Maven tree).
- **G5 = advisory** connector matrix-drift report; never auto-writes the matrix.
- Renamed file: `connector-notes-map.yaml` (artifactId-as-in-POM → release-notes URL).

## Already done (verified in code this session — dropped from backlog)
- Exchange host + matrix fetch fix (mavenBaseUrl + HTML guard + org-scoped path).
- B7: matrix `muleMavenPlugin.min` is already `4.1.1`.
- B8: matrix already has `setAccessible` / `resourceBundle` / `powermock` scan hints.

## Newly found
- **CLI wiring gap:** assess.js CLI never passes `exchange`/`fetchConnectorHtml` to assess(), so
  resolveVersions is matrix-only in real CLI runs. G4 must fix this.

## Phases
- **P0 data:** B4 (diff Exchange 15 vs bundled 16) + G1 (Graph catalog sweep → exchange-catalog.json).
- **P1 (G3):** exchange.js — add Graph-backed version listing; rewire listVersions() to Graph
  (keep `{ok,versions[]}` shape). Tests.
- **P2 (G2):** generate `connector-notes-map.yaml` for all connectors (catalog GAV ⋈ docs-index scrape).
- **P3 (G4):** resolve_versions.js uses the notes-map (retire connectorSlug formula); assess.js CLI
  instantiates ExchangeClient + release-notes fetcher and passes them to resolveVersions. Tests.
- **P4 (B6):** version_resolver.js extract Mule-runtime row alongside JDK; surface on choices/result.
- **P5 (B12/B13):** exchange.js fetchPom + graphDependencies(one level); assess connectorGaps uses them.
- **P6 (G5):** matrix_drift.js extend to connectors (advisory); optional candidate matrix emitter.
- **P7 cleanup:** B3 (retire matrix_fetch index+indexOf path), B5 (align matrix version 1.0.4→1.0.5),
  B10 (docs). Full test + lint green.

## Files touched
- lib_shared/exchange.js (G3, B12/B13)
- skills/mule-upgrade-assess/scripts/lib/resolve_versions.js (G4, notes-map loader)
- skills/mule-upgrade-assess/scripts/lib/version_resolver.js (B6 runtime row)
- skills/mule-upgrade-assess/scripts/assess.js (G4 CLI wiring, B6/B13 surfacing)
- skills/mule-upgrade-assess/scripts/lib/matrix_drift.js (G5)
- skills/mule-upgrade-assess/scripts/lib/matrix_fetch.js (B3 retire broken path)
- skills/mule-upgrade-assess/references/connector-notes-map.yaml (NEW, G2)
- skills/mule-upgrade-assess/references/compatibility-matrix.yaml (B5 version note)
- config/config.yaml, config-*.yaml (B5)
- tests/*.test.js (new coverage per phase)
- docs: SETUP-VIBES / VIBES-BEGINNER-GUIDE (B10)
