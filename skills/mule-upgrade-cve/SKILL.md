---
name: mule-upgrade-cve
description: Scan a Mule app's declared Maven coordinates against the OSV.dev advisory database and report which known vulnerabilities the Java upgrade already fixes, which still need action (with the exact minimum fix version), and which have no published fix. Read-only — never edits a pom or opens a PR. Use when asked about CVEs, vulnerabilities, security posture, or "what does this upgrade actually fix?".
---

# Vulnerability scan (SKILL 12)

A version bump is a security event whether or not anyone frames it that way. Moving a connector from
1.5.0 to 1.10.3 silently closes every advisory fixed in between — and silently leaves open the ones
fixed in 1.11. This skill makes that ledger explicit, so an upgrade can be justified as
"closes 7 known CVEs, 2 remain" rather than "moves us to Java 17".

## What it does

1. **Collect** — walks the app's pom inheritance chain (the same `buildAppChain` every other skill uses)
   and gathers declared coordinates: direct dependencies, `dependencyManagement` entries, and build
   plugins, resolving `${property}` versions through the chain.
2. **Query** — asks OSV.dev's `querybatch` endpoint which advisories affect each `groupId:artifactId` at
   its resolved version, then fetches the full advisory for each match.
3. **Classify** — compares each advisory's fixed versions against **the version the upgrade plan moves
   that coordinate to**, producing three buckets:

| Bucket | Meaning | What to do |
| --- | --- | --- |
| `resolved-by-upgrade` | The plan already reaches a fixed version | Nothing. Report it as a win. |
| `action-required` | A fix exists, the plan doesn't reach it | Bump further — the minimum fix version is given |
| `no-fix-available` | No fixed version published | Human decision: mitigate or document acceptance |

Output leads with `action-required` and ends with `resolved-by-upgrade`. A report that opens with 60
resolved advisories buries the two that need a decision.

## Scope limits — state these to the user, every time

**Only declared coordinates are scanned.** Transitive dependencies are not resolved, because resolving
them requires a real Maven build (`dependency:tree`) against configured repositories, which this
toolchain deliberately avoids. Most real CVE exposure in a Mule app is transitive, so:

- Findings are a **lower bound**.
- An empty result means "no public advisory matched what the poms declare" — **not** "this app is
  secure". Never present a clean scan as a security clearance.
- For a complete picture, run a real SCA tool (`mvn dependency-check:check`, Snyk, Dependabot) in CI.
  This skill is the fast, build-free signal that fits inside an upgrade conversation.

**MuleSoft's own connectors are largely absent from public advisory databases.** Zero findings for
`org.mule.connectors:*` reflects the database's coverage, not an audit.

These limitations are returned in the JSON payload (`limitations[]`), not just printed, so a
programmatic consumer cannot mistake this for full software composition analysis.

## Reliability posture

Every failure is non-fatal and reported. An OSV outage, a rate limit, or an offline laptop degrades to a
partial scan with `complete: false` and a warning — it never fails an upgrade, because advisory
enrichment must not be able to block a build.

Two caching layers keep repeat scans cheap: per-`(coordinate, version)` batch answers for 6 hours
(including the clean "no advisories" answer, which is the common case), and per-advisory details for 7
days, since an advisory's fixed-version list is effectively immutable. On the fixture app this is a 9x
difference — 8.9s cold against 1.0s warm.

Detail fetches are pooled and capped because one stale library can carry 60+ advisories; when the cap
bites, **counts stay complete** and the truncation is reported rather than hidden. All four knobs are
operator-tunable in `config.yaml` under `cve:` (no code change needed):

| Key | Default | What it controls |
| --- | --- | --- |
| `cve.maxVulnDetails` | 250 | cap on per-advisory detail fetches |
| `cve.concurrency` | 8 | detail fetches in flight |
| `cve.batchTtlSeconds` | 21600 (6h) | per-`(coordinate, version)` cache lifetime |
| `cve.vulnTtlSeconds` | 604800 (7d) | per-advisory cache lifetime |

## Two correctness traps this skill is built around

A false "resolved" is the one error this feature must never produce: an open vulnerability reported as
fixed, delivered with confidence. Two things cause it, and both are handled deliberately.

### 1. Fixes are backported across maintenance branches

The intuitive test — "is my version at or above a published fix?" — is wrong. Maintainers patch several
maintenance branches at once, and OSV models each as its own range. Log4Shell (CVE-2021-44228) is fixed
in **2.3.1, 2.12.2 and 2.15.0**. For an app on log4j `2.14.1` the naive test gives two catastrophic
answers: `2.14.1 >= 2.3.1`, so the app looks patched while fully exposed — and the advice becomes
"upgrade to 2.3.1", which is a *downgrade* that is still vulnerable.

So the engine asks about **containment** instead: does the version fall inside a half-open
`[introduced, fixed)` interval? That makes:

- the recommended fix the one closing the app's **own** branch (`2.14.1 → 2.15.0`, never `2.3.1`), and
- "does the upgrade resolve this?" simply "is the planned version outside every affected interval?".

Branch awareness then comes for free. On the fixture app this reproduces the real remediation ladder —
2.15.0 for CVE-2021-44228, 2.16.0 for CVE-2021-45046, 2.17.0 for CVE-2021-45105, 2.17.1 for
CVE-2021-44832 — and jackson `2.9.0` is correctly told to reach `2.9.7`, not the lowest-listed `2.7.9.5`.

A branch with **no** published fix is reported as `no-fix-available` with
`fixedOnOtherBranchOnly: true` when other branches were patched. Switching branches may mean a
downgrade, so it is surfaced as a deliberate decision rather than an actionable bump.

`last_affected` (inclusive, "this branch was never fixed") and unclosed ranges are both handled, and
`GIT` ranges are skipped because commit hashes are not versions.

### 2. Maven versions are not three-segment semver

`lib_shared/semver.js` compares only `major.minor.patch`, which is correct for runtime and connector
pins. It is wrong here: OSV fixes routinely land on a fourth segment — the fix for CVE-2020-11619 is
`jackson-databind 2.9.10.4`. A three-segment compare rates `2.9.10` as "not less than `2.9.10.4`" and
again reports a live vulnerability as resolved. So `cve_engine.compareVersions` compares all numeric
segments and treats a qualifier as earlier than the same core release, matching Maven.

## Usage

Source flags are identical to `assess.js` — `--repo` for a local clone, `--owner`/`--repo-name`/
`--branch` (or `--repo-url`) for GitHub. They are not merely similar: a scan that resolved "which app"
differently from the assessment would eventually report on a different pom than the one being upgraded.

```bash
# GitHub app, compared against its upgrade plan
node skills/mule-upgrade-cve/scripts/cve_cli.js scan \
  --source github --owner acme --repo-name orders-api

# Local checkout, monorepo module, plain list (no plan comparison — faster)
node skills/mule-upgrade-cve/scripts/cve_cli.js scan \
  --repo /path/to/clone --app-path apps/orders-api --no-compare-plan

# CI gate: fail only on ACTION-REQUIRED findings at HIGH or above
node skills/mule-upgrade-cve/scripts/cve_cli.js scan \
  --source github --owner acme --repo-name orders-api --fail-on high
```

The `--fail-on` gate deliberately ignores `no-fix-available` and `resolved-by-upgrade`. A gate that
fails on findings nobody can act on gets switched off within a week.

MCP: `scan_vulnerabilities` — same arguments, same read-only guarantee.
