# Phase 2 Research — Java-support assessment, trusted-source version sourcing, and an agentic session

Source of truth for this document: MuleSoft docs read on 2026-07-26.
- https://docs.mulesoft.com/general/java-support (main matrix + prerequisites)
- https://docs.mulesoft.com/general/customer-connector-upgrade (custom connector Java 17 checklist)
- https://docs.mulesoft.com/general/partner-connector-upgrade (ISV/certified connector checklist)
- https://docs.mulesoft.com/release-notes/connector/anypoint-connector-release-notes (connector index — ~150 connectors, links only, no versions/feed)
- https://docs.mulesoft.com/exchange/asset-versions (Exchange GraphQL + Limits API)
- https://docs.mulesoft.com/release-notes/mule-runtime/updating-mule-4-versions (runtime update compatibility guidance)
- KB "Java 17-Compatible Anypoint Connectors" id=000782248 — **does not render server-side** (Salesforce Lightning "CSS Error"); not machine-fetchable via WebFetch.

---

## Part 1 — What must be ASSESSED and EDITED for a Java 17 upgrade

### 1a. Runtime → Java support matrix (from java-support)
| Mule runtime | Java 8 | Java 11 | Java 17 |
|---|---|---|---|
| 4.5 | ✅ | ✅ | ❌ |
| 4.6 (LTS/Edge), 4.7, 4.8 | ✅ | ✅ | ✅ |
| 4.9 (LTS/Edge), 4.10, 4.11, 4.12 | ❌ | ❌ | ✅ (Java 17 only) |

- Java 17 support **begins at Mule 4.6**.
- **Compile-for-17** requires **Mule 4.9.0+** (projects and their dependencies must be compiled for Java 17 or lower).
- No Java 21 information on the page.

### 1b. EOL / deadlines
- **Java 8 and 11 standard support ends August 2026** (tied to 4.6 LTS).
- Java 8 support for included policies / API proxies ended **February 2025**.

### 1c. Full assessment checklist (what our assessor should detect)
Ordered roughly by our current coverage vs. gaps:

**Already covered by our matrix/assessor:**
1. `app.runtime` / `app.runtime.semver` ≥ 4.6.0 (we set 4.9.18).
2. `java.version`, `maven.compiler.source`, `maven.compiler.target` 8/11 → 17.
3. `mule.maven.plugin.version` ≥ 4.1.0 (doc floor is **4.1.1+ for Java 17 deploy**; our min 4.1.0 → **should raise to 4.1.1**).
4. `munit.version` ≥ 3.6.3 (JPMS container fix).
5. `munit.extensions.maven.plugin.version` ≥ 1.2.0.
6. `weave.version` ≥ 1.2.0 (DataWeave POJO setter requirement lands at **DW 2.6.0+**).
7. Connector version pinning (16 connectors).
8. `mule-artifact.json`: `minMuleVersion` 4.9.0, `javaSpecificationVersions: [17]`.
9. JPMS hygiene: strip `-XX:-UseBiasedLocking`; strip `--add-opens/--add-exports/--add-modules` from MUnit argLines.
10. manualReview flags: custom Java, DW POJO, API policies, MUnit JPMS flags.

**Gaps to add (surfaced by the docs):**
- **`mule-artifact.json` may need `javaSpecificationVersions` sanity** even when the field key differs across older archetypes — assessor should detect its ABSENCE and add it (already in muleArtifact target; confirm apply covers absent-key case).
- **JDK-internal / reflection usage in custom Java** — doc calls out `setAccessible(true)` on JDK internals, split packages (JPMS), `ResourceBundle` loading. We flag customJavaCode generically; we could add a `scanRegex` for `setAccessible(` and `ResourceBundle.getBundle(` to make the warning specific.
- **Serialization via reflection (Gson-style) → DTOs** — add a soft scan hint.
- **Test tooling**: PowerMock → Mockito; Mockito can't mock JVM classes. Add manualReview for `powermock` in test deps.
- **`mule-sdk-api` 0.10.1 + `@JavaVersionSupport`** — only relevant if the target repo is *itself a connector/module project* (has `<packaging>mule-extension` or a `@Extension` class). Our tool targets **apps**, but the fleet may include custom connectors → add topology detection `CUSTOM_CONNECTOR` and, when detected, emit the connector-upgrade checklist as warnings rather than auto-edits.
- **REST Connect connectors**: republish spec to Exchange to regenerate a Java-17 connector (cannot be fixed by pom edit) — surface as manualReview when a REST-Connect-generated dependency is found.
- **Deploy-time enforcement reality**: Mule 4.5.0+ assumes connectors *without* `@JavaVersionSupport` are Java 8/11 only, and **blocks deployment** with `Extension '...' does not support Java 17. Supported versions are: [1.8, 11]`. This is the ground truth our version pinning is trying to pre-empt. `-Dmule.jvm.version.extension.enforcement=LOOSE` bypasses the check (test only) — worth documenting in transform-rules.md.
- **Ordering constraint**: policies must be upgraded **before** API proxies/apps. Relevant to fleet scan sequencing.

### 1d. Custom / partner connector concrete versions (for a CUSTOM_CONNECTOR topology or fleet member)
| Component | Required for Java 17 |
|---|---|
| `mule-sdk-api` | 0.10.1 |
| `mule-modules-parent` (legacy) | ≥ 1.9.0 (auto-sets minMuleVersion 4.9.0; <1.9.0 pins bytecode to Java 8) |
| `mule-java-extension-parent` | recommended (declare min Mule version explicitly) |
| Min Mule runtime for Java 17 tests | 4.6.0 |
| ByteBuddy | 1.14.0 (replace CGLib) |
| Jacoco | 0.8.10 |
| SLF4J | 2.x |
| REST SDK | 0.8.0-RC4 |
| JDeps plugin | 3.1.2 (detect JDK-internal API use) |
| `mule-javaee-runtime-bom` | 4.6.0 |
| MUnit (MTF) | 3.1.0+ (3.1 needs runtime ≥ 4.3.0) |
| `@JavaVersionSupport` | must include `JAVA_17` in the `@Extension` class (Java SDK); XML SDK inherits automatically |

Earliest-compatible test command from the doc:
```
mvn -f pom.xml -s ~/.m2/settings.xml -Dapp.runtime=4.6.0 -Dmunit.version=3.1.0 -Dmule.maven.plugin.version=4.1.0 -fae test
```

---

## Part 2 — Can EVERY version be fetched from a trusted MuleSoft source (matrix as fallback only)?

**Short answer: Partially — and our existing architecture already implements the right layering. Full "every version, always live" is NOT achievable from a single public machine-readable feed. Here is the honest source-by-source breakdown.**

### 2a. What trusted, machine-readable sources actually exist
| Source | Machine-readable? | Gives us | Auth |
|---|---|---|---|
| **Exchange Maven facade** `/api/v3/maven/{org}/{asset}/maven-metadata.xml` | ✅ XML list of ALL versions | Every published version of any Exchange asset (connectors, modules, the matrix asset) | Bearer (Connected App) for private; MuleSoft public connectors are readable |
| **Exchange GraphQL** `https://anypoint.mulesoft.com/graph/api/v1/graphql` | ✅ JSON | `{groupId, assetId, version}` lists, paginated (limit/offset), by org | Bearer w/ root-org perms |
| **Maven Central / MuleSoft Maven repo** `maven-metadata.xml` per artifact | ✅ XML | All published versions of an artifact (groupId/artifactId) | none (public) |
| **Connector release-notes index** | ❌ HTML links only, ~150 connectors, **no versions, no feed** | connector NAMES + per-connector page URLs | none |
| **Per-connector release-notes page** | ⚠️ HTML prose | latest version + Java-support notes, but no stable schema | none |
| **KB 000782248 (Java-17 connectors)** | ❌ renders client-side (Lightning); WebFetch gets a CSS-error stub | the canonical Java-17 version list — **only human-readable** | Salesforce login for some views |
| **java-support / updating-mule-4-versions** | ❌ HTML prose | gating rules, prerequisites, deadlines — **not per-version data** | none |

### 2b. The critical distinction: "latest version" ≠ "Java-17-compatible version"
- Maven-metadata / Exchange GraphQL give the **newest** version — but the newest may be a **breaking major** (e.g. Slack 2.x, Salesforce 11.x) or may still lack `@JavaVersionSupport`.
- The **only authoritative statement of Java-17 compatibility** is (a) the KB article, or (b) the connector artifact's own `@JavaVersionSupport` metadata evaluated at deploy time.
- Therefore "fetch every version from a trusted source" splits into two questions:
  1. **What versions exist?** → fully answerable live (Maven-metadata / Exchange GraphQL). ✅
  2. **Which existing version is the right Java-17 target?** → NOT reliably answerable from a public machine feed. Requires either the KB (not machine-readable) or actually resolving the artifact and inspecting its `@JavaVersionSupport` (heavy). ⚠️

### 2c. Feasibility verdict
**Yes, we can make the matrix a true fallback for the "what versions exist / what is latest-in-major" question, and we already have most of the plumbing (`exchange.js` Maven facade + `matrix_fetch.js` release-notes fetch + 24h cache + bundled fallback).** But for the "**is this version Java-17-safe**" judgment, the curated matrix must remain the **primary trusted source** because MuleSoft publishes that fact only in human-readable form. So the accurate framing is:

- **Version discovery** → live-first (Exchange/Maven), matrix as fallback. ✅ achievable.
- **Java-17 compatibility floor + breaking-major ceiling** → matrix-first (curated), live data as an *enrichment/staleness check*. ⚠️ matrix stays authoritative.

This is defensible and honest — and it is the exact "single source of truth prevents drift" principle we applied to the tool schemas.

### 2d. Concrete improvements to propose (design, not yet built)
1. **Add a Maven-metadata resolver to `exchange.js`** — `listVersions(groupId, artifactId)` hitting `/api/v3/maven/{org}/{artifact}/maven-metadata.xml` (public MuleSoft org for the 16 connectors), reusing existing `parseMavenMetadata` + `highestSemver`. Already 90% present; just needs a per-connector (not per-family) entry point.
2. **Add a "latest-in-major" selector** — given the matrix `set` version (e.g. Salesforce 10.19.2), query live versions and pick the highest patch **within the same major** (10.x), never crossing into 11.x. This keeps us current on patches without risking breaking majors, and needs no compatibility oracle.
3. **Staleness advisory, not a hard override** — when live data shows a newer in-major version than the matrix `set`, emit a `matrixStaleness` warning ("matrix pins Salesforce 10.19.2; 10.21.0 is now published — consider bumping the matrix") rather than silently upgrading. Preserves curator control; surfaces drift.
4. **Exchange GraphQL enumerator (optional, org-scoped)** — for customers with private/custom connectors, enumerate `{groupId, assetId, version}` for the root org so the fleet scanner discovers connectors not in the bundled 16. Env-gated + non-fatal (same pattern as the ARM/API-Manager clients).
5. **Keep gating rules 100% static** — runtime/java/compiler/munit/weave/plugin floors are NOT on any machine feed; they stay curated and authoritative. (Already the design.)
6. **Raise `mule.maven.plugin.version` min 4.1.0 → 4.1.1** to match the doc's Java-17-deploy floor.
7. **Document the compatibility-oracle limitation** in `compatibility-matrix.yaml` header and `matrix_fetch.js` — future maintainers must know that "latest published" is deliberately NOT auto-adopted.
8. **Cache layering** — extend the existing `~/.mule-upgrade/matrix-cache.json` to hold per-connector version lists (keyed by artifactId) with the same 24h TTL, so a fleet run makes one Maven-metadata call per connector, not per app.

### 2e. What is NOT feasible / must stay curated (state honestly)
- A fully automated "give me the correct Java-17 version for every connector, live" is not achievable purely from public machine-readable sources because the compatibility fact lives in the KB (client-rendered) and in per-artifact bytecode metadata.
- Deploy-time is the ultimate oracle (`@JavaVersionSupport`); we can pre-empt but not replace it. Document that MUnit/deploy is the final gate.

---

## Part 3 — Agentic interactive session (MuleSoft Vibes / Agentforce style)

Goal: one conversational session where a user drives all skills with natural prompts — "scan my fleet", "which connectors are incompatible?", "upgrade payments-api, but pick the first compatible version not the latest", "open the PR", "did it deploy?".

### 3a. What we already have (the hard 80%)
- **10 MCP tools** with published JSON schemas (SoT): assess_app, start_upgrade, get_job_status, reapply_job, delete_job, upgrade_parent_pom, reconcile, rollback, scan_fleet, scan_notify.
- **MCP JSON-RPC server** + REST facade + correlation IDs + structured logs + /health + /metrics.
- **Skills auto-invoke** via SKILL.md frontmatter (in a Claude Code session, the LLM already routes prompts to skills).
- **Job store** as durable session state across turns.

### 3b. What's missing for a true interactive agentic experience
1. **A conversational entry-point skill / system prompt** ("mule-upgrade-agent") that:
   - Knows the 10 tools and the state machine, and maps free-form user intents to tool calls.
   - Holds session context (which app/fleet, which env, last jobId) so follow-ups like "now open the PR" resolve without re-specifying.
2. **Choice-offering, not just execution** (the image's key UX): when the assessor finds incompatible connectors, the agent should PRESENT options rather than auto-pick:
   - "latest compatible" / "first (minimum) compatible" / "highest-in-current-major" / per-connector manual selection.
   - This needs assess to RETURN candidate version sets (from Part 2's live resolver) with a compatibility label, and a tool param `versionStrategy: latest|min|in-major|manual` on start_upgrade.
3. **A `resolve_versions` (or `list_connector_options`) tool** — new: given the assessed connector gaps, return `{artifactId, current, matrixSet, liveLatest, latestInMajor, recommended}` so the agent can render the choice table like the screenshot.
4. **Interactive confirmation gating** — start_upgrade should support a `dryRun`/`plan-only` mode (return ChangePlan for the user to approve) then a `confirm` call. Maps to the Agentforce "here's what I'll do — proceed?" turn.
5. **Streaming progress over the session** — the poll-based deploy tail (reconcile) already exists; the agent surfaces `get_job_status.message` + `nextPollSeconds` as conversational updates ("PR open, waiting on MUnit CI…").
6. **Transport for a hosted agent** — two paths:
   - **In-IDE (Claude Code)**: already works today — the skills + MCP server are directly usable. This is the fastest "agentic session".
   - **Standalone hosted agent (Agentforce/Vibes parity)**: point an Agentforce agent / any MCP client at our MCP endpoint (bearer-guarded, correlation-ID aware). The 10 tools become the agent's action library. The image ("MuleSoft Vibes, GA Q3'26") is essentially this — an Agentforce topic backed by upgrade tools.
7. **Guardrails** — the agent must never auto-merge/auto-deploy without explicit user confirmation (we already don't merge; keep it). Destructive tools (rollback, delete_job) should require confirmation phrases.

### 3c. Minimal build to get there (proposed, not built)
- **New tool** `resolve_versions` (assess → live version options) — schema JSON added to server/schemas + tools.js.
- **New param** `versionStrategy` + `dryRun` on `start_upgrade` (schema update; SoT guard already enforces parity).
- **New skill** `mule-upgrade-agent/SKILL.md` — a conversational orchestration guide: intent→tool routing table, session-state conventions (remember last jobId/app/env), and the choice-presentation script. No new engine code; it composes existing skills.
- **Docs**: a "Use as an Agentforce/MCP agent" section in README pointing an external MCP client at the server.
- Everything stays non-fatal / env-gated where it touches Anypoint, consistent with existing clients.

### 3d. Honest scope note
- We cannot host a *persistent push* experience from a skill alone (same constraint as the webhook decision) — the interactive session is request/response (MCP) + polling for long-running deploy. That matches how Agentforce topics actually call tools, so it is not a real limitation for the target UX.

---

## Recommended next actions (for user approval)
1. Small matrix corrections now (safe, low-risk): mmp min 4.1.0→4.1.1; add header note on compatibility-oracle limitation; add powermock/setAccessible/ResourceBundle scan hints.
2. Build the **live Maven-metadata version resolver** + **latest-in-major selector** + **staleness advisory** in exchange.js/matrix_fetch.js (matrix stays authoritative for compatibility).
3. Build the **agentic layer**: `resolve_versions` tool, `versionStrategy`/`dryRun` on start_upgrade, and the `mule-upgrade-agent` conversational skill.
