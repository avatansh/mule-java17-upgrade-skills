---
name: mule-upgrade-job
description: >-
  Track a MuleSoft Java-17 upgrade as a stateful job across its whole lifecycle. Provides a local
  JSON job store (mirroring the Mule app's Object Store partitions), the job state machine
  (PROCESSING → PR_OPEN → DEPLOYING → DEPLOYED / failed), single-flight per-app locking, a
  branch→job index, idempotency markers, a buildJobStatus response builder (message +
  nextPollSeconds + optional PR/Jira/error/dep-guard fields), and a polling-based reconcile sweep
  that advances or fails stale jobs. Use it to create/read/update a job, get a pollable status, or
  run reconcile. Triggers on "track this upgrade as a job", "what's the status of upgrade job X",
  "reconcile stale mule upgrade jobs", "release the upgrade lock for app Y".
---

# mule-upgrade-job

The stateful backbone of the upgrade suite — a dependency-free JSON reimplementation of the Mule
app's Object Store + `dwl::jobStatus` + `pf-reconcile` + the reapply/delete admin actions. It lets
the many separate skill invocations that make up one upgrade share durable state.

## Why this exists

The Mule app needed async job-tracking because a single upgrade spans multiple HTTP round-trips
(GitHub, CI, Anypoint) that can't complete in one request. The skill suite has the same problem:
assess, apply, PR, and the deploy-monitoring tail are separate runs. This skill persists the job so
each run picks up where the last left off, and so a polling reconcile can finish jobs whose external
events (merge, deploy) happened while no skill was running.

## The store (`~/.mule-upgrade/`, override with `MULE_UPGRADE_HOME`)

Four partitions mirror the Mule app's Object Stores 1:1:

| Object Store | JSON mirror | Key |
|---|---|---|
| `jobStore` | `jobs/<jobId>.json` | `jobId` (`job-<uuid>`) |
| `locksStore` | `locks/<enc(lock::app)>.json` | per-app single-flight; value = jobId |
| `indexStore` | `index/<enc(branch::name)>.json` | branch → jobId correlation |
| `idempotencyStore` | `idem/<enc(key)>.json` | poll/callback/notify dedup markers |

Keys that contain `:` or `/` (illegal in Windows filenames) are encoded to a safe stem + short hash.
Writes are atomic (temp file + rename); locks and idempotency markers use exclusive create (`wx`) so
contention is detected without a read-modify-write race.

## Job record & state machine

Record shape (identical to `post-jobs.xml`):
`{jobId, status, appName, environment, jiraTicketId, approvedChangePlan, coords, changePlan,
createdAt, updatedAt, prUrl, branchName, completedAt, error}` (plus `prNumber`, `munit`, `depGuard`
as the lifecycle adds them).

States: `PROCESSING, ASSESSING, COMMITTING, COMMITTED, PR_OPEN, NO_CHANGE, MUNIT_FAILED,
DEP_GUARD_FAILED, DEPLOYING, DEPLOYED, CLOSED, FAILED_ASSESS, FAILED_COMMIT, FAILED_CI, FAILED_DEPLOY,
FAILED_INTERRUPTED`. Terminal states (`DEPLOYED, NO_CHANGE, CLOSED, FAILED_*`) auto-stamp
`completedAt`.

## How to run

```bash
cd skills/mule-upgrade-job/scripts

# Create a job (acquires the per-app lock; exits with a CONFLICT if the app is already in flight):
node job.js create --app my-app --env dev --jira J1U-123 --coords '{"owner":"o","repo":"r"}'

# Pollable status (port of buildJobStatus): message + nextPollSeconds + optional fields:
node job.js status --job job-<uuid> --jira-base-url https://acme.atlassian.net

# Advance the state machine (merge status + updatedAt + arbitrary fields):
node job.js set --job job-<uuid> --status PR_OPEN --field prNumber=42 --field prUrl=https://github.com/o/r/pull/42 --field branchName=migrate/my-app

# Inspect / list:
node job.js get  --job job-<uuid>
node job.js list

# Locks:
node job.js lock   --app my-app     # who holds it
node job.js unlock --app my-app     # idempotent release

# Reconcile sweep (advances/fails stale jobs by polling — see below):
node job.js reconcile --stale-seconds 900

# Admin:
node job.js reapply --job job-<uuid>   # reseed a fresh PROCESSING job from a prior job's coords
node job.js delete  --job job-<uuid>   # remove record + clear branch index + release its own lock
```

## Status — `buildJobStatus` (status.js)

Ported 1:1 from `dwl::jobStatus`: a `statusMeta` table maps each status to a human message and
`nextPollSeconds` (0 = terminal, stop polling; 5/10 = active; 300 = paused for human action on
MUNIT_FAILED / DEP_GUARD_FAILED). Optional fields (`branchName`, `prUrl`, `prNumber`, `jiraTicketId`,
`jiraUrl`, `completedAt`, `error`, `report`) appear only when present. The `PR_OPEN` +
`munit.result === "passed"` sub-stage is surfaced through an enriched `message` without changing the
status enum, and `DEP_GUARD_FAILED` surfaces `depGuard.report[]` as `report` so callers see exactly
what to pin.

## Reconcile — polling, not webhooks (reconcile.js)

The Mule app used inbound HMAC webhooks + a scheduler. A skill can't host a listener, so reconcile
**polls** external state for every stale job (`updatedAt` older than `--stale-seconds`, default 900):

- **stale `PR_OPEN`** → poll the PR (`gh pr view … --json state,mergedAt` by default):
  merged → `DEPLOYING` (+ notify hook); closed-unmerged → `CLOSED` + release the app lock; still
  open → left untouched.
- **stale `DEPLOYING`** → verify the deployment (injected verifier; default unknown): healthy →
  `DEPLOYED`; unhealthy → `FAILED_DEPLOY`.
- **stale early-stage** (`PROCESSING/ASSESSING/COMMITTING/COMMITTED`) → `FAILED_INTERRUPTED` +
  release the app lock (orphaned by a crash/restart — mirrors the Mule reconciler's interrupted
  branch).

The PR poller, deploy verifier, and notifier are injectable, so the sweep is pure and unit-tested.
Run it on demand, or on a timer via the `/loop` skill or OS cron for continuous, server-free
lifecycle tracking.

## Improvements over the Mule app

- **Zero infrastructure** — no Object Store, no webhook endpoint, no HMAC secret; just JSON files.
- **Crash-safe by construction** — atomic writes and exclusive-create locks; `delete` never steals a
  lock it doesn't own (checks `lockHolder === jobId` first).
- **Deterministic & testable** — `runReconcile` takes `nowMs` and injectable pollers, so the entire
  stale-sweep logic is covered without wall-clock or network.

## Verification

`tests/job.test.js` ports all 8 `pf-get-job-status-suite.xml` cases for `buildJobStatus`, plus
store behaviour (create + single-flight CONFLICT, setStatus terminal `completedAt`, branch index,
idempotency first-wins, delete clears index + releases only its own lock, reapply reseed) and every
reconcile transition. Run `npm test` from the repo root (51 tests across all skills).
