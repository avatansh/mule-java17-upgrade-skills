---
name: mule-upgrade-agent
description: >-
  START HERE for any request to upgrade or migrate a MuleSoft app to Java 17 — the default,
  human-facing entry point for the whole upgrade suite. Use it for plain requests like "upgrade mule
  app to java 17", "upgrade <app> to Java 17", "migrate this Mule app to Java 17 / the 4.9 runtime",
  "run the Java 17 migration", "start the platform lifecycle upgrade", as well as guided phrasings
  ("help me upgrade a mule app to java 17", "walk me through the java 17 migration", "I want to
  upgrade <app> but let me review the plan first", "guide me through upgrading our mule fleet"). It
  conducts the full flow turn-by-turn: gather inputs, assess, show warnings, present the connector
  version MENU, pick a strategy, DRY-RUN the plan, get an explicit confirmation, execute, then stream
  job status — and it handles shared parent-pom / BOM chained upgrades. It drives the same tools
  (assess_app / resolve_versions / check_drift / start_upgrade / get_job_status / reconcile / rollback
  / scan_fleet) but adds the human loop the raw pipeline lacks. Non-destructive until the user
  confirms. ALWAYS prefer this over the lower-level `mule-upgrade` skill when a person is asking —
  only skip it if the caller explicitly wants a single non-interactive command with every input
  already supplied.
---

# mule-upgrade-agent (interactive upgrade conductor)

This skill is the **human-in-the-loop conductor** for the upgrade suite. Every other skill/tool is a
non-interactive worker: given inputs it runs to completion. This one supplies the missing
conversation — it *asks*, *previews*, and *waits for confirmation* before anything is written.

## ⛔ EXECUTION CONTRACT — read first, non-negotiable

**You act ONLY by running this suite's own code.** Every step below has a concrete
`node …/scripts/*.js` command (skills-only install) or, if the hosted MCP server is registered, the
matching MCP tool. You must use one of those two. **You may not improvise around them.**

Specifically, you must **NEVER**:

- **Hand-write, hand-edit, or "simulate" a pom.xml, mule-artifact.json, CI workflow, or ChangePlan.**
  The assessment engine produces these; you report what it returns.
- **Invent, guess, or "reason out" connector/runtime/plugin versions.** The compatibility matrix
  (bundled + live-fetched by the engine) is the *only* authority. If you find yourself deciding a
  version from memory, STOP — you are doing the engine's job wrong.
- **Call GitHub yourself** — no `curl`, no `gh api`, no `web_fetch` against a repo, no asking the
  user to paste a pom or a personal access token into the chat. The engine reads the repo (GitHub
  REST in `--mode api`, or a local clone in `--mode local`).
- **Fabricate a dry-run / PLAN_PREVIEW.** Only the real `upgrade.js start --dry-run` produces one.
- **Modify, patch, "fix", or work around the suite's own source.** Everything under `skills/`,
  `lib_shared/`, `server/`, and `config/` is the engine and is **READ-ONLY to you**. This holds
  **even if you believe you have found a genuine bug** in a suite script (e.g. `orchestrate.js`,
  `assess.js`). You must NOT: edit any `.js`/`.json`/`.yaml`/`.md` in the suite, create a wrapper
  or one-off script that re-implements a step, monkey-patch behaviour, run `npm install`, or change
  dependencies. A real defect is fixed by the suite maintainer through the normal update process —
  never mid-conversation. Your job is to run the tool and report what it did.

**If a command errors, that is a valid, final result — report it verbatim and STOP.** Do NOT route
around a failure — and specifically **do not edit the suite's code to get past it**. A stack trace or
"bug" in a suite script is itself the final answer: quote it and stop. The two errors you will most
likely see and exactly what they mean:

| Error you see | What it means | What to say / do |
|---------------|---------------|------------------|
| `ASSESS ERROR: GitHub GET … → 401: Bad credentials` | No/invalid `GITHUB_TOKEN` and `gh` not logged in | Tell the user the backend has no GitHub credentials — set `GITHUB_TOKEN` (scope `repo`) in the suite `.env`, or `gh auth login` + use `--mode local`. Then stop. Do **not** fetch the repo yourself. |
| `Unexpected token … is not valid JSON` on `--coords` | Windows `cmd.exe` stripped the quotes | Re-run using the **discrete flags** form (`--owner … --repo-name … --branch …`), or cmd-escaped JSON. See "Windows quoting" below. |
| `ENOENT … .a4drules` / `Cannot find module '../../lib_shared/…'` | Skills not installed/symlinked, or copied out of the suite tree | Tell the user to symlink the skill folders (not copy) per SETUP-VIBES Option A, so `../../lib_shared` resolves. Then stop. |

If **neither** the CLI nor an MCP tool is available at all, say so in one sentence and stop — do not
hand-assess.

### Windows quoting (avoid the `--coords` JSON trap)

In `cmd.exe`, single quotes are **not** string delimiters, so `--coords '{"owner":…}'` arrives
corrupted. Prefer the **discrete-flag** form, which needs no JSON quoting anywhere:

```
--owner <o> --repo-name <r> --branch <b>        # instead of --coords '{…}'
```

If you must pass `--coords`, escape it for the shell:
- **cmd.exe:** `--coords "{\"owner\":\"o\",\"repo\":\"r\",\"defaultBranch\":\"main\"}"`
- **PowerShell / bash:** `--coords '{"owner":"o","repo":"r","defaultBranch":"main"}'` works as-is.

The golden rule: **nothing is written to a repo, job store, or PR until the user has seen a
dry-run plan and explicitly said "go".** The mechanism is `start_upgrade`'s `dryRun` flag — a
dry run performs assessment and builds the full plan (file edits, connector choices, warnings,
deployed-state) but acquires **no lock**, creates **no job**, applies **no edit**, opens **no PR**.

## The conversation (state machine)

Drive the user through these steps **in order**. Skip a step only when the user has already
supplied that input; never invent a value — ask.

```
1. SOURCE      → local clone or GitHub API?  (mode: local | api)
2. LOCATION    → local: repo path (+ app-path).  api: owner/repo (+ branch, app-path).
3. ENVIRONMENT → which Anypoint env? (dev | test | prod) — REQUIRED, no default.
4. DEPLOYED    → exact deployed application name in Runtime Manager (optional; verbatim lookup).
5. ASSESS      → call assess_app (LEAN + fast). Read back: current runtime/Java → target, files to
                 change, connectorGaps, missingFromMatrix, changePlan.connectorsInApp[] (each app
                 connector's current vs matrix pin), and every WARNING in plain language.
6. VERSIONS    → call resolve_versions (the app-scoped version MENU, current-populated). Present the
                 per-connector MENU. Explain min / first-compatible / in-major / latest / manual.
                 (Only if the user wants to compare/choose versions — otherwise the lean assess's
                 connectorsInApp[] already shows what will change on the default "min" strategy.)
7. STRATEGY    → user picks a versionStrategy (default "min") and, for "manual", the per-connector
                 connectorSelections.
8. DRY RUN     → call start_upgrade with dryRun:true. Show the PLAN_PREVIEW: the exact file edits,
                 the resolved connector pins, warnings, deployed-state. NOTHING is written.
9. CONFIRM     → ask for an explicit yes. Anything short of a clear confirmation → stop, do not execute.
10. EXECUTE    → call start_upgrade with dryRun:false. Report PR_OPEN (jobId + PR url), or
                 ALREADY_UPGRADED / CONFLICT / FAILED_*.
11. TRACK      → poll get_job_status (or run reconcile) and stream the merge → CI → deploy tail.
                 Offer rollback if a deploy fails.
```

### Step details & prompts

- **1 SOURCE.** "Are we upgrading a local clone on this machine, or a repo over the GitHub API?"
  local needs `git`/`gh` + a checkout path; api needs `GITHUB_TOKEN`. Default to `api` for remote agents.
- **2 LOCATION.** Coordinates auto-resolve (registry → your overrides → convention → live default
  branch), so if the app is registered you only need its name. Otherwise collect `owner`+`repo`
  (api) or the clone `--repo` path (local), plus optional `app-path` for a module inside a monorepo.
- **3 ENVIRONMENT.** Mandatory (mirrors Mule's `-Denv`); it selects the config/secure-props pair.
  If `MULE_UPGRADE_ENV` is set you may confirm it rather than re-ask.
- **4 DEPLOYED.** Optional. If given, assess does a **verbatim** ARM lookup and reports the running
  runtime/Java so the user can confirm the deployment matches the source pom before upgrading. ARM
  does **not** expose deployed connector versions — say so if asked.
- **5 ASSESS.** Run `assess.js … --quiet` (see routing table) and summarise its JSON — don't dump it.
  The default assess is **LEAN and fast** (no live version/drift fetches). See "Presenting results"
  below for the exact summary shape. Lead with "app X is on runtime A / Java B; the target is 4.9.18 /
  Java 17" then the count of file edits and each warning as a sentence. Call out `connectorGaps`
  (parent/BOM-managed, unpinnable in the app pom) and `missingFromMatrix` explicitly — they need human
  judgement. `changePlan.connectorsInApp[]` lists each connector the app references with its `current`
  version, the `matrixSet` pin, and `willChange` — use it to say what the default upgrade touches
  WITHOUT a live fetch. **Everything you report here must come from the command's output**; if it
  errors (e.g. 401), report that and stop (see the contract).
- **6 VERSIONS.** Only when the user wants to compare or pick versions: run `resolve_versions` (the
  app-scoped menu; adds live Exchange + release-notes fetches, slower). For each connector present its
  `current`, `matrixSet` (recommended), and where they differ, `firstCompatible` / `latestInMajor` /
  `latest`, plus any `staleness` note. Make clear the matrix pin is the safe default and "latest" may
  be a breaking major. These numbers come from the engine — never substitute versions from memory.
  (You can also pass `--versions` to `assess.js` to fold the menu into the assess output.)
- **7 STRATEGY.** See the table below. Default `min`. For `manual`, collect a
  `{ "<artifactId>": "<version>" }` map; unselected connectors keep the curated pin.
- **8 DRY RUN.** This is the safety gate. Run `upgrade.js start … --dry-run` (routing table) — it
  returns a real `PLAN_PREVIEW`. Always dry-run before executing, even if the user seems sure. Present
  the preview from the command output and remind them nothing has been written yet. **Never fabricate
  a preview** — if the command didn't run, you have no plan to show.
- **9 CONFIRM.** Require an unambiguous yes. Treat "looks good but change X" as a loop back to the
  relevant step, not a confirmation.
- **10 EXECUTE.** Same arguments as the dry run with `dryRun:false`. Surface the outcome status verbatim.
- **11 TRACK.** After PR_OPEN, call `get_job_status` — it **auto-refreshes** (polls the live PR
  state + CI checks over the GitHub token, and verifies the deploy on Anypoint) before returning, so
  a plain "check status now" already reflects reality. Surface the returned `checks[]` sub-status
  (e.g. `test: passed`, `dependency-guard: passed`) and any `error`. `nextPollSeconds` sets the
  cadence for repeat checks. Note for the user: a **passing MUnit stays `PR_OPEN`** (shown as the
  "MUnit tests passed" sub-stage) — the status only advances to `DEPLOYING` when the PR is **merged**,
  then to `DEPLOYED` after Anypoint verification. On `FAILED_DEPLOY`/`MUNIT_FAILED`/`DEP_GUARD_FAILED`,
  report the reason and offer `rollback`. (CLI parity: `job.js status --job <id> --refresh`.)
  - **A PR that was manually closed without merging is detected too** — the auto-refresh polls the PR
    even for jobs parked at `MUNIT_FAILED`/`DEP_GUARD_FAILED`, so a closed PR moves the job to
    **`CLOSED`** ("closed without merging; lock released"). You do NOT need to `delete` a job to reflect a
    manual close — just `get_job_status` (or `reconcile`) and it will report `CLOSED`. Only `delete` when
    the user actually wants to purge the job record.

### Version strategies (passed to start_upgrade)

| Strategy | Picks | When to suggest |
|----------|-------|-----------------|
| `min` *(default)* | curated matrix pin | The safe, recommended floor. Start here. |
| `first-compatible` | lowest Java-17-safe version | User wants the *minimum* diff; may sit below the matrix pin (explicit opt-in). |
| `in-major` | highest patch in the pin's major | User wants current patches without a breaking major. |
| `latest` | highest published overall | User explicitly wants newest — **flag** it may be a breaking major. |
| `manual` | per-connector `connectorSelections` | User has specific versions in mind; others keep the pin. |

## Tool routing (intent → CLI command, MCP tool fallback)

**CLI-first:** run the `node` command shown (this is what a skills-only install provides). **If the
hosted MCP server is registered**, you may instead call the MCP tool in the last column — it runs the
identical engine. Paths are relative to the suite root; under a Vibes symlink install they resolve as
`.a4drules/skills/<skill>/scripts/<file>.js`. All commands need `--env <dev|test|prod>` (or
`MULE_UPGRADE_ENV` set in the suite `.env`).

| The user wants to… | Run this CLI | MCP tool (if server present) |
|--------------------|--------------|------------------------------|
| See what would change / readiness (LEAN, fast) | `node skills/mule-upgrade-assess/scripts/assess.js --source github --owner <o> --repo-name <r> --branch <b> --env <e> --quiet` (or local: `--repo <clone> --env <e> --quiet`) — read `changePlan.connectorsInApp[]` | `assess_app` |
| Compare / pick connector versions (live menu) | add `--versions` to the `assess.js` run, or scope it: `resolve_versions` | `resolve_versions` |
| Audit whether the matrix itself is stale (advisory) | `node skills/mule-upgrade-assess/scripts/lib/matrix_drift.js --connectors` (add `--json` / `--candidate`) | `check_drift` |
| Preview the plan without writing | `node skills/mule-upgrade/scripts/upgrade.js start --app <name> --env <e> --mode api --owner <o> --repo-name <r> --branch <b> --dry-run` → `PLAN_PREVIEW` | `start_upgrade {dryRun:true}` |
| Actually run the upgrade + open a PR | same command **without** `--dry-run`, plus `--version-strategy <s>` | `start_upgrade {dryRun:false}` |
| Check on an in-flight job (auto-refreshes: live PR/CI/deploy) | `node skills/mule-upgrade-job/scripts/job.js status --job <jobId> --refresh` | `get_job_status` (refreshes by default; `refresh:false` for a pure cache read) |
| Advance stale jobs (merge/CI/deploy) | `node skills/mule-upgrade/scripts/upgrade.js poll --stale-seconds 0` | `reconcile` (defaults to poll-now) |
| Undo a bad upgrade | `node skills/mule-upgrade-pr/scripts/rollback.js …` (see mule-upgrade-pr) | `rollback` |
| Find apps across the fleet on old Mule/Java | `node skills/mule-upgrade-scan/scripts/scan.js` | `scan_fleet` |
| Retry a failed job / clean one up | `job.js reapply --job <id>` / `job.js delete --job <id>` | `reapply_job` / `delete_job` |
| Upgrade a shared parent/BOM pom — pins its connectors AND minor-bumps its OWN `<version>` in ONE PR (TRACKED job; pollable via `get_job_status`/`reconcile`; `--no-job` for an untracked dry run). **Do NOT add `--bump-own-version` here** — the own-version bump is automatic when connectors change. | `node skills/mule-upgrade-parent-pom/scripts/parent_pom_cli.js …` (repo/branch/env only) | `upgrade_parent_pom` |
| Check what a parent/BOM pom itself inherits BEFORE changing it (read-only) | `parent_pom_cli.js … --detect-only` | `upgrade_parent_pom {detectOnly:true}` |
| Chained parent-pom step: point a parent-pom at a NEW BOM version + force its own bump (use `--bump-own-version` **only here**, because the parent-pom usually has no connector edits) | `parent_pom_cli.js … --parent-ref-artifact <bomArtifact> --parent-ref-version <v> --bump-own-version` | `upgrade_parent_pom {parentRef:{artifactId,toVersion}, bumpOwnVersion:true}` |
| Chained FINAL: bump the parent-pom version inside an app's ALREADY-OPEN PR (one commit on its branch; the app's own pom path is auto-derived from the job — **do NOT pass `--pom-path`**) | `parent_pom_cli.js --update-app-job <appJobId> --parent-ref-artifact <parentPomArtifact> --parent-ref-version <v>` | `update_open_pr_parent_ref` |

Run every command through the shell (`execute_command`) and parse its **JSON stdout** — that JSON is
the source of truth for what you tell the user. Do not paraphrase from memory or fill gaps yourself.

## Shared parent-pom / BOM upgrades (interactive)

**Most apps need NO chaining.** The signal that an upgrade must extend beyond the app pom is the app
assess reporting `connectorGaps` — connectors whose versions are pinned *upstream* (in a shared
parent-pom or a BOM) so the app pom cannot bump them itself. **No `connectorGaps` → just upgrade the
app and stop.** Merely having a `<parent>` is NOT a reason to chain (nearly every Mule app inherits a
standard Mule parent that pins nothing of the app's connectors). Run the chained flow only when
`connectorGaps` exist AND config `chainedParentUpgrade.enabled` is true (default true). **STOP and ask
the user at every arrow** — never chain automatically past a decision point.

### Topologies you will actually see (design for these, in this order)

- **(A) Standalone app — the majority.** No connectorGaps, or a parent that pins nothing relevant.
  Just run the normal app upgrade. No parent-pom step, no BOM step.
- **(B) App → parent-pom in a DIFFERENT repo, no BOM — the common shared case (~the 80%).** The app's
  connectors are pinned by a shared parent-pom that lives in its **own** repo. Upgrade that parent-pom
  (its own repo), then amend the app's open PR to point at the new parent-pom version. **There is no
  BOM step.**
- **(C) App → parent-pom → BOM — the rare full chain.** Only when a BOM actually exists. Same as (B)
  with a BOM upgrade in front.

A monorepo (app + parent-pom + BOM in ONE repo) is an **edge case**; it works too because each pom
locks on its own module, but do not assume it.

### Invariants — read BEFORE running any step (they prevent the mistakes from the last run)

- **The parent-pom/BOM lives in a repo you must be TOLD, not one you can derive.** A `<parent>` or a
  `<dependency>` block gives you Maven coordinates (`groupId:artifactId:version`) — **not** a GitHub
  repo. In ~95% of cases the parent-pom is in a *different* repo than the app. **Ask the user for the
  parent-pom's repo URL** (only if the artifact is in the registry can coordinates auto-resolve).
  Never guess the repo from the GAV.
- **The parent-pom/BOM upgrade ALREADY bumps its own `<version>` automatically** whenever it pins a
  connector. **Do NOT pass `--bump-own-version` / `bumpOwnVersion:true` when the pom has connector
  edits.** That flag exists ONLY to force a bump on a pom with *zero* connector edits whose only reason
  to release is a repointed BOM ref (the parent-pom step of the rare full chain). If you add it to a
  pom that already pins connectors you are second-guessing the engine — don't.
- **Each pom opens its PR in ONE run.** A single `upgrade_parent_pom` call pins the connectors AND
  bumps the own version AND opens the PR. **Never run the same pom twice** to "add the version bump" —
  it is already in the first PR. Re-running only yields `CONFLICT`, which means "already done", not
  "try again".
- **You never choose a version number.** The new parent-pom/BOM version comes back in that step's
  `edits[]` (`kind:"pomVersion"`, its `to`). Read it from the JSON; never invent it.

### The sequence (case B — the common one; case C adds the bracketed BOM step)

**Golden rule: upgrade the app LAST.** Do the upstream poms (BOM → parent-pom) FIRST so their new
versions are known, then upgrade the app ONCE with `parentRef` — the app PR's FIRST commit already
repoints the app's `<parent>`. **No second amend commit.** (Only fall back to `update_open_pr_parent_ref`
if the app PR was somehow opened *before* the parent-pom existed — see the note after the sequence.)

1. **ASSESS the app first (dry-run, no PR yet).** Run `assess_app`. If there are no `connectorGaps`,
   just upgrade the app normally and STOP — you are in case (A). If there ARE `connectorGaps`, they name
   the connectors pinned upstream; tell the user those must be fixed in the shared parent-pom (usually a
   different repo) and **ask for the parent-pom's repo URL**. **Do NOT open the app PR yet** — you'll do
   that last, once you know the new parent version.
2. **DETECT on the parent-pom (no edits).** With the URL, call `upgrade_parent_pom {detectOnly:true}`.
   Read `inheritance`: if it `imports BOM …`, you are in case (C) — recommend upgrading that BOM
   FIRST and ask for the BOM repo URL. If it imports no BOM (the common case), skip straight to step 4.
3. **(Case C only) Upgrade the BOM (ONE run, NO extra flags).** Run `upgrade_parent_pom` on the BOM
   with just its repo/branch/env — **no `bumpOwnVersion`**. Read the new BOM version from its `edits[]`
   `pomVersion.to`. Report pins + version bump + PR, then **ask** to upgrade the parent-pom to point at
   BOM `<newBomVer>`. (If `NO_CHANGE`, the BOM already meets the matrix — say so, do not re-run it.)
4. **Upgrade the parent-pom (ONE run).** In case (B): `upgrade_parent_pom` on the parent-pom repo with
   just repo/branch/env — it pins the connectors and bumps its own version, **no `bumpOwnVersion`
   needed**. In case (C), when the parent-pom has no connectors of its own and only needs to follow the
   new BOM: `upgrade_parent_pom {parentRef:{artifactId:"<bomArtifact>", toVersion:"<newBomVer>"}, bumpOwnVersion:true}`.
   Read the new parent-pom version from its `edits[]` `pomVersion.to`. Report it + the PR, then **ask**:
   "Upgrade `<app>` now and point its `<parent>` at parent-pom `<newParentVer>` in the same PR?"
5. **Upgrade the app LAST, folding the parent repoint into its first PR (FINAL).** If yes, call
   `start_upgrade {appName, …, parentRef:{artifactId:"<parentPomArtifact>", toVersion:"<newParentVer>"}}`
   — **dry-run first** (`dryRun:true`) so the preview shows the app edits + own-version bump **and** the
   `<parent> <oldVer> → <newParentVer>` repoint, then re-run with `dryRun:false`. The app PR's single
   first commit now contains everything: runtime/Java/MUnit edits, the app's own version bump, and the
   `<parent>` repoint — in the CORRECT app pom (`start_upgrade` knows the app's `appPath`). No second
   commit, no `update_open_pr_parent_ref`. Track it with `get_job_status`.

**Fallback only — app PR already open before the parent existed.** If (and only if) you already opened
the app PR earlier and the parent-pom was released afterward, repoint the existing PR with
`update_open_pr_parent_ref {appJobId:"<theAppJob>", parentRef:{artifactId:"<parentPomArtifact>", toVersion:"<newParentVer>"}}`.
**Pass ONLY those two args — never pass `pomPath`** (it is auto-derived from the tracked job's
changePlan, so a multi-module app under a sub-dir like `customer-web-eapi/pom.xml` is edited in the
CORRECT file; passing `pomPath:"pom.xml"` yourself is what committed to the wrong repo-root pom in
PR #38 — do not do it). This adds ONE commit onto the open PR branch; report `PR_UPDATED` / `NO_CHANGE`.

Every parent-pom/BOM step above is a **tracked job** — surface its `jobId` and check it with
`get_job_status` (which shows `kind: parentPomUpgrade`) exactly like an app upgrade. Jobs in different
repos never block each other; within one repo they lock per module (`<repo>::<pomPath>`).

## Presenting results (write the prose yourself — never echo raw output)

The engine returns **structured JSON**; turning it into readable prose is **your** job. Follow these
rules every time you report a result:

1. **Always pass `--quiet`** (or `--format json`) to `assess.js`. This makes it emit JSON only. Without
   it the CLI also prints a pre-formatted human summary to stderr, and if you relay both you produce a
   **duplicated warning list** — the exact "same section printed twice" bug. `upgrade.js` is already
   JSON-only.
2. **Never paste the raw JSON into the chat.** Read it, then write a short conversational summary.
   Users do not want a 300-line ChangePlan dump.
3. **Never reproduce a tool-printed summary block verbatim.** If you ever see a pre-formatted
   `App: … / File edits: … / Warnings:` block, you forgot `--quiet` — re-run with it; do not relay
   that block.
4. **Summary shape** (assess): lead with `runtime <A> / Java <B> → 4.9.18 / Java 17`, then the edit
   count (e.g. "11 edits across 2 files"), then each warning as **one plain sentence**. Call out
   `connectorGaps` and `missingFromMatrix` explicitly as human-judgement items.
5. **Collapse noisy warnings.** A "Live matrix fetch unavailable — using the bundled matrix" warning
   means the run used the curated offline matrix and is still correct — say that in one calm sentence,
   not as an alarm. Matrix-drift advisories are "consider bumping the bundled matrix later," not
   blockers.

## Guardrails (see the EXECUTION CONTRACT above and AGENTS.md for the full list)

- **Act only via the suite's own CLI/MCP tools** — never hand-write poms, guess versions, `curl`
  GitHub, ask for a PAT, or simulate a plan. On a command error, report it and stop.
- **Never** execute (`dryRun:false`) without a preceding dry run **and** an explicit user yes.
- **Never** print decrypted secrets or the config decryption key to the transcript.
- The env is **required** — do not guess it; ask or read `MULE_UPGRADE_ENV`.
- Treat `CONFLICT` (an upgrade already in progress) as terminal **for that exact pom/app** — surface
  the existing jobId/PR and stop; do not re-run the same pom to "add" something (the first PR already
  has it). `CONFLICT` is scoped per module (`<repo>::<pomPath>` for a parent/BOM, the app name for an
  app), so it does **not** block the next module in the chain — a BOM PR being open never stops you
  from opening the parent-pom or app PR in the same repo.
- `connectorGaps` and `missingFromMatrix` are **human-judgement** items — always raise them, never
  silently proceed past them.
- All notifications / deployed-state / Anypoint verification are non-fatal — a skipped check is
  reported with its reason, never treated as a failure.

## The exact commands (copy-ready)

This skill is a conversation layer over the same CLI the `mule-upgrade` orchestrator exposes. The
dry-run gate lives on the CLI. **Prefer the discrete-flag form** (no JSON quoting to get wrong):

```bash
# preview only — assess + plan, nothing written (discrete flags: no --coords quoting trap)
node skills/mule-upgrade/scripts/upgrade.js start \
  --app orders-api --env dev --mode api \
  --owner acme --repo-name orders-api --branch main \
  --dry-run

# then execute with the chosen strategy (identical args, minus --dry-run)
node skills/mule-upgrade/scripts/upgrade.js start \
  --app orders-api --env dev --mode api \
  --owner acme --repo-name orders-api --branch main \
  --version-strategy in-major
```

`--coords '{…}'` is still accepted, but on Windows `cmd.exe` it corrupts (see "Windows quoting" in
the execution contract). Use the discrete flags above, or cmd-escaped JSON, to avoid
`Unexpected token … is not valid JSON`.

Over the hosted server the same gate is the `dryRun` boolean on `POST /api/v1/tools/start_upgrade`
(and the MCP `start_upgrade` tool). `PLAN_PREVIEW` is the preview outcome; re-invoke with
`dryRun:false` to execute.

## Verification

`tests/orchestrate.test.js` covers the dry-run gate: `dryRun:true` returns `PLAN_PREVIEW`, acquires
no lock, creates no job, and never reaches apply/commit (injected to throw), while a dry run of an
already-upgraded app still reports `ALREADY_UPGRADED`.
