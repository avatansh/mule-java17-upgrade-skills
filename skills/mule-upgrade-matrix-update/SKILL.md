---
name: mule-upgrade-matrix-update
description: >-
  Turn check_drift advisories into a REVIEWED bump of the bundled Java-17 compatibility matrix.
  Use this when the user says things like "update the compatibility matrix", "the matrix pins are
  stale", "bump the matrix to the latest connector/gating versions", "adopt the drift advisories",
  or "our compatibility-matrix.yaml is behind". It proposes the bumps for review by default and
  writes them back to references/compatibility-matrix.yaml ONLY on an explicit apply. This is a
  maintenance action on the RULES DATA — distinct from mule-upgrade (which upgrades an app) and
  from check_drift (which only reports, never proposes an edit).
---

# mule-upgrade-matrix-update

The bundled `compatibility-matrix.yaml` is the **authoritative, curated Java-17-safe floor** — the
gating pins (runtime patch, `mule-maven-plugin`, MUnit runner/extensions) and the connector `set`
versions the assessor and rewrites consume. Those pins **rot**: MuleSoft publishes newer patch
releases while the bundled YAML stays fixed. `check_drift` already *reports* that trailing, and
`candidateMatrix()` already computes *what a bump would look like* — but both stop short of writing,
by design (the curated pin stays authoritative until a human adopts it).

This skill closes that last mile: it gathers the drift advisories, presents the proposed bumps for
**review**, and writes them back to the matrix **only on an explicit `--apply`**.

## The safety model (why this never surprises you)

- **Default is dry-run.** With no flags it computes and prints the proposed bumps and writes nothing.
- **`--apply` is the only writer.** Adoption is always an explicit, deliberate act.
- **Text-preserving edits.** The matrix YAML is heavily commented and uses inline flow-maps. This
  skill NEVER round-trips through a YAML dumper (which would strip every comment and reflow every
  map). It locates the exact line and rewrites only the version token in place.
- **Guarded on the current value.** Each edit only fires if the line still holds the value drift
  observed (`from`). A pin that already moved (hand-edited, or a prior apply) is **skipped**, never
  clobbered — reported as a skip so you can reconcile by hand.
- **Advisory-driven, not "latest".** Bumps come from `check_drift`: gating pins move to the latest
  clean release **on the pinned LTS line** (never a cross-train jump); connectors move to the latest
  **in-major** (never across a breaking major). The floor semantics are preserved.

## Run it (CLI-first — actually run this, do not simulate)

```bash
# Review what WOULD change (writes nothing):
node skills/mule-upgrade-matrix-update/scripts/matrix_update_cli.js

# Gating pins only, skip connector bumps:
node skills/mule-upgrade-matrix-update/scripts/matrix_update_cli.js --no-connectors

# Machine-readable report for an agent:
node skills/mule-upgrade-matrix-update/scripts/matrix_update_cli.js --json

# Adopt the bumps (the ONLY thing that writes the matrix):
node skills/mule-upgrade-matrix-update/scripts/matrix_update_cli.js --apply
```

| Flag              | Effect                                                                  |
|-------------------|-------------------------------------------------------------------------|
| *(none)*          | dry-run review — gather drift, print proposed bumps, write nothing      |
| `--apply`         | write the proposed bumps to `references/compatibility-matrix.yaml`      |
| `--no-connectors` | gating pins only (skip connector latest-in-major bumps)                 |
| `--no-fetch`      | skip all network → nothing to propose (drift unchecked)                 |
| `--json`          | emit the raw report JSON instead of the human summary                   |

## What it edits

- **Gating** (`gating.*.set`, and for the runtime also `target.runtime`): a runtime bump moves
  `target.runtime`, `gating.muleRuntime.set` and `gating.muleRuntimeSemver.set` together so the
  matrix stays internally consistent.
- **Connectors** (`connectors[].set`): one line per connector, matched by its `artifactId`.

## Output

A report `{ path, driftChecked, proposals[], applied[], skipped[], changed, wrote, warnings[] }`:
- `proposals` — every `{kind, id, label, from, to}` drift wants to bump.
- `applied` — the ones whose YAML line matched, with the 1-indexed line numbers touched.
- `skipped` — proposals whose line didn't match the expected `from` (already moved / not found).
- `wrote` — true only when `--apply` was given AND something changed.

## Recommended workflow

1. Run `check_drift` (or the assess skill's drift advisory) to see what's trailing.
2. Run this skill **without** `--apply` to see the exact proposed matrix edits.
3. Eyeball the `from → to` list; confirm the LTS-line / in-major constraints look right.
4. Re-run with `--apply` to adopt, then run the test suite and commit the matrix change.

This is the human-in-the-loop adoption step. It does not open a PR or touch any application — it
only maintains the rules data that every other skill reads.
