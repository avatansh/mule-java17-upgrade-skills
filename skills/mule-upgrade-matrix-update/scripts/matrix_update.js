// matrix_update.js — SKILL: mule-upgrade-matrix-update.
//
// Turn the check_drift ADVISORIES (gating pins trailing live Maven metadata + connector pins
// trailing their latest-in-major) into a REVIEWED bump of the bundled compatibility matrix YAML.
//
// The bundled matrix is the authoritative, curated Java-17-safe FLOOR. runDriftCheck() /
// candidateMatrix() already compute "what a bump WOULD look like" but NEVER write — the curated
// pins stay authoritative until a human adopts them. This skill adds the missing last mile: it
// presents the proposed bumps for review and writes them back to
// references/compatibility-matrix.yaml ONLY on an explicit --apply. Default is dry-run.
//
// CRITICAL — text-preserving edits: the matrix YAML is heavily commented and uses inline flow-maps
// (`munit: { property: "...", min: "...", set: "3.6.3", ... }`). Round-tripping through js-yaml would
// discard every comment and reflow every map. So we NEVER parse+dump: we locate the exact line and
// replace only the version token in place, guarded on the CURRENT value matching what drift saw
// (so a matrix that already moved is skipped, never clobbered).

import fs from "node:fs";
import yaml from "js-yaml";

import { runDriftCheck } from "../../mule-upgrade-assess/scripts/lib/matrix_drift.js";
import {
  bundledMatrixPath,
  loadBundledMatrix,
  _resetMatrixCache,
} from "../../mule-upgrade-assess/scripts/lib/matrix.js";
import { listTargets, versionDelta } from "../../mule-upgrade-assess/scripts/lib/matrix_targets.js";
import { javaMajor } from "../../../lib_shared/java_version.js";

/** Escape a string for embedding as a literal in a RegExp. */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Gating drift keys → the YAML line(s) that pin them. A single gating bump can touch several lines
// (the runtime pins target.runtime AND both gating.muleRuntime{,.Semver}.set — all must move together
// or the matrix goes internally inconsistent). Each anchor identifies its line by a `contains`
// substring and the `token` (`set:` or the bare `runtime:`) whose quoted value we rewrite.
const GATING_ANCHORS = {
  muleRuntime: [
    { contains: 'runtime: "', token: "runtime", note: "target.runtime" },
    { contains: "muleRuntime:", token: "set", note: "gating.muleRuntime.set" },
    { contains: "muleRuntimeSemver:", token: "set", note: "gating.muleRuntimeSemver.set" },
  ],
  muleMavenPlugin: [{ contains: "muleMavenPlugin:", token: "set", note: "gating.muleMavenPlugin.set" }],
  munit: [{ contains: "munit:", token: "set", note: "gating.munit.set" }],
  munitExtPlugin: [{ contains: "munitExtPlugin:", token: "set", note: "gating.munitExtPlugin.set" }],
};

/**
 * Build the flat list of PROPOSED bumps from a runDriftCheck() result. Pure — no I/O, no network.
 * Each proposal is plain data (JSON-safe) describing one artifact's from→to and the YAML anchors
 * that pin it. Only artifacts with `drift:true` (pin strictly behind live) become proposals.
 * @param {{gating?:object, connectors?:object, candidate?:object}} drift  runDriftCheck() output
 * @returns {Array<{kind:'gating'|'connector', id:string, label:string, from:string, to:string, anchors:object[]}>}
 */
export function proposeBumps(drift = {}) {
  /** @type {Array<{kind:'gating'|'connector', id:string, label:string, from:string, to:string, anchors:any[]}>} */
  const proposals = [];

  // ── gating pins (runtime patch, mule-maven-plugin, munit, munit-extensions) vs live Maven metadata
  for (const r of drift.gating?.results ?? []) {
    if (!r.drift || !r.latest || r.pinned == null) continue;
    const anchors = GATING_ANCHORS[r.key];
    if (!anchors) continue; // no known line to touch → skip (never guess)
    proposals.push({
      kind: "gating",
      id: r.key,
      label: r.label,
      from: String(r.pinned),
      to: String(r.latest),
      anchors,
    });
  }

  // ── connector pins vs latest-in-major. candidateMatrix() already reduced these to {artifactId,from,to};
  //    prefer it (single source), else fall back to the raw connector drift results.
  const proposedConnectors =
    drift.candidate?.proposed ??
    (drift.connectors?.results ?? [])
      .filter((r) => r.drift && r.latestInMajor)
      .map((r) => ({ artifactId: r.artifactId, from: r.pinned ?? null, to: r.latestInMajor }));

  for (const p of proposedConnectors) {
    if (!p.to || p.from == null || p.to === p.from) continue;
    proposals.push({
      kind: "connector",
      id: p.artifactId,
      label: p.artifactId,
      from: String(p.from),
      to: String(p.to),
      // A connector line is uniquely identified by its artifactId; bump only that line's `set:`.
      anchors: [{ contains: `artifactId: "${p.artifactId}"`, token: "set", note: `connector ${p.artifactId}` }],
    });
  }

  return proposals;
}

/**
 * Apply proposed bumps to the matrix YAML TEXT, preserving every comment/format. For each anchor we
 * find the matching line and rewrite ONLY its version token, guarded on the current value equalling
 * the proposal's `from`. A line whose current value already differs (matrix moved / hand-edited) is
 * left untouched and reported as a skip — we never clobber a value drift didn't observe.
 * @param {string} text  the raw matrix YAML
 * @param {ReturnType<typeof proposeBumps>} proposals
 * @returns {{text:string, applied:object[], skipped:object[]}}
 */
export function applyMatrixEdits(text, proposals) {
  const lines = text.split("\n");
  const applied = [];
  const skipped = [];

  for (const p of proposals) {
    const hits = [];
    for (const anchor of p.anchors) {
      // token `set` → `set: "X"`, token `runtime` → `runtime: "X"` (the bare target line).
      const tokenRe = new RegExp(`(\\b${escapeRe(anchor.token)}:\\s*")${escapeRe(p.from)}(")`);
      let matchedThisAnchor = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes(anchor.contains)) continue;
        if (!tokenRe.test(line)) continue; // present but value != from → guard fails, skip this line
        lines[i] = line.replace(tokenRe, `$1${p.to}$2`);
        hits.push({ line: i + 1, note: anchor.note });
        matchedThisAnchor = true;
        break; // one line per anchor
      }
      if (!matchedThisAnchor) {
        skipped.push({ ...proposalMeta(p), reason: `no line matched anchor (${anchor.note}) with value ${p.from}` });
      }
    }
    if (hits.length) applied.push({ ...proposalMeta(p), lines: hits });
  }

  return { text: lines.join("\n"), applied, skipped };
}

function proposalMeta(p) {
  return { kind: p.kind, id: p.id, label: p.label, from: p.from, to: p.to };
}

/**
 * Which target files should this update touch?
 *
 * With one matrix there is nothing to decide. With several (one per Java target) the answer is a
 * JUDGEMENT the operator has to make, and guessing it is exactly how the per-target layout goes
 * wrong: a version bump is usually target-specific (the safe version differs per Java) while a
 * coordinate change is Java-neutral and belongs everywhere. So when the caller has not said, we
 * REFUSE and hand back the choices for the skill layer to ask about — the same refuse-with-options
 * shape the rest of the suite uses for confirmation gates.
 *
 * @param {Array<string|number>|"all"|undefined} requested
 * @returns {{resolved:{javaVersion:string, file:string, curated:boolean}[]}|{needsChoice:true, available:any[]}}
 */
function chooseTargets(requested) {
  const available = listTargets();
  if (available.length <= 1) return { resolved: available };

  if (requested === "all") return { resolved: available };

  if (Array.isArray(requested) && requested.length > 0) {
    const want = requested.map((r) => javaMajor(r));
    const resolved = available.filter((t) => want.includes(t.major));
    const missing = want.filter((w) => !available.some((t) => t.major === w));
    if (missing.length) {
      throw new Error(
        `No compatibility matrix for Java ${missing.join(", ")}. Available: ${available.map((t) => t.major).join(", ")}.`
      );
    }
    return { resolved };
  }

  return { needsChoice: true, available };
}

/**
 * runMatrixUpdate(opts): the skill's backend. Gathers drift, proposes bumps, and (only when
 * opts.apply) writes them back to the bundled matrix YAML — text-preservingly. Default is a
 * DRY-RUN review: it computes and returns the proposal + the would-be edits, writing nothing.
 *
 * MULTI-TARGET: with more than one matrix file present, `targets` says which to touch. Omitting it
 * returns `needsTargetChoice` and writes nothing, so the operator is always the one deciding whether
 * a bump is Java-specific or Java-neutral. `matrixPath` still forces a single explicit file.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.apply]              write the bumps to disk (default false → dry-run review)
 * @param {boolean} [opts.noFetch]            skip network → nothing to propose (drift unchecked)
 * @param {boolean} [opts.includeConnectors]  also propose connector bumps (default true)
 * @param {Array<string|number>|"all"} [opts.targets]  Java targets to update; omit to be asked
 * @param {string}  [opts.matrixPath]         override the matrix file path (single file; tests)
 * @param {object}  [opts.driftResult]        inject a runDriftCheck() result (tests; skips network)
 * @param {any}     [opts.exchange]           injectable ExchangeClient (tests)
 * @param {(url:string)=>Promise<string>} [opts.fetchHtml] injectable release-notes fetcher (tests)
 * @param {(p:string)=>string}  [opts.readText]  injectable reader (tests)
 * @param {(p:string,t:string)=>void} [opts.writeText] injectable writer (tests)
 * @returns {Promise<any>}
 */
export async function runMatrixUpdate(opts = {}) {
  const includeConnectors = opts.includeConnectors !== false;
  const readText = opts.readText ?? ((p) => fs.readFileSync(p, "utf8"));
  const writeText = opts.writeText ?? ((p, t) => fs.writeFileSync(p, t));

  // An explicit matrixPath means "this exact file" — the pre-multi-target contract, kept intact.
  /** @type {{javaVersion:string, file:string, curated:boolean}[]} */
  let files;
  if (opts.matrixPath) {
    files = [{ javaVersion: "", file: opts.matrixPath, curated: true }];
  } else {
    const choice = chooseTargets(opts.targets);
    if ("needsChoice" in choice) {
      return {
        needsTargetChoice: true,
        availableTargets: choice.available.map((t) => ({
          javaVersion: t.javaVersion,
          file: t.file,
          curated: t.curated,
          isDefault: t.isDefault,
        })),
        proposals: [],
        applied: [],
        skipped: [],
        changed: false,
        wrote: false,
        driftChecked: false,
        warnings: [],
        path: null,
        targets: [],
      };
    }
    files = choice.resolved;
  }

  // Gather drift (gating + connectors + candidate) unless the caller injected a result.
  const drift =
    opts.driftResult ??
    (await runDriftCheck({
      noFetch: opts.noFetch === true,
      includeConnectors,
      candidate: includeConnectors, // candidate.proposed feeds connector bumps
      exchange: opts.exchange,
      fetchHtml: opts.fetchHtml,
    }));

  const proposals = proposeBumps(drift);

  const perTarget = [];
  let anyWrote = false;
  for (const f of files) {
    const before = readText(f.file);
    const { text: after, applied, skipped } = applyMatrixEdits(before, proposals);
    const changed = after !== before;
    let wrote = false;
    if (opts.apply && changed) {
      writeText(f.file, after);
      wrote = true;
      anyWrote = true;
    }
    perTarget.push({ javaVersion: f.javaVersion, path: f.file, curated: f.curated, applied, skipped, changed, wrote });
  }

  // Invalidate the in-process memo once, after all writes, so a subsequent loadBundledMatrix() in
  // this process re-reads the freshly-written YAML instead of serving the pre-bump cached copy.
  if (anyWrote) _resetMatrixCache();

  // Top-level fields mirror the FIRST target so every pre-multi-target caller keeps working.
  const primary = perTarget[0] ?? { path: null, applied: [], skipped: [], changed: false, wrote: false };
  return {
    path: primary.path,
    driftChecked: drift.gating?.checked === true || drift.connectors?.checked === true,
    proposals: proposals.map(proposalMeta),
    applied: primary.applied,
    skipped: primary.skipped,
    changed: perTarget.some((t) => t.changed),
    wrote: anyWrote,
    targets: perTarget,
    needsTargetChoice: false,
    warnings: drift.warnings ?? [],
  };
}

/** Human-readable one-line-per-bump summary for the CLI. */
export function formatMatrixUpdate(report) {
  const lines = [];

  // Multi-target and nobody said which — ask, do not guess.
  if (report.needsTargetChoice) {
    lines.push("Which Java target(s) should this update touch?\n");
    for (const t of report.availableTargets) {
      const tags = [t.isDefault ? "default" : null, t.curated ? null : "uncurated"].filter(Boolean).join(", ");
      lines.push(`  --targets ${t.javaVersion}${tags ? `   (${tags})` : ""}`);
    }
    lines.push("  --targets all   apply to every target");
    lines.push(
      "\nRule of thumb: a VERSION bump is usually target-specific (the safe version differs per Java);" +
        "\na COORDINATE change (connector added/renamed) is Java-neutral and belongs in ALL targets."
    );
    return lines.join("\n");
  }

  const n = report.proposals.length;
  if (!report.driftChecked) {
    lines.push("Matrix update: drift not checked (no live data / --no-fetch) — nothing to propose.");
    return lines.join("\n");
  }
  if (n === 0) {
    lines.push("Matrix update: no bumps proposed — the bundled matrix is current.");
    return lines.join("\n");
  }

  lines.push(
    report.wrote
      ? `Matrix update — APPLIED bumps:`
      : `Matrix update — ${n} proposed bump(s) (DRY-RUN, nothing written; pass --apply to adopt):`
  );

  const targets = report.targets?.length ? report.targets : [report];
  const multi = targets.length > 1;
  for (const t of targets) {
    if (multi) lines.push(`\n  ${t.javaVersion ? `Java ${t.javaVersion}` : t.path} — ${t.path}`);
    const indent = multi ? "    " : "  ";
    for (const a of t.applied) {
      const where = a.lines.map((l) => `L${l.line}`).join(", ");
      lines.push(`${indent}${a.kind === "gating" ? "⚙" : "→"} ${a.label}: ${a.from} → ${a.to}  (${where})`);
    }
    for (const s of t.skipped) {
      lines.push(`${indent}⚠ ${s.label}: ${s.from} → ${s.to} SKIPPED — ${s.reason}`);
    }
    // An uncurated target's placeholders never match a bump's `from` guard, so everything skips.
    // Say so plainly rather than leaving a wall of identical skip lines to interpret.
    if (t.curated === false && !t.changed) {
      lines.push(`${indent}(nothing applied — this target is still uncurated, so there are no versions to bump)`);
    }
  }

  if (!report.wrote && report.changed) lines.push("\nRe-run with --apply to write these bumps to the matrix.");
  return lines.join("\n");
}

/**
 * Format the version-level delta between two targets. This is the one affordance a single-file
 * overlay layout would have given for free — recovered on demand so the per-target layout does not
 * have to carry merge semantics permanently just to answer "what differs between 17 and 21?".
 */
export function formatTargetDiff(aMajor, bMajor) {
  const targets = listTargets();
  const find = (m) => targets.find((t) => t.major === javaMajor(m));
  const a = find(aMajor);
  const b = find(bMajor);
  if (!a || !b) {
    const have = targets.map((t) => t.major).join(", ");
    return `Unknown target. Available: ${have}.`;
  }

  const delta = versionDelta(loadBundledMatrixRaw(a.file), loadBundledMatrixRaw(b.file));
  if (delta.length === 0) return `Java ${a.major} and Java ${b.major} are version-identical.`;

  const width = Math.max(...delta.map((d) => d.key.length));
  const lines = [
    `Java ${a.major} → Java ${b.major}: ${delta.length} field(s) differ`,
    `  ${"".padEnd(width)}  ${String(a.major).padEnd(12)}${b.major}`,
  ];
  for (const d of delta) {
    lines.push(`  ${d.key.padEnd(width)}  ${String(d.a ?? "-").padEnd(12)}${d.b ?? "-"}`);
  }
  return lines.join("\n");
}

/** Read+parse a matrix file directly (bypasses the target-curation gate, which diff must ignore). */
function loadBundledMatrixRaw(file) {
  return yaml.load(fs.readFileSync(file, "utf8"));
}

// re-export for callers/tests that want the loader without a second import
export { loadBundledMatrix, bundledMatrixPath };
