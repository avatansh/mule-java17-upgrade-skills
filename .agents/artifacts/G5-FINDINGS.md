# G5 findings — connector matrix drift (advisory) — 2026-07-28

Shipped in `skills/mule-upgrade-assess/scripts/lib/matrix_drift.js`:
- `checkConnectorDrift({ matrix, choices })` — pure reduction of the resolveVersions CHOICE menu into
  a per-connector drift report (pinned vs latest-in-major). NO extra network.
- `candidateMatrix(matrix, connectorReport)` — a PROPOSED matrix bumping only the drifting pins.
  Returned as a review artifact; NEVER written to disk. Source matrix is not mutated.
- `formatConnectorDrift(report)` — CLI summary.
- CLI: `matrix_drift.js --connectors` (also runs connector drift) / `--candidate` (also prints the
  proposed bumps). Builds a real ExchangeClient + release-notes fetcher (non-fatal, unconfigured →
  matrix-only). `--json` emits `{ gating, connectors, candidate }`.

Wired into `assess.js`: `result.connectorDrift` is attached from the already-computed
`connectorChoices` (no extra network). Per-connector staleness is already bubbled into
`versionWarnings` by resolveVersions, so we attach only the STRUCTURED report (no duplicate warnings).

Tests: `tests/matrix_drift.test.js` +4 (drift verdict, no-choices, candidate emit, formatter) — 283
pass, 0 lint errors.

## Design (locked decision: advisory, never auto-writes)
- Compares each pin against **latest-in-major only** — never proposes crossing a breaking major. When
  a newer major exists, the warning notes it ("X exists in a newer major — verify separately") but the
  candidate bump stays in-major.
- The curated matrix pin remains the **authoritative Java-17-safe floor**. Both the warning text and
  the CLI header state "matrix stays authoritative". Adoption is a human step.
- Reuses the CHOICE menu → zero additional Exchange calls in the assess path; only the standalone CLI
  builds its own client.

## Live verification (real Exchange, `--connectors --candidate` → .agents/artifacts/connector-drift.json)
Gating drift: 4 (runtime 4.9.18<4.9.19, mmp 4.10.0<4.10.1, munit 3.6.3<3.7.3, munitExt 1.5.0<1.7.0).
Connector drift: **12 of 15** trail their latest-in-major. Current: http (1.11.3), twilio (4.2.9),
gmail (1.1.2). Sample proposed in-major bumps (NOT written):
- mule-db-connector 1.14.6 → 1.16.2
- mule-salesforce-connector 10.19.2 → 10.22.9
- mule-tracing-module 1.0.3 → 1.2.1
- mule-apikit-module 1.11.8 → 1.12.2
- mule4-slack-connector 1.0.17 → 1.0.19 (matrix pin; slack 2.x is a separate breaking major, excluded)

These are ADVISORY — the shipped matrix is unchanged. A maintainer reviews connector-drift.json and
bumps the YAML deliberately.
