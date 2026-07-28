---
name: mule-upgrade-apply
description: >-
  Apply a Java-17 upgrade ChangePlan to a MuleSoft app's files — surgically rewrites pom.xml
  properties, dependency/plugin versions, the project version, mule-artifact.json, MUnit
  runtimeVersion, GitHub Actions Java version, and strips JPMS argLines. Use after
  mule-upgrade-assess has produced a ChangePlan and you need to edit the files (locally or as
  staged blobs). Byte-preserving: only targeted values change. Triggers on "apply the change
  plan", "rewrite the pom for Java 17", "apply mule upgrade edits".
---

# mule-upgrade-apply

Applies an approved `ChangePlan` (from `mule-upgrade-assess`) to a MuleSoft app's source files.
This is the faithful port of the Mule app's `dwl::applyEdits` + the 8 surgical rewrite modules.

## What it does

Given a `ChangePlan.fileEdits[]`, it groups edits by file and applies each file's edits in the
**fixed order** the Mule app uses:

```
depVersion → pluginVersion → pomProperty → munitRuntimeVersion → muleArtifactJson
→ ciWorkflow → munitArgLines → pomVersion
```

Every rewrite is **byte-preserving**: only the targeted values change — comments, ordering,
indentation, and unrelated elements are left exactly as-is. See `references/transform-rules.md`
for the precise semantics of each rewrite.

## How to run

```bash
# Apply a ChangePlan to a local clone and write files in place:
node scripts/apply_edits.js --change-plan plan.json --repo /path/to/clone --write

# Or preview staged blobs (JSON [{path, content}]) without writing (API/PR mode):
node scripts/apply_edits.js --change-plan plan.json --repo /path/to/clone
```

`plan.json` may be a full AssessmentResult (with a `changePlan` key) or a bare ChangePlan.

## Programmatic use

```js
import { applyEdits, applyChangePlan } from "./scripts/apply_edits.js";
const after = applyEdits(rawPomText, editsForThatFile);          // one file (sync)
// Whole plan → [{path,content}]. `applyChangePlan` is async and awaits its reader.
// Local clone: default fs reader (pass repoRoot). API mode (no clone): pass a GitHub reader.
const staged = await applyChangePlan(changePlan, repoRoot);                 // local clone
const stagedApi = await applyChangePlan(changePlan, undefined, ghReadFile); // api mode
```

## Notes / improvements over the Mule app

- `ci_workflow` only rewrites `actions/setup-java` `java-version:` values. Matrix `java:` blocks
  and `JAVA_VERSION` env vars are intentionally out of scope here — `mule-upgrade-assess` flags
  them as warnings so a human handles them. When run inside Claude, you can additionally reason
  about those cases and edit them explicitly.
- `mule_artifact` preserves all existing keys and only manages `minMuleVersion` +
  `javaSpecificationVersions`.
