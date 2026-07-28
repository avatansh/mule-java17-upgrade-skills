---
name: mule-upgrade-assess
description: >-
  Assess a MuleSoft app for a Java-17 / runtime-4.9 upgrade. Walks the pom inheritance chain,
  reads mule-artifact.json and the CI workflow, applies the compatibility matrix (bundled gating
  rules + dynamically fetched connector versions), and emits a byte-level ChangePlan of exactly
  which pom properties, dependency/plugin versions, MUnit runtime, mule-artifact.json fields and
  CI Java version to change — plus connector gaps and matrix-coverage warnings. Use this first,
  before applying edits or opening a PR. Triggers on "assess this mule app for java 17",
  "what needs to change to upgrade to java 17", "produce a mule upgrade change plan".
---

# mule-upgrade-assess

The assessment engine — a faithful Node.js port of the Mule app's `dwl::assessment`,
`dwl::treeAnalysis`, and `dwl::pomChain` modules, plus a **dynamic compatibility-matrix fetch**
that the original app couldn't do inline.

> **⛔ Actually run this — do not simulate it.** Assessment is deterministic engine code, not
> something to reason out. **Run the `node scripts/assess.js …` command via the shell and report its
> JSON output.** Never hand-read a pom, guess connector/runtime versions from memory, `curl` GitHub,
> or ask the user to paste a pom or a token — the engine reads the repo (GitHub REST in `--source
> github`, or a local clone). If the command errors (e.g. `401: Bad credentials` → no `GITHUB_TOKEN`),
> report the error verbatim and stop; do not route around it.
>
> **Windows note:** in `cmd.exe` single quotes are not delimiters. This script uses discrete flags
> (`--owner`/`--repo-name`/`--branch`), so no JSON quoting is needed — good.

## What it produces

An `AssessmentResult`:

```jsonc
{
  "appName": "…",
  "currentRuntime": "4.6.0",
  "currentJavaVersion": "8",
  "changePlan": {
    "targetRuntime": "4.9.18",
    "targetJavaVersion": "17",
    "topology": "BOM_PARENT_APP | PARENT_APP | APP_STANDALONE | MULTI_LEVEL",
    "headSha": "…",
    "fileEdits": [ /* {kind, file, from, to, …} — consumable by mule-upgrade-apply */ ],
    "filesToChange": ["pom.xml", "mule-artifact.json", ".github/workflows/build.yml"],
    "hasApiPolicies": false,
    "hasCustomJavaCode": false,
    "hasLookupFunction": false,
    "missingFromMatrix": [ /* connectors declared but not covered by the matrix */ ],
    "connectorGaps":     [ /* parent/BOM-managed connectors below target, unpinnable in the app pom */ ],
    "connectorsInApp":   [ /* LEAN per-app connector view (always present, network-free):
                              {artifactId, groupId, current, matrixSet, declaredInApp, willChange} */ ]
  },
  "connectorChoices": [ /* per-connector version MENU — ONLY when --versions/includeVersions (or a
                           versionStrategy) is set; otherwise absent. See "Connector version choice" */ ],
  "versionSelections": [ /* only when a versionStrategy rewrote a pin: {artifactId, from, to, strategy} */ ],
  "matrixDrift": { /* gating-drift advisory — ONLY when --drift/includeDrift is set; otherwise null */ },
  "deployedStateCheck": { /* verbatim deployed-state lookup — see "Deployed-state check" below */ },
  "warnings": [ /* actionable prose */ ]
}
```

The `changePlan` is exactly what `mule-upgrade-apply` consumes — assess → apply → PR is the pipeline.

> **Lean by default (the Full Split).** assess emits the network-free ChangePlan (including
> `connectorsInApp[]`) + deployed-state + warnings, and returns in ~1–3s. The rich connector version
> **MENU** (`connectorChoices[]`) is opt-in via `--versions` / `includeVersions` (or an active
> `versionStrategy`, which `start_upgrade` uses) — otherwise prefer the **`resolve_versions`** tool.
> The gating **matrix-drift** advisory (`matrixDrift`) is opt-in via `--drift` / `includeDrift` —
> otherwise prefer the **`check_drift`** tool. `--no-fetch` forces lean (matrix-only, no live fetch).

## How to run

`--env <dev|local|prod>` is **required** on every run (or set `MULE_UPGRADE_ENV` once in `.env`) —
there is no default, mirroring Mule's `-Denv`. It selects which `config-<env>.yaml` +
`config-secure-<env>.yaml` pair loads. The examples below assume `MULE_UPGRADE_ENV` is set in `.env`;
otherwise append `--env dev`.

```bash
# Assess a local clone (default: fetch connector versions live, fall back to bundled YAML):
node scripts/assess.js --repo /path/to/clone --env dev --out plan.json

# Multi-module repo: point at the app subpath (its pom chain is walked up to the outermost in-repo parent):
node scripts/assess.js --repo /path/to/clone --env dev --app-path modules/my-app --app-name my-app

# Offline / deterministic (skip all network — bundled matrix, no live enrichment):
node scripts/assess.js --repo /path/to/clone --env dev --no-fetch

# Pass the HEAD sha so the PR step can enforce a stale-plan guard:
node scripts/assess.js --repo /path/to/clone --env dev --head-sha "$(git -C /path/to/clone rev-parse HEAD)"
```

Flags: `--env <dev|local|prod>` (**required** — or `MULE_UPGRADE_ENV`),
`--strategy appOverride|inPlace` (default `appOverride`), `--out <file>` (else stdout),
`--versions` (opt-in: add the connector version MENU — default is lean), `--drift` (opt-in: add the
gating matrix-drift advisory). `--no-fetch` forces lean (matrix-only, no live enrichment).

## The compatibility matrix (hybrid, dynamic + static)

- **Static core** — `references/compatibility-matrix.yaml` (copied verbatim from the Mule app):
  target runtime/Java, all **gating** rules (runtime, java.version, compiler source/target,
  mule-maven-plugin, munit, munit-extensions, weave), `removeMunitJpmsFlags`, `manualReview` flags,
  and the `mule-artifact.json` target. Gating rules do **not** live on the connector release-notes
  page, so they stay static and authoritative.
- **Matrix source** — `scripts/lib/matrix_fetch.js`: when `matrix.source=exchange*` the FULL governed
  matrix (gating + connectors) is fetched from the Anypoint Exchange asset (`matrix.exchange`). On
  **any** failure (network error, unparseable body, empty connector set) it **falls back to the
  bundled YAML** — never a hard failure. The run reports which source won (`exchange:<ver>` /
  `bundled`).
- **Live connector enrichment** — `scripts/lib/resolve_versions.js` resolves each connector's
  published *versions* via the Exchange **Graph API** and locates its release-notes compatibility
  table via the curated `references/connector-notes-map.yaml` (artifactId → release-notes URL). This
  feeds the version-choice menu below; it never replaces the curated pins. *(The earlier
  release-notes-**index** scrape heuristic was retired — the index page has no Maven coordinates, so it
  was superseded by the Graph + notes-map resolver.)*
- **Release-notes disk cache** — `fetchReleaseNotesCached` (in `matrix_fetch.js`) is the default fetcher
  for those per-connector release-notes pages. It wraps the plain fetch with a per-URL JSON cache at
  `~/.mule-upgrade/matrix-cache.json` (`MULE_UPGRADE_HOME` override) with a **~24h TTL**, so a
  multi-connector assess followed by an upgrade run doesn't re-download the same pages. It is **purely a
  repeat-run latency optimisation and fully non-fatal**: a missing/corrupt cache file, an unwritable
  home, or a stale entry silently degrades to a live fetch (and a live-fetch error propagates exactly as
  before — callers already treat that as a per-connector degrade). Tests inject their own fetcher, so
  the cache is bypassed under test.

### Gating-version drift check (advisory)

The **gating** versions (runtime patch, mule-maven-plugin, MUnit plugins) stay static because they
encode a *minimum required for Java 17* — a policy floor, not "newest available". But floors still
rot, so `scripts/lib/matrix_drift.js` audits them against MuleSoft's live Maven metadata and
**warns** (as `matrixDrift` advisories in the assess result) when the bundled pin trails the latest
published version. It **never auto-applies** a version — a human bumps the YAML.

```bash
# standalone drift report (also runs automatically inside assess)
node scripts/lib/matrix_drift.js            # live
node scripts/lib/matrix_drift.js --json     # machine-readable
node scripts/lib/matrix_drift.js --no-fetch # skip network → "unchecked"
```

Why advisory and not live-authoritative (all proven by a live audit):
- Maven's `<release>`/`<latest>` spans **all** trains — the runtime's is `4.12.1`, but a 4.9 **LTS**
  upgrade must stay on `4.9.x`. The check filters to the pinned LTS line (→ `4.9.19`, not `4.12.1`).
- Some artifacts version on an unrelated line (weave `assertions` vs the 2.x DataWeave runtime), so
  blind "latest" would pin a nonsensical value.
- MUnit `≥3.6.3` is a **bug-fix floor** (JPMS container fix, W-20335051), a rule that lives in a KB
  article — not something Maven metadata publishes. Newer *satisfies* the floor; it isn't the rule.

Disable with `matrix.driftCheck: "false"`. Non-fatal: any fetch/parse failure degrades that artifact
to "unknown" and the assessment proceeds. *(As of this writing the live check flags all four pins as
behind: runtime 4.9.18→4.9.19, mule-maven-plugin 4.10.0→4.10.1, munit 3.6.3→3.7.3, munit-extensions
1.5.0→1.7.0.)*

## Connector version choice (live-enriched, matrix-authoritative)

The bundled matrix pins a single curated, Java-17-safe version per connector. That pin stays the
**authoritative floor and default** — but assess also offers a *menu* of alternatives, so an
operator can deliberately choose a newer version. Two **live, non-fatal** signals feed the menu
(`scripts/lib/version_resolver.js` + `resolve_versions.js`):

- **Exchange Maven facade** (`exchange.listVersions(groupId, artifactId)` → every published version):
  used for **latest-in-major** (highest patch within the matrix pin's major — never crosses a
  breaking major, e.g. Slack `1.x → 2.x`) and **latest** (highest published overall).
- **The connector's release-notes page** — each version's Compatibility TABLE carries an **OpenJDK**
  row (`"8 and 11"` → `"8, 11, and 17"`). Parsing that cell is MuleSoft's only machine-readable,
  per-version statement of Java-17 support, from which we derive **firstCompatible** (the *minimum*
  Java-17-safe version).

Each connector's entry in `connectorChoices[]` looks like:

```jsonc
{
  "artifactId": "mule4-slack-connector",
  "matrixSet": "1.0.17",          // curated Java-17-safe pin (authoritative floor)
  "firstCompatible": "1.0.17",    // lowest version the OpenJDK table marks 17-safe
  "latestInMajor": "1.0.20",      // highest 1.x patch published (safe bump)
  "latest": "2.1.0",              // highest published overall (may be a breaking major)
  "recommended": "1.0.17",        // = matrixSet; NEVER auto-jumps to latest
  "options": [ /* {strategy, version, label} menu, matrixSet first */ ],
  "staleness": "Matrix pins … 1.0.17; 1.0.20 is now published in the 1.x line — consider bumping (not auto-adopted)."
}
```

**The matrix pin is never auto-replaced by live data.** "Latest published" may be a breaking major
or not yet Java-17-verified, so it is advisory only; a per-connector `staleness` note is bubbled into
`warnings` when a newer in-major version exists. Every live lookup is wrapped so a network/auth/parse
failure (or `--no-fetch`) degrades that connector to a **matrix-only** choice — resolution never
throws and never pins *below* the curated floor.

### Choosing a strategy

The orchestrator's `start_upgrade` accepts `versionStrategy` and per-connector `connectorSelections`;
assess then rewrites the matrix pins **before** producing the ChangePlan, so the emitted edits target
the chosen versions. Strategies (each falls back to `matrixSet` when its live value is missing):

| Strategy | Picks | Notes |
|----------|-------|-------|
| `min` *(default)* | `matrixSet` | The curated, recommended floor. Nothing changes. |
| `first-compatible` | `firstCompatible` | Lowest Java-17-safe version — the *minimum* upgrade (may sit below `matrixSet` by explicit opt-in). |
| `in-major` | `latestInMajor` | Highest patch within the pin's major; never crosses a breaking major. |
| `latest` | `latest` | Highest published overall — **verify**, may be a breaking major. |
| `manual` | `connectorSelections[artifactId]` | Explicit per-connector version; unselected connectors keep the curated pin. |

The **`resolve_versions`** tool (and its underlying `resolveVersionsForApp()`) returns just the
`connectorChoices[]` menu — SCOPED to the connectors THIS app actually references, with each one's
`current` version populated — without emitting the full ChangePlan. This is the Full Split's step ②:
useful for an interactive agent that wants to present the version menu before committing to a strategy.
The gating/connector **drift** advisory is likewise split out into the **`check_drift`** tool (step ③),
so a plain `assess` stays lean.

## Deployed-state check (verbatim name, always explained)

The source assessment reads the *repo*; assess can additionally report what's **actually running** in
Anypoint Runtime Manager. Pass the exact deployed application name via `--deployed-api-name`
(or the tool's `deployedApiName`); assess looks it up **verbatim** (exact match — no fuzzy/contains
logic) in the given `--env-name`/environment and reports the outcome on `deployedStateCheck`:

```jsonc
// found:
{ "checked": true,
  "deployedState": {
    "found": true, "name": "orders-api", "status": "RUNNING",
    "runtimeVersion": "4.6.0:8-java", "muleVersion": "4.6.0", "javaVersion": 8,
    "replicas": 2, "lastDeploy": "2026-05-01T10:00:00Z", "environment": "Production" } }

// skipped — the reason is ALWAYS stated:
{ "checked": false, "reason": "No deployed application name provided — skipped the live deployed-state check." }
{ "checked": false, "reason": "Anypoint not configured (credentials absent) — skipped the deployed-state check for \"orders-api\"." }
{ "checked": false, "reason": "Deployed-state check skipped: no deployment named \"orders-api\" in environment \"Production\"." }
```

The check is **never silently omitted** — whenever it isn't done, `deployedStateCheck.reason` explains
why (no name given / not configured / name-not-found / unreachable) and the reason is also pushed into
`warnings`. Fully **non-fatal**: any auth/network error degrades to a skip-with-reason.

> **ARM does not expose deployed connector versions** — those are baked into the app archive, not the
> deployment descriptor. So this check informs the **runtime / Java** picture only (useful to confirm
> the running app matches the source pom before upgrading); connector pins still come from the matrix +
> the connector version choice above.

## The rules engine (ported semantics)

- **Topology** (`classifyTopology`): chain depth + top-of-chain `dependencyManagement`
  → BOM_PARENT_APP / PARENT_APP / APP_STANDALONE / MULTI_LEVEL.
- **appOverride strategy** (default): every version edit is written into the app's OWN module pom
  so sibling modules sharing a parent/BOM are never touched.
  - `${property}` connector/plugin version → override that property in the app pom (one edit covers
    every artifact referencing it).
  - literal inline `<version>` → replace with the pinned literal.
  - declared but version-less: **gating** rules ADD a `<version>`; **connectors** SKIP (inherited
    from parent/BOM) and are surfaced as `connectorGaps`.
  - a coordinate the app pom doesn't declare at all → never added.
- **inPlace strategy** (legacy): edits land on the declaring parent/BOM pom, and a shared-file
  WARNING is raised.
- **resolveRule precedence**: `<properties>` value → inline dependency `<version>` → inline plugin
  `<version>`. An inline `${ref}` collapses back to a property edit.
- **Rehydrate**: each pom is re-parsed from its raw text so repeated `<dependency>`/`<plugin>`
  elements survive (a Map-based parse would collapse duplicates and silently drop connector pins).
- **Hygiene**: `computeMunitArgLineEdits` emits a `munitArgLines` edit per in-repo pom whose MUnit
  plugin carries JPMS `--add-opens/--add-exports/--add-modules` argLines (rejected by the Mule 4.9
  embedded container on Java 17).
- **Diff-aware app edits**: MUnit `<runtimeVersion>`, `mule-artifact.json`
  (`minMuleVersion` + `javaSpecificationVersions`, never downgraded), and CI `java-version` are
  emitted only when the current value is actually below target.
- **App pom `<version>` minor bump**: emitted only when the upgrade changes something else and the
  app declares its own literal `<version>` + `<artifactId>`.

## Improvements over the Mule app

- Runs against a **full local clone**, not paged GitHub Contents-API reads — sees every `.java`
  file, DW POJO usage, and matrix `java:`/env-var CI Java versions the fixed regex transforms miss.
- **Live connector-version enrichment** via the Exchange Graph API + the curated notes-map, with a
  graceful bundled-YAML fallback (the Mule app used a static Exchange-hosted matrix facade).
- Every edit and warning is emitted as structured data AND explained in the CLI summary, so the
  reasoning is auditable.

## Verification

`tests/assessment.test.js` ports the Mule app's `dw-assessment-suite.xml` MUnit cases 1:1
(semver `lt`, `computePropEdits`, `computePropEditsOverride`, `buildAssessmentResult` golden +
shared-file warning + appOverride retarget + rehydrate-from-pomText + pomVersion bump/no-bump,
`classifyTopology`, `normalizePath`/`initChain`, `scanFlags`). Run `npm test` from the repo root.
