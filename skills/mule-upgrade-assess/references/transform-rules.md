# Transform Rules — exact semantics of the 8 surgical rewrites

These document the byte-preserving rewrite functions ported from the Mule app's DataWeave
modules (`src/main/resources/dwl/*.dwl`). Each is implemented in
`skills/mule-upgrade-apply/scripts/rewrites/`. They are applied by `apply_edits.js` in the
fixed order listed at the bottom.

All rewrites operate on **raw text** and change ONLY the targeted values — comments, ordering,
indentation, and unrelated elements are preserved untouched.

---

## 1. pom_properties (`rewritePomProperties`)
Replace Maven `<property>` VALUES by tag name.
- Replaces `<tag>val</tag>` where `tag` appears in the edit list.
- `addIfAbsent: true` edits whose tag is NOT already present are INSERTED into `<properties>`
  (or a new `<properties>` block is created just before `</project>` when none exists).
- Edits without `addIfAbsent` are replace-only (no-op when the tag is absent).
- Backs the **appOverride** strategy (override an inherited property by adding it to the app pom).

## 2. dep_versions (`rewriteDepVersions`)
Pin `<version>` of `<dependency>` entries matched by `groupId` + `artifactId`.
- Existing inline `<version>` (literal OR `${…}`) → REPLACED with the pinned literal.
- BOM-managed dependency with NO `<version>` → one INSERTED after the first `</artifactId>`.
- A dependency the app doesn't declare is never touched.

## 3. plugin_versions (`rewritePluginVersions`)
Pin `<version>` of `<plugin>` entries matched by `artifactId` (+ optional `groupId`).
- Only the plugin's OWN (first) `<version>` is affected — nested dependency versions are untouched.
- Plugin with no `<version>` → one INSERTED after its own `</artifactId>`.

## 4. pom_version (`rewritePomVersion`)
Bump the app module's OWN `<project><version>`.
- Rewrites ONLY the value inside the EXISTING `<version>` tag that immediately follows the
  project's own `<artifactId>`. No tag is ever added.
- No-op when the version is inherited, declared before the artifactId, or `${property}`-driven.

## 5. munit_runtime (`rewriteMunitRuntime`)
Replace ALL `<runtimeVersion>…</runtimeVersion>` values (munit-maven-plugin config) with the
target runtime. No-op if absent. (Placeholder `${…}` values are handled via the property path.)

## 6. mule_artifact (`rewriteMuleArtifact`)
Update `mule-artifact.json`: set `minMuleVersion` and (re)add `javaSpecificationVersions`,
PRESERVING every other key. Re-serialised as pretty JSON (2-space indent).

## 7. ci_workflow (`rewriteCiWorkflow`)
Bump the Java version in a GitHub Actions workflow using `actions/setup-java`:
`(java-version:[ \t]*["']?)([0-9]+)(["']?)` → replace the numeric group. Surrounding
quotes/spacing preserved. **Out of scope:** strategy-matrix `java:` and `JAVA_VERSION` env vars.

## 8. munit_arglines (`rewriteMunitArgLines`)
Strip `<argLine>` entries carrying JPMS flags (`--add-opens` / `--add-exports` / `--add-modules`)
but ONLY inside MUnit plugin blocks (`munit-maven-plugin` / `munit-extensions-maven-plugin`).
A now-empty `<argLines>` wrapper is removed. Idempotent (no flags present → unchanged).
Required because the Mule 4.9 embedded MUnit container rejects boot-module-layer tweaks on Java 17.

## Bonus. parent_pom (`rewriteParentPom`)
Used by `mule-upgrade-parent-pom`. Pins matrix connectors MANAGED by a shared parent/BOM (via a
`<properties>` value referenced by dependencyManagement, or a literal inline `<version>`), then
minor-bumps the parent/BOM's OWN `<version>` when at least one connector was pinned. Never adds a
dependency the parent doesn't already manage; `${ref}` inline versions are handled via the property.

---

## Fixed apply order (`applyEdits`)
```
depVersion → pluginVersion → pomProperty → munitRuntimeVersion → muleArtifactJson
→ ciWorkflow → munitArgLines → pomVersion
```
Inline dependency + plugin `<version>` rewrites run first (independent regions), then property
rewrites, then the app-level file edits, and finally the project version bump.
