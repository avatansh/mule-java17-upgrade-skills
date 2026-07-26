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

Unlike the app upgrade (`mule-upgrade`), this touches **one** pom, takes **no lock**, and
runs **no assessment pipeline**. It is a focused "make this BOM Java-17-ready" action.

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

```bash
# API mode (read pom via Contents API, commit + PR via Git Data API)
node skills/mule-upgrade-parent-pom/scripts/parent_pom_cli.js \
  --repo-url https://github.com/acme/mule-apps/tree/develop/bom \
  --jira BOM-7

# equivalent with explicit coordinates
node skills/mule-upgrade-parent-pom/scripts/parent_pom_cli.js \
  --owner acme --repo mule-apps --branch develop --pom-path bom/pom.xml

# local mode (read from a clone; git checkout -b / push / gh pr create)
node skills/mule-upgrade-parent-pom/scripts/parent_pom_cli.js \
  --owner acme --repo mule-apps --mode local --repo-root /path/to/clone --pom-path bom/pom.xml
```

Flags: `--repo-url` OR (`--owner` + `--repo`) required; `--pom-path`, `--branch`,
`--mode api|local` (default `api`), `--repo-root` (local mode), `--jira`, `--jira-base-url`,
`--env` (log-only), `--release-notes-url`, `--no-fetch` (skip dynamic matrix fetch).

**Exit codes:** `0` ok (NO_CHANGE / PR_OPEN), `5` VALIDATION (unresolved coords / unreadable
pom), `2` usage, `1` other.

## Outcome objects

- **NO_CHANGE** — `{status:"NO_CHANGE", upgraded:false, edits:[], jobId, appName, pomPath, jiraUrl}`.
  The parent already meets the matrix.
- **PR_OPEN** — `{status:"PR_OPEN", upgraded:true, branchName, commitSha, prNumber, prUrl,
  edits:[...], jobId, appName, pomPath, jiraUrl}`. `edits` lists each pinned connector
  (`kind:"pomProperty"|"depVersion"`) plus the parent-version bump (`kind:"pomVersion"`).

`appName` is the repo name (a BOM has no app name); `jobId` is deterministic per request.

## What gets rewritten (`rewriteParentPom`)

- **Managed via property** — `<http.connector.version>1.7.0</http.connector.version>` below the
  matrix `set` → replaced literally; the referencing `${...}` inline version is driven by it.
- **Managed via inline `<version>`** — a literal version on a `dependencyManagement` entry below
  the matrix → replaced in that dependency block only.
- **Parent's own `<version>`** — minor-bumped (`bumpMinor`) when at least one connector was pinned
  and the version is a literal (not `${...}`); no-op when nothing changed.

Only connectors the parent already manages are touched — never added. Every other byte is preserved.

## Matrix source

Same hybrid resolver as assess: dynamic connector versions fetched from the release-notes page
(24h disk cache) merged over the bundled static gating rules; `--no-fetch` forces the bundled
YAML. The chosen source is reported as `matrixSource`.

## Verification

`node --test tests/parent_pom.test.js` — repo-URL parsing edge cases (plain, `/tree/`, `/blob/`,
explicit-override, explicit-pomPath), NO_CHANGE, the managed-connector PR_OPEN path (asserts the
pinned `1.9.0` property + staged single pom), tree-URL-driven read (`bom/pom.xml`@`develop`), the
Contents-API base64 decode, and VALIDATION on unresolved coordinates.
