---
name: mule-upgrade-matrix-update
description: >-
  Turn check_drift advisories into a REVIEWED bump of the bundled compatibility matrices, and manage
  the per-Java-target matrix files (list, diff, scaffold a new target). Use this when the user says
  things like "update the compatibility matrix", "the matrix pins are stale", "bump the matrix to the
  latest connector/gating versions", "adopt the drift advisories", "our compatibility-matrix.yaml is
  behind", "what differs between Java 17 and 21", or "add a Java 25 target". It proposes bumps for
  review by default and writes ONLY on an explicit apply, and with more than one Java target present
  it ASKS which target(s) a change belongs in rather than guessing. This is a maintenance action on
  the RULES DATA — distinct from mule-upgrade (which upgrades an app) and from check_drift (which
  only reports, never proposes an edit).
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
node skills/mule-upgrade-matrix-update/scripts/matrix_update_cli.js --apply --targets 17

# Inspect the per-Java-target files:
node skills/mule-upgrade-matrix-update/scripts/matrix_update_cli.js targets
node skills/mule-upgrade-matrix-update/scripts/matrix_update_cli.js diff 17 21
node skills/mule-upgrade-matrix-update/scripts/matrix_update_cli.js scaffold 25
```

| Flag / command    | Effect                                                                  |
|-------------------|-------------------------------------------------------------------------|
| *(none)*          | dry-run review — gather drift, print proposed bumps, write nothing      |
| `--apply`         | write the proposed bumps to the chosen target file(s)                   |
| `--targets`       | which Java target(s) to touch: `17`, `17,21`, or `all`                  |
| `--no-connectors` | gating pins only (skip connector latest-in-major bumps)                 |
| `--no-fetch`      | skip all network → nothing to propose (drift unchecked)                 |
| `--json`          | emit the raw report JSON instead of the human summary                   |
| `targets`         | list every Java target and whether it is curated                        |
| `diff <a> <b>`    | the version-level delta between two targets                             |
| `scaffold <n>`    | create a new (uncurated) target from the default                        |

## Which target file? (ALWAYS ask — never guess)

There is **one matrix file per Java target** (`compatibility-matrix.yaml` is the default;
`compatibility-matrix-java21.yaml` and friends sit alongside it). Java-neutral fields are therefore
duplicated across files, and deciding where a change belongs is a judgement the **operator** makes.

So when more than one target exists and `--targets` was not given, this skill **refuses and asks**:
it returns `needsTargetChoice` with the available targets and writes nothing, even under `--apply`.

Put the question to the user in those terms:

> Which Java target should this land in — 17, 21, or both?

| Change | Usually belongs in |
|---|---|
| A version bump (drift, a CVE forces a pin up) | the **specific** target — the safe version differs per Java |
| A new connector, a renamed coordinate, a new scan pattern | **all** targets — coordinates are Java-neutral |

If you get it wrong, `npm test` catches it: the parity test fails by name when the Java-neutral
identity fields drift between target files. See `references/MATRIX.md` for the full model.

**Uncurated targets absorb nothing.** A scaffolded target's versions are all `TODO`, so no bump's
`from` guard can match and every proposal skips. That is by design, and the summary says so rather
than printing a wall of identical skip lines.

## What it edits

- **Gating** (`gating.*.set`, and for the runtime also `target.runtime`): a runtime bump moves
  `target.runtime`, `gating.muleRuntime.set` and `gating.muleRuntimeSemver.set` together so the
  matrix stays internally consistent.
- **Connectors** (`connectors[].set`): one line per connector, matched by its `artifactId`.

## Output

A report `{ path, driftChecked, proposals[], applied[], skipped[], changed, wrote, targets[], needsTargetChoice, availableTargets[], warnings[] }`:
- `proposals` — every `{kind, id, label, from, to}` drift wants to bump.
- `applied` — the ones whose YAML line matched, with the 1-indexed line numbers touched.
- `skipped` — proposals whose line didn't match the expected `from` (already moved / not found).
- `wrote` — true only when `--apply` was given AND something changed.
- `targets[]` — per-target `{javaVersion, path, curated, applied, skipped, changed, wrote}`.
- `needsTargetChoice` — true when the target question is unanswered; nothing was written.

`path`/`applied`/`skipped` mirror the first target, so callers written before multi-target support
keep working unchanged.

## Recommended workflow

1. Run `check_drift` (or the assess skill's drift advisory) to see what's trailing.
2. Run this skill **without** `--apply` to see the exact proposed matrix edits.
3. Eyeball the `from → to` list; confirm the LTS-line / in-major constraints look right.
4. Ask the user which target(s) the change belongs in (see above).
5. Re-run with `--apply --targets <answer>` to adopt.
6. Run `npm test` — the parity test is what catches a change that should have gone to every target
   but only landed in one. Then commit.

This is the human-in-the-loop adoption step. It does not open a PR or touch any application — it
only maintains the rules data that every other skill reads.
