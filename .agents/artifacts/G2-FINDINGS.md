# G2 findings — connector-notes-map.yaml — 2026-07-27

Shipped: `skills/mule-upgrade-assess/references/connector-notes-map.yaml`
(106 connectors: 15 curated + 91 auto). Generators kept as evidence:
`build_notes_map.mjs` (docs-index ⋈ Graph exact-verify), `assemble_notes_map.mjs` (merge + YAML).

## Why the map is built this way (probe-driven)
- Release-notes pages carry **NO Maven coordinates** — artifactId cannot be scraped from a page.
- A display-name **Graph search is relevance-ranked toward deprecated Mule-3 modules**
  ("Salesforce Connector" → salesforce-commerce-cloud-connector; "HTTP Connector" → mule-as2-connector;
  "Database" → mapr-db-connector). Fuzzy top-hit is WRONG.
- Reliable primitive: Graph **exact-matches a known assetId**. So the generator turns each
  (slug, displayName) into candidate artifactIds and EXACT-verifies them against connector groups.
- Auto-resolve rate: **97/143** index connectors. The 46 misses are mostly newer/AI/EDI/partner
  connectors whose artifactId doesn't follow the candidate patterns — they degrade to matrix-only/
  no-enrichment (non-fatal). They are NOT matrix connectors, so no upgrade impact.

## The 15 matrix connectors are all hand-verified (authoritative, source: curated)
Two docs conventions + special cases (all HTTP 200 + parseable compat table unless noted):
- Prefix form on connector index: `connector-http`, `connector-db`, `connector-sockets`.
- Suffix form: `object-store-connector-release-notes-mule-4`, `salesforce-…`, `slack-…`, `gmail-…`,
  `twilio-…`; modules `json-module-release-notes`, `oauth-module-release-notes`, `tracing-module-release-notes`.
- **Runtime-modules section** (NOT the connector index): validation → `mule-runtime/module-validation`,
  xml → `mule-runtime/module-xml`, secure-config → `mule-runtime/secure-properties`.
- **apikit** — split into per-version pages under `apikit/apikit-release-notes` with NO single
  compatibility table. Mapped for discoverability; live parse yields nothing → matrix-only fallback.

## B6 confirmed working while verifying slugs
parseCompatibilityTable() extracts the Mule-runtime row too — e.g. http/db/sockets "4.1.1 and later",
salesforce "4.9.0 and later", tracing "4.4.0 or later", gmail "4.3.0 and later". firstJava17 matches
the matrix pins (http 1.9.0, salesforce 10.19.2, slack 1.0.17, db 1.14.8, etc.).

## Slack caveat (advisory, for G5)
Matrix pins `mule4-slack-connector` 1.0.17; auto-resolver also finds `mule-slack-connector` (org.mule.modules)
as a separate asset. Curated entry uses the matrix's `mule4-slack-connector` (com.mulesoft.connectors) —
the correct one. Graph shows slack latest 2.0.1 (breaking major) → advisory only.
