# Flow: compatibility-matrix maintenance

Read this when the user asks to update the matrix, says the pins are stale, wants to know what
differs between Java targets, or wants to add a new Java target.

This maintains the **rules data** every other skill reads. It does not touch any application.

## Intake for this flow

Only one question, and it is the important one: **which Java target(s)?** See below.

## The target files

There is one matrix file per Java target:

```
skills/mule-upgrade-assess/references/
  compatibility-matrix.yaml          the DEFAULT target (currently Java 17)
  compatibility-matrix-java21.yaml   Java 21
  MATRIX.md                          the operator's guide — read it before editing
```

```bash
# what targets exist, and are they curated?
node skills/mule-upgrade-matrix-update/scripts/matrix_update_cli.js targets

# what actually differs between two targets?
node skills/mule-upgrade-matrix-update/scripts/matrix_update_cli.js diff 17 21

# start a new target (generated from the default; identity copied, versions blanked)
node skills/mule-upgrade-matrix-update/scripts/matrix_update_cli.js scaffold 25
```

## ALWAYS ask which target a change belongs in

With more than one target file, Java-neutral fields are duplicated, so deciding where a change lands
is a judgement **the user** makes. The CLI enforces this: omit `--targets` and it prints the choices
and writes nothing, even under `--apply`.

Put it to them plainly:

> Which Java target should this land in — 17, 21, or both?

| Change | Usually belongs in |
|---|---|
| A version bump (drift, a CVE forces a pin up) | the **specific** target — the safe version differs per Java |
| A new connector, a renamed coordinate, a new scan pattern | **all** targets — coordinates are Java-neutral |

If it lands in the wrong place, `npm test` catches it: the parity test fails by name when the
Java-neutral identity fields drift between target files.

## Updating pins from drift

```bash
# review what WOULD change (writes nothing)
node skills/mule-upgrade-matrix-update/scripts/matrix_update_cli.js

# adopt, for a specific target
node skills/mule-upgrade-matrix-update/scripts/matrix_update_cli.js --apply --targets 17
```

MCP equivalent: `check_drift` reports the drift; adoption is CLI-only and deliberately human-gated.

An **uncurated** target absorbs nothing: its versions are all `TODO`, so no bump's guard can match
and every proposal skips. That is by design — say so rather than reporting it as a failure.

## Adding a Java target (e.g. making Java 21 real)

1. `scaffold 21` if the file doesn't exist yet. Identity fields are copied by machine, so it starts
   parity-clean.
2. Curate every `TODO` against the real sources — release notes, the MuleSoft Java-compatible
   connector KB, runtime support matrices. `diff 17 21` lists exactly what still needs a value.
3. Delete the `status: "uncurated"` line. The target now appears in the assistant's Java menu
   automatically.

**Until step 3, the engine refuses to run against that target** rather than emitting a plan built
from another Java version's floors. If a user asks to upgrade to an uncurated target, relay that
refusal — do not work around it, and never fill in versions yourself. Curating the matrix is a
maintainer task with real sources, not something to reason out in a conversation.
