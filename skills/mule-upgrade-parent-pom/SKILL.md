---
name: mule-upgrade-parent-pom
description: >-
  Upgrade a SHARED parent/BOM pom.xml so the connector versions it manages meet the Java 17
  compatibility matrix, then open a pull request. Use this when the user says things like
  "upgrade the parent POM", "bump the BOM connectors for Java 17", "make our shared parent
  pom Java-17 ready", or points at a repo/BOM rather than an application. This is a targeted,
  single-file operation — distinct from mule-upgrade, which upgrades a whole application.
---

# mule-upgrade-parent-pom (SKILL 4)

Port of `pf-upgrade-parent-pom` (`process/parent-pom-upgrade.xml`). A parent/BOM pom
centralizes connector versions via `<properties>` referenced by `dependencyManagement`
(or literal inline `<version>`s). This skill pins those managed connectors up to the
Java-17 matrix `set` versions, minor-bumps the parent's OWN version when anything changed,
and opens a PR — reusing SKILL 2's `rewriteParentPom` and SKILL 3's commit+PR.

It runs as a **tracked job by default** (single-flight lock + job record + pollable status), exactly
like an app upgrade — so a parent/BOM upgrade shows up in `get_job_status` (with `kind:
parentPomUpgrade`) and advances through `reconcile`. Pass `--no-job` for an untracked one-shot
(tests/dry runs). It also drives the interactive **chained** parent → BOM → app flow (detect nested
inheritance, repoint a `<parent>` at a new BOM/parent, and amend an app's already-open PR).

## Coordinate resolution (the tree-URL fix)

`repoUrl` — when present — is **always** parsed for `owner/repo/branch/pomPath`. An explicit
`--owner/--repo` overrides **only** owner/repo, so a `/tree/<branch>/<subdir>` URL keeps its
branch and sub-path. This mirrors the Mule bug fix: callers (e.g. an LLM) often pass BOTH a
`/tree/develop/bom` URL AND their own parsed owner+repo; the old short-circuit discarded the
URL's branch + sub-path and read the root `pom.xml` on the default branch (spurious NO_CHANGE).

| Input                                                      | owner | repo       | branch  | pomPath        |
|------------------------------------------------------------|-------|------------|---------|----------------|
| `https://github.com/o/r.git`                               | o     | r          | (repo default) | `pom.xml`  |
| `https://github.com/av/mule-apps/tree/develop/bom`         | av    | mule-apps  | develop | `bom/pom.xml`  |
| `.../blob/main/nested/custom-pom.xml`                      | o     | r          | main    | `nested/custom-pom.xml` |

Base branch precedence: `--branch` → URL branch → repo's default branch. `pomPath`
precedence: `--pom-path` → URL sub-path → `pom.xml`.

## Usage

`--env <dev|local|prod>` is **required** (or set `MULE_UPGRADE_ENV` once in `.env`) — no default,
mirroring Mule's `-Denv`. It selects the `config-<env>.yaml` + `config-secure-<env>.yaml` pair. The
examples below assume `MULE_UPGRADE_ENV` is set in `.env`; otherwise append `--env dev`.

```bash
# API mode (read pom via Contents API, commit + PR via Git Data API)
node skills/mule-upgrade-parent-pom/scripts/parent_pom_cli.js \
  --repo-url https://github.com/acme/mule-apps/tree/develop/bom \
  --env dev --jira BOM-7

# equivalent with explicit coordinates
node skills/mule-upgrade-parent-pom/scripts/parent_pom_cli.js \
  --owner acme --repo mule-apps --env dev --branch develop --pom-path bom/pom.xml

# local mode (read from a clone; git checkout -b / push / gh pr create)
node skills/mule-upgrade-parent-pom/scripts/parent_pom_cli.js \
  --owner acme --repo mule-apps --env dev --mode local --repo-root /path/to/clone --pom-path bom/pom.xml
```

Flags: `--repo-url` OR (`--owner` + `--repo`) required; `--env <dev|local|prod>` (**required** — or
`MULE_UPGRADE_ENV`; also the log-only environment label on the job), `--pom-path`, `--branch`,
`--mode api|local` (default `api`), `--repo-root` (local mode), `--jira`, `--jira-base-url`,
`--no-fetch` (skip the live matrix fetch → bundled YAML), `--no-job` (opt OUT of the tracked job → the
untracked one-shot).

Read-only + chained flags: `--detect-only` (report inheritance + edit preview, no lock/PR),
`--parent-ref-artifact <a> --parent-ref-version <v> [--parent-ref-group <g>]` (repoint this pom's
`<parent>` at a new BOM/parent version), `--bump-own-version` (force the own-version minor bump even
with no connector edits). Final app-PR amend: `--update-app-job <appJobId> --parent-ref-artifact <a>
--parent-ref-version <v>` (no `--env` needed).

**Exit codes:** `0` ok (NO_CHANGE / PR_OPEN / DETECTED / PR_UPDATED), `4` CONFLICT (repo already
locked), `5` VALIDATION (unresolved coords / unreadable pom) or FAILED_*, `2` usage, `1` other.

### Tracked mode (default; `--no-job` to opt out) — the job/lock/assess pipeline

By default this skill runs the SAME assess+commit phases wrapped in the app-upgrade's job/lock
machinery, so a parent/BOM upgrade is a tracked, single-flight operation. `--no-job` reverts to the
untracked one-shot (no lock, no job):

```
assess (read-only) ──► NO_CHANGE short-circuit (no lock, no job)
     │ edits exist
     ▼
store.createJob (acquire lock — CONFLICT if THIS module <repo>::<pomPath> is already locked) ──► PROCESSING
     ▼ COMMITTING
commit + open PR ──► PR_OPEN (+ branch→job index; lock retained for the deploy tail)
     ▼ on error
FAILED_ASSESS (VALIDATION / STALE_PLAN / 404) | FAILED_COMMIT (else) + release lock
```

- **Assess-before-lock:** a `NO_CHANGE` parent never creates a job or takes a lock (mirrors the app
  upgrade's `ALREADY_UPGRADED` short-circuit).
- **Single-flight lock keyed per MODULE** (`lockKey = <repo>::<pomPath>`): two upgrades of the SAME
  pom are mutually exclusive, but different modules never block each other. This matters both ways:
  the common case (parent-pom in its OWN repo, separate from the app) naturally has distinct keys; and
  the monorepo edge case (app + parent-pom + BOM in one repo) also works — the BOM PR, parent-pom PR,
  and app PR can be open at once because each locks `<repo>::bom/pom.xml`, `<repo>::parent-pom/pom.xml`,
  etc. A second tracked run of the SAME pom while the first holds the lock returns `CONFLICT` /
  `UPGRADE_IN_PROGRESS` with the in-flight `prUrl` (exit 4).
- **Failure taxonomy + lock release:** a commit failure drives the job to `FAILED_COMMIT` (or
  `FAILED_ASSESS` for validation/404), stamps `completedAt`, and **releases the lock** so a retry can
  proceed — the same terminal-state contract as the app orchestrator.
- **Notifications are opt-in per run:** nothing is posted and no ticket is created unless you pass
  `--slack` and/or `--jira-mode comment|create` (MCP: `notifyPrefs`) — a configured Slack webhook or
  Jira token is capability, not consent. The choice is persisted on the job, so the `PR_OPEN`
  announcement and every later transition found by `reconcile` honor the same answer.
- The job is inspectable / manageable with the `mule-upgrade-job` tools (`get_job_status`, `delete_job`,
  `reapply_job`) and the branch is indexed for the reconcile/poll tail.

A pre-lock **VALIDATION** error (unresolved coords, unreadable pom) is raised as a throw *before* any
job/lock is created — never a `FAILED_*` job — so a bad request leaves no orphaned state.

## Outcome objects

- **DETECTED** (`--detect-only`) — `{status:"DETECTED", inheritance:{parent, importedBoms,
  inheritsFromShared}, editsPreview:[...], appName, pomPath, coords, headSha}`. Read-only: no lock, no
  PR. Use it to recommend upgrading the BOM before the parent pom.
- **NO_CHANGE** — `{status:"NO_CHANGE", upgraded:false, edits:[], inheritance, jobId, appName, pomPath,
  jiraUrl}`. The parent already meets the matrix.
- **PR_OPEN** — `{status:"PR_OPEN", upgraded:true, branchName, commitSha, prNumber, prUrl,
  edits:[...], inheritance, jobId, appName, pomPath, jiraUrl}`. `edits` lists each pinned connector
  (`kind:"pomProperty"|"depVersion"`), the optional chained parent-ref repoint
  (`kind:"pomParentVersion"`), and the own-version bump (`kind:"pomVersion"`).
- **PR_UPDATED** (`--update-app-job` / `update_open_pr_parent_ref`) — `{status:"PR_UPDATED", jobId,
  appName, branchName, commitSha, prNumber, prUrl, parentRef:{artifactId, from, to}}`. One commit was
  added onto the app's already-open PR branch and recorded as an amendment on the app job.

`appName` is the repo name (a BOM has no app name); `jobId` is deterministic per request.

## What gets rewritten (`rewriteParentPom`)

- **Managed via property** — `<http.connector.version>1.7.0</http.connector.version>` below the
  matrix `set` → replaced literally; the referencing `${...}` inline version is driven by it.
- **Managed via inline `<version>`** — a literal version on a `dependencyManagement` entry below
  the matrix → replaced in that dependency block only.
- **Parent's own `<version>`** — minor-bumped (`bumpMinor`) when at least one connector was pinned,
  OR the chained parent-ref changed, OR `bumpOwnVersion` was requested — and the version is a literal
  (not `${...}`); no-op when nothing changed. The detector tolerates interposed `<name>`/`<packaging>`/
  comments between `<artifactId>` and `<version>` (Exchange BOMs require a `<name>`), so the bump is
  never silently skipped.
- **Chained `<parent>` reference** (`parentRef`) — the `<version>` inside this pom's `<parent>` block
  is repointed at a new BOM/parent version (`kind:"pomParentVersion"`), matched by groupId+artifactId.

Only connectors the parent already manages are touched — never added. Every other byte is preserved.

## Matrix source

Same resolver as assess: when `matrix.source=exchange*` the governed matrix is fetched from the
Anypoint Exchange asset over the bundled static gating rules; `--no-fetch` forces the bundled
YAML. The chosen source is reported as `matrixSource` (`exchange:<ver>` / `bundled`).

## Verification

`node --test tests/parent_pom.test.js` — repo-URL parsing edge cases (plain, `/tree/`, `/blob/`,
explicit-override, explicit-pomPath), NO_CHANGE, the managed-connector PR_OPEN path (asserts the
pinned `1.9.0` property + staged single pom), tree-URL-driven read (`bom/pom.xml`@`develop`), the
Contents-API base64 decode, and VALIDATION on unresolved coordinates. The **Tier 2b** `runParentPomJob`
suite runs against a real sandboxed jobstore: NO_CHANGE takes no lock/job, PR_OPEN persists the job +
retains the lock + indexes the branch, a second run returns CONFLICT (single-flight, no second job), a
commit failure yields FAILED_COMMIT + lock release, and a pre-lock VALIDATION error creates no job.
