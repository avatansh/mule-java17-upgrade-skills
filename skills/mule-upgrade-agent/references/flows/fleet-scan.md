# Flow: fleet overview — which apps are behind

Read this when the user asks who needs upgrading, wants an estate overview, or says "scan the fleet".

This is **read-only**. It writes nothing.

## Intake for this flow — usually none

`scan.js` takes **no required arguments**. It scans every environment it can see and reports the apps
behind the configured floor. So do not run an intake at all unless the user asked to narrow it:

- Want one environment only? Pass it. Otherwise all environments are reported.
- Nothing else is needed — no source, no branch, no notify, no strategy.

## Run it

```bash
node skills/mule-upgrade-scan/scripts/scan.js
```

MCP equivalent: `scan_fleet`.

**Do not reach for `scan_notify` unless the user has explicitly opted into Slack.** Its whole purpose
is posting to Slack; running it *is* the opt-in. If Slack was declined for the session, use the plain
scan and report in chat.

## Reporting the result

State the counts first ("6 of 17 apps need the upgrade, across 4 environments"), then list the apps
with their current runtime and environment. Note the scope limit the tool itself reports: it counts
**CloudHub 2.0 / Runtime Fabric (AMC)** deployments only — CloudHub 1.0 and on-prem/hybrid apps are
not included. Say that, because a fleet answer that silently excludes part of the estate is
misleading.

## Natural follow-up

A fleet scan is the usual entry point to a **batch** upgrade. Offer it, and note that the scan gives
Runtime Manager app names — the batch maps those to repos by convention, which can be wrong. See
`batch.md`; confirm the owner/repo mapping before executing anything.
