# Wire ALL live integrations & test everything in MuleSoft Vibes

This is the end-to-end runbook for connecting the suite to **your real Anypoint Platform, GitHub,
Jira, and Slack** and then exercising **every** function from inside **MuleSoft Vibes** (Anypoint
Code Builder).

> **TL;DR** — the `dev` environment already points at your real org/owner/site/channel, and all
> seven secrets ship **already AES-encrypted** in `config/config-secure-dev.yaml`. So "wiring" is
> mostly: **put the one AES decryption key (`MULE_CONFIG_KEY`) into `.env` and select
> `MULE_UPGRADE_ENV=dev`.** Verify from a terminal first, then plug into Vibes.

---

## 0. What "already wired" means

`config/config-dev.yaml` (non-secret, committed) already targets **your** accounts:

| Integration | Key(s) in `config-dev.yaml` | Value |
|-------------|------------------------------|-------|
| Anypoint | `anypoint.defaultOrgId`, `anypoint.verify.enabled`, `assess.armCrossCheck`, `assess.apiPolicyCheck` | your org UUID; verify + cross-checks **on** |
| GitHub | `github.defaultOwner` | `avatansh` |
| Jira | `jira.baseUrl`, `jira.host`, `jira.projectKey`, `jira.autoCreate` | `avatansh-sharma.atlassian.net`, `J1U`, autoCreate **off** (tickets are a per-run opt-in) |
| Slack | `slack.channel` | `#java17-upgrades` |

`config/config-secure-dev.yaml` (committed) holds the **matching secrets, already encrypted** as
`![…]`: `github.token`, `github.webhookSecret`, `anypoint.clientId`, `anypoint.clientSecret`,
`slack.webhookUrl`, `jira.email`, `jira.apiToken`.

**All four clients resolve credentials the same way: plaintext env var first, then the decrypted
YAML.** So you have two ways to supply each secret:

1. **Supply the AES key** (`MULE_CONFIG_KEY`) → every encrypted secret decrypts at runtime. One
   value wires all four integrations. *(Preferred — nothing else to paste.)*
2. **Supply plaintext env vars** (`GITHUB_TOKEN`, `SLACK_WEBHOOK_URL`, `JIRA_EMAIL`,
   `JIRA_API_TOKEN`, `ANYPOINT_CLIENT_ID`, `ANYPOINT_CLIENT_SECRET`) → these **override** the YAML,
   so you don't need the key at all. Handy if you don't hold the AES key.

You can mix them (e.g. key for Anypoint/Slack, a fresh `GITHUB_TOKEN` for GitHub).

---

## 1. Create your `.env` (the only wiring step)

From the cloned suite root, in a **plain terminal** (not inside any DX/Anypoint runtime):

```bash
cd /path/to/mule-java17-upgrade-skills
cp .env.example .env
```

Edit `.env`. **Option 1 — one key wires everything:**

```dotenv
MULE_CONFIG_KEY=<the 16/24/32-char AES key that encrypted config-secure-dev.yaml>
MULE_UPGRADE_ENV=dev
```

**Option 2 — no key, paste plaintext creds instead** (each overrides the YAML):

```dotenv
MULE_UPGRADE_ENV=dev
GITHUB_TOKEN=ghp_xxx                       # repo scope
ANYPOINT_CLIENT_ID=xxx
ANYPOINT_CLIENT_SECRET=xxx
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=xxx
```

> **You must hold the correct AES key for Option 1.** Without it the `![…]` values cannot be
> decrypted and you'll see *"cannot decrypt secure property"* / *"MULE_CONFIG_KEY must be
> 16/24/32 characters"*. If you don't have the key, use Option 2. **Never commit `.env` or the
> real key** — `.env` is git-ignored and `.env.example` keeps `MULE_CONFIG_KEY=` empty on purpose.

`lib_shared/env.js` auto-loads `.env` at the top of every script, CLI, and the server — no shell
exports needed.

---

## 1a. How the key & env are supplied automatically (set once, never prompted)

A real user in Vibes (or at a prompt) is **never asked to type the key or pick a config file**.
The mechanism is entirely automatic once the one-line `.env` above exists:

**1. The `.env` is found no matter where the skill runs.** `lib_shared/env.js` locates `.env` by
walking **up from its own file location** (`import.meta.url`), not from the current working
directory. So whether Vibes invokes a script from the workspace root, a sub-folder, or the ACB
sandbox, the *same* suite-root `.env` is the one that loads. It's idempotent (loads once) and
**never overrides a variable already set in the real environment** — so CI/container injection still
wins over the file.

> **This is why Vibes skills must be SYMLINKED, not copied** (§3, Option A). A symlinked skill's
> `../../lib_shared/env.js` resolves back into the suite, so it finds the suite's single `.env`. A
> *copied* skill would look for a `.env` that isn't there and silently find no key.

**2. The environment is a MANDATORY input (no silent default).** Faithful to the Mule app's
required `-Denv`/`mule.env`, the active environment must be supplied on every run — there is **no**
default. Supply it **either** by setting `MULE_UPGRADE_ENV` in `.env` (set once — the common case)
**or** by passing `--env <dev|local|prod>` at each command; the `--env` flag wins when both are
present. With `dev`, the loader reads `config.yaml` → `config-dev.yaml` → `config-secure-dev.yaml`;
switch to `prod` and it transparently loads the `-prod` pair instead. If **neither** is supplied,
every entrypoint — the skills, the CLIs, and the server at boot — **fails fast** with
`environment is required: pass --env <dev|local|prod> or set MULE_UPGRADE_ENV`, and an unknown env
(e.g. `staging`) is rejected too. Once resolved it's pinned for the whole run so every config read
uses the same env (and the same per-env key).

**3. The decryption key is auto-resolved per env.** `lib_shared/config.js` resolves the AES key with
this precedence (first non-empty wins):

| Order | Source | When to use |
|-------|--------|-------------|
| 1 | explicit `opts.key` | programmatic / tests only |
| 2 | `MULE_CONFIG_KEY_<ENV>` (e.g. `MULE_CONFIG_KEY_PROD`) | **only if** an env was encrypted with a *different* key — the active `MULE_UPGRADE_ENV` auto-selects the matching one |
| 3 | `MULE_CONFIG_KEY` | the single shared key — **the common case here** |

Because all three envs in this suite were encrypted with the **same** key, setting `MULE_CONFIG_KEY`
once covers dev, local, and prod. The per-env `MULE_CONFIG_KEY_<ENV>` slots exist only for the day
someone re-encrypts one environment under a distinct key — then dropping that one var in `.env` is
all that changes; `MULE_UPGRADE_ENV` picks it up automatically.

**4. Every integration reads the same resolved config.** All four clients resolve credentials
identically — **plaintext env var first, then the decrypted YAML value, then a default** — so the
one key (or an optional plaintext override) wires Anypoint, GitHub, Jira, and Slack with no
per-skill configuration.

**Net effect:** set `MULE_CONFIG_KEY` + `MULE_UPGRADE_ENV` **once** in the suite `.env`. Every skill,
CLI, MCP tool, and the server thereafter picks the correct files and key on its own — the user is
never prompted for the *key*, in Vibes or at a terminal, while the *environment* is always an
explicit, required input (from `.env` or `--env`).

> **Two different `--env` meanings — don't confuse them.** On `upgrade start`, `assess`, and
> `parent-pom`, `--env <dev|local|prod>` **is** the config selector (equivalent to setting
> `MULE_UPGRADE_ENV`). On `scan`/`scan_notify`, `--env` instead names the **Anypoint environment(s)**
> to scan (e.g. `--env Production,Staging`); those two commands take the *config* env from
> `MULE_UPGRADE_ENV` only. Setting `MULE_UPGRADE_ENV` in `.env` satisfies the config requirement for
> every command, so the scan examples below just need it present in `.env`.

---

## 2. Verify each integration from a terminal FIRST

Do this **before** touching Vibes — it isolates a credential problem from a Vibes-integration
problem. Every call is non-fatal and env-gated, so a missing/rotated secret prints a clear "skipped
/ unverified" instead of crashing.

### 2.1 Prove the suite is healthy (no secrets, no network)

```bash
npm ci && node --test          # 310 tests must pass
```

### 2.2 GitHub — real PR against your repo

```bash
# api mode uses github.token (decrypted) or plaintext GITHUB_TOKEN:
node skills/mule-upgrade/scripts/upgrade.js start \
  --app orders-api --mode api --owner avatansh --repo-name <a-test-repo> --env dev
```

A `401/403` means the token is missing/rotated or lacks `repo` scope. Success → a real PR and a job
at `PR_OPEN`. (`local` mode instead uses `git` + an authenticated `gh` against a clone you own.)

### 2.3 Anypoint — read your Runtime Manager fleet

```bash
# scan_fleet reads AMC deployments across environments using anypoint.clientId/secret + org:
node skills/mule-upgrade-scan/scripts/scan.js --env dev
```

If Anypoint creds resolve, you get a fleet table; if not, rows report `unverified` (never a crash).
The `dev` config also has `armCrossCheck`/`apiPolicyCheck` **on**, so `assess` will read Runtime
Manager + API Manager too.

### 2.4 Slack — post to your channel (dry-run first, then live)

```bash
# compute the digest WITHOUT sending (safe, no post):
node skills/mule-upgrade-scan/scripts/scan_notify.js --dry-run

# then send for real to slack.webhookUrl → #java17-upgrades:
node skills/mule-upgrade-scan/scripts/scan_notify.js
```

Check `#java17-upgrades` for the message. No webhook resolved → cleanly skipped.

### 2.5 Jira + Slack — opt in, once

Both are **silent by default**. Having a webhook and a Jira token wired up only makes delivery
*possible*; someone still has to ask for it, so a plain `upgrade … start` posts nothing. (In Vibes the
conductor asks once, as the second intake question, and reuses your answer for the whole session.)

```bash
# comment on an existing ticket, and alert Slack
node skills/mule-upgrade/scripts/upgrade.js start --app orders-api --env dev --mode api \
  --owner acme --repo-name orders-api --jira J1U-12 --jira-mode comment --slack

# let the suite file the ticket first (needs jira.projectKey), then comment on it
node skills/mule-upgrade/scripts/upgrade.js start --app orders-api --env dev --mode api \
  --owner acme --repo-name orders-api --jira-mode create
```

With `--jira-mode create` a ticket appears in project **J1U** at
`https://avatansh-sharma.atlassian.net` and a PR-opened comment follows. Missing creds → a clean "no
Jira creds" skip. The choice is stored on the job, so later transitions (merge → deploy) alert too.
Set `jira.autoCreate: "true"` only for an unattended pipeline that should always file a ticket.

> **State lives** under `~/.mule-upgrade/` (override with `MULE_UPGRADE_HOME`). Inspect any run with
> `cat ~/.mule-upgrade/jobs/*.json`. For throwaway testing, set
> `MULE_UPGRADE_HOME=./.local-jobstore` in `.env`.

### 2.6 Test EVERY skill E2E from the terminal (exact commands)

Steps 2.2–2.5 prove the four **connections**. This section runs **every skill's CLI** end-to-end so
you've exercised the whole suite before wiring Vibes. Run them **in order** — a few reuse the
`jobId` printed by an earlier step. Set `SUITE`, `REPO`, and (for api mode) `OWNER`/`REPONAME` once:

```bash
cd /path/to/mule-java17-upgrade-skills
REPO=/path/to/a-mule-4.6-to-4.8-java8or11-clone     # a real target app you can open a PR against
OWNER=avatansh                                       # your GitHub owner (api mode)
REPONAME=<a-test-repo>                               # a repo you can push branches to (api mode)
```

**Skill 1 — `mule-upgrade-assess` (assess_app).** Read-only; writes nothing. `--no-fetch` keeps it
fully offline; drop it to also hit the live connector matrix + (in dev) Anypoint ARM/API-Manager
cross-checks:

```bash
# offline, deterministic:
node skills/mule-upgrade-assess/scripts/assess.js --repo "$REPO" --no-fetch --out plan.json
# live (matrix fetch + Anypoint cross-check, since dev has armCrossCheck/apiPolicyCheck on):
node skills/mule-upgrade-assess/scripts/assess.js --repo "$REPO" --out plan.json
#   optional: --app-path sub/dir  --app-name my-app  --head-sha <sha>  --strategy appOverride|inPlace
```
Expect the `AssessmentResult` JSON (also saved to `plan.json`) + a human summary on stderr.

**Skill 2 — `mule-upgrade` orchestrator (start_upgrade).** The full pipeline; this is what fires
**GitHub + Jira + Slack** together. Pick the mode you can support:

```bash
# api mode → Git Data API commit + PR (uses github.token / GITHUB_TOKEN):
node skills/mule-upgrade/scripts/upgrade.js start \
  --app orders-api --mode api --owner "$OWNER" --repo-name "$REPONAME" --env dev

# local mode → git + gh against a clone you own:
node skills/mule-upgrade/scripts/upgrade.js start \
  --app orders-api --mode local --repo "$REPO" --env dev
```
Expect a job at `PR_OPEN`, a real PR, a **J1U** Jira ticket + comment, and a Slack post to
`#java17-upgrades`. **Copy the `jobId` from the output** — later steps need it:

```bash
JOB=<the job-… id printed above>
```

**Skill 5a — `mule-upgrade-job` status (get_job_status).**

```bash
node skills/mule-upgrade-job/scripts/job.js status --job "$JOB" --jira-base-url https://avatansh-sharma.atlassian.net
node skills/mule-upgrade-job/scripts/job.js get  --job "$JOB"     # raw record
node skills/mule-upgrade-job/scripts/job.js list                 # all jobs
```

**Skill 6b — `mule-upgrade` poll tail (reconcile).** Advances `PR_OPEN → DEPLOYING → DEPLOYED`
using **GitHub** (`gh pr view`/`checks`) + **Anypoint** deploy-verify. `--stale-seconds 0` treats
every job as pollable now:

```bash
node skills/mule-upgrade/scripts/upgrade.js poll --stale-seconds 0
# continuous: node skills/mule-upgrade/scripts/upgrade.js poll --watch --interval 30
```

**Skill 5b — `mule-upgrade-job` reconcile sweep.** Same engine, standalone; stale early-stage jobs
flip to `FAILED_INTERRUPTED` and release their lock:

```bash
node skills/mule-upgrade-job/scripts/job.js reconcile --stale-seconds 0
```

**Skill 4 — `mule-upgrade-parent-pom` (upgrade_parent_pom).** Bumps the shared parent/BOM pom and
opens its own PR (or reports `NO_CHANGE`):

```bash
# api mode via repo URL (branch/subpath preserved if present):
node skills/mule-upgrade-parent-pom/scripts/parent_pom_cli.js \
  --repo-url https://github.com/$OWNER/<parent-pom-repo> --mode api --env dev
# or explicit owner/repo, local mode against a clone:
node skills/mule-upgrade-parent-pom/scripts/parent_pom_cli.js \
  --owner "$OWNER" --repo <parent-pom-repo> --mode local --repo-root "$REPO" --env dev
#   optional: --pom-path pom.xml  --branch main  --jira <KEY>  --no-fetch
```

**Skill 3 — `mule-upgrade-pr` rollback (rollback).** Opens a revert PR restoring the pre-upgrade
tree (api mode). Needs the upgrade commit sha + branch from the job record (`job.js get`):

```bash
node skills/mule-upgrade-pr/scripts/pr.js rollback --mode api \
  --coords "$(node skills/mule-upgrade-job/scripts/job.js get --job "$JOB" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(JSON.stringify({owner:j.owner,repo:j.repo,defaultBranch:j.defaultBranch||"main"}))})')" \
  --commit-sha <upgradeCommitSha> --branch <upgradeBranch> --app orders-api --job "$JOB"
```
> Simpler: drive rollback through the orchestrator/MCP tool (step 7 of the Vibes table), which reads
> the coords/sha/branch from the job record for you. The raw CLI above is for direct testing.

**Skill 5c — `mule-upgrade-job` reapply + delete (reapply_job / delete_job).** Do these **last** —
`delete` removes the record:

```bash
node skills/mule-upgrade-job/scripts/job.js reapply --job "$JOB"   # reseed a new jobId from coords
node skills/mule-upgrade-job/scripts/job.js delete  --job "$JOB"   # remove record + clear index + release lock
```

**Skill 7 — `mule-upgrade-scan` (scan_fleet + scan_notify).** Already run in 2.3/2.4; together they
are the fleet audit + proactive Slack push:

```bash
node skills/mule-upgrade-scan/scripts/scan.js --env dev              # fleet table (Anypoint)
node skills/mule-upgrade-scan/scripts/scan.js --env dev --json       # machine-readable
node skills/mule-upgrade-scan/scripts/scan_notify.js --dry-run       # digest, no send
node skills/mule-upgrade-scan/scripts/scan_notify.js                 # send to #java17-upgrades
```

> **Apply skill note:** `mule-upgrade-apply` is not a standalone connection test — it's the
> byte-level rewriter the orchestrator calls between assess and commit. It's covered by `node --test`
> (step 2.1) and exercised live inside Skill 2. To see its output in isolation, feed `plan.json`
> from Skill 1 to `node skills/mule-upgrade-apply/scripts/apply_edits.js` against a scratch copy of
> the repo.

Once **all** of the above behave — real PR, J1U ticket, Slack posts, poll advancing the job,
rollback/reapply/delete working — you've proven the suite E2E and can wire Vibes (§3) with
confidence, then repeat the §4 prompts there.

---

## 3. Plug the wired suite into Vibes

Both options below inherit the same `.env` you just verified, so all four integrations stay live.

### Option A — Install as Vibes Skills (recommended, no server)

Symlink the 7 skill folders into the ACB workspace's `.a4drules/skills/` (symlink, **not** copy, so
`../../lib_shared`, `config/`, `server/` still resolve):

```bash
SUITE=/path/to/mule-java17-upgrade-skills
mkdir -p .a4drules/skills
for s in mule-upgrade mule-upgrade-assess mule-upgrade-apply mule-upgrade-pr \
         mule-upgrade-parent-pom mule-upgrade-job mule-upgrade-scan; do
  ln -s "$SUITE/skills/$s" ".a4drules/skills/$s"
done
```

On Windows: `mklink /D` (CMD as admin) or `New-Item -ItemType SymbolicLink`. Reload the ACB window;
the 8 skills appear under **Workspace** scope. The `.env` at the suite root is what supplies the
creds when Vibes runs the scripts. See [SETUP-VIBES.md](./SETUP-VIBES.md) Option A for detail.

### Option B — Register the MCP server (first-class tools + webhooks)

```bash
cd /path/to/mule-java17-upgrade-skills
MCP_BEARER_TOKEN=<long-random-string> node server/server.js   # → http://0.0.0.0:8080/mcp
```

In Vibes → **MCP Servers → Remote Servers → Add** with URL `http://localhost:8080/mcp` and header
`Authorization: Bearer <MCP_BEARER_TOKEN>`. The server reads the **same `.env`**, so it decrypts the
same secrets. All 12 tools appear. See [SETUP-VIBES.md](./SETUP-VIBES.md) Option B.

---

## 4. Test EVERY function from inside Vibes

Drive it in natural language (Option A skills) — or invoke the named tool (Option B). Each row is a
real, credentialed round-trip.

| # | Say to Vibes | Skill / tool | Live integration exercised | Expect |
|---|--------------|--------------|-----------------------------|--------|
| 1 | "Assess `<repo>` for the Java 17 upgrade" | `mule-upgrade-assess` / `assess_app` | Anypoint (ARM + API Mgr cross-check), matrix fetch | ChangePlan JSON + summary |
| 2 | "Upgrade orders-api to Java 17 and open a PR" | `mule-upgrade` / `start_upgrade` | **GitHub** (PR) + **Jira** (create+comment) + **Slack** (PR-ready) | job at `PR_OPEN`, real PR, J1U ticket, Slack post |
| 3 | "What's the status of job `job-…`?" | `mule-upgrade-job` / `get_job_status` | — (local job store) | status + `nextPollSeconds` |
| 4 | "Poll the merge/deploy tail for `job-…`" | `mule-upgrade` (`poll`) / `reconcile` | **GitHub** (`gh pr view/checks`) + **Anypoint** (deploy verify) | PR_OPEN → DEPLOYING → DEPLOYED / MUNIT_FAILED / DEP_GUARD_FAILED |
| 5 | "Reconcile stale jobs" | `mule-upgrade-job` / `reconcile` | GitHub + Anypoint | stale early-stage → `FAILED_INTERRUPTED`, lock released |
| 6 | "Upgrade the shared parent/BOM pom in `<repo>`" | `mule-upgrade-parent-pom` / `upgrade_parent_pom` | **GitHub** (PR) | parent/BOM bump PR (or `NO_CHANGE`) |
| 7 | "Roll back the PR for job `job-…`" | `mule-upgrade-job` / `rollback` | **GitHub** (revert PR) + **Slack** | `Revert:` PR + failure/rollback Slack note |
| 8 | "Reapply job `job-…`" | `mule-upgrade-job` / `reapply_job` | — | new jobId reseeded from coords |
| 9 | "Delete job `job-…`" | `mule-upgrade-job` / `delete_job` | — | record removed, index cleared, lock released |
| 10 | "Scan the fleet for apps still on old Mule/Java and alert me on Slack" | `mule-upgrade-scan` / `scan_fleet` + `scan_notify` | **Anypoint** (fleet read) + **Slack** (digest) | fleet table + Slack digest to `#java17-upgrades` |

**Recommended order for a full live sweep:** 1 → 2 → 3 → 4 → 10 → 7 → 9. That exercises all four
integrations (assess reads Anypoint; upgrade hits GitHub+Jira+Slack; poll hits GitHub+Anypoint; scan
hits Anypoint+Slack; rollback hits GitHub+Slack) and leaves a clean job store.

---

## 5. Confirm each integration actually fired

- **GitHub** → the PR exists on the repo; the job record shows `prUrl`/`branchName`
  (`cat ~/.mule-upgrade/jobs/*.json`).
- **Jira** → a **J1U** ticket exists and carries the "PR opened" comment.
- **Slack** → `#java17-upgrades` shows the PR-ready message (and the fleet digest from #10).
- **Anypoint** → the poll tail moved the job past `PR_OPEN` using a real deploy-verify, and
  `scan_fleet` returned live deployments (not all `unverified`).

---

## 6. Troubleshooting the live wiring

| Symptom | Cause & fix |
|---------|-------------|
| *"cannot decrypt secure property"* / *"MULE_CONFIG_KEY must be 16/24/32 characters"* | Wrong/missing AES key. Fix `MULE_CONFIG_KEY`, or switch to plaintext env vars (Option 2). |
| GitHub `401/403` | `github.token` rotated or lacks `repo` scope. Set a fresh plaintext `GITHUB_TOKEN` (overrides YAML), or `gh auth login` for local mode. |
| Anypoint rows all `unverified` | `anypoint.clientId/secret`/org not resolving, or the Connected App lacks Runtime/API Manager scope. |
| Slack "no SLACK_WEBHOOK_URL" | Webhook not resolving — check the key decrypts, or set `SLACK_WEBHOOK_URL` plaintext. |
| Jira "no Jira creds" / no ticket | `jira.email`/`jira.apiToken` not resolving, or the run didn't opt in (`--jira-mode create`). |
| No Slack message despite a working webhook | The run didn't pass `--slack`. Notifications are opt-in per run by design. |
| Skills don't appear in Vibes | Confirm `.a4drules/skills/<skill>/SKILL.md` and reload ACB; symlink (don't copy) so `../../lib_shared` resolves. |
| MCP server 401 | Service URL must end in `/mcp` and the `Authorization: Bearer` header must equal `MCP_BEARER_TOKEN`. |

> Any *"Token exchange timed out"* against the Anypoint **DX** server is a **separate** tool
> (VPN-dependent internal gateway) and unrelated to this suite — you do **not** need the Salesforce
> `sf`/`sfdx` CLI to run any of the above.
