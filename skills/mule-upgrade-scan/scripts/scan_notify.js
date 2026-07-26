// scan_notify.js — the PROACTIVE PUSH. Runs the fleet scan on a schedule and, when it finds apps
// that still need the Java 17 upgrade, PUSHES a Slack message — instead of waiting for someone to
// ask "how many are stale?".
//
// The whole point of "proactive" is that it fires by itself. A skill cannot host a long-lived
// daemon, so the timer lives OUTSIDE this script — the /loop skill, OS cron, or a scheduled GitHub
// Action calls `node scan_notify.js` every N minutes/hours. This file supplies the intelligence:
//
//   1. scanFleet()  → current stale candidates (AMC / CloudHub 2.0 + Runtime Fabric).
//   2. Diff against REMEMBERED state on disk (~/.mule-upgrade/scan-watch.json) so we only alert on
//      *change*: apps that BECAME stale (newly deployed / downgraded / newly discovered) and apps
//      that got RESOLVED (upgraded away). Re-running every 15 min does NOT re-spam the same list.
//   3. slackNotify() the delta (non-fatal, env-gated — no SLACK_WEBHOOK_URL → cleanly skipped).
//   4. Persist the new baseline.
//
// Flags:
//   --env a,b        restrict to environments (as scan.js)
//   --json           print the machine-readable watch result
//   --always-notify  push the FULL current list every run (periodic digest, ignores the diff)
//   --dry-run        compute + print the message, do NOT send and do NOT persist state
//
// Everything is non-fatal: an unconfigured platform, an unreachable Slack, or a first-ever run all
// produce a clean result object, never a throw — safe to wire straight into an unattended timer.

import fs from "node:fs";
import path from "node:path";
import { scanFleet, fleetScanSlackText } from "./scan.js";
import { slackNotify } from "../../mule-upgrade/scripts/lib/notify.js";
import { storeRoot } from "../../mule-upgrade-job/scripts/jobstore.js";
import { nowUtc } from "../../../lib_shared/dates.js";

/** Where the watch baseline lives — beside the job store so all state is under one root. */
export function watchStatePath() {
  return path.join(storeRoot(), "scan-watch.json");
}

/** Load the remembered baseline; {} on first run / unreadable / corrupt (never throws). */
export function loadWatchState(file = watchStatePath()) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { known: {}, lastRun: null };
  }
}

/** Persist the baseline atomically-ish (write tmp then rename); best-effort, non-fatal. */
export function saveWatchState(state, file = watchStatePath()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** A stable per-app signature: appName + the *reasons* it is stale. Changes if the reasons change. */
function sig(c) {
  return `${c.appName}::${[...(c.reasons ?? [])].sort().join("|")}`;
}

/**
 * diffAgainst(known, candidates): classify the current stale set against the remembered one.
 * @param {object} known  map appName -> { sig, firstSeen, reasons }
 * @param {object[]} candidates  current stale candidates from scanFleet
 * @returns {{newlyStale:object[], changed:object[], resolved:string[], stillStale:object[]}}
 */
export function diffAgainst(known, candidates) {
  const newlyStale = [];
  const changed = [];
  const stillStale = [];
  const currentNames = new Set(candidates.map((c) => c.appName));
  for (const c of candidates) {
    const prev = known[c.appName];
    if (!prev) newlyStale.push(c);
    else if (prev.sig !== sig(c)) changed.push(c);
    else stillStale.push(c);
  }
  const resolved = Object.keys(known).filter((name) => !currentNames.has(name));
  return { newlyStale, changed, resolved, stillStale };
}

/**
 * scanAndNotify(opts): the proactive run. Non-fatal; returns a structured result.
 * @param {object}   [opts]
 * @param {string[]} [opts.environments]
 * @param {boolean}  [opts.alwaysNotify=false]  push the full list even with no change
 * @param {boolean}  [opts.dryRun=false]        compute + return, don't send or persist
 * @param {object}   [opts.deps]  {scan?, notify?, load?, save?, now?} injectable (tests)
 */
export async function scanAndNotify(opts = {}) {
  const scan = opts.deps?.scan ?? scanFleet;
  const notify = opts.deps?.notify ?? slackNotify;
  const load = opts.deps?.load ?? loadWatchState;
  const save = opts.deps?.save ?? saveWatchState;
  const now = opts.deps?.now ?? nowUtc;

  const report = await scan({ environments: opts.environments });

  // Platform not configured → nothing to watch; surface it, don't notify, don't clobber state.
  if (!report.configured) {
    return { ran: true, configured: false, notified: false, report, reason: report.note };
  }

  const state = load();
  const known = state.known ?? {};
  const { newlyStale, changed, resolved, stillStale } = diffAgainst(known, report.candidates);

  const hasChange = newlyStale.length > 0 || changed.length > 0 || resolved.length > 0;
  const shouldNotify = opts.alwaysNotify ? report.candidates.length > 0 : hasChange;

  // Compose the message. On a plain change-driven push we lead with what changed; on --always-notify
  // we send the full current list (digest).
  let message = null;
  if (shouldNotify) {
    if (opts.alwaysNotify) {
      message = fleetScanSlackText(report);
    } else {
      const lead = [];
      if (newlyStale.length)
        lead.push(`:rotating_light: *${newlyStale.length} app(s) newly need the Java 17 upgrade:*`);
      const attention = [...newlyStale, ...changed];
      message = fleetScanSlackText(report, {
        candidates: attention,
        heading: lead.length ? lead.join(" ") : undefined,
      });
      if (changed.length) message += `\n\n:arrows_counterclockwise: ${changed.length} app(s) changed staleness reason.`;
      if (resolved.length) message += `\n\n:white_check_mark: *Resolved since last scan:* ${resolved.join(", ")}`;
    }
  }

  let notifyResult = { sent: false, skipped: "no change" };
  if (shouldNotify && !opts.dryRun) {
    notifyResult = await notify(message);
  } else if (shouldNotify && opts.dryRun) {
    notifyResult = { sent: false, skipped: "dry-run" };
  }

  // Rebuild the baseline from the CURRENT stale set (drop resolved apps so they can re-alert if they
  // regress later). Preserve firstSeen for apps we already knew about.
  const nextKnown = {};
  const ts = now();
  for (const c of report.candidates) {
    const prev = known[c.appName];
    nextKnown[c.appName] = {
      sig: sig(c),
      reasons: c.reasons,
      firstSeen: prev?.firstSeen ?? ts,
      lastSeen: ts,
    };
  }
  const nextState = { known: nextKnown, lastRun: ts };
  let persisted = false;
  if (!opts.dryRun) persisted = save(nextState);

  return {
    ran: true,
    configured: true,
    notified: Boolean(notifyResult.sent),
    notifyResult,
    hasChange,
    message,
    delta: {
      newlyStale: newlyStale.map((c) => c.appName),
      changed: changed.map((c) => c.appName),
      resolved,
      stillStale: stillStale.map((c) => c.appName),
    },
    report,
    persisted,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && process.argv[1].endsWith("scan_notify.js");
if (isMain) {
  const args = process.argv.slice(2);
  const envIdx = args.indexOf("--env");
  const environments = envIdx >= 0 && args[envIdx + 1] ? args[envIdx + 1].split(",") : undefined;
  scanAndNotify({
    environments,
    alwaysNotify: args.includes("--always-notify"),
    dryRun: args.includes("--dry-run"),
  })
    .then((r) => {
      if (args.includes("--json")) {
        process.stdout.write(JSON.stringify(r, null, 2) + "\n");
        return;
      }
      if (!r.configured) {
        process.stdout.write(r.reason + "\n");
        return;
      }
      const { newlyStale, changed, resolved } = r.delta;
      process.stdout.write(
        `Scan complete: ${r.report.staleApps} stale of ${r.report.totalApps} scanned. ` +
          `new=${newlyStale.length} changed=${changed.length} resolved=${resolved.length}. ` +
          (r.notified ? "Slack push sent." : `No push (${r.notifyResult.skipped ?? r.notifyResult.error ?? "n/a"}).`) +
          "\n"
      );
      if (r.message) process.stdout.write("\n--- message ---\n" + r.message + "\n");
    })
    .catch((e) => {
      process.stderr.write(`scan_notify failed: ${e?.message ?? e}\n`);
      process.exitCode = 1;
    });
}
