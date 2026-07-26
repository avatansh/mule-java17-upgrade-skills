// scan.js — fleet scan: enumerate every AMC (CloudHub 2.0 / Runtime Fabric) deployment across the
// org's environments and flag apps that still run an OLD Mule runtime (default < 4.5, i.e. 4.4 or
// older) or an OLD Java (< 17). Produces a grouped summary + an actionable candidate list, mapping
// each stale deployed app to its GitHub repo where possible.
//
// This is the PROACTIVE entrypoint: it answers "how many apps still need the Java 17 upgrade?" and
// hands back candidates that start_upgrade can act on directly.
//
// Coverage caveat (v1): the AMC application-manager endpoint covers CloudHub 2.0 / Runtime Fabric
// only. CloudHub 1.0 (/cloudhub/api/v2/applications) and on-prem/hybrid (ARM /hybrid) apps use
// different endpoints and are NOT counted here; the report says so explicitly so the number is
// never mistaken for the whole estate.
//
// Name→repo mapping: each stale deployed app is resolved to owner/repo/appPath via the SAME 3-tier
// waterfall used by upgrades (registry → request → convention). When it can't be resolved (e.g. an
// env-suffixed deploy name that doesn't follow convention and isn't in the registry) the candidate
// is still reported, flagged `needsCoordinates:true`, so the count is complete and the operator can
// supply owner/repo to upgrade it. There is NO hard dependency on app-registry.yaml.
//
// NEVER throws for platform/network reasons: the AnypointClient reads are all non-fatal and yield
// empty lists, so an unreachable/unconfigured platform yields a clean "0 scanned / not configured"
// report rather than an error.

import { AnypointClient } from "../../mule-upgrade/scripts/lib/anypoint.js";
import { resolveCoordinates } from "../../../lib_shared/coordinates.js";
import { get } from "../../../lib_shared/config.js";
import { lt } from "../../../lib_shared/semver.js";

function cfg(dotted, fallback) {
  try {
    const v = get(dotted, undefined);
    return v === undefined || v === null || v === "" ? fallback : v;
  } catch {
    return fallback;
  }
}

/** Parse a comma/space list from config or string into a trimmed array. */
function toList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * classifyApp(app, thresholds): decide whether a deployed app is stale and why.
 * @returns {{stale:boolean, reasons:string[]}}
 */
export function classifyApp(app, { staleMuleBelow, targetJava }) {
  const reasons = [];
  // Mule staleness: known version strictly below the threshold (4.4.x < 4.5 → stale).
  if (app.muleVersion && lt(app.muleVersion, staleMuleBelow)) {
    reasons.push(`Mule ${app.muleVersion} is older than ${staleMuleBelow}`);
  }
  // Java staleness: a known Java major below the target (8/11 < 17 → stale).
  if (typeof app.javaVersion === "number" && app.javaVersion < targetJava) {
    reasons.push(`Java ${app.javaVersion} is older than ${targetJava}`);
  }
  return { stale: reasons.length > 0, reasons };
}

/**
 * scanFleet(opts): the fleet scan.
 * @param {object} [opts]
 * @param {AnypointClient} [opts.client]        injectable (tests)
 * @param {string[]}       [opts.environments]  restrict to these env NAMES (else all, or config list)
 * @param {object}         [opts.deps]          {resolve?} injectable coordinate resolver (tests)
 * @param {boolean}        [opts.resolveRepos=true]  map stale app names to repos
 * @returns {Promise<object>} report
 */
export async function scanFleet(opts = {}) {
  const client = opts.client ?? new AnypointClient();
  const staleMuleBelow = String(opts.staleMuleBelow ?? cfg("scan.staleMuleBelow", "4.5.0"));
  const targetJava = Number(opts.targetJava ?? cfg("scan.targetJava", 17));
  const resolve = opts.deps?.resolve ?? resolveCoordinates;

  if (!client.configured()) {
    return {
      configured: false,
      coverage: "amc", // CloudHub 2.0 / Runtime Fabric only
      note: "Anypoint is not configured (set ANYPOINT_CLIENT_ID / ANYPOINT_CLIENT_SECRET / ANYPOINT_ORG_ID). No fleet scan performed.",
      environmentsScanned: [],
      totalApps: 0,
      staleApps: 0,
      candidates: [],
      warnings: [],
    };
  }

  // ── resolve which environments to scan ─────────────────────────────────────────────────────
  const allEnvs = await client.listEnvironments();
  const restrictTo = new Set(
    (opts.environments && opts.environments.length ? opts.environments : toList(cfg("scan.environments", ""))).map((s) =>
      s.toUpperCase()
    )
  );
  const envs = restrictTo.size ? allEnvs.filter((e) => restrictTo.has(String(e.name).toUpperCase())) : allEnvs;
  const warnings = [];
  if (restrictTo.size && envs.length < restrictTo.size) {
    const found = new Set(envs.map((e) => e.name.toUpperCase()));
    for (const want of restrictTo) if (!found.has(want)) warnings.push(`Requested environment "${want}" not found in the org.`);
  }

  // ── enumerate deployments per environment ──────────────────────────────────────────────────
  const all = [];
  for (const env of envs) {
    const deps = await client.listDeployments({ env: env.name });
    for (const d of deps) all.push(d);
  }

  // ── classify + build stale candidate list ──────────────────────────────────────────────────
  const stale = [];
  for (const app of all) {
    const { stale: isStale, reasons } = classifyApp(app, { staleMuleBelow, targetJava });
    if (isStale) stale.push({ ...app, reasons });
  }

  // ── map stale app names → repos (best-effort; never fatal) ─────────────────────────────────
  const candidates = [];
  const seen = new Set(); // de-dup an app deployed to multiple envs → one candidate
  for (const app of stale) {
    if (seen.has(app.name)) {
      const existing = candidates.find((c) => c.appName === app.name);
      if (existing && !existing.environments.includes(app.environment)) existing.environments.push(app.environment);
      continue;
    }
    seen.add(app.name);
    const candidate = {
      appName: app.name,
      muleVersion: app.muleVersion,
      javaVersion: app.javaVersion,
      status: app.status,
      environments: [app.environment],
      reasons: app.reasons,
      needsCoordinates: true,
      owner: null,
      repo: null,
      appPath: null,
    };
    if (opts.resolveRepos !== false) {
      try {
        const coords = await resolve({ appName: app.name, discoverBranch: false });
        candidate.owner = coords.owner;
        candidate.repo = coords.repo;
        candidate.appPath = coords.appPath;
        candidate.fromRegistry = coords.fromRegistry;
        candidate.needsCoordinates = !(coords.owner && coords.repo);
      } catch {
        // unresolvable → leave needsCoordinates:true; still reported so the count is complete
      }
    }
    candidates.push(candidate);
  }

  const unmapped = candidates.filter((c) => c.needsCoordinates).length;
  if (unmapped) {
    warnings.push(
      `${unmapped} stale app(s) could not be mapped to a GitHub repo automatically — supply owner/repo ` +
        `(or add an app-registry.yaml entry) to upgrade them.`
    );
  }

  return {
    configured: true,
    coverage: "amc", // CloudHub 2.0 / Runtime Fabric only
    coverageNote:
      "Counts CloudHub 2.0 / Runtime Fabric (AMC) deployments only. CloudHub 1.0 and on-prem/hybrid apps are not included in this scan.",
    thresholds: { staleMuleBelow, targetJava },
    environmentsScanned: envs.map((e) => e.name),
    totalApps: all.length,
    staleApps: candidates.length,
    candidates,
    warnings,
  };
}

/** Human-readable one-liner + candidate table for CLI / chat surfacing. */
export function formatReport(report) {
  if (!report.configured) return report.note;
  const lines = [];
  lines.push(
    `Fleet scan (${report.coverage.toUpperCase()}): ${report.staleApps} of ${report.totalApps} app(s) need the Java 17 upgrade ` +
      `across ${report.environmentsScanned.length} environment(s) [${report.environmentsScanned.join(", ")}].`
  );
  lines.push(report.coverageNote);
  for (const c of report.candidates) {
    const where = c.needsCoordinates ? "⚠ needs owner/repo" : `${c.owner}/${c.repo}${c.appPath && c.appPath !== "." ? " @" + c.appPath : ""}`;
    lines.push(`  • ${c.appName} — ${c.reasons.join("; ")} [${c.environments.join(", ")}] → ${where}`);
  }
  for (const w of report.warnings) lines.push(`  ! ${w}`);
  return lines.join("\n");
}

/** Slack-friendly text for a set of candidate objects (used by the proactive watch). */
export function fleetScanSlackText(report, { candidates = report.candidates, heading } = {}) {
  const head =
    heading ??
    `:mag: *Java 17 fleet scan* — ${candidates.length} app(s) still need upgrading ` +
      `(${report.totalApps} scanned across ${report.environmentsScanned.length} env).`;
  const lines = [head];
  for (const c of candidates.slice(0, 25)) {
    const where = c.needsCoordinates ? "_needs owner/repo_" : `${c.owner}/${c.repo}`;
    lines.push(`• *${c.appName}* — ${c.reasons.join("; ")} → ${where}`);
  }
  if (candidates.length > 25) lines.push(`…and ${candidates.length - 25} more.`);
  return lines.join("\n");
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && process.argv[1].endsWith("scan.js");
if (isMain) {
  const args = process.argv.slice(2);
  const jsonOut = args.includes("--json");
  const envIdx = args.indexOf("--env");
  const environments = envIdx >= 0 && args[envIdx + 1] ? args[envIdx + 1].split(",") : undefined;
  scanFleet({ environments })
    .then((report) => {
      process.stdout.write(jsonOut ? JSON.stringify(report, null, 2) + "\n" : formatReport(report) + "\n");
    })
    .catch((e) => {
      process.stderr.write(`scan failed: ${e?.message ?? e}\n`);
      process.exitCode = 1;
    });
}
