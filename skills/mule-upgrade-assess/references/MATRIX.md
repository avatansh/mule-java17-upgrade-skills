# The compatibility matrix

Everything the upgrade engine knows about "what version is safe" lives in a compatibility matrix
YAML in this folder. This document is the operator's guide to those files. It used to be a 43-line
comment block at the top of the matrix itself; it moved here when the matrix became one file **per
Java target**, because duplicating it per file guaranteed the copies would drift.

---

## 1. One file per Java target

```
references/
  compatibility-matrix.yaml          <- the DEFAULT target (currently Java 17)
  compatibility-matrix-java21.yaml   <- Java 21
  MATRIX.md                          <- this file
```

`compatibility-matrix.yaml` is always the default target. That is a deliberate invariant: when the
estate finishes moving to Java 21 and Java 17 is retired, the Java 21 content becomes
`compatibility-matrix.yaml` and the old file is deleted — no code, no config, and no caller changes.

Non-default targets are named `compatibility-matrix-java<major>.yaml`. Discovery is automatic: the
loader globs `compatibility-matrix*.yaml`, so adding Java 25 later means dropping in a file. Nothing
else needs to know about it.

### Why separate files rather than one file with overlays

The Java-dependent and Java-neutral fields are interleaved at field level. A connector entry is
`{ property, groupId, artifactId, set }` — the first three are the same on every Java version and
only `set` moves. There is no clean seam to split on, so an overlay design would have to re-key
`connectors` from a list to a map and introduce merge-precedence rules. For an artifact whose entire
job is to be the authoritative safety judgment, "read it top to bottom and see the whole truth" is
worth more than avoiding repetition.

The trade is real duplication, and it is handled mechanically rather than by discipline — see
section 4.

The count also does not grow. Java targets follow the LTS cadence (8, 11, 17, 21, 25) and old ones
are **retired, not accumulated**. Two live targets is the steady state.

---

## 2. Delivery (see `config.yaml` -> `matrix.source`)

- These files are the bundled **classpath** copies — always packaged with the skill and used as the
  fallback whenever a live fetch fails.
- In dev/prod the orchestrator fetches the **centrally-governed** copy from Anypoint Exchange at
  runtime (cached `matrix.refreshSeconds`), so updating the matrix does **not** require redeploying
  every instance: publish a new asset version and instances pick it up.

> **Multi-target caveat.** The Exchange source fetches a single asset, which is the default target.
> A run against a non-default target always resolves from the bundled file, and `resolveMatrix()`
> emits a warning saying so rather than letting it pass unnoticed. Governing a second target through
> Exchange means publishing it as its own asset.

### Publish / update on Exchange

Asset `<orgId>:java17-compatibility-matrix`, packaging `yaml`. Using `anypoint-cli-v4` (needs a
Connected App with the Exchange Contributor role):

```bash
anypoint-cli-v4 exchange asset upload \
  --organization "<orgId>" \
  --name "Java 17 Compatibility Matrix" \
  --classifier yaml --mainFile compatibility-matrix.yaml \
  "<orgId>/java17-compatibility-matrix/1.0.0"
```

Bump the version (and `config.yaml` `matrix.exchange.version`) when publishing a revision, and keep
the bundled copy in sync so the fallback stays accurate.

---

## 3. Authority model — read before editing connector versions

The matrix is the **authoritative** source for the Java-safe judgment.

Live enrichment (`resolve_versions.js`: the Exchange Graph API for published versions, plus the
curated connector-notes-map for each connector's OpenJDK/Mule-runtime compatibility table) adds a
run's connector `firstCompatibleVersion`, `latest`, and `latest-in-major`. "Latest published" is
deliberately **not** auto-adopted as the pin, because a newer version may be a breaking major or may
not yet be verified on the target Java.

So: live data drives the version **choice** offered to the user and a staleness advisory. The
curated matrix remains the fallback and the compatibility **floor**.

---

## 4. Keeping the target files in sync

Some fields are Java-neutral and must be identical in every target file — connector `property` /
`groupId` / `artifactId`, and the gating rules' coordinate fields. Editing one file and forgetting
the other is the one real hazard of the per-target layout, so it is enforced rather than trusted:

| Guard | What it does |
| --- | --- |
| `npm test` parity check | Fails if connector or gating **identity** fields differ across target files, naming the exact drift |
| `matrix_update` prompt | Any change asks which targets it applies to (17 / 21 / both) before writing |
| `matrix diff <a> <b>` | Prints the delta between two targets on demand |
| Scaffolding | A new target file is generated from an existing one, so identity fields are copied by machine, never by hand |

Rule of thumb for the prompt: a **version** change (a CVE forces a pin up, a new connector release)
is usually target-specific, because the safe version differs per Java. A **coordinate** change (a
connector is renamed, a new connector is added to the estate) is Java-neutral and belongs in **all**
targets.

---

## 5. Adding a new Java target

1. Scaffold it from the current default. Identity fields are copied; every version-bearing field is
   blanked and the file is stamped `status: uncurated`.
2. Curate the blanked fields against the real sources (release notes, the MuleSoft Java-compatible
   connector KB, runtime support matrices). Until this is done the engine **refuses** to run against
   the target rather than emitting a plan built from another Java version's floors.
3. Drop `status: uncurated`. The target now appears in the assistant's menu automatically.

### What has to be curated

| Key | Notes |
| --- | --- |
| `target.javaVersion` | The new major |
| `target.runtime` | Lowest Mule runtime supporting it |
| `muleArtifact.minMuleVersion` | Match `target.runtime` |
| `muleArtifact.javaSpecificationVersions` | Must include the new target |
| `gating.*` `min` / `set` | Tool floors: mule-maven-plugin, MUnit, munit-extensions, weave, runtime |
| `connectors[].set` | Re-curate every pin against its release notes |
| `manualReview` / `processGuide` prose | Reword any text naming a specific Java version |

Outside these files: `config.yaml` `scan.targetJava` controls what the fleet scan calls stale.

The three Java gating rules use `compare: "java"`, so the set of "stale" Java versions is **derived**
— there is no `in: [...]` list to extend. `assess()` cross-checks `target.javaVersion`,
`muleArtifact.javaSpecificationVersions`, and the Java gating rules, and warns on a half-done
retarget.
