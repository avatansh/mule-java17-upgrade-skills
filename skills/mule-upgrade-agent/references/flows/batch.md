# Flow: several apps at once (batch)

Read this when the user names more than one app, picks several off a fleet scan, or says "batch
upgrade" / "upgrade everything".

Do **not** loop the single-app flow N times. Use `mule-upgrade-batch`: it previews every app
concurrently, groups the ones blocked on a shared parent pom, and executes the rest with a bounded
pool. Each app still gets its own lock, job and PR.

## Intake for this flow

Batch-wide, asked once — not per app:

1. Source mode (local clone or GitHub API) + the app list.
2. **Target Java** (only the curated targets — see the main SKILL.md).
3. Base branch (default `develop`).
4. Env (default `dev`). **One environment per batch** — see below.
5. Version strategy (default `min`).
6. Notify — ask **once, just before EXECUTE**, not during intake.

Do not ask for a deployed app name; a live ARM lookup per app is not part of the batch flow.

## The tail

1. **PREVIEW.** `batch_cli.js preview --env <e> --apps a,b,c` (or `--from-scan`). Nothing is written.
2. **READ IT BACK.** Give the counts, then name the exceptions individually: which apps are already on
   target, which are `NEEDS_PARENT_POM` and which pom blocks them, which were `SKIPPED` and why. Do not
   present a batch as "N apps ready" when only some are.
3. **CONFIRM.** An explicit yes, and say plainly how many PRs it will open. This gate matters more than
   in a single upgrade — the blast radius is N repos.
4. **EXECUTE.** Add `run … --confirm`. Without `--confirm` the CLI deliberately degrades to a preview.
5. **TRACK.** Report every `jobId` + PR url. Afterwards, one `reconcile` sweeps them all; there is no
   batch-level record, so follow up per job.

## Guardrails

**Never pass `--include-parent-pom` to "unblock" a group of apps that share one pom.** They are held
back because the fix is to upgrade that pom **once** (see `parent-pom.md`) — running them in
parallel makes all but one `CONFLICT` on the same parent-pom lock. Offer the chained parent-pom upgrade
instead, then re-run the batch.

Keep a batch to **one environment**. Same app in two envs is fine, but as two separate runs, so a
report always describes one environment.

**Repo coordinates are derived, and derivation can be wrong.** A fleet scan reports Runtime Manager
app names, and the batch maps them to `owner/<app-name>`. If a preview comes back with 404s for every
app, the mapping — or the branch default — is wrong, not the apps. Report that plainly and ask for the
correct owner/repo or branch rather than presenting it as "these apps failed".

## Commands

```bash
# preview (writes nothing)
node skills/mule-upgrade-batch/scripts/batch_cli.js preview --env <e> --apps a,b,c

# from the last fleet scan instead of an explicit list
node skills/mule-upgrade-batch/scripts/batch_cli.js preview --env <e> --from-scan

# execute — --confirm is required, or it degrades to a preview
node skills/mule-upgrade-batch/scripts/batch_cli.js run --env <e> --apps a,b,c --confirm
```
