# mule-java17-upgrade-skills 🚀

An agent-driven toolkit that automates the **Java 8/11 → Java 17** (and **Java 21**) upgrade of
MuleSoft applications end to end: it assesses a repository against a curated compatibility matrix,
rewrites the POM chain surgically, opens a pull request, and then tracks that PR through CI, merge,
and deployment — for one app or for a whole fleet.

It ships as **12 composable skills** that an AI assistant invokes conversationally (Cursor, Claude
Code, or MuleSoft Vibes / Anypoint Code Builder), as **plain Node.js CLIs** for scripting and CI, and
as a **hosted MCP + REST server** exposing the same **15 tools** to a remote agent such as Agentforce.
All three surfaces run the identical scripts against the identical job store.

Nothing is written without an explicit confirmation.

## Target Audience

- **MuleSoft developers** who need to move applications off Java 8/11 before end of support.
- **Integration architects** standardising runtime, connector, and plugin versions across an estate.
- **C4E and platform teams** running a fleet-wide migration and needing to report on progress.
- **Security and compliance owners** who need to know which CVEs an application carries and which
  ones the upgrade actually closes.

It is built for organisations with more applications than can reasonably be upgraded by hand, where
consistency across repositories matters as much as the upgrade itself.

## Problem Statement

Java 8 and 11 are out of support for Mule 4.9+, and Mule 4.6 and older runtimes are reaching end of
life. That forces a migration across every application in the estate at once — and done by hand, it
is slow and inconsistent.

Key issues teams hit during a manual migration:

- **Repetitive, low-value work.** Every application needs the same edits to its runtime version,
  Java properties, compiler settings, `mule-maven-plugin`, MUnit plugins, `mule-artifact.json`, and
  CI workflow. Multiply that by fifty repositories.
- **Version guesswork.** Knowing the *minimum* connector version that is safe on Java 17 means
  reading release notes per connector. Guessing high risks a breaking major; guessing low fails at
  runtime.
- **Shared parent POMs and BOMs.** When connectors are pinned upstream, upgrading the application
  alone silently achieves nothing — and the parent usually lives in a different repository.
- **No fleet visibility.** There is no straightforward answer to "how many apps are still on Java 8,
  and which repositories are they?"
- **Invisible security posture.** An upgrade quietly fixes some vulnerabilities and leaves others
  untouched, and nobody can say which is which.
- **Losing track mid-flight.** Once PRs are open across many repositories, merge, CI, and deploy
  state has to be chased manually.

## Scope

This toolkit covers:

- **Assessment** — reads the full POM inheritance chain, `mule-artifact.json`, and CI workflow
  against a curated compatibility matrix, and produces an explained change plan.
- **Surgical rewrites** — byte-preserving edits that change only what they intend to change.
- **Pull requests** — branch, commit, and open a PR via local `git`/`gh` or the GitHub API; revert
  via a rollback PR.
- **Job tracking** — a state machine that follows each upgrade through CI, merge, and deployment,
  with a self-healing reconcile sweep.
- **Shared parent POM and BOM chains** — detects upstream-managed connectors and upgrades the
  parent or BOM first, then repoints the application's open PR at the new version.
- **Batch upgrades** — many applications in one run, grouped so apps sharing a parent POM do not
  collide.
- **Fleet scanning** — enumerates deployed applications still on an old runtime or Java, maps them
  back to repositories, and can push a Slack alert when new ones appear.
- **Vulnerability scanning** — looks up declared Maven coordinates in OSV.dev and splits findings
  into what the upgrade fixes and what still needs action.
- **Matrix maintenance** — audits the curated version pins against live Maven metadata and proposes
  bumps, per Java target.

## 📌 Prerequisites

- **Node.js ≥ 18** (developed and tested on 24; see `.nvmrc`). The only runtime dependency is
  `js-yaml`.
- **`git`**, plus the **GitHub CLI (`gh`)** authenticated, if you use local mode.
- **A `GITHUB_TOKEN`** if you use API mode (no clone required) or read private repositories.
- **An Anypoint connected app** *(optional)* — needed only for deployed-state checks, deploy
  verification, and fleet scanning. Everything else works from source alone.

```bash
git clone <this-repo> && cd mule-java17-upgrade-skills
npm install          # js-yaml only
npm test             # 596 tests
```

Copy `.env.example` to `.env` and fill in only the integrations you actually want; every one of them
is optional and non-fatal when absent.

## 🚀 How to Run

### Option 1 — Guided (recommended)

Install the skills into Cursor, Claude Code, or MuleSoft Vibes and simply ask. The
**Mule Upgrade Assistant** (`mule-upgrade-agent`) is the front door: it offers a short menu of what
it can do, asks only the questions that capability needs, previews the plan, and waits for your
confirmation before anything is written.

```
"upgrade my-mule-app to Java 17"
"what CVEs does this app have, and which does the upgrade fix?"
"which apps in the fleet are still on Java 8?"
"is my PR merged yet?"
```

Setup instructions per IDE: [docs/SETUP-IDE.md](docs/SETUP-IDE.md),
[docs/SETUP-VIBES.md](docs/SETUP-VIBES.md).

### Option 2 — CLI

Every skill is a plain Node script. `--env` is required throughout (or set `MULE_UPGRADE_ENV`).

```bash
# Assess a local clone — read-only, writes nothing
node skills/mule-upgrade-assess/scripts/assess.js \
  --repo /path/to/clone --env dev

# Assess a GitHub repo with no clone, targeting Java 21
node skills/mule-upgrade-assess/scripts/assess.js \
  --source github --owner acme --repo-name my-mule-app --branch develop \
  --env dev --target-java 21

# Full upgrade → opens a PR
node skills/mule-upgrade/scripts/upgrade.js start \
  --app my-mule-app --env dev --mode api \
  --coords '{"owner":"acme","repo":"my-mule-app","defaultBranch":"main"}' \
  --repo /path/to/clone --head-sha <sha>

# Follow the merge / CI / deploy tail
node skills/mule-upgrade/scripts/upgrade.js poll --stale-seconds 0
node skills/mule-upgrade-job/scripts/job.js status --job <jobId>

# Scan for vulnerabilities — read-only, no --confirm because nothing is written
node skills/mule-upgrade-cve/scripts/cve_cli.js scan --repo /path/to/clone
node skills/mule-upgrade-cve/scripts/cve_cli.js scan --repo /path/to/clone --fail-on high

# Batch: preview writes nothing; run requires an explicit --confirm
node skills/mule-upgrade-batch/scripts/batch_cli.js preview --apps app-a,app-b --env dev
node skills/mule-upgrade-batch/scripts/batch_cli.js run --from-scan --env dev --confirm

# Shared parent / BOM POM
node skills/mule-upgrade-parent-pom/scripts/parent_pom_cli.js \
  --repo-url https://github.com/acme/mule-apps/tree/develop/bom --env dev
node skills/mule-upgrade-parent-pom/scripts/parent_pom_cli.js \
  --repo-url <url> --env dev --detect-only        # read-only: what does this POM inherit?

# Fleet: audit deployments, and alert only when something new appears
node skills/mule-upgrade-scan/scripts/scan.js
node skills/mule-upgrade-scan/scripts/scan_notify.js

# Compatibility matrix maintenance (dry-run unless --apply)
node skills/mule-upgrade-matrix-update/scripts/matrix_update_cli.js targets
node skills/mule-upgrade-matrix-update/scripts/matrix_update_cli.js diff 17 21
node skills/mule-upgrade-matrix-update/scripts/matrix_update_cli.js --targets 17 --apply
```

### Option 3 — Hosted server

For remote agents (Agentforce) and event-driven CD, the same 15 tools are served over MCP JSON-RPC
(`POST /mcp`) and a REST facade (`/api/v1/tools/*`), behind a bearer token, with HMAC-verified CI/CD
webhooks at `POST /webhook/cd-result`. Every call is validated against its JSON Schema before
dispatch.

```bash
MCP_BEARER_TOKEN=<token> node server/server.js     # default :8080
```

See [docs/SETUP-AGENTFORCE.md](docs/SETUP-AGENTFORCE.md).

## The 12 skills

| Skill | What it does |
|-------|--------------|
| **mule-upgrade-agent** | **Start here.** The Mule Upgrade Assistant — the conversational conductor. Offers a capability menu, asks only what is needed, previews, and waits for confirmation. |
| **mule-upgrade** | Non-interactive orchestrator: assess → apply → commit → PR → track, then poll the deploy tail. |
| **mule-upgrade-assess** | Reads the POM chain, `mule-artifact.json`, and CI workflow against the matrix → change plan, connector menu, deployed-state check, warnings. |
| **mule-upgrade-apply** | Applies the byte-preserving rewrites in a fixed order → staged file contents. |
| **mule-upgrade-pr** | Commit and open a PR (local `git`/`gh` or the GitHub Git Data API); revert PR. |
| **mule-upgrade-parent-pom** | Upgrades a shared parent/BOM POM, and repoints an application's open PR at the new parent version. |
| **mule-upgrade-batch** | Many applications in one run — previews, groups by shared parent POM, then executes behind an explicit confirm. |
| **mule-upgrade-job** | JSON job store, status machine, stale-job reconcile sweep, reapply/delete. |
| **mule-upgrade-scan** | Fleet audit of deployed apps still on old Mule/Java, mapped to repositories, with de-duplicated Slack alerts. |
| **mule-upgrade-cve** | Read-only vulnerability scan against OSV.dev, split into resolved-by-upgrade, action-required, and no-fix-available. |
| **mule-upgrade-matrix-update** | Audits the curated pins against live Maven metadata and proposes bumps; manages multiple Java targets. |
| **mule-upgrade-mcp** | The hosted server: 15 tools over MCP JSON-RPC + REST, HMAC webhooks, bearer auth. |

Each skill has a `SKILL.md` with YAML frontmatter so an assistant can auto-invoke it, a `scripts/`
directory of ES modules, and where relevant a `references/` directory holding the data files.

## 📄 Sample Configuration

Configuration is layered: `config/config.yaml` holds settings that are identical everywhere,
`config-<env>.yaml` overrides per environment, and `config-secure-<env>.yaml` holds AES-encrypted
secrets. Environment variables override all of it.

```yaml
# config/config.yaml — excerpt
matrix:
  source: "exchange-latest"     # exchange | exchange-latest | classpath
  refreshSeconds: "86400"       # matrix cache TTL
  driftCheck: "true"            # warn (never auto-apply) when a pin trails the latest release

upgrade:
  pomEditStrategy: "appOverride"  # write edits into the app's own POM, never a sibling's

scan:
  staleMuleBelow: "4.5.0"       # deployed Mule below this counts as old
  targetJava: "17"

batch:
  concurrency: "3"              # apps in flight at once

cve:
  maxVulnDetails: "250"
  batchTtlSeconds: "21600"      # 6h — new advisories land against unchanged versions

hooks:
  enabled: "true"               # refresh job status on session start / before each prompt
  minIntervalSeconds: "45"      # debounce, so a chatty session doesn't burn rate limit
```

Environment variables, all optional:

| Purpose | Variables |
|---------|-----------|
| GitHub | `GITHUB_TOKEN` (local mode uses `gh` auth) |
| Anypoint | `ANYPOINT_CLIENT_ID`, `ANYPOINT_CLIENT_SECRET`, `ANYPOINT_ORG_ID`, `ANYPOINT_BASE_URL` |
| Slack | `SLACK_WEBHOOK_URL`, `SLACK_CHANNEL` |
| Jira | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`, `JIRA_ISSUE_TYPE` |
| Server | `MCP_BEARER_TOKEN`, `MCP_SERVER_PORT`, `GITHUB_WEBHOOK_SECRET` |
| Runtime | `MULE_UPGRADE_ENV`, `MULE_UPGRADE_HOME` (default `~/.mule-upgrade`), `MULE_UPGRADE_HOOKS=off`, `MULE_UPGRADE_CACHE=off`, `MULE_UPGRADE_REFRESH=1` |
| Logging | `LOG_LEVEL`, `LOG_FORMAT` |

Every notification and every Anypoint call is **env-gated and non-fatal** — a missing credential or
an outage is logged and skipped, never a pipeline failure.

## What actually gets changed

Eight byte-preserving rewrites, applied in this fixed order:

```
depVersion → pluginVersion → pomProperty → munitRuntimeVersion
  → muleArtifactJson → ciWorkflow → munitArgLines → pomVersion
```

Each preserves every byte it does not intend to change; a ninth rewrite handles the shared-BOM case.
See [`transform-rules.md`](skills/mule-upgrade-assess/references/transform-rules.md).

Every upgrade is tracked as a job through this state machine:

```
PROCESSING → ASSESSING → COMMITTING → COMMITTED → PR_OPEN → DEPLOYING → DEPLOYED → CLOSED
```

with `NO_CHANGE`, `MUNIT_FAILED`, `DEP_GUARD_FAILED`, and
`FAILED_ASSESS / FAILED_COMMIT / FAILED_CI / FAILED_DEPLOY / FAILED_INTERRUPTED` as terminals. On any
error the job goes terminal and the application lock is released. A `reconcile` sweep advances stale
jobs: a stale `PR_OPEN` polls the PR (merged → `DEPLOYING`, closed unmerged → `CLOSED`), a stale
`DEPLOYING` verifies the deployment, and a stale early-stage job becomes `FAILED_INTERRUPTED`.

In an IDE, Cursor hooks pull that sweep automatically at session start and before each prompt, so
status is fresh without a public webhook endpoint or any polling loop you have to run.

## Compatibility matrix

The matrix is a **data file, not code** — version policy is tuned without touching a script.

- **Curated pins are authoritative.** They are the *minimum* versions known to be safe on the target
  Java, not the newest available. Live Exchange and release-notes data is **advisory only**; `latest`
  is never auto-adopted, because it may be a breaking major.
- **One file per Java target.** `compatibility-matrix.yaml` is the default (Java 17);
  `compatibility-matrix-java21.yaml` is discovered automatically. Java-neutral fields — connector
  coordinates, gating coordinates, scan patterns — are enforced identical across targets by a parity
  test, so the files cannot silently diverge.
- **Uncurated targets are refused.** A target whose versions are still placeholders makes the engine
  stop rather than quietly plan from another Java version's floors.
- **Drift is reported, never applied.** `matrix_update` audits pins against live Maven metadata and
  proposes bumps; only an explicit `--apply` writes.

Full detail, including how to add a new Java target:
[`skills/mule-upgrade-assess/references/MATRIX.md`](skills/mule-upgrade-assess/references/MATRIX.md).

> **Note:** the Java 21 target currently ships **uncurated** — a scaffold with placeholder versions.
> It must be curated before use, and the engine will refuse it until then.

## 📌 Unsupported Features

Deliberate boundaries, so the output is never mistaken for more than it is:

- **Does not resolve transitive dependencies.** The CVE scan covers *declared* coordinates only —
  direct dependencies, `dependencyManagement`, and plugins. Real transitive resolution needs a Maven
  build, so findings are a **lower bound**, never a clean bill of health.
- **Does not deploy.** It opens pull requests. Merging and deploying stay with your CI/CD.
- **Does not auto-adopt the latest versions.** It plans to the curated safe floor unless you
  explicitly choose another strategy.
- **Does not curate a Java target for you.** Version floors for a new Java target are a human
  judgement backed by release notes.
- **Does not touch business logic.** It will not refactor Java sources, rewrite DataWeave semantics,
  or fix a failing test. Patterns it cannot safely change are reported for manual review.
- **Does not cover the whole estate in a fleet scan.** CloudHub 2.0 and Runtime Fabric only;
  CloudHub 1.0 and on-prem/hybrid use different endpoints and are excluded — the report says so
  explicitly.
- **Does not host a listener in IDE mode.** A skill cannot hold a port open, so merge/CI/deploy
  detection is polling plus Cursor hooks. Event-driven webhooks require the hosted server.

## Repository layout

```
mule-java17-upgrade-skills/
├── skills/                      # the 12 skills — SKILL.md + scripts/ + references/
│   ├── mule-upgrade-agent/      #   interactive conductor (start here)
│   ├── mule-upgrade/            #   orchestrator (start + poll)
│   ├── mule-upgrade-assess/     #   assess.js + lib/ + references/compatibility-matrix*.yaml
│   ├── mule-upgrade-apply/      #   apply_edits.js + rewrites/
│   ├── mule-upgrade-pr/         #   commit_pr.js, rollback.js
│   ├── mule-upgrade-parent-pom/ #   shared parent / BOM chains
│   ├── mule-upgrade-batch/      #   multi-app runs
│   ├── mule-upgrade-job/        #   job store, status, reconcile
│   ├── mule-upgrade-scan/       #   fleet audit + Slack alerting
│   ├── mule-upgrade-cve/        #   OSV.dev vulnerability scan
│   ├── mule-upgrade-matrix-update/  # matrix maintenance, multi-target
│   └── mule-upgrade-mcp/        #   hosted-server documentation
├── server/                      # server.js + lib/ + schemas/ (15 tool contracts)
├── lib_shared/                  # config, cache, env, exchange, semver, java_version
├── config/                      # config[-<env>].yaml + config-secure-<env>.yaml (AES)
├── docs/                        # setup and deep-dive guides
├── tests/                       # 38 suites, 596 tests (node --test)
├── tools/                       # diagnose.mjs
├── .cursor/                     # hooks.json + hooks/ — automatic job-status refresh
└── .github/workflows/           # test.yml, upgrade.yml, ci-result.yml
```

## Documentation

| Document | Covers |
|----------|--------|
| [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) | First run, end to end |
| [docs/SETUP-IDE.md](docs/SETUP-IDE.md) | Cursor / Claude Code, including hooks |
| [docs/SETUP-VIBES.md](docs/SETUP-VIBES.md) | MuleSoft Vibes / Anypoint Code Builder |
| [docs/SETUP-AGENTFORCE.md](docs/SETUP-AGENTFORCE.md) | Hosted MCP + REST server, Agentforce wiring |
| [docs/WIRE-LIVE-INTEGRATIONS.md](docs/WIRE-LIVE-INTEGRATIONS.md) | Anypoint, Slack, Jira credentials |
| `docs/TECHNICAL-DEEP-DIVE.html` | Architecture, security, scalability, testing, risks |
| `docs/VIBES-BEGINNER-GUIDE.html` | Step-by-step walkthrough of every skill |
| [`AGENTS.md`](AGENTS.md) | Guardrails and tool routing for AI assistants |

## 🤝 Contributing

Contributions are welcome — please open an issue or a pull request.

```bash
npm test             # 596 tests, node --test
npm run typecheck    # tsc --noEmit over JSDoc types
npm run lint         # eslint
npm run format       # prettier
```

All four must pass. When changing a compatibility matrix, state which Java target the change belongs
to — version bumps are usually target-specific, coordinate changes are almost always Java-neutral and
belong in every target. The parity test will catch a wrong answer.
