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

import { runDriftCheck } from "../../mule-upgrade-assess/scripts/lib/matrix_drift.js";
import {
  bundledMatrixPath,
  loadBundledMatrix,
  _resetMatrixCache,
} from "../../mule-upgrade-assess/scripts/lib/matrix.js";

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
 * runMatrixUpdate(opts): the skill's backend. Gathers drift, proposes bumps, and (only when
 * opts.apply) writes them back to the bundled matrix YAML — text-preservingly. Default is a
 * DRY-RUN review: it computes and returns the proposal + the would-be edits, writing nothing.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.apply]              write the bumps to disk (default false → dry-run review)
 * @param {boolean} [opts.noFetch]            skip network → nothing to propose (drift unchecked)
 * @param {boolean} [opts.includeConnectors]  also propose connector bumps (default true)
 * @param {string}  [opts.matrixPath]         override the matrix file path (tests)
 * @param {object}  [opts.driftResult]        inject a runDriftCheck() result (tests; skips network)
 * @param {any}     [opts.exchange]           injectable ExchangeClient (tests)
 * @param {(url:string)=>Promise<string>} [opts.fetchHtml] injectable release-notes fetcher (tests)
 * @param {(p:string)=>string}  [opts.readText]  injectable reader (tests)
 * @param {(p:string,t:string)=>void} [opts.writeText] injectable writer (tests)
 * @returns {Promise<{path, proposals, applied, skipped, wrote, changed, driftChecked, warnings}>}
 */
export async function runMatrixUpdate(opts = {}) {
  const includeConnectors = opts.includeConnectors !== false;
  const matrixPath = opts.matrixPath ?? bundledMatrixPath();
  const readText = opts.readText ?? ((p) => fs.readFileSync(p, "utf8"));
  const writeText = opts.writeText ?? ((p, t) => fs.writeFileSync(p, t));

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
  const before = readText(matrixPath);
  const { text: after, applied, skipped } = applyMatrixEdits(before, proposals);
  const changed = after !== before;

  let wrote = false;
  if (opts.apply && changed) {
    writeText(matrixPath, after);
    wrote = true;
    // Invalidate the in-process matrix memo so any subsequent loadBundledMatrix() in this process
    // re-reads the freshly-written YAML instead of serving the pre-bump cached copy.
    _resetMatrixCache();
  }

  return {
    path: matrixPath,
    driftChecked: drift.gating?.checked === true || drift.connectors?.checked === true,
    proposals: proposals.map(proposalMeta),
    applied,
    skipped,
    changed,
    wrote,
    warnings: drift.warnings ?? [],
  };
}

/** Human-readable one-line-per-bump summary for the CLI. */
export function formatMatrixUpdate(report) {
  const lines = [];
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
      ? `Matrix update — APPLIED ${report.applied.length} bump(s) to ${report.path}:`
      : `Matrix update — ${n} proposed bump(s) (DRY-RUN, nothing written; pass --apply to adopt):`
  );
  for (const a of report.applied) {
    const where = a.lines.map((l) => `L${l.line}`).join(", ");
    lines.push(`  ${a.kind === "gating" ? "⚙" : "→"} ${a.label}: ${a.from} → ${a.to}  (${where})`);
  }
  for (const s of report.skipped) {
    lines.push(`  ⚠ ${s.label}: ${s.from} → ${s.to} SKIPPED — ${s.reason}`);
  }
  if (!report.wrote && report.changed) lines.push("\nRe-run with --apply to write these bumps to the matrix.");
  return lines.join("\n");
}

// re-export for callers/tests that want the loader without a second import
export { loadBundledMatrix, bundledMatrixPath };
