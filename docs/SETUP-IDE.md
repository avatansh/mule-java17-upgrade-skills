# Setup — Skills in your IDE (Claude Code / local)

Run the Java-17 upgrade suite as **Claude Code skills** against a local clone or the GitHub
API, from any IDE that runs Claude Code. No server, no hosting — you talk to Claude, it invokes
the skills. This is the workflow for hands-on, interactive upgrades: several apps can be in flight at
once, and the same app can even be upgraded in two environments concurrently (the single-flight lock
is keyed per app **and** environment).

> For remote/headless access (Agentforce, another agent over the network), see
> [SETUP-AGENTFORCE.md](./SETUP-AGENTFORCE.md) instead.

---

## 0. Where do I run these commands? (and do I need the Salesforce CLI?)

- **Run everything in a plain terminal on your own machine, from the root of the cloned
  `mule-java17-upgrade-skills` repo** — the same place you run `npm test`. macOS/Linux: Terminal;
  Windows: Git Bash, PowerShell, or CMD (the examples use bash-style paths — on PowerShell/CMD swap
  `~` for `%USERPROFILE%`/`$HOME` and line-continuation `\` for `` ` ``/`^`).
- These are **ordinary `node …` scripts**. Do **not** run them inside Anypoint Studio / Code
  Builder's embedded runtime, the Anypoint **DX MCP server**, or any other MuleSoft tool. When you
  drive them by *asking Claude*, Claude runs the exact same commands in that same shell for you.
- **You do NOT need the Salesforce / `sf` / `sfdx` CLI.** This suite never calls it. Its only
  external tools are **`node`** (required) and **`git` + `gh`** (only for *local-mode* PRs);
  everything else (GitHub API, Anypoint, Slack, Jira) is plain HTTPS that is env-gated and
  non-fatal. If you hit *"Token exchange timed out"* connecting to the Anypoint **DX** server, that
  is a **separate** tool and unrelated to running this suite — see its own troubleshooting.

---

## 1. Prerequisites

| Need | Why |
|------|-----|
| **Node.js ≥ 24** (`node --version`) | runs the skill scripts (ES modules, `node --test`) |
| **git** + **gh** (GitHub CLI, authenticated) | `local` mode: branch/commit/push/PR |
| A **GitHub token** (`GITHUB_TOKEN`) | `api` mode: Git Data API commits + PRs |
| *(optional)* Anypoint Connected App creds | deploy verification during the poll tail |
| *(optional)* Slack webhook / Jira creds | notifications (env-gated, non-fatal) |

Clone the suite and install its one dependency:

```bash
git clone <this-repo> mule-java17-upgrade-skills
cd mule-java17-upgrade-skills
npm ci
node --test          # sanity: the whole suite should pass
```

---

## 2. Point your IDE at the skills

The skills live under `skills/*/SKILL.md`, each with YAML frontmatter so Claude auto-invokes
them by trigger phrase. Make Claude Code aware of this folder:

- **Project-scoped:** open `mule-java17-upgrade-skills` (or a workspace containing it) in your
  IDE. Claude Code discovers `skills/*/SKILL.md` automatically.
- **User-scoped (available everywhere):** symlink or copy the `skills/` entries into your
  Claude Code skills directory (e.g. `~/.claude/skills/`), so they trigger from any project —
  handy when you upgrade a clone that lives outside this repo.

You do **not** register scripts anywhere; each `SKILL.md` documents the exact `node …` command
Claude runs.

---

## 3. Configure secrets (the `.env` auto-loads)

The suite ports the Mule app's layered config: `config/config-<env>.yaml` (non-secret) +
`config/config-secure-<env>.yaml` (AES-CBC encrypted secrets). Because the secrets ship
**already encrypted**, the only thing you must supply is the **decryption key**.

```bash
cp .env.example .env
# edit .env:
#   MULE_CONFIG_KEY=<the 16/24/32-char AES key>     ← required to read encrypted secrets
#   MULE_UPGRADE_ENV=dev                             ← selects config-dev.yaml (default)
```

`lib_shared/env.js` auto-loads `.env` at the top of every script and CLI, so nothing needs to
be exported into your shell. Precedence: a plaintext env var (e.g. `GITHUB_TOKEN=…` in `.env`)
**overrides** the decrypted YAML value — convenient when you'd rather not ship the key.

> **Security:** `.env` is git-ignored — never commit it. Never commit the real
> `MULE_CONFIG_KEY`. `.env.example` keeps `MULE_CONFIG_KEY=` empty on purpose.

---

## 4. Everyday use — just ask Claude

With the skills loaded, drive everything in natural language; Claude picks the right skill:

| You say | Skill | What runs |
|---------|-------|-----------|
| "Walk me through upgrading orders-api to Java 17" | `mule-upgrade-agent` | guided loop: assess → version menu → **dry-run** → confirm → execute → track |
| "Assess `~/src/orders-api` for the Java 17 upgrade" | `mule-upgrade-assess` | `assess.js` → ChangePlan JSON + summary |
| "Upgrade orders-api to Java 17 and open a PR" | `mule-upgrade` | full pipeline → PR at `PR_OPEN` |
| "What's the status of job job-…?" | `mule-upgrade-job` | job record + next-poll hint |
| "Poll the merge/deploy tail" | `mule-upgrade` (`poll`) | reconcile once (or `--watch`) |
| "Upgrade the shared parent pom in …" | `mule-upgrade-parent-pom` | parent/BOM bump → PR |
| "Roll back the PR for job job-…" | `mule-upgrade-job` | revert branch + revert PR |

### Or run the CLIs directly

```bash
# assess a local clone (no writes)
node skills/mule-upgrade-assess/scripts/assess.js --repo ~/src/orders-api

# preview the plan without writing anything (the interactive-agent confirm gate)
node skills/mule-upgrade/scripts/upgrade.js start \
  --app orders-api --mode api --owner acme --repo-name orders-api --env dev --dry-run

# full upgrade in API mode → opens a PR
node skills/mule-upgrade/scripts/upgrade.js start \
  --app orders-api --mode api --owner acme --repo-name orders-api --env dev

# full upgrade in local mode against a clone → git + gh pr create
node skills/mule-upgrade/scripts/upgrade.js start \
  --app orders-api --mode local --repo ~/src/orders-api

# poll the deploy tail (gh + Anypoint verify); one shot, or --watch on a timer
node skills/mule-upgrade/scripts/upgrade.js poll --stale-seconds 0
```

Exit codes mirror the Mule error taxonomy: `0` ok (incl. `ALREADY_UPGRADED` / `PR_OPEN`),
`4` CONFLICT (an upgrade for that app is already in progress), `5` FAILED_*, `2` usage.

---

## 5. Where state lives

Jobs persist as JSON under **`~/.mule-upgrade/`** (override with `MULE_UPGRADE_HOME`), mirroring
the Mule Object Store partitions:

```
~/.mule-upgrade/
├── jobs/job-<uuid>.json          # the job record + state machine status
├── locks/lock::<app>::<env>.json # single-flight lock per app + environment
├── index/branch::<branch>.json   # branch → jobId
└── idempotency/*.json            # webhook/callback de-dup
```

Inspect a run with `cat ~/.mule-upgrade/jobs/*.json`. If a run is interrupted, ask Claude to
"reconcile stale jobs" (or `upgrade.js poll`) — stale early-stage jobs move to
`FAILED_INTERRUPTED` and their locks are released.

---

## 6. Deploy tail — polling, not webhooks

A skill can't host a listener, so merge/CI/deploy detection is done by **polling** (`gh pr view`,
`gh pr checks`, Anypoint verify) via the `poll` subcommand / reconcile. Run it on demand, or on a
timer via the `/loop` skill or OS cron. (If you *do* want event-driven CD callbacks, run the
hosted server — see [SETUP-AGENTFORCE.md](./SETUP-AGENTFORCE.md).)

**In Cursor you get this for free.** Opening this repo activates `.cursor/hooks.json`, which runs a
debounced reconcile at session start and before each prompt — so the agent answers "what's the status?"
from fresh state without you polling, and without a public webhook URL. Nothing to install; it is
already checked in.

```bash
cat ~/.mule-upgrade/hooks.log   # what the hooks actually did
MULE_UPGRADE_HOOKS=off          # disable for a session
```

The guardrails (only when a job is in flight, ≥45s apart, hard timeout, always fail-open) are described
in [`skills/mule-upgrade-job/SKILL.md`](../skills/mule-upgrade-job/SKILL.md#cursor-hooks--the-automatic-trigger-for-that-sweep).

---

## 7. Run it locally, end-to-end (no live credentials needed)

You can exercise the whole pipeline on your own machine with **nothing but Node + a throwaway
Mule repo** — every network call (GitHub API, Anypoint, Slack, Jira, connector-matrix fetch) is
optional and degrades gracefully when its credential is absent. Do it in this order:

**Step 1 — install & prove the suite is healthy.**

```bash
cd mule-java17-upgrade-skills
npm ci
node --test          # the full suite (310 tests) must pass — this needs no secrets and no network
```

**Step 2 — minimal `.env` (offline profile).** For pure local testing you don't even need the
AES key — plaintext env vars override the encrypted YAML, and you can simply omit the ones you
aren't testing:

```dotenv
MULE_UPGRADE_ENV=dev
MULE_UPGRADE_HOME=./.local-jobstore     # keep test jobs out of your real ~/.mule-upgrade
# GITHUB_TOKEN=ghp_…                     # only needed for API-mode PRs (Step 5)
# SLACK_WEBHOOK_URL=…  ANYPOINT_CLIENT_ID/SECRET=…   # leave unset — those steps just skip
```

**Step 3 — get a target app to assess.** Clone any real Mule 4.6–4.8 / Java 8-or-11 app, or make a
tiny fixture: a folder with a `pom.xml` (declaring a `mule-maven-plugin` version + a runtime
property), a `mule-artifact.json`, and optionally `.github/workflows/build.yml` with a
`java-version:`. Point assess at it — this writes nothing:

```bash
node skills/mule-upgrade-assess/scripts/assess.js --repo /path/to/target-app --no-fetch
#   --no-fetch  = skip the live connector-matrix fetch → deterministic, fully offline
#   drop --no-fetch to also see the live advisory drift check against MuleSoft Maven metadata
```

You'll get the `ChangePlan` JSON on stdout and a human summary on stderr. This is the safest thing
to run first — it only reads.

**Step 4 — dry the fleet scan + drift check (offline-friendly).**

```bash
# advisory gating-version drift audit (needs network; --no-fetch degrades to "unchecked")
node skills/mule-upgrade-assess/scripts/lib/matrix_drift.js --no-fetch

# proactive fleet scan → Slack push. With no Anypoint/Slack creds it short-circuits no-op;
# --dry-run computes the digest without sending or persisting, so it's safe to run bare:
node skills/mule-upgrade-scan/scripts/scan_notify.js --dry-run
```

**Step 5 — a real end-to-end upgrade → PR.** Choose the mode you can support:

- **local mode** (needs `git` + an authenticated `gh`): operates on a clone you own.
  ```bash
  node skills/mule-upgrade/scripts/upgrade.js start \
    --app orders-api --mode local --repo /path/to/your-clone
  ```
- **api mode** (needs a `GITHUB_TOKEN` with `repo` scope on a test repo):
  ```bash
  node skills/mule-upgrade/scripts/upgrade.js start \
    --app orders-api --mode api --owner <you> --repo-name <test-repo> --env dev
  ```

Either way the job lands at `PR_OPEN`. Inspect the job record:

```bash
cat ./.local-jobstore/jobs/*.json      # matches MULE_UPGRADE_HOME from Step 2
```

**Step 6 — poll the tail / test reconcile.** With no Anypoint creds the deploy-verify simply
reports "unverified" instead of failing:

```bash
node skills/mule-upgrade/scripts/upgrade.js poll --stale-seconds 0
```

To test interruption recovery: start an upgrade, kill it mid-run, then `poll` (or ask Claude to
"reconcile stale jobs") — the early-stage job flips to `FAILED_INTERRUPTED` and its lock releases.

> **What each missing credential does (all non-fatal):** no `GITHUB_TOKEN`/`gh` → API/local PR
> steps error clearly (use the other mode, or stop after assess); no Anypoint creds → deploy
> verify is skipped/"unverified"; no Slack/Jira → notifications are silently skipped; no network →
> connector fetch + drift check fall back to the bundled matrix / "unchecked". Nothing here needs
> the Salesforce CLI.

---

## 8. Troubleshooting

- **"cannot decrypt secure property"** → `MULE_CONFIG_KEY` is missing/wrong in `.env`.
- **API-mode 401/403** → `GITHUB_TOKEN` missing or lacks `repo` scope.
- **`gh` errors in local mode** → run `gh auth login` first.
- **Wrong environment loaded** → set `MULE_UPGRADE_ENV` (dev | local | prod).
- **Assess can't find the app pom** → pass `--app-path <sub/dir>` for a monorepo sub-module.
