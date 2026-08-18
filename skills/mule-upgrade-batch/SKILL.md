---
name: mule-upgrade-batch
description: >-
  Upgrade MANY MuleSoft apps to Java 17 in one run — the batch/fan-out layer on top of the
  single-app pipeline. Use this when the user says things like "upgrade all of these apps",
  "upgrade these five apps", "batch upgrade", "upgrade everything the scan found", "do the whole
  fleet", "upgrade apps A, B and C", or picks several apps off a fleet-scan candidate list. It
  previews every app first (nothing is written without an explicit confirm), holds back apps whose
  connector versions live in a shared parent/BOM pom, then runs the rest concurrently — each with
  its own lock, its own tracked job and its own PR. ONE environment per batch. For a single app,
  use mule-upgrade-agent (interactive) or mule-upgrade (engine) instead.
---

# mule-upgrade-batch (fan-out upgrades)

The engine could always upgrade different apps concurrently — the single-flight lock is keyed
`<app>::<env>`, so distinct apps never contend. What was missing was an **orchestrator**: nothing
fanned the calls out, so N apps meant N manual round-trips through the conductor. This skill is that
layer, and nothing more: it does not reimplement any pipeline stage.

Every app still goes through the **normal `runUpgrade` pipeline**, so each one keeps its own
stale-plan anchor, failure taxonomy, lock acquisition/release, notify opt-in and reconcile behaviour.
A batch is a scheduler, not a second code path.

## Three phases

```
PHASE 1 — PREVIEW    every selected app is dry-run CONCURRENTLY (bounded pool).
                     No locks. No jobs. No edits. Produces a per-app plan.
     │
PHASE 2 — GROUP      apps whose connector gaps are managed UPSTREAM are grouped by the pom that
                     manages them and marked NEEDS_PARENT_POM — held back, not run (see below).
     │
PHASE 3 — EXECUTE    only with confirm:true, and only the app-pom-routed apps. Bounded pool again;
                     each app takes its own <app>::<env> lock and creates its own tracked job.
```

## Why shared parent POMs are held back

If five apps inherit their connector versions from one parent POM, the fix is to edit **that pom
once** — not to start five upgrades that each discover they can't pin anything. Worse, all five
would contend on the same `<repo>::<pomPath>` parent-pom lock, so four would get `CONFLICT` even
though nothing is wrong.

So batch reports them as `NEEDS_PARENT_POM` with the managing pom path, and groups the apps waiting
on each pom (`sharedParentPoms[]`). The chained parent → BOM → app flow is a human-in-the-loop
sequence with a decision at each hop; run it via `mule-upgrade-parent-pom`, then re-run the batch and
those apps will route to `app-pom` normally.

`--include-parent-pom` overrides this. It exists for the single-app-per-pom case; do not reach for it
to "unblock" a group of apps sharing one pom.

## Safety posture

**Nothing is written without `confirm:true`.** `run` without `--confirm` prints the preview and exits.
This is deliberately stricter than the single-app pipeline: accidentally opening one PR is a nuisance,
accidentally opening twenty is an incident.

**Failure is isolated per app.** One app's 401, `CONFLICT`, or unexpected throw is recorded against
that app and the pool keeps going — a 20-app run always returns 20 outcomes. `--stop-on-failure`
inverts this when you want a batch to halt early.

**Duplicates are dropped.** The same app twice in one selection would self-`CONFLICT` on its own lock,
so the second entry is `SKIPPED` before anything runs.

## Run

```bash
# preview an explicit selection — writes nothing
node skills/mule-upgrade-batch/scripts/batch_cli.js preview \
  --env dev --apps orders-api,payments-api,billing-api

# preview everything the fleet scan found (skips apps it can't map to a repo)
node skills/mule-upgrade-batch/scripts/batch_cli.js preview --env dev --from-scan

# execute — 3 apps in flight at a time
node skills/mule-upgrade-batch/scripts/batch_cli.js run \
  --env dev --apps orders-api,payments-api,billing-api --confirm --concurrency 3

# per-app coordinate overrides (monorepo modules, non-convention repos)
node skills/mule-upgrade-batch/scripts/batch_cli.js preview --env dev \
  --apps '[{"appName":"orders-api","owner":"acme","repo":"mule-apps","appPath":"apps/orders"}]'

# with notifications (opt-in, applied to EVERY app in the batch)
node skills/mule-upgrade-batch/scripts/batch_cli.js run --env dev --apps a,b --confirm \
  --slack --jira PLAT-42 --jira-mode comment
```

MCP: `batch_upgrade` takes the same arguments (`apps[]`, `fromScan`, `environment`, `confirm`,
`concurrency`, `notifyPrefs`, …).

## Selection

| Input | Behaviour |
|---|---|
| `--apps a,b,c` | names only; coordinates resolve through the usual registry → request → convention waterfall |
| `--apps '[{…}]'` | per-app `owner`/`repo`/`appPath`/`branch`/`deployedApiName` overrides |
| `--from-scan` | takes `scan_fleet` candidates; apps flagged `needsCoordinates` are `SKIPPED` with the reason |

An app whose coordinates can't be resolved is `SKIPPED` — never guessed at.

## Outcome statuses

| Per-app status | Meaning |
|---|---|
| `PR_OPEN` | upgraded; PR open, job tracked |
| `PLAN_PREVIEW` | would upgrade (preview runs only) |
| `ALREADY_UPGRADED` | no file edits needed — already on target |
| `NEEDS_PARENT_POM` | connector versions pinned in a shared parent/BOM pom; held back |
| `CONFLICT` | another job already holds this app's `<app>::<env>` lock |
| `FAILED_ASSESS` / `FAILED_COMMIT` | that app's pipeline failed; taxonomy identical to a single run |
| `SKIPPED` | duplicate, unresolvable coordinates, or halted by `--stop-on-failure` |
| `ERROR` | a throw outside the pipeline's own taxonomy (bad argument) |

Batch-level `status` is `PLAN_PREVIEW`, `BATCH_COMPLETE`, or `EMPTY_SELECTION`, with a `summary`
rollup (`upgraded`, `alreadyUpgraded`, `needsParentPom`, `conflicts`, `failed`, `skipped`).

## Scope

**One environment per batch.** Concurrency is across *apps*, not environments. Because the lock is
`<app>::<env>`, the same app can be batched in `dev` and separately in `test` without contending —
but keep those separate runs so a single report always describes a single environment.

**No batch record is persisted.** Each app gets a durable tracked job; the batch itself is just the
fan-out. To follow progress afterwards, poll each returned `jobId` with `get_job_status`, or run
`reconcile` once to sweep them all.

## Tuning concurrency

`--concurrency` (default `batch.concurrency`, 3) bounds apps in flight. Each app is I/O-bound on
GitHub + Exchange, so raising it mostly trades GitHub secondary-rate-limit risk for wall time. Start
at 3–5; back off if you see 403 rate-limit warnings in the per-app reasons.
