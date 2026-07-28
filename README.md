# mule-java17-upgrade-skills

A suite of composable **Claude Code skills** that automate the Java-8/11 → **Java-17**
(runtime **4.9.18**) upgrade of MuleSoft applications: assess a repo, rewrite the files
surgically, commit, open a pull request, track the job, and poll the merge/CI/deploy tail
to completion.

This is a skill-native reimplementation of the **Platform Lifecycle Orchestrator**
(`platform-lifecycle-orchestrator`), a MuleSoft 4.9.18 / Java 17 app that did the same job
as a REST API + 6 MCP tools. Every rewrite, the compatibility-matrix rules engine, the job
state machine, and the atomic-commit GitHub sequence are ported faithfully — then improved:
assessment runs against a **full local clone** (seeing custom Java, DataWeave POJOs, and CI
`java:` blocks the original regex transforms missed), every edit is explained in prose, and
the async worker collapses into one synchronous run plus a polling tail.

Two ways to run it: as **skills in your IDE** (Claude Code, no server) for hands-on upgrades,
or as a **hosted MCP + REST server** so a remote agent like **Agentforce** can drive the same
12 tools over the network — including the inbound HMAC CI/CD webhook. It also plugs into
**MuleSoft Vibes** (Anypoint Code Builder) as native Skills or a remote MCP server. See
[docs/SETUP-IDE.md](docs/SETUP-IDE.md), [docs/SETUP-AGENTFORCE.md](docs/SETUP-AGENTFORCE.md),
and [docs/SETUP-VIBES.md](docs/SETUP-VIBES.md).

## Why skills can do this better

- **Full-clone assessment** instead of paged GitHub API reads — catches custom Java sources,
  DW POJOs, matrix `java:` blocks, and env-var CI Java versions.
- **Explained edits** — every file change and warning is actionable prose, not an opaque diff.
- **Tunable rules** — the compatibility matrix stays a data file; gating rules are reused verbatim.
- **No infrastructure required** — job state is local JSON (mirrors the Object Store partitions);
  in the IDE flow, merge/CI/deploy detection is polling (`gh` + Anypoint verify), so no server is
  needed. When you *want* event-driven CD or remote agent access, the same tools run as a hosted
  MCP + REST server with the inbound HMAC webhook (see below).

## The skills

| Skill | Replaces | What it does |
|-------|----------|--------------|
| **mule-upgrade-agent** (interactive) | *(new — the human loop)* | Conversational conductor: gather inputs → assess → show warnings → present the connector version menu → pick a strategy → **dry-run the plan** → confirm → execute → stream job status. Non-destructive until you say go. **Start here for a guided upgrade.** |
| **mule-upgrade** (orchestrator) | `start_upgrade` pipeline | End-to-end: assess → apply → commit → PR → track, then poll the deploy tail. The non-interactive engine `mule-upgrade-agent` drives. |
| **mule-upgrade-assess** | `assess_app` + assessment DWL | Reads pom chain / `mule-artifact.json` / CI workflow against the matrix → `ChangePlan` + connector version menu + verbatim deployed-state check + summary. |
| **mule-upgrade-apply** | `applyEdits.dwl` + 8 rewrites | Applies the byte-preserving rewrites in fixed order → staged file contents. |
| **mule-upgrade-pr** | `pf-atomic-commit` / `pf-open-pr` / `pf-rollback` | Commit + open PR (local `git`/`gh` **or** GitHub Git Data API); revert PR. |
| **mule-upgrade-parent-pom** | `upgrade_parent_pom` | Pin the connectors a shared parent/BOM manages up to the matrix, open a PR. |
| **mule-upgrade-job** | Object Store + `jobStatus` + `reconcile` | JSON job store, status machine, stale-scan reconcile, reapply/delete. |
| **mule-upgrade-scan** | *(new — proactive)* | Scan the Anypoint fleet for apps still on old Mule/Java → count + candidate list mapped to repos. Runs on a timer and **pushes a Slack alert** when new stale apps appear (`scan_notify`, de-duped against remembered state). |
| **mule-upgrade-mcp** | shared HTTP listener + `mcp:tool-listener` | Hosted server: 12 tools over MCP JSON-RPC + REST, HMAC CI/CD webhooks, bearer auth. |

Each skill has a `SKILL.md` with YAML frontmatter (`name` + trigger-phrase `description`) so
Claude auto-invokes it, plus `scripts/` (Node.js, ES modules) and, where relevant, `references/`
(the bundled `compatibility-matrix.yaml`, `app-registry.yaml`, `transform-rules.md`).

## How they compose

```
mule-upgrade (orchestrator)
   │
   ├─ mule-upgrade-assess ──► ChangePlan  (uses the compatibility matrix: dynamic connectors + static gating)
   ├─ mule-upgrade-apply  ──► staged files [{path, content}]
   ├─ mule-upgrade-pr     ──► branch + commit + PR   (mode: local git/gh | GitHub REST API)
   └─ mule-upgrade-job    ──► job record + lock + branch index; reconcile polls PR/CI/deploy

mule-upgrade-parent-pom (standalone) ──► reuses mule-upgrade-apply + mule-upgrade-pr for one BOM pom
```

## Quick start

```bash
npm install          # js-yaml only
npm test             # node --test over tests/**  (310 tests)

# assess a local clone
node skills/mule-upgrade-assess/scripts/assess.js --repo /path/to/clone --app my-mule-app

# full upgrade → opens a PR (API mode)
node skills/mule-upgrade/scripts/upgrade.js start \
  --app my-mule-app --env dev --mode api \
  --coords '{"owner":"acme","repo":"my-mule-app","defaultBranch":"main"}' \
  --repo /path/to/clone --head-sha <sha>

# poll the merge/deploy tail
node skills/mule-upgrade/scripts/upgrade.js poll --stale-seconds 0

# upgrade a shared parent/BOM pom
node skills/mule-upgrade-parent-pom/scripts/parent_pom_cli.js \
  --repo-url https://github.com/acme/mule-apps/tree/develop/bom

# proactive: scan the fleet and push a Slack alert when new stale apps appear (run on a timer)
node skills/mule-upgrade-scan/scripts/scan_notify.js        # only pushes on change

# OR run the hosted server (12 tools over MCP JSON-RPC + REST + HMAC webhooks)
node server/server.js        # default :8080 — set MCP_BEARER_TOKEN to require auth
```

See each skill's `SKILL.md` for full flags, outcome objects, and exit codes; see
[docs/SETUP-AGENTFORCE.md](docs/SETUP-AGENTFORCE.md) for the server + Agentforce wiring.

## Configuration (env, all optional)

| Purpose | Variables |
|---------|-----------|
| GitHub (API mode) | `GITHUB_TOKEN` (local mode uses `gh` auth) |
| Slack notifications | `SLACK_WEBHOOK_URL`, `SLACK_CHANNEL` |
| Jira comments / auto-create | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_AUTO_CREATE`, `JIRA_PROJECT_KEY`, `JIRA_ISSUE_TYPE` |
| Anypoint deploy verify | `ANYPOINT_CLIENT_ID`, `ANYPOINT_CLIENT_SECRET`, `ANYPOINT_ORG_ID`, `ANYPOINT_BASE_URL`, `ANYPOINT_TOKEN_PATH`, `ANYPOINT_HEALTHY_STATUSES` |
| Job store location | `MULE_UPGRADE_HOME` (default `~/.mule-upgrade`) |
| Matrix source | Anypoint Exchange governed asset when `matrix.source=exchange*` (cached per `matrix.refreshSeconds`); bundled YAML fallback |

All notifications and Anypoint verification are **non-fatal** and **env-gated** — a missing
credential or an outage is logged and skipped, never a pipeline failure. This mirrors the
Mule app's `<try>`-wrapped notify sub-flows and the on-error-continue in `pf-verify-deployment`.

## Compatibility matrix (hybrid)

- **Static gating** (bundled `compatibility-matrix.yaml`, copied verbatim from the Mule app):
  runtime 4.6→4.9.18, Java 8/11→17, compiler source/target, mule-maven-plugin, MUnit / munit-extensions
  / weave versions, JPMS-flag removal, `manualReview` flags, `mule-artifact.json` targets. These do not
  live on the connector release-notes page, so they stay static and authoritative.
- **Matrix source:** when `matrix.source=exchange*` the FULL governed matrix (gating + connectors) is
  fetched from the Anypoint Exchange asset (`matrix.exchange`); on **any** fetch/parse failure — or an
  empty connectors block — it falls back to the bundled YAML (never a hard failure) and logs which
  source won (`matrixSource`). The connector list is otherwise the bundled, curated, Java-17-safe set.
- **Live connector enrichment:** per-connector *versions* are resolved from the Exchange **Graph API**
  and each connector's release-notes compatibility table is located via the curated
  `references/connector-notes-map.yaml` (artifactId → release-notes URL). This enriches the choice
  menu (below); it never replaces the curated pins. (The earlier release-notes-**index** scrape +
  `~/.mule-upgrade/matrix-cache.json` disk cache have been retired — the index page carries no Maven
  coordinates, so it was superseded by the Graph + notes-map resolver.)
- `--no-fetch` forces the bundled matrix and skips all live enrichment.
- **Lean assess + the Full Split:** by default `assess` is **lean and fast** — it emits the network-free
  ChangePlan (including `connectorsInApp[]`: each app connector's `current` version, `matrixSet` pin, and
  `willChange`) + deployed-state + warnings, with **no** live version/drift fetches. The two live,
  advisory features are split into their own opt-in tools so the common path stays quick:
  - **Connector version choice** → the **`resolve_versions`** tool (or `assess --versions` /
    `includeVersions`). Builds a per-connector **menu** (`connectorChoices[]`), SCOPED to the app's
    connectors, from two live non-fatal signals — the Exchange Graph (`latest-in-major`, `latest`) and
    each connector's release-notes OpenJDK table (`first-compatible`, the minimum Java-17-safe version).
    Live "latest" is **never** auto-adopted (it may be a breaking major); a `staleness` advisory fires
    when a newer in-major version exists. `start_upgrade` accepts a `versionStrategy` (`min` |
    `first-compatible` | `in-major` | `latest` | `manual`) + per-connector `connectorSelections` (it
    computes the menu internally regardless of the lean default). See `mule-upgrade-assess/SKILL.md`.
  - **Matrix-drift advisory** → the **`check_drift`** tool (or `assess --drift` / `includeDrift`). The
    static gating pins (runtime patch, mule-maven-plugin, MUnit plugins) are *minimums required for Java
    17*, not "newest available", so they stay bundled — but `matrix_drift.js` audits them against
    MuleSoft's live Maven metadata (plus connector staleness) and **warns** (never auto-applies) when a
    pin trails the latest release on its LTS line. Emitted as `matrixDrift`; disable the built-in path
    with `matrix.driftCheck: "false"`.
- `--no-fetch` forces the bundled matrix and lean output (skips all live enrichment).

## The 8 rewrites (byte-preserving)

Applied by `mule-upgrade-apply` in this fixed order (see `references/transform-rules.md`):
`depVersion → pluginVersion → pomProperty → munitRuntimeVersion → muleArtifactJson → ciWorkflow →
munitArgLines → pomVersion`. `parent_pom` handles the shared-BOM case. Each preserves every byte it
does not intend to change; the MUnit `dw-rewrite-suite` expectations are ported as unit tests.

## Job lifecycle

State machine (ported verbatim): `PROCESSING → ASSESSING → COMMITTING → COMMITTED → PR_OPEN →
DEPLOYING → DEPLOYED → CLOSED`, with `NO_CHANGE`, `MUNIT_FAILED`, `DEP_GUARD_FAILED`, and
`FAILED_ASSESS / FAILED_COMMIT / FAILED_CI / FAILED_DEPLOY / FAILED_INTERRUPTED` terminals. On any
pipeline error the job goes terminal and the app lock is released (VALIDATION/STALE_PLAN/NOT_FOUND →
`FAILED_ASSESS`; else `FAILED_COMMIT`). `reconcile` sweeps stale jobs: stale `PR_OPEN` → poll the PR;
stale `DEPLOYING` → verify the deploy; stale early-stage → `FAILED_INTERRUPTED` + release lock.

## Layout

```
mule-java17-upgrade-skills/
├── README.md
├── package.json                 # type: module; npm test = node --test
├── lib_shared/                  # dates.js (nowUtc), semver.js (lt/toNums/bumpMinor)
├── skills/
│   ├── mule-upgrade-agent/      # interactive conductor (conversation layer over the tools)
│   ├── mule-upgrade/            # orchestrator (start + poll)
│   ├── mule-upgrade-assess/     # assess.js + lib/{matrix,matrix_fetch,pom_chain,pom_parse,topology,assess_engine}
│   ├── mule-upgrade-apply/      # apply_edits.js + rewrites/*.js
│   ├── mule-upgrade-pr/         # commit_pr.js, rollback.js, pr.js + lib/{gh_api,pr_meta}
│   ├── mule-upgrade-parent-pom/ # parent_pom.js, parent_pom_cli.js + lib/repo_url
│   ├── mule-upgrade-job/        # jobstore.js, status.js, reconcile.js, job.js
│   ├── mule-upgrade-scan/       # scan.js (fleet audit) + scan_notify.js (proactive Slack push)
│   └── mule-upgrade-mcp/        # SKILL.md for the hosted server (below)
├── server/                     # server.js + lib/{mcp,tools,schema,auth,webhook}.js
├── config/                     # config[-<env>].yaml + config-secure-<env>.yaml (AES)
├── docs/                       # SETUP-IDE.md, SETUP-AGENTFORCE.md
├── .github/workflows/          # test.yml, upgrade.yml (dispatch→CLI), ci-result.yml (callback)
└── tests/                       # node --test suites (assessment, rewrites, job, pr, orchestrate, parent_pom, server)
```

## Two runtimes: IDE skills vs. hosted server

- **IDE (skills)** — the default. Claude Code invokes the skills against a local clone or the
  GitHub API; merge/CI/deploy detection is **polling** (`gh` + Anypoint verify). No server, no
  open ports. See [docs/SETUP-IDE.md](docs/SETUP-IDE.md).
- **Hosted server (`mule-upgrade-mcp`)** — for remote agents (Agentforce) and event-driven CD.
  `server/server.js` exposes the same 12 tools over **MCP JSON-RPC** (`POST /mcp`) and a **REST**
  facade (`/api/v1/tools/*`), guarded by a bearer token, plus **HMAC-verified** CI/CD webhooks
  (`POST /webhook/cd-result`) that drive the job state machine without polling. Every tool call is
  checked against its JSON Schema (the schema-contract guard) before dispatch. See
  [docs/SETUP-AGENTFORCE.md](docs/SETUP-AGENTFORCE.md).

Both share the identical skill scripts and job store — the server is a thin transport over them.

### CI shims (`.github/workflows/`)

- `test.yml` — runs the Node test suite on every push/PR.
- `upgrade.yml` — `workflow_dispatch` that runs the orchestrator `start` CLI from CI (inputs
  passed through quoted `env:`, never interpolated into the shell).
- `ci-result.yml` — reusable callback an upgraded target repo runs post-CI to POST an
  HMAC-signed result to the server's `/webhook/cd-result`.

## Not reproduced (by design)

- **Exchange-hosted matrix facade** — reproduced directly: when `matrix.source=exchange*` the governed
  asset is fetched via the Exchange client with the bundled YAML as fallback (see above). The earlier
  release-notes-index scrape + `~/.mule-upgrade/matrix-cache.json` disk cache have been retired in favour
  of the Exchange Graph + `connector-notes-map.yaml` resolver.

The inbound HMAC webhook the Mule app hosted **is** reproduced — but only in the optional hosted
server, not in the IDE-skills flow (a skill cannot host a long-lived listener, so it polls instead).

## Requirements

Node.js ≥ 18 (developed on v24), `git` + `gh` (local mode), a `GITHUB_TOKEN` (API mode). Only runtime
dependency is `js-yaml`.
