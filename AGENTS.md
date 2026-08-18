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
| `batch_upgrade` | `skills/mule-upgrade-batch/scripts/batch_cli.js preview\|run …` (`run` needs `--confirm`) |
| `scan_vulnerabilities` | `skills/mule-upgrade-cve/scripts/cve_cli.js scan …` (read-only; no confirm gate) |
| `upgrade_parent_pom` | `skills/mule-upgrade-parent-pom/scripts/parent_pom_cli.js …` |
| *(no MCP tool)* | `skills/mule-upgrade-matrix-update/scripts/matrix_update_cli.js [targets\|diff\|scaffold]` — matrix maintenance is CLI-only and human-gated |

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
| Target a specific Java version | add `targetJava` (CLI `--target-java <n>`) | Omit for the default target. Unknown/uncurated targets are **refused**, never silently downgraded. |

## Guardrails

1. **Confirm before executing.** No `start_upgrade {dryRun:false}` without a preceding
   `PLAN_PREVIEW` shown to the user and an unambiguous confirmation. "Looks good but change X" is a
   loop-back, not a yes. The same gate applies — harder — to `batch_upgrade`: it writes nothing without
   `confirm:true`, and you must say how many PRs will be opened before asking. One accidental PR is a
   nuisance; twenty is an incident.
2. **Environment.** `environment` mirrors Mule's `-Denv`. The **engine** has no default (`requireEnv`
   throws without `--env`/`MULE_UPGRADE_ENV`) — a non-interactive caller (CI) must pass it explicitly.
   The **interactive conductor** (`mule-upgrade-agent`) treats it as optional intake and defaults to
   `dev` (or `MULE_UPGRADE_ENV` if set), always passing it through as `--env`; it surfaces `test`/`prod`
   as options and never silently picks a non-dev env. Same rule for the base branch: the conductor
   defaults to `develop` when the user doesn't specify one.
3. **Respect single-flight — which is scoped per app *and* environment.** The lock key is
   `<app>::<env>`, so upgrading `orders-api` in `dev` and in `test` at the same time is legitimate and
   both jobs run independently. A `CONFLICT` (`UPGRADE_IN_PROGRESS`) therefore means another job is
   already upgrading **this app in this same environment** — surface the existing `jobId`/`prUrl` and
   stop; never force a second concurrent job for the same app+env. Different apps never contend, and a
   shared parent/BOM locks per module (`<repo>::<pomPath>`) instead.
4. **Raise human-judgement items.** `connectorGaps` (parent/BOM-managed, unpinnable in the app pom)
   and `missingFromMatrix` are never auto-resolved — always surface them explicitly. Likewise every
   `processGuide` item whose status is `action` (a Process Guide requirement the upgrade will not fix,
   e.g. `error.muleMessage` in DataWeave). Never present a `manual` verdict as a pass — it means "not
   knowable from the repo", not "fine".
   **Batch:** when several apps share one parent pom they come back `NEEDS_PARENT_POM` and are held
   back on purpose. Do not use `includeParentPomRouted` to push them through — they would contend on the
   same `<repo>::<pomPath>` lock and all but one would `CONFLICT`. Upgrade that pom once via the chained
   flow, then re-run the batch.
   **CVE scan:** `action-required` findings are the human-judgement bucket — report them with the
   `minimumFix` the tool gives and never round it off. `no-fix-available` must never be presented as
   fixable; when it carries `fixedOnOtherBranchOnly` say so, because moving to that branch can be a
   downgrade.
5. **Never present a CVE scan as a clean bill of health.** `scan_vulnerabilities` reads only DECLARED
   coordinates — transitive dependencies are not resolved, because that needs a real Maven build. Always
   pass on the `limitations` array, and when there are zero findings say "no public advisory matched the
   declared coordinates" rather than "no vulnerabilities". A `complete:false` result is a partial scan:
   report the counts as a floor, not a total. Recommend a real SCA tool for full coverage.
6. **The matrix pin is authoritative.** Live Exchange/release-notes data is **advisory**. Never
   auto-adopt `latest` (it may be a breaking major); default to `min`. `latest`/`first-compatible`
   are explicit opt-ins the user must choose.
7. **Offer only CURATED Java targets, and never curate one yourself.** There is one matrix file per
   Java target (`compatibility-matrix.yaml` is the default; `compatibility-matrix-java<n>.yaml` for
   the rest). A target marked `status: uncurated` has placeholder versions, and the engine **refuses**
   to run against it rather than planning from another Java version's floors. Get the offerable list
   from `matrix_update_cli.js targets`; relay a refusal verbatim. Filling in versions to make an
   uncurated target work is the "invent versions" violation in a different costume.
8. **A matrix edit must say WHICH target it belongs in.** Java-neutral fields (connector coordinates,
   gating coordinates, scan patterns) are duplicated per target file, so `matrix_update` refuses to
   write when `--targets` is unanswered and more than one target exists — even under `--apply`. Ask
   the user: a **version** bump is usually target-specific, a **coordinate** change belongs in all
   targets. The parity test in `npm test` catches a wrong answer by name.
9. **Never leak secrets.** Do not print decrypted secure-props, tokens, or the config decryption key
   to stdout/transcript. `.env.example` ships with empty secret values.
10. **Notifications are opt-in, and the choice is made ONCE per session.** Configured Slack/Jira
    credentials are *capability, not consent*. Nothing is posted and no ticket is created unless the
    caller passes `notifyPrefs` (`{slack:true}` and/or `{jira:"comment"|"create"}`); omitted or
    malformed → silent. An interactive agent asks once, up front — Jira as an either/or (*update this
    ticket* vs *create one for me* vs *skip*) and Slack as a plain yes/no — then **obeys that answer for
    the whole session**: never re-asking, and applying it to every job it starts afterwards, including
    parent-pom/BOM upgrades and chained steps. "Slack off" means off by every route, so `scan_notify` is
    off too (use `scan_fleet`). The choice is stamped on each job record at creation, so later
    transitions discovered by `reconcile` or a status refresh honor the same answer — and it cannot be
    retro-applied to a job that was already created.
11. **Non-fatal means non-fatal.** Slack/Jira notifications, the deployed-state check, Anypoint
    deploy verification, and the OSV vulnerability lookup never fail the pipeline — a skipped check is
    reported *with its reason*.
12. **Stale-plan safety.** Pass `headSha` from assess time; the PR step aborts (`STALE_PLAN` →
    `FAILED_ASSESS`) if the branch moved, rather than committing against a changed tree.
13. **Shell safety (for CLI/local mode).** Invoke `git`/`gh` via `execFile`-style calls, never a
    shell string — inputs are arguments, not interpolated into a command line.
14. **Status may already be fresh — never claim it isn't.** When `.cursor/hooks.json` is active, a
    debounced `reconcile` sweep runs at `sessionStart` and before each prompt, so the job store can
    already reflect a merge/CI/deploy that happened while nothing was running. Read `get_job_status`
    and report what it says. Do not tell the user status "may be stale" or that they need a webhook, and
    do not run a redundant `reconcile` just to be sure — the debounce exists to stop exactly that. If a
    hook sweep timed out or errored it is recorded in `~/.mule-upgrade/hooks.log`; that log is the only
    place to make a staleness claim from.

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
- (batch only) `BATCH_COMPLETE` / `EMPTY_SELECTION` at the batch level; per app, the statuses above plus
  `NEEDS_PARENT_POM` (held back: gaps live in a shared parent/BOM pom), `SKIPPED` (duplicate,
  unresolvable coordinates, or stopped early) and `ERROR` (a throw outside the pipeline's taxonomy).

## Environment (all optional except where a flow needs it)

- **GitHub:** `GITHUB_TOKEN` (api mode); `gh` auth (local mode).
- **Anypoint (deployed-state + deploy verify):** `ANYPOINT_CLIENT_ID`, `ANYPOINT_CLIENT_SECRET`,
  `ANYPOINT_ORG_ID`, optional `ANYPOINT_BASE_URL` / `ANYPOINT_TOKEN_PATH` / `ANYPOINT_HEALTHY_STATUSES`.
- **Slack / Jira:** `SLACK_WEBHOOK_URL`, `SLACK_CHANNEL`; `JIRA_BASE_URL`, `JIRA_EMAIL`,
  `JIRA_API_TOKEN`, `JIRA_AUTO_CREATE`, `JIRA_PROJECT_KEY`, `JIRA_ISSUE_TYPE`.
- **Job store / env:** `MULE_UPGRADE_HOME` (default `~/.mule-upgrade`), `MULE_UPGRADE_ENV`.
- **Server:** `MCP_BEARER_TOKEN` (auth), webhook HMAC secret.
- **Cursor hooks:** `MULE_UPGRADE_HOOKS=off` disables the auto-refresh hooks for a session (config:
  `hooks.*`). Nothing else is needed — hooks are the no-endpoint alternative to the inbound webhook.

## Where things live

- `skills/mule-upgrade-agent/` — the Mule Upgrade Assistant (conversation layer). `SKILL.md` holds the
  capability menu, router and intake rules; each secondary flow lives in `references/flows/*.md` and is
  read only when routed to.
- `skills/mule-upgrade/` — the orchestrator (`start` + `poll`); `runUpgrade` is the pipeline.
- `skills/mule-upgrade-assess/` — assessment + connector version resolution + deployed-state.
- `skills/mule-upgrade-assess/references/` — the compatibility matrices, **one file per Java target**
  (`compatibility-matrix.yaml` is the default). `MATRIX.md` is the operator's guide: delivery, the
  authority model, which fields must stay identical across targets, and how to add a target.
  `scripts/lib/matrix_targets.js` is the registry (discovery, curation gate, parity, diff, scaffold).
- `skills/mule-upgrade-apply/`, `mule-upgrade-pr/`, `mule-upgrade-parent-pom/`, `mule-upgrade-job/`,
  `mule-upgrade-scan/` — the worker skills.
- `skills/mule-upgrade-batch/` — fan-out over `runUpgrade`: N apps, one env, bounded pool. A scheduler
  only; it reimplements no pipeline stage.
- `server/` — hosted MCP + REST server; `server/schemas/*.json` are the single source of truth for
  every tool's input contract (MCP `tools/list`, the REST facade, and request validation all read them).
- `.cursor/hooks.json` + `.cursor/hooks/refresh-jobs.mjs` — auto-refresh hooks; the gating policy they
  depend on is `skills/mule-upgrade-job/scripts/lib/hook_refresh.js`.
- `tests/` — `node --test` suites; run `npm test` from the repo root.
