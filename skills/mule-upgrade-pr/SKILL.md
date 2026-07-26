---
name: mule-upgrade-pr
description: >-
  Commit a set of Java-17 upgrade file edits onto a fresh branch and open a pull request, in either
  local-clone mode (git + gh) or GitHub REST API mode (atomic Git Data API: blob → tree → commit →
  ref → PR). Enforces a stale-plan guard (repo HEAD must still equal the assessed headSha), picks a
  collision-free branch name (migrate/<app>-<runtime>-java<java>, then -1..-50, else -<jobId>), and
  can open a revert PR that restores the pre-upgrade tree when a deploy fails. Use it after
  mule-upgrade-apply has produced rewritten files. Triggers on "open a PR for this mule upgrade",
  "commit the java 17 changes and raise a pull request", "roll back the failed upgrade deploy",
  "revert the java 17 upgrade PR".
---

# mule-upgrade-pr

Ports `system/github.xml` — `pf-atomic-commit`, `pf-open-pr`, and `pf-rollback` — into a dependency-free
Node.js skill. It takes the staged file edits from **mule-upgrade-apply** and lands them as a single
commit on a new branch, then opens the upgrade PR. Two interchangeable modes cover both a local clone
and a remote-only workflow.

## Modes

| Mode | How it commits | When to use |
|------|----------------|-------------|
| `api` (default) | GitHub Git Data API — creates a branch ref at the assessed `headSha`, one blob per file, a tree with `base_tree=headSha`, a commit with `parents=[headSha]`, moves the ref, then opens the PR. Fully atomic; never touches a working copy. | CI, no local checkout, or when you want the exact byte-level commit the Mule app produced. |
| `local` | `git checkout -b`, writes the files, `git commit`, `git push`, `gh pr create`. | You already have the repo cloned and `gh` authenticated. |

Both modes enforce the **stale-plan guard**: if the repo HEAD moved since assessment
(`changePlan.headSha`), they raise a `STALE_PLAN` conflict so a stale ChangePlan is never committed
on top of newer work. Disable with `--no-stale-guard` only when you know the plan is fresh.

## Branch naming

`branchBase = migrate/<appName>-<targetRuntime>-java<targetJavaVersion>`. If that ref exists, tries
`-1 … -50`; if all are taken, falls back to `-<jobId>` (guaranteed unique). In api mode the existing
refs come from `git/matching-refs/heads/<base>`; in local mode from `git for-each-ref`.

## How to run

```bash
cd skills/mule-upgrade-pr/scripts

# API mode — coords + changePlan + staged files as JSON (files may use contentFile paths):
GITHUB_TOKEN=… node pr.js commit --mode api \
  --app my-app --job job-abc \
  --coords '{"owner":"o","repo":"r","defaultBranch":"main"}' \
  --change-plan-file ./changeplan.json \
  --files '[{"path":"pom.xml","contentFile":"./out/pom.xml"}]' \
  --jira J1U-123 --jira-base-url https://acme.atlassian.net \
  --warnings '["custom Java detected"]'

# Local mode — against a working clone:
node pr.js commit --mode local --repo-root /path/to/clone \
  --app my-app --job job-abc \
  --change-plan-file ./changeplan.json \
  --files '[{"path":"pom.xml","contentFile":"./out/pom.xml"}]'

# Rollback — open a revert PR restoring the pre-upgrade tree (api):
GITHUB_TOKEN=… node pr.js rollback \
  --coords '{"owner":"o","repo":"r","defaultBranch":"main"}' \
  --commit-sha <upgradeCommitSha> --branch migrate/my-app-4.9.18-java17 \
  --app my-app --job job-abc
```

`commit` prints `{branchName, commitSha, prNumber, prUrl}` (api) or `{branchName, commitSha, prUrl}`
(local). `rollback` prints `{revertBranch, revertCommitSha, prNumber, prUrl, baseSha}`. Feed
`branchName`/`commitSha`/`prNumber`/`prUrl` back into **mule-upgrade-job** (`job.js set --status
PR_OPEN …`) and `putBranchIndex` so the branch→job correlation used by reconcile is recorded.

## Rollback strategy (pf-rollback)

The upgrade commit has exactly one parent — the pre-upgrade `baseSha`. Rather than a git revert diff,
`rollback` recreates that parent's *tree* on a fresh `revert/<branch>` cut from the current default
branch HEAD and commits it, restoring the exact pre-upgrade file state, then opens
`Revert: Java 17 upgrade <app>`. This is the same approach as the Mule `pf-rollback` flow and is
immune to intervening unrelated changes on other files.

## API endpoint sequence (api mode)

```
GET   /repos/{o}/{r}/commits/{defaultBranch}              → HEAD sha (stale-plan check)
GET   /repos/{o}/{r}/git/matching-refs/heads/{base}       → collision probe
POST  /repos/{o}/{r}/git/refs                             → create branch at headSha
POST  /repos/{o}/{r}/git/blobs            (× files)       → blob per file (utf-8)
POST  /repos/{o}/{r}/git/trees            base_tree=head  → tree
POST  /repos/{o}/{r}/git/commits          parents=[head]  → commit
PATCH /repos/{o}/{r}/git/refs/heads/{branch}              → move ref to commit
POST  /repos/{o}/{r}/pulls                                → open PR
```

## Improvements over the Mule app

- **Same commit, no runtime** — the Git Data API sequence is reproduced byte-for-byte with only
  `fetch`; no Mule worker, no Object Store round-trips for `coords`/`jobId`.
- **Injectable client** — `GitHubApi` accepts a `fetchImpl`, so the entire commit + PR + rollback flow
  is unit-tested (endpoint order, `base_tree`/`parents`, stale-plan conflict, collision suffixing)
  with zero network in `tests/pr.test.js`.
- **Two modes, one interface** — the same `pr.js commit` drives a local clone or a remote-only repo;
  the orchestrator picks per environment.

## Verification

`tests/pr.test.js` (14 tests): pr_meta units (branch base/collision/fallback, title, body with &
without Jira/warnings, commit + revert helpers), the full api-mode Git Data sequence + `base_tree`/
`parents` assertions (ported from `sys-github-suite.xml` atomic-commit-happy & open-pr), the
`STALE_PLAN` guard (atomic-commit-stale), branch-collision suffixing, and the rollback tree-restore.
Run `npm test` from the repo root.
