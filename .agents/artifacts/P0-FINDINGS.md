# P0 findings (B4 + G1 + G3 version-enumeration) — 2026-07-27

Live probes: `catalog_sweep.mjs`, `scope_probe.mjs`, `version_enum_probe.mjs`. Artifacts:
`exchange-catalog.json`, `matrix-diff.json`.

## G3 — how to list versions (CONFIRMED, drives implementation)
- Graph rejects `groupId`/`assetId` as `SearchAsset` fields. Only `searchTerm`, `type`, `limit`, `offset` work.
- `assets(query:{searchTerm:"<artifactId>", limit:100, offset:N})` returns rows; filter client-side to
  `assetId === artifactId` (and optionally `groupId === expected`).
- **Single page is relevance-ranked and truncated** — a single limit:100 page for `mule-http-connector`
  peaked at 1.5.15, MISSING the newer 1.11.3. **Full offset pagination reaches the true max (1.11.3).**
  → listVersions() MUST paginate until a short/empty page, accumulate exact matches, then dedup.
- No singular `asset()` query; no version-list sub-field (Platform/Asset introspection returns empty/blocked).
- All 15 matrix connectors resolve via per-artifactId searchTerm with `groupId` matching the matrix:
  | artifactId | groupId | live max | matrix set |
  |---|---|---|---|
  | mule-apikit-module | org.mule.modules | 1.12.2 | 1.11.8 |
  | mule-http-connector | org.mule.connectors | 1.11.3 | 1.11.3 |
  | mule-sockets-connector | org.mule.connectors | 1.2.9 | 1.2.8 |
  | mule-objectstore-connector | org.mule.connectors | 1.3.1 | 1.3.0 |
  | mule-secure-configuration-property-module | com.mulesoft.modules | 1.3.1 | 1.2.7 |
  | mule-db-connector | org.mule.connectors | 1.16.2 | 1.14.6 |
  | mule-validation-module | org.mule.modules | 2.0.9 | 2.0.4 |
  | mule-json-module | org.mule.modules | 2.5.7 | 2.5.2 |
  | mule-xml-module | org.mule.modules | 1.4.5 | 1.4.2 |
  | mule-oauth-module | org.mule.modules | 1.1.27 | 1.1.24 |
  | mule-tracing-module | org.mule.modules | 1.2.1 | 1.0.3 |
  | mule-twilio-connector | com.mulesoft.connectors | 4.2.9 | 4.2.9 |
  | mule4-gmail-connector | com.mulesoft.connectors | 1.1.2 | 1.1.2 |
  | mule4-slack-connector | com.mulesoft.connectors | 2.0.1 | 1.0.17 |
  | mule-salesforce-connector | com.mulesoft.connectors | 12.0.0 | 10.19.2 |
  NOTE: `secure-configuration-property-module` real groupId is **com.mulesoft.modules** (matrix says
  same). Salesforce/slack show large majors ahead (12.0.0, 2.0.1) — advisory only (G5), never auto-adopt.

## B4 — bundled matrix has 15 connectors (NOT 16)
- The summary said "16"; the file actually lists **15**. The "16th" was a miscount — no connector is missing.
- The Exchange-hosted matrix asset (v1.0.5) reported 15 connectors too → consistent. Nothing to reconcile.

## G1 — a single global public-connector catalog is NOT obtainable via Graph
- Blind `type:"connector"` offset sweep returns 2254 rows → 853 unique GAV, but scoped to THIS ORG's
  visible Exchange: examples (`org.mule.examples`), templates, partner/custom modules
  (`com.glomidco.xbrl`, `works.integration`, guid groups). Only 141 sit in connector groups, and the
  PUBLIC MuleSoft connectors (`mule-http-connector`, `mule-salesforce-connector`) are ABSENT from the sweep.
- Broad `searchTerm:"connector"` fully paged surfaced only 1 public-connector-group row.
- **Conclusion:** Graph is authoritative for *per-connector* version lists (G3) but NOT for *enumerating*
  the public connector set. → **G2 pivot:** the docs release-notes INDEX is the authoritative public
  connector list; join it with per-artifactId Graph resolution / release-notes-page Maven coords for GAV.

## Net plan deltas
- **B4: CLOSED** — matrix is complete at 15; no missing connector. (Task can be marked done.)
- **G1: repurposed** — keep `exchange-catalog.json` as evidence of org scope; do NOT rely on it as the
  public catalog. G2 sources the connector list from the docs index, not a Graph sweep.
- **G3: ready to build** — paginate searchTerm, exact-assetId filter, dedup, non-fatal.
