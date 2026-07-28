# P7 cleanup findings — B3 / B5 / B10 — 2026-07-28

Closes the EPIC-G/H backlog. All three sub-items done; 284 tests pass, 0 lint errors (12
pre-existing test-file warnings unchanged).

## B3 — retire matrix_fetch index+indexOf path  (done in a prior session, verified here)
`skills/mule-upgrade-assess/scripts/lib/matrix_fetch.js` no longer scrapes the connector
release-notes INDEX page or caches to `~/.mule-upgrade/matrix-cache.json`. `resolveMatrix(opts)`
now only takes `{ noFetch, exchange }`: Exchange governed matrix (when `matrix.source=exchange*`)
→ bundled YAML fallback. `parseConnectorVersions`, `readCache`/`writeCache`,
`DEFAULT_RELEASE_NOTES_URL`, and the `fs`/`path`/`os`/`mergeConnectors` imports were removed.
`fetchReleaseNotesHtml` + `tryExchangeMatrix` remain (used by resolve_versions.js). Superseded by
the Exchange Graph API + curated `connector-notes-map.yaml` resolver.

## B5 — align matrix version 1.0.4 → 1.0.5
`config/config.yaml` `matrix.exchange.version: "1.0.4"` → `"1.0.5"` (line 60). This is the Exchange
ASSET REVISION version, distinct from the matrix's internal `schemaVersion: "1.2"`. Bundled matrix
header comment (references/compatibility-matrix.yaml, AUTHORITY MODEL block) also corrected: it
still described the retired `matrix_fetch.js: index -> per-connector page` flow; now points at
`resolve_versions.js` (Exchange Graph + connector-notes-map).

## B10 — docs align to the Graph-backed resolution + retired index-scrape
Rewrote the stale "dynamic connector versions / 24h disk cache / release-notes index" language:
- **README.md** — matrix env-var table row (`Matrix cache` → `Matrix source`); "Compatibility
  matrix (hybrid)" section (matrix source + live connector enrichment via Graph + notes-map,
  index-scrape retirement noted); "Not reproduced" Exchange-facade line.
- **skills/mule-upgrade-assess/SKILL.md** — removed the `--release-notes-url` usage example;
  rewrote the "Matrix source" / "Live connector enrichment" bullets; fixed the
  "Improvements over the Mule app" line.
- **skills/mule-upgrade-parent-pom/SKILL.md** — flags list + "Matrix source" section.
- **skills/mule-upgrade/SKILL.md** — orchestrator flags list.

### Retired the dead `--release-notes-url` flag
The flag was parsed by assess.js, upgrade.js, and parent_pom_cli.js but consumed NOWHERE after B3
(resolveMatrix dropped `releaseNotesUrl`). Removed the parse + the usage strings in all three CLIs
and the `parent_pom.js` JSDoc (`matrixOpts` is now `{noFetch, exchange}`). No test referenced it.

## Verification
- `node --test` → tests 284, pass 284, fail 0.
- `npm run lint` → 0 errors, 12 warnings (all pre-existing, in test files).
