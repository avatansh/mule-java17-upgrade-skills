# AGENTS.md — operating guide for agents driving this repo

This repo automates the MuleSoft **Java-8/11 → Java-17 (runtime 4.9.18)** upgrade as a suite of
composable skills plus a hosted MCP + REST server. This file is the contract for any agent
(Claude Code in an IDE, Agentforce, MuleSoft Vibes, or a CI runner) that drives those tools. It
defines the safe interaction loop, guardrails, and intent→tool routing.

For a hands-on human walkthrough use the **`mule-upgrade-agent`** skill — it implements the
conversational state machine described below.

## ⛔ Execution contract: act only through this suite's own code

You perform actions **only** by invoking this suite's tools — the MCP tools (when the server is
registered) or the equivalent `node …/scripts/*.js` CLIs (skills-only install). You may **never**:

- hand-write, hand-edit, or **simulate** a pom.xml / mule-artifact.json / CI workflow / ChangePlan /
  PLAN_PREVIEW — the engine produces these; you report what it returns;
- invent, guess, or "reason out" connector / runtime / plugin versions — the compatibility matrix
  (bundled + live-fetched by the engine) is the sole authority;
- call GitHub yourself (`curl`, `gh api`, `web_fetch` a repo) or ask the user to paste a pom or a
  token in chat — the engine reads the repo (GitHub REST in `--mode api`; a local clone in `--mode
  local`).

**A command error is a valid final result: report it verbatim and stop — do not route around it.**
Common ones: `401: Bad credentials` (set `GITHUB_TOKEN` scope `repo`, or `gh auth login` + `--mode
local`), `Unexpected token … is not valid JSON` on `--coords` (Windows `cmd.exe` quoting — use the
discrete `--owner/--repo-name/--branch` flags), `ENOENT .a4drules` / `Cannot find module
'../../lib_shared/…'` (symlink the skill folders per SETUP-VIBES Option A, don't copy them).

### Skills-only CLI mapping (when no MCP server is registered)

Each MCP tool has an identical-engine CLI behind it (paths relative to suite root; under a Vibes
symlink install, `.a4drules/skills/<skill>/scripts/<file>.js`):

| MCP tool | CLI |
|----------|-----|
| `assess_app` / `resolve_versions` | `skills/mule-upgrade-assess/scripts/assess.js` (`connectorChoices[]` is the version menu) |
| `start_upgrade {dryRun:true/false}` | `skills/mule-upgrade/scripts/upgrade.js start … [--dry-run]` |
| `get_job_status` / `reapply_job` / `delete_job` | `skills/mule-upgrade-job/scripts/job.js status\|reapply\|delete …` |
| `reconcile` | `skills/mule-upgrade/scripts/upgrade.js poll …` |
| `rollback` | `skills/mule-upgrade-pr/scripts/rollback.js …` |
| `scan_fleet` / `scan_notify` | `skills/mule-upgrade-scan/scripts/scan.js` / `scan_notify.js` |
| `upgrade_parent_pom` | `skills/mule-upgrade-parent-pom/scripts/parent_pom_cli.js …` |

## The prime directive: preview before you write

**Nothing may be written to a repo, the job store, or GitHub until the user has seen a dry-run
plan and explicitly confirmed.** Writing means: acquiring the app lock, creating a job, applying a
file edit, or opening a PR.

The mechanism is the `dryRun` flag on **`start_upgrade`**:

- `dryRun: true` → runs assessment, builds the full plan (fileEdits, connectorChoices, warnings,
  deployed-state), returns **`PLAN_PREVIEW`** (or `ALREADY_UPGRADED` when there is nothing to do),
  and writes **nothing** — no lock, no job, no edit, no PR.
- `dryRun: false` (default) → executes the pipeline and opens the PR.

Always call `dryRun:true` first, show the preview, get an explicit yes, then re-call with the
**identical arguments** and `dryRun:false`.

## Interaction loop (intent → tool)

| The user wants to… | Call | Notes |
|--------------------|------|-------|
| Assess readiness / see the change plan | `assess_app` | Read-only. Start here. |
| Compare connector versions | `resolve_versions` | Returns the per-connector menu only. |
| Preview the plan without writing | `start_upgrade` `{dryRun:true}` | Returns `PLAN_PREVIEW`. |
| Execute the upgrade + open a PR | `start_upgrade` `{dryRun:false}` | Only after a dry run + explicit yes. |
| Check an in-flight job | `get_job_status` | Use `nextPollSeconds` for cadence. |
| Advance stale jobs (merge/CI/deploy) | `reconcile` | Polling tail; safe to run on a timer. |
| Undo a bad upgrade | `rollback` | Opens a revert PR for the job. |
| Find fleet apps on old Mule/Java | `scan_fleet` | Feeds candidates into `start_upgrade`. |
| Proactive fleet alert on change | `scan_notify` | De-duped Slack push; run on a schedule. |
| Retry a failed job | `reapply_job` | New jobId from an existing job's coords. |
| Clean up a job | `delete_job` | Removes record, clears index, releases lock. |
| Upgrade a shared parent/BOM pom | `upgrade_parent_pom` | `NO_CHANGE` when already at matrix. |

## Guardrails

1. **Confirm before executing.** No `start_upgrade {dryRun:false}` without a preceding
   `PLAN_PREVIEW` shown to the user and an unambiguous confirmation. "Looks good but change X" is a
   loop-back, not a yes.
2. **Environment is required.** `environment` mirrors Mule's `-Denv`; there is no default. Ask, or
   read `MULE_UPGRADE_ENV`. Never guess.
3. **Respect single-flight.** A `CONFLICT` (`UPGRADE_IN_PROGRESS`) means another job holds the app
   lock. Surface the existing `jobId`/`prUrl` and stop — never force a second concurrent job.
4. **Raise human-judgement items.** `connectorGaps` (parent/BOM-managed, unpinnable in the app pom)
   and `missingFromMatrix` are never auto-resolved — always surface them explicitly.
5. **The matrix pin is authoritative.** Live Exchange/release-notes data is **advisory**. Never
   auto-adopt `latest` (it may be a breaking major); default to `min`. `latest`/`first-compatible`
   are explicit opt-ins the user must choose.
6. **Never leak secrets.** Do not print decrypted secure-props, tokens, or the config decryption key
   to stdout/transcript. `.env.example` ships with empty secret values.
7. **Non-fatal means non-fatal.** Slack/Jira notifications, the deployed-state check, and Anypoint
   deploy verification never fail the pipeline — a skipped check is reported *with its reason*.
8. **Stale-plan safety.** Pass `headSha` from assess time; the PR step aborts (`STALE_PLAN` →
   `FAILED_ASSESS`) if the branch moved, rather than committing against a changed tree.
9. **Shell safety (for CLI/local mode).** Invoke `git`/`gh` via `execFile`-style calls, never a
   shell string — inputs are arguments, not interpolated into a command line.

## Outcome statuses to handle

- `ASSESSED` — assessment done (assess_app).
- `RESOLVED` — connector menu returned (resolve_versions).
- `PLAN_PREVIEW` — dry-run plan; nothing written; awaiting confirmation.
- `ALREADY_UPGRADED` — no edits needed; no job, no lock.
- `PR_OPEN` — success: `{jobId, branchName, commitSha, prNumber, prUrl}`; poll from here.
- `CONFLICT` — an upgrade is already in progress; `{existingJobId, prUrl}`.
- `FAILED_ASSESS` / `FAILED_COMMIT` — terminal; lock already released; `{jobId, error}`.
- (job tail) `DEPLOYING` / `DEPLOYED` / `MUNIT_FAILED` / `DEP_GUARD_FAILED` / `FAILED_DEPLOY` /
  `FAILED_INTERRUPTED`.

## Environment (all optional except where a flow needs it)

- **GitHub:** `GITHUB_TOKEN` (api mode); `gh` auth (local mode).
- **Anypoint (deployed-state + deploy verify):** `ANYPOINT_CLIENT_ID`, `ANYPOINT_CLIENT_SECRET`,
  `ANYPOINT_ORG_ID`, optional `ANYPOINT_BASE_URL` / `ANYPOINT_TOKEN_PATH` / `ANYPOINT_HEALTHY_STATUSES`.
- **Slack / Jira:** `SLACK_WEBHOOK_URL`, `SLACK_CHANNEL`; `JIRA_BASE_URL`, `JIRA_EMAIL`,
  `JIRA_API_TOKEN`, `JIRA_AUTO_CREATE`, `JIRA_PROJECT_KEY`, `JIRA_ISSUE_TYPE`.
- **Job store / env:** `MULE_UPGRADE_HOME` (default `~/.mule-upgrade`), `MULE_UPGRADE_ENV`.
- **Server:** `MCP_BEARER_TOKEN` (auth), webhook HMAC secret.

## Where things live

- `skills/mule-upgrade-agent/` — this interactive conductor (conversation layer).
- `skills/mule-upgrade/` — the orchestrator (`start` + `poll`); `runUpgrade` is the pipeline.
- `skills/mule-upgrade-assess/` — assessment + connector version resolution + deployed-state.
- `skills/mule-upgrade-apply/`, `mule-upgrade-pr/`, `mule-upgrade-parent-pom/`, `mule-upgrade-job/`,
  `mule-upgrade-scan/` — the worker skills.
- `server/` — hosted MCP + REST server; `server/schemas/*.json` are the single source of truth for
  every tool's input contract (MCP `tools/list`, the REST facade, and request validation all read them).
- `tests/` — `node --test` suites; run `npm test` from the repo root.
