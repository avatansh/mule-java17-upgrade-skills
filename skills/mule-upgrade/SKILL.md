---
name: mule-upgrade
description: >-
  Low-level, NON-INTERACTIVE CLI pipeline that executes a single MuleSoft Java-17 upgrade end to end
  (assess → apply file rewrites → commit → open a pull request → track the job, then poll the
  merge/CI/deploy tail): ONE shell command, no questions, no confirmation prompt. It is normally
  invoked BY the `mule-upgrade-agent` conductor rather than chosen directly. Use this ONLY when the
  caller (a script, a CI job, or a user who explicitly asks for the raw one-shot command) already has
  EVERY input and wants no prompts — e.g. "run the upgrade.js pipeline for <app> non-interactively".
  For any human asking to "upgrade a mule app to Java 17" (or similar), use `mule-upgrade-agent`
  instead — it adds the assess / preview / confirm loop this skill deliberately omits. Composes
  mule-upgrade-assess, mule-upgrade-apply, mule-upgrade-pr, and mule-upgrade-job.
---

# mule-upgrade (orchestrator)

> **⛔ Actually run this — do not simulate it.** The pipeline is engine code. **Run
> `node skills/mule-upgrade/scripts/upgrade.js start …` via the shell and report its JSON result.**
> Never fabricate a `PLAN_PREVIEW`, hand-write file edits, guess versions, or `curl` GitHub. Always
> `--dry-run` first, show the real preview, get an explicit yes, then re-run without `--dry-run`. On
> any error (401, `STALE_PLAN`, `CONFLICT`, bad `--coords` JSON), report it verbatim and stop.
>
> **Windows quoting:** prefer discrete flags `--owner <o> --repo-name <r> --branch <b>` over
> `--coords '{…}'` — `cmd.exe` strips the quotes and you get `Unexpected token … is not valid JSON`.

Reproduces the Platform Lifecycle Orchestrator's `start_upgrade` pipeline as a single
synchronous skill run. The Mule app split the work across an HTTP 202 response plus an
`<async>` worker because it had to survive across inbound webhook callbacks. A skill
invocation **is** the worker, so the pipeline runs start-to-finish in one call and stops
at `PR_OPEN`; the deploy tail is handled by polling (`poll` subcommand / reconcile).

## Pipeline (port of `pf-start-upgrade`)

```
pre-flight assess ──► topology routing (app-pom | parent-pom | none)
     │                     │                    │              └─► ALREADY_UPGRADED (no lock, no job)
     │                     │                    └─► dispatch mule-upgrade-parent-pom job (see below)
     ▼ app-pom (fileEdits exist)
acquire lock ──► CONFLICT (UPGRADE_IN_PROGRESS) if another job holds the app
     │
     ▼ job PROCESSING
[optional] auto-create Jira ticket ──► COMMITTING
     ▼
apply transforms (SKILL 2) ──► commit + open PR (SKILL 3) ──► COMMITTED ──► PR_OPEN
     ▼
notify (Slack + Jira, non-fatal) ──► record branchName/commitSha/prNumber/prUrl + branch index
```

### Topology routing (Tier 2c)

The pre-flight assessment yields a `ChangePlan` with both `fileEdits` (what the app's OWN pom can
change) and `connectorGaps` (connectors the app **inherits** from a parent/BOM below the Java-17
matrix — the app pom cannot fix those). The orchestrator routes on that:

| Route | Condition | Action |
|-------|-----------|--------|
| **app-pom** | `fileEdits.length > 0` | the normal pipeline above (apply → commit → PR). Takes precedence — inherited gaps ride along as warnings. |
| **parent-pom** | no `fileEdits`, but `connectorGaps.length > 0` | **dispatch the `mule-upgrade-parent-pom` job** (`runParentPomJob`) so the shared parent/BOM is bumped. The two skills call each other. |
| **none** | no `fileEdits` and no `connectorGaps` | `ALREADY_UPGRADED` (no lock, no job). |

This fixes the previous blind spot where an app that was only blocked on an **inherited** connector
was wrongly reported `ALREADY_UPGRADED` (its own pom is clean, but the repo isn't Java-17-ready until
the BOM moves). The parent-pom result is returned with `routedVia:"parent-pom"`, `topology`,
`routeReason`, and merged `warnings`. Pass `routeParentPom:false` to force the plain app pipeline
(which then no-ops to `ALREADY_UPGRADED`); `--dry-run` shows `route.strategy` without dispatching.

On **any** stage error the job goes terminal and the lock is released, matching the Mule
async error-handler taxonomy:

| Error signal                                             | Terminal status |
|----------------------------------------------------------|-----------------|
| `code=VALIDATION` / `STALE_PLAN` / `APP_NOT_FOUND` / HTTP 404 | `FAILED_ASSESS` |
| anything else (e.g. GitHub 5xx, git push failure)        | `FAILED_COMMIT` |

## Usage

### Start an upgrade

```bash
# API mode (GitHub REST, no local clone needed for commit/PR)
# Prefer discrete flags over --coords '{…}' (Windows cmd.exe corrupts the JSON quoting):
node skills/mule-upgrade/scripts/upgrade.js start \
  --app orders-api --env dev --mode api \
  --owner acme --repo-name orders-api --branch main \
  --head-sha <sha> --jira ORD-42

# local mode (git checkout -b / push / gh pr create)
node skills/mule-upgrade/scripts/upgrade.js start \
  --app orders-api --env dev --mode local \
  --repo /path/to/clone --repo-root /path/to/clone \
  --coords '{"owner":"acme","repo":"orders-api","defaultBranch":"main"}'
```

Flags: `--app` (required), `--env <dev|local|prod>` (**required** — or set `MULE_UPGRADE_ENV`; no
default, mirrors Mule's `-Denv`), `--mode api|local` (default `api`),
`--coords <json>` (`{owner,repo,defaultBranch}`), `--repo` (local clone for assess/apply;
required unless mode=api has a pre-computed assessment), `--repo-root` (commit root for
local mode; defaults to `--repo`), `--head-sha` (stale-plan anchor), `--jira <ticket>`,
`--jira-base-url <url>`, `--app-path`, `--no-fetch` (skip the live matrix fetch + connector
enrichment, use bundled YAML).

**Exit codes:** `0` ok (incl. `ALREADY_UPGRADED` / `PR_OPEN`), `4` CONFLICT, `5` FAILED_*,
`2` usage, `1` other.

### Poll the deploy tail

Polling only — a skill cannot host a webhook listener, so merge/CI/deploy detection is done
by sweeping jobs and querying `gh` + Anypoint. Advances `PR_OPEN → DEPLOYING → DEPLOYED`
(or `MUNIT_FAILED` / `DEP_GUARD_FAILED` / `FAILED_DEPLOY`).

```bash
# one sweep
node skills/mule-upgrade/scripts/upgrade.js poll --stale-seconds 0

# keep polling (dev convenience; production should use the /loop skill or OS cron)
node skills/mule-upgrade/scripts/upgrade.js poll --watch --interval 30
```

## Outcome objects

`start` prints one JSON result:

- `ALREADY_UPGRADED` — assessment found no edits; no job, no lock.
- `PR_OPEN` — `{jobId, branchName, commitSha, prNumber, prUrl, jiraTicketId, warnings, nextPollSeconds:0}`.
- `CONFLICT` — `{code:"UPGRADE_IN_PROGRESS", existingJobId, prUrl}`.
- `FAILED_ASSESS` / `FAILED_COMMIT` — `{jobId, error}`; lock already released.

## Configuration (env, all optional)

- **GitHub:** `GITHUB_TOKEN` (API mode); `gh` auth (local mode).
- **Slack:** `SLACK_WEBHOOK_URL`, `SLACK_CHANNEL` — PR-ready / failure notices. Absent → skipped.
- **Jira:** `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`; auto-create gated by
  `JIRA_AUTO_CREATE=true` + `JIRA_PROJECT_KEY` (+ optional `JIRA_ISSUE_TYPE`, default `Task`).
- **Anypoint (deploy verify):** `ANYPOINT_CLIENT_ID`, `ANYPOINT_CLIENT_SECRET`, `ANYPOINT_ORG_ID`,
  optional `ANYPOINT_BASE_URL`, `ANYPOINT_TOKEN_PATH`, `ANYPOINT_HEALTHY_STATUSES`.
- **Job store:** `MULE_UPGRADE_HOME` (default `~/.mule-upgrade`).

All notifications and Anypoint verification are **non-fatal** — an outage or missing
credential never fails the pipeline; it is logged and skipped (matches the `<try>`-wrapped
notify sub-flows and the on-error-continue in `pf-verify-deployment`).

## Improvements over the Mule app

- The async worker + inbound HMAC webhook model collapses into one synchronous run plus a
  polling tail — no server, no callback endpoints, no idempotency dance for the happy path.
- Assessment reads a full local clone (custom Java, DW POJOs, matrix `java:` blocks) instead
  of paged GitHub reads, and every edit/warning is explained in prose.
- Fully injectable `deps` ({assess, applyChangePlan, commitApi, commitLocal, slackNotify,
  jiraComment, jiraCreateIssue}) make the whole pipeline unit-testable with zero network.

## Verification

`node --test tests/orchestrate.test.js` covers the ALREADY_UPGRADED short-circuit, the happy
PR_OPEN path (job persisted + branch indexed + lock retained), CONFLICT on a held lock, and
the FAILED_COMMIT / FAILED_ASSESS taxonomy with lock release.
