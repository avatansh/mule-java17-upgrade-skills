# Flow: shared parent-pom / BOM upgrades (interactive)

Read this when the app assess reported `connectorGaps`, or the user asks about a shared parent pom
or BOM.

**Most apps need NO chaining.** The signal that an upgrade must extend beyond the app pom is the app
assess reporting `connectorGaps` — connectors whose versions are pinned *upstream* (in a shared
parent-pom or a BOM) so the app pom cannot bump them itself. **No `connectorGaps` → just upgrade the
app and stop.** Merely having a `<parent>` is NOT a reason to chain (nearly every Mule app inherits a
standard Mule parent that pins nothing of the app's connectors). Run the chained flow only when
`connectorGaps` exist AND config `chainedParentUpgrade.enabled` is true (default true). **STOP and ask
the user at every arrow** — never chain automatically past a decision point.

## Intake for this flow

Ask only these. Do **not** ask for a version strategy, a deployed app name, or the connector menu —
none of them apply to a parent pom.

1. The parent-pom's **repo URL** (required — see the invariant below; you cannot derive it).
2. Base branch (default `develop`).
3. Env (default `dev`) — needed for `--env`.

Notify was already settled session-wide; do not re-ask.

## Topologies you will actually see (design for these, in this order)

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

## Invariants — read BEFORE running any step

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
- **The parent is judged against the SAME Java target as the app.** If the app run used
  `--target-java 21`, the chained parent-pom run inherits it automatically. Do not mix targets across
  a chain.

## The sequence (case B — the common one; case C adds the bracketed BOM step)

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

## Commands

```bash
# detect only (read-only)
node skills/mule-upgrade-parent-pom/scripts/parent_pom_cli.js --repo-url <url> --branch <b> --env <e> --detect-only

# upgrade the parent pom (pins connectors AND bumps its own version, in ONE PR)
node skills/mule-upgrade-parent-pom/scripts/parent_pom_cli.js --repo-url <url> --branch <b> --env <e>

# chained: repoint a parent pom at a new BOM version (the ONLY place --bump-own-version belongs)
node skills/mule-upgrade-parent-pom/scripts/parent_pom_cli.js --repo-url <url> --branch <b> --env <e> \
  --parent-ref-artifact <bomArtifact> --parent-ref-version <v> --bump-own-version

# fallback: bump the parent ref inside an app's already-open PR
node skills/mule-upgrade-parent-pom/scripts/parent_pom_cli.js \
  --update-app-job <appJobId> --parent-ref-artifact <parentPomArtifact> --parent-ref-version <v>
```
