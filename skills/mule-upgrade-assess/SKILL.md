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
    "connectorGaps":     [ /* parent/BOM-managed connectors below target, unpinnable in the app pom */ ]
  },
  "warnings": [ /* actionable prose */ ]
}
```

The `changePlan` is exactly what `mule-upgrade-apply` consumes — assess → apply → PR is the pipeline.

## How to run

```bash
# Assess a local clone (default: fetch connector versions live, fall back to bundled YAML):
node scripts/assess.js --repo /path/to/clone --out plan.json

# Multi-module repo: point at the app subpath (its pom chain is walked up to the outermost in-repo parent):
node scripts/assess.js --repo /path/to/clone --app-path modules/my-app --app-name my-app

# Use a specific release-notes page for connector versions:
node scripts/assess.js --repo /path/to/clone --release-notes-url https://docs.mulesoft.com/release-notes/connector/anypoint-connector-release-notes

# Offline / deterministic (skip the network, use bundled matrix or a fresh cache):
node scripts/assess.js --repo /path/to/clone --no-fetch

# Pass the HEAD sha so the PR step can enforce a stale-plan guard:
node scripts/assess.js --repo /path/to/clone --head-sha "$(git -C /path/to/clone rev-parse HEAD)"
```

Flags: `--strategy appOverride|inPlace` (default `appOverride`), `--out <file>` (else stdout).

## The compatibility matrix (hybrid, dynamic + static)

- **Static core** — `references/compatibility-matrix.yaml` (copied verbatim from the Mule app):
  target runtime/Java, all **gating** rules (runtime, java.version, compiler source/target,
  mule-maven-plugin, munit, munit-extensions, weave), `removeMunitJpmsFlags`, `manualReview` flags,
  and the `mule-artifact.json` target. Gating rules do **not** live on the connector release-notes
  page, so they stay static and authoritative.
- **Dynamic connectors** — `scripts/lib/matrix_fetch.js` fetches the latest Java-17 connector
  versions from a release-notes URL (`--release-notes-url`, else the MuleSoft connector
  release-notes index), matched to the 16 known connector artifactIds. The result **replaces** the
  bundled connector versions for the run.
- **Cache + fallback** — the first fetch per run is cached to `~/.mule-upgrade/matrix-cache.json`
  (~24h TTL) and reused across assess + upgrade. On **any** failure (network error, unparseable
  HTML, empty connector set) it **falls back to the bundled YAML** — never a hard failure. The run
  reports which source won (`fetch` / `cache` / `bundled`).

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
- **Dynamic connector versions** with cache + graceful fallback (the Mule app used a static
  Exchange-hosted matrix facade).
- Every edit and warning is emitted as structured data AND explained in the CLI summary, so the
  reasoning is auditable.

## Verification

`tests/assessment.test.js` ports the Mule app's `dw-assessment-suite.xml` MUnit cases 1:1
(semver `lt`, `computePropEdits`, `computePropEditsOverride`, `buildAssessmentResult` golden +
shared-file warning + appOverride retarget + rehydrate-from-pomText + pomVersion bump/no-bump,
`classifyTopology`, `normalizePath`/`initChain`, `scanFlags`). Run `npm test` from the repo root.
