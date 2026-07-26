---
name: mule-upgrade
description: >-
  End-to-end orchestrator that upgrades a MuleSoft app to Java 17 (runtime 4.9.18):
  assess → apply file rewrites → commit → open a pull request → track the job, then
  poll the merge/CI/deploy tail to completion. Use this when the user says things like
  "upgrade <app> to Java 17", "run the Java 17 migration for <app>", "migrate this Mule
  app to the 4.9 runtime and open a PR", or "start the platform lifecycle upgrade". This
  is the top-level skill; it composes mule-upgrade-assess, mule-upgrade-apply,
  mule-upgrade-pr, and mule-upgrade-job.
---

# mule-upgrade (orchestrator)

Reproduces the Platform Lifecycle Orchestrator's `start_upgrade` pipeline as a single
synchronous skill run. The Mule app split the work across an HTTP 202 response plus an
`<async>` worker because it had to survive across inbound webhook callbacks. A skill
invocation **is** the worker, so the pipeline runs start-to-finish in one call and stops
at `PR_OPEN`; the deploy tail is handled by polling (`poll` subcommand / reconcile).

## Pipeline (port of `pf-start-upgrade`)

```
pre-flight assess ──► ALREADY_UPGRADED (no fileEdits) / APP_NOT_FOUND short-circuit
     │ edits exist
     ▼
acquire lock ──► CONFLICT (UPGRADE_IN_PROGRESS) if another job holds the app
     │
     ▼ job PROCESSING
[optional] auto-create Jira ticket ──► COMMITTING
     ▼
apply transforms (SKILL 2) ──► commit + open PR (SKILL 3) ──► COMMITTED ──► PR_OPEN
     ▼
notify (Slack + Jira, non-fatal) ──► record branchName/commitSha/prNumber/prUrl + branch index
```

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
node skills/mule-upgrade/scripts/upgrade.js start \
  --app orders-api --env dev --mode api \
  --coords '{"owner":"acme","repo":"orders-api","defaultBranch":"main"}' \
  --repo /path/to/local/clone \        # still used by assess/apply to read the tree
  --head-sha <sha> --jira ORD-42

# local mode (git checkout -b / push / gh pr create)
node skills/mule-upgrade/scripts/upgrade.js start \
  --app orders-api --env dev --mode local \
  --repo /path/to/clone --repo-root /path/to/clone \
  --coords '{"owner":"acme","repo":"orders-api","defaultBranch":"main"}'
```

Flags: `--app` (required), `--env` (default `dev`), `--mode api|local` (default `api`),
`--coords <json>` (`{owner,repo,defaultBranch}`), `--repo` (local clone for assess/apply;
required unless mode=api has a pre-computed assessment), `--repo-root` (commit root for
local mode; defaults to `--repo`), `--head-sha` (stale-plan anchor), `--jira <ticket>`,
`--jira-base-url <url>`, `--app-path`, `--release-notes-url`, `--no-fetch` (skip dynamic
matrix fetch, use bundled YAML).

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
