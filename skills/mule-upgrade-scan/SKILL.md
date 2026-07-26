---
name: mule-upgrade-scan
description: >-
  Scan the Anypoint Platform fleet to find MuleSoft apps that still run an OLD runtime
  (Mule 4.4 or older) or OLD Java (8/11) and therefore need the Java 17 upgrade. Produces
  a count + an actionable candidate list mapped to GitHub repos. Use this when the user
  says things like "how many apps are on old Mule/Java", "which apps still need the Java 17
  upgrade", "scan the fleet", "find upgrade candidates", "audit our Anypoint org for old
  runtimes", or "what should we upgrade next". It also runs PROACTIVELY on a schedule and
  PUSHES a Slack alert when new stale apps appear — trigger phrases: "watch the fleet",
  "notify me when apps fall behind", "alert on old runtimes", "set up a proactive scan",
  "push me upgrade candidates". Hand a candidate to the mule-upgrade orchestrator to actually
  perform the upgrade.
---

# mule-upgrade-scan (proactive fleet scan)

Answers **"how many apps still need the Java 17 upgrade, and which ones?"** by reading the
Anypoint Platform directly — turning the orchestrator from reactive (upgrade what you're told)
into proactive (surface what's stale). It enumerates every deployment across the org's
environments, flags the ones on an old Mule/Java, and maps each to its GitHub repo so it can be
fed straight into `start_upgrade`.

## Run

```bash
# human-readable report (default)
node skills/mule-upgrade-scan/scripts/scan.js

# machine-readable
node skills/mule-upgrade-scan/scripts/scan.js --json

# restrict to specific environment names
node skills/mule-upgrade-scan/scripts/scan.js --env Production,Staging
```

Requires Anypoint credentials (`ANYPOINT_CLIENT_ID` / `ANYPOINT_CLIENT_SECRET` /
`ANYPOINT_ORG_ID`, or the layered config). If nothing is configured, the scan returns a clean
"not configured / 0 scanned" report — it never errors.

## What it does

1. **Lists environments** for the org (or just those passed via `--env` / `scan.environments`).
2. **Lists AMC deployments** per environment, reading each app's `runtimeVersion`
   (e.g. `4.4.0:8-java`) and splitting it into Mule version + Java major.
3. **Classifies** each app **stale** when its Mule version is `< scan.staleMuleBelow`
   (default `4.5.0`, so 4.4.x and older) **or** its Java major is `< scan.targetJava`
   (default `17`, so 8 and 11).
4. **Maps** each stale app name to `owner/repo/appPath` via the same 3-tier waterfall upgrades
   use (registry → request → convention). De-dups apps deployed to multiple environments.
5. **Reports** a count + candidate list, each with the reason it was flagged and where its source
   lives.

## Output shape (`--json`)

```jsonc
{
  "configured": true,
  "coverage": "amc",
  "thresholds": { "staleMuleBelow": "4.5.0", "targetJava": 17 },
  "environmentsScanned": ["Production", "Staging"],
  "totalApps": 42,
  "staleApps": 7,
  "candidates": [
    {
      "appName": "orders-api",
      "muleVersion": "4.4.0", "javaVersion": 8, "status": "RUNNING",
      "environments": ["Production"],
      "reasons": ["Mule 4.4.0 is older than 4.5.0", "Java 8 is older than 17"],
      "owner": "acme", "repo": "orders-api", "appPath": ".",
      "needsCoordinates": false, "fromRegistry": false
    },
    {
      "appName": "legacy-billing-prod",
      "muleVersion": "4.3.0", "javaVersion": 8, "status": "RUNNING",
      "environments": ["Production"],
      "reasons": ["Mule 4.3.0 is older than 4.5.0", "Java 8 is older than 17"],
      "owner": null, "repo": null, "appPath": null,
      "needsCoordinates": true
    }
  ],
  "warnings": ["1 stale app(s) could not be mapped to a GitHub repo automatically — …"]
}
```

## Handing a candidate to the upgrade

A resolved candidate (`needsCoordinates:false`) is directly actionable:

```bash
# from the report above
node skills/mule-upgrade/scripts/upgrade.js --app orders-api
```

For an **unmapped** candidate (`needsCoordinates:true`), supply the coordinates the scan couldn't
derive (the deployed name didn't follow convention and isn't in the registry):

```bash
node skills/mule-upgrade/scripts/upgrade.js --app legacy-billing-prod \
  --owner acme --repo billing-service --app-path .
```

## Proactive push (scan on a timer, alert on change)

`scan.js` is *on-demand* — you ask, it answers. `scan_notify.js` is the **genuinely proactive**
half: it runs the same scan on a schedule and **pushes a Slack message** the moment the stale set
*changes*, so nobody has to remember to ask.

```bash
# scan + push to Slack ONLY if something changed since the last run
node skills/mule-upgrade-scan/scripts/scan_notify.js

# compute the message but don't send or persist (preview)
node skills/mule-upgrade-scan/scripts/scan_notify.js --dry-run

# send the full current list every run (periodic digest, e.g. a weekly summary)
node skills/mule-upgrade-scan/scripts/scan_notify.js --always-notify

# machine-readable result (delta + report + notify outcome)
node skills/mule-upgrade-scan/scripts/scan_notify.js --json
```

**How the de-dup works.** Each run diffs the current stale candidates against a remembered
baseline at `~/.mule-upgrade/scan-watch.json` (under `MULE_UPGRADE_HOME`). It only pushes when the
set *changes*:

- **newly stale** — an app that just appeared (new deploy, downgrade, or newly discovered),
- **changed reason** — an app whose staleness reasons changed (e.g. Mule upgraded but Java still 11),
- **resolved** — an app that dropped off the stale list (upgraded away) → announced ✅ and removed
  from the baseline so it can re-alert if it ever regresses.

So running it every 15 minutes does **not** re-spam the same list — you hear about *change*, not
steady state. The Slack push is **non-fatal and env-gated**: no `SLACK_WEBHOOK_URL` → the push is
cleanly skipped (the scan + diff still run and are still returned).

### Running it on a timer

A skill can't host a daemon, so schedule the CLI from outside:

- **`/loop` skill** — `node skills/mule-upgrade-scan/scripts/scan_notify.js` on an interval.
- **OS cron** (every 6h): `0 */6 * * * cd /path/to/repo && node skills/mule-upgrade-scan/scripts/scan_notify.js`
- **Scheduled GitHub Action** — `on: schedule: - cron: "0 8 * * 1"` (Mon 08:00) running the CLI with
  `ANYPOINT_*` and `SLACK_WEBHOOK_URL` as secrets. Add `--always-notify` for a weekly digest.

Exposed remotely as the `scan_notify` MCP/REST tool for agents (Agentforce / Vibes) that drive it
on their own cadence.

## Coverage caveat (read this)

This v1 scans **CloudHub 2.0 / Runtime Fabric** deployments via the AMC application-manager
endpoint. It does **NOT** count:

- **CloudHub 1.0** apps (`/cloudhub/api/v2/applications`), or
- **on-prem / hybrid** apps registered through ARM (`/hybrid/api/v1/...`).

Those live behind different endpoints with different schemas. The report states this in
`coverageNote` so the number is never mistaken for the entire estate. Adding those surfaces is a
planned enhancement.

## No hard registry dependency

The name→repo mapping is **best-effort**. `app-registry.yaml` is only *one* of three resolution
tiers (registry → request override → convention); an app that follows convention
(`repo == appName`, module at repo root) needs no registry entry. Apps that resolve neither way
are still **reported** — flagged `needsCoordinates:true` — so the count stays complete and the
operator can supply owner/repo. You never need to maintain a registry just to run the scan.

## Config

| Key | Default | Meaning |
|-----|---------|---------|
| `scan.staleMuleBelow` | `4.5.0` | Mule versions strictly below this are flagged (4.4.x and older) |
| `scan.targetJava` | `17` | Java majors below this are flagged (8, 11) |
| `scan.environments` | `""` | comma-separated env names to restrict to (empty = all) |

## Files

- `scripts/scan.js` — `scanFleet()`, `classifyApp()`, `formatReport()`, `fleetScanSlackText()` + CLI.
- `scripts/scan_notify.js` — `scanAndNotify()`, `diffAgainst()`, watch-state load/save + CLI
  (the proactive push).
- Reads via `skills/mule-upgrade/scripts/lib/anypoint.js` (`listEnvironments`, `listDeployments`,
  `parseRuntimeVersion`), `lib_shared/coordinates.js` (`resolveCoordinates`), and pushes via
  `skills/mule-upgrade/scripts/lib/notify.js` (`slackNotify`); state under `MULE_UPGRADE_HOME`.
- Exposed remotely as the `scan_fleet` and `scan_notify` MCP/REST tools (see `server/lib/tools.js`).
