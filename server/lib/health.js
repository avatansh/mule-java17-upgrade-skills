// server/lib/health.js — health & metrics snapshots for the hosted deployment.
//
// Two read-only views over the JSON job store, for liveness probes and lightweight observability
// (the skill-server analogue of the Mule app's health/monitoring endpoints):
//
//   healthSnapshot()   → { ok, service, version, env, uptimeSeconds, jobs:{total, active} }
//                        cheap, safe to poll frequently (k8s/ALB liveness & readiness).
//   metricsSnapshot()  → the above PLUS a full status histogram, environment breakdown, and the
//                        oldest active job's age (a stuck-job smell test) — for a /metrics scrape.
//
// Both degrade gracefully: if the job store can't be read (fresh install, permissions) they report
// zero counts rather than throwing, so a probe never flaps on a store hiccup.

import process from "node:process";
import { listJobs } from "../../skills/mule-upgrade-job/scripts/jobstore.js";
import { get } from "../../lib_shared/config.js";

// Terminal statuses = the job reached a definitive end; everything else is "active" (in flight).
// NOTE: MUNIT_FAILED and DEP_GUARD_FAILED are deliberately NOT terminal — they are resumable PARK
// states (a passing CI re-run resumes them → PR_OPEN via ci_ingest). Counting them as terminal
// under-reported active jobs and hid stuck-in-CI work from oldestActiveAgeSeconds, so they count as
// active here. (PR_OPEN remains terminal — awaiting an external merge, not in-flight work.)
const TERMINAL = new Set([
  "PR_OPEN",
  "NO_CHANGE",
  "ALREADY_UPGRADED",
  "DEPLOYED",
  "CLOSED",
  "FAILED_ASSESS",
  "FAILED_COMMIT",
  "FAILED_DEPLOY",
  "FAILED_INTERRUPTED",
]);

function cfg(dotted, fallback) {
  try {
    const v = get(dotted, undefined);
    return v === undefined || v === null || v === "" ? fallback : v;
  } catch {
    return fallback;
  }
}

/** Read all job records, never throwing (returns [] on any store error). */
function safeListJobs(deps = {}) {
  const list = deps.listJobs ?? listJobs;
  try {
    return list() ?? [];
  } catch {
    return [];
  }
}

/**
 * healthSnapshot(deps): a small liveness/readiness object. `nowMs` and `startMs` are injectable so
 * uptime is deterministic in tests (Date.now() is otherwise the source).
 * @param {{listJobs?: () => any[], nowMs?: number, startMs?: number}} [deps]
 */
export function healthSnapshot(deps = {}) {
  const jobs = safeListJobs(deps);
  const active = jobs.filter((j) => !TERMINAL.has(j?.status)).length;
  const nowMs = deps.nowMs ?? Date.now();
  const startMs = deps.startMs ?? START_MS;
  return {
    ok: true,
    service: cfg("mcp.serverName", "mule-java17-upgrade-skills"),
    version: cfg("mcp.serverVersion", "1.0.0"),
    env: process.env.MULE_UPGRADE_ENV ?? null,
    node: process.version,
    uptimeSeconds: Math.max(0, Math.round((nowMs - startMs) / 1000)),
    jobs: { total: jobs.length, active },
  };
}

/**
 * metricsSnapshot(deps): the health view plus a status histogram, per-environment counts, and the
 * oldest active job's age in seconds (null when none) — a cheap stuck-job signal.
 * @param {{listJobs?: () => any[], nowMs?: number, startMs?: number}} [deps]
 */
export function metricsSnapshot(deps = {}) {
  const jobs = safeListJobs(deps);
  const nowMs = deps.nowMs ?? Date.now();

  /** @type {Record<string, number>} */
  const byStatus = {};
  /** @type {Record<string, number>} */
  const byEnvironment = {};
  let oldestActiveMs = null;

  for (const j of jobs) {
    const status = j?.status ?? "UNKNOWN";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    const env = j?.environment ?? "unknown";
    byEnvironment[env] = (byEnvironment[env] ?? 0) + 1;
    if (!TERMINAL.has(status)) {
      const t = Date.parse(j?.updatedAt ?? j?.createdAt ?? "");
      if (!Number.isNaN(t)) oldestActiveMs = oldestActiveMs === null ? t : Math.min(oldestActiveMs, t);
    }
  }

  return {
    ...healthSnapshot(deps),
    metrics: {
      byStatus,
      byEnvironment,
      oldestActiveAgeSeconds:
        oldestActiveMs === null ? null : Math.max(0, Math.round((nowMs - oldestActiveMs) / 1000)),
    },
  };
}

// Process start time — captured at module load so uptime is measured from server boot.
const START_MS = Date.now();
