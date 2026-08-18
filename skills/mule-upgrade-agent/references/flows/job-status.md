# Flow: check an in-flight upgrade (and roll one back)

Read this when the user asks about the status of an upgrade, a PR, a deployment, or wants to undo
one.

## Intake for this flow — one question

Just the **jobId**. If they don't have it to hand, offer the most recent job rather than making them
find it. Nothing else is needed: no source, no branch, no env, no notify.

## Status may already be fresh — never claim it isn't

`get_job_status` **auto-refreshes**: it polls the live PR state and CI checks over the GitHub token
and verifies the deploy on Anypoint before returning. When Cursor hooks are active, a reconcile sweep
also runs on session start and before a prompt. So a plain "check status now" already reflects
reality — read the result and report it. Never suggest the user set up a webhook to get fresher data.

```bash
node skills/mule-upgrade-job/scripts/job.js status --job <jobId> --refresh
```

MCP equivalent: `get_job_status` (refreshes by default; `refresh:false` for a pure cache read).

## Reading the result

Surface the returned `checks[]` sub-status (e.g. `test: passed`, `dependency-guard: passed`) and any
`error`. `nextPollSeconds` sets the cadence for repeat checks.

**A passing MUnit stays `PR_OPEN`** (shown as the "MUnit tests passed" sub-stage). The status only
advances to `DEPLOYING` when the PR is **merged**, then to `DEPLOYED` after Anypoint verification.
Explain that rather than letting the user read `PR_OPEN` as "nothing happened".

**Live Runtime Manager deploy state is included.** When Anypoint is configured, the auto-refresh also
reaches out to Runtime Manager and attaches a `deployedState` block (`status`, `runtimeVersion`,
`muleVersion`, `javaVersion`, `environment`, `matchesTarget`). Report it directly; you do **not** need
a separate platform tool to answer "is it deployed?". This closes the gap for apps whose deploy runs
**out-of-band** — a separate GitHub Action that never posts a cd-result callback and isn't a PR check.
Once the PR checks are green you can still see what is actually running.

**Caveat worth stating every time:** a running app can PREDATE the open PR, so `matchesTarget:true`
means "already running the target runtime/Java" — it does **not** by itself prove the PR's specific
changes are live. The enum still advances to `DEPLOYED` only via the merge → `DEPLOYING` →
Anypoint-verify path (or a cd-result webhook).

**A PR manually closed without merging is detected.** The auto-refresh polls the PR even for jobs
parked at `MUNIT_FAILED`/`DEP_GUARD_FAILED`, so a closed PR moves the job to **`CLOSED`** ("closed
without merging; lock released"). You do NOT need to `delete` a job to reflect a manual close — just
`get_job_status` (or `reconcile`). Only `delete` when the user actually wants to purge the record.

**Notifications fire on state changes only if the session opted in.** A transition surfaced during
auto-refresh pushes the alert without waiting for you to ask again, because the choice is persisted on
the job. It's exactly-once per status, and credential-gated on top. A run that opted out stays silent
everywhere — don't promise alerts the user declined.

## Advancing several stale jobs

```bash
node skills/mule-upgrade/scripts/upgrade.js poll --stale-seconds 0
```

MCP equivalent: `reconcile` (defaults to poll-now).

## When it went wrong

On `FAILED_DEPLOY` / `MUNIT_FAILED` / `DEP_GUARD_FAILED`, report the reason from the output and offer
a rollback. Do not roll back without an explicit yes — it is a write.

```bash
node skills/mule-upgrade-pr/scripts/rollback.js …      # see the mule-upgrade-pr skill
node skills/mule-upgrade-job/scripts/job.js reapply --job <id>
node skills/mule-upgrade-job/scripts/job.js delete  --job <id>
```

MCP equivalents: `rollback`, `reapply_job`, `delete_job`.
