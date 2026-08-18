// lib/hook_refresh.js — the decision layer behind the Cursor hooks that keep job status fresh.
//
// WHY THIS EXISTS (hooks instead of GitHub webhooks)
// -------------------------------------------------
// Getting PR / CI / deploy transitions into the job store used to require an INBOUND webhook:
// server/server.js reachable from the internet, HMAC secrets on both ends, and per-repo GitHub +
// CD-pipeline configuration. On a laptop or in a Vibes demo none of that is available, so status went
// stale and the user had to ask "check status now" — and even then the answer was only as fresh as the
// moment they asked.
//
// A Cursor hook inverts it. Instead of GitHub pushing to us, we PULL at the only two moments the answer
// is actually needed: when a session opens (catching everything that happened while Cursor was closed —
// exactly the deliveries a webhook would have made) and immediately before the model reasons about a
// prompt. Same freshness where it matters, with no endpoint, no secret, and no repo configuration.
//
// The cost of that trade is the thing this module manages: `beforeSubmitPrompt` fires on EVERY user
// message, and a reconcile sweep makes real GitHub calls. Left ungated, a chatty session would burn
// through the API rate limit and add latency to every prompt. So a refresh only happens when all of
// these hold:
//
//   1. hooks are enabled                       (config `hooks.enabled`)
//   2. at least one job is actually in flight  (non-terminal) — the overwhelmingly common case is none,
//                                              and that path must cost nothing
//   3. the last refresh is older than a floor   (config `hooks.minIntervalSeconds`) — the debounce
//
// Everything here is pure and injectable so the policy is unit-tested rather than trusted; the hook
// script itself stays a thin, boring wrapper.

import fs from "node:fs";
import path from "node:path";
import { TERMINAL, storeRoot } from "../jobstore.js";
import { get } from "../../../../lib_shared/config.js";

/** Same read-with-fallback helper the other skills use, so config stays optional. */
function cfg(dotted, fallback) {
  try {
    const v = get(dotted, undefined);
    return v === undefined || v === null || v === "" ? fallback : v;
  } catch {
    return fallback;
  }
}

/** Resolved hook settings. Env `MULE_UPGRADE_HOOKS=off` is an unconditional kill switch. */
export function hookSettings() {
  const envOff = String(process.env.MULE_UPGRADE_HOOKS ?? "").toLowerCase() === "off";
  return {
    enabled: !envOff && String(cfg("hooks.enabled", "true")) !== "false",
    staleSeconds: Number(cfg("hooks.staleSeconds", 60)),
    minIntervalSeconds: Number(cfg("hooks.minIntervalSeconds", 45)),
    timeoutMs: Number(cfg("hooks.timeoutMs", 8000)),
    promptTimeoutMs: Number(cfg("hooks.promptTimeoutMs", 3000)),
  };
}

/**
 * Which ceiling applies to this event. A measured cold sweep runs ~5s, which is acceptable once at
 * session open but not while the user waits for their prompt to be sent — so `beforeSubmitPrompt` gets
 * the tighter `promptTimeoutMs`. Losing that race is cheap: the sweep's writes are idempotent and the
 * next turn (or the sessionStart sweep) picks the state up.
 */
export function timeoutForEvent(event, settings) {
  return event === "beforeSubmitPrompt"
    ? (settings.promptTimeoutMs ?? settings.timeoutMs)
    : settings.timeoutMs;
}

/** Where the last-run stamp lives. Deliberately NOT the shared cache: that has its own on/off switch
 *  (`cache.enabled`), and a disabled cache must never silently disable the debounce and let a hook
 *  hammer GitHub on every keystroke-turn. */
export function stateFile() {
  return path.join(storeRoot(), "hook-state.json");
}

/** Read the last-run stamp. Any problem reads as "never ran", which fails toward doing the work. */
export function readState(file = stateFile()) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    return { lastRunMs: Number(doc?.lastRunMs) || 0, lastResult: doc?.lastResult ?? null };
  } catch {
    return { lastRunMs: 0, lastResult: null };
  }
}

/** Persist the last-run stamp. Non-fatal: a read-only home must not break the hook. */
export function writeState(state, file = stateFile()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Jobs that a reconcile could still move. A terminal job will never change again, so its presence is
 *  not a reason to call GitHub. */
export function inFlightJobs(jobs) {
  return (jobs ?? []).filter((j) => j && j.status && !TERMINAL.has(j.status));
}

/**
 * shouldRefresh — the whole gating policy, as one testable decision.
 *
 * @param {object} args
 * @param {Array<{status?:string}>} args.jobs
 * @param {number} args.nowMs
 * @param {number} [args.lastRunMs]
 * @param {boolean} [args.enabled]
 * @param {number} [args.minIntervalSeconds]
 * @returns {{run:boolean, reason:string, inFlight:number, waitSeconds?:number}}
 */
export function shouldRefresh({ jobs, nowMs, lastRunMs = 0, enabled = true, minIntervalSeconds = 45 }) {
  if (!enabled) return { run: false, reason: "hooks disabled", inFlight: 0 };

  const inFlight = inFlightJobs(jobs).length;
  // The common case, and the one that must be free: nothing is in flight, so there is nothing a
  // GitHub round-trip could tell us.
  if (inFlight === 0) return { run: false, reason: "no jobs in flight", inFlight: 0 };

  const sinceMs = nowMs - lastRunMs;
  const floorMs = Math.max(0, minIntervalSeconds * 1000);
  if (lastRunMs > 0 && sinceMs < floorMs) {
    return {
      run: false,
      reason: `debounced (last refresh ${Math.round(sinceMs / 1000)}s ago, floor ${minIntervalSeconds}s)`,
      inFlight,
      waitSeconds: Math.ceil((floorMs - sinceMs) / 1000),
    };
  }
  return { run: true, reason: `${inFlight} job(s) in flight`, inFlight };
}

/**
 * runHookRefresh — decide, then (if warranted) run a bounded reconcile sweep.
 *
 * Two properties matter more than completeness here:
 *   - It NEVER throws. A hook that throws on a bad token would break the user's prompt, so every
 *     failure is swallowed into a reported outcome.
 *   - It NEVER outlives `timeoutMs`. `beforeSubmitPrompt` sits in front of the model, so a slow or
 *     hanging GitHub call must lose the race rather than stall the session. The sweep is left running
 *     (it is harmless and its writes are idempotent); we simply stop waiting on it.
 *
 * @param {object} [deps]
 * @param {() => Array} [deps.listJobs]
 * @param {(opts:any) => Promise<any>} [deps.runReconcile]
 * @param {object} [deps.settings]
 * @param {string} [deps.event]                hook event name — selects the timeout ceiling
 * @param {number} [deps.nowMs]
 * @param {string} [deps.file]                 state-file override (tests)
 * @param {(s:any,f?:string)=>boolean} [deps.writeState]
 * @param {(f?:string)=>any} [deps.readState]
 * @returns {Promise<{ran:boolean, reason:string, inFlight:number, fixed?:number, scanned?:number, timedOut?:boolean, error?:string}>}
 */
export async function runHookRefresh(deps = {}) {
  const settings = deps.settings ?? hookSettings();
  const nowMs = deps.nowMs ?? Date.now();
  const file = deps.file;
  const rState = deps.readState ?? readState;
  const wState = deps.writeState ?? writeState;

  let jobs = [];
  try {
    const list = deps.listJobs ?? (await import("../jobstore.js")).listJobs;
    jobs = list() ?? [];
  } catch {
    // No store yet (fresh install) is normal, not an error worth surfacing to the user.
    return { ran: false, reason: "job store unavailable", inFlight: 0 };
  }

  const { lastRunMs } = rState(file);
  const decision = shouldRefresh({
    jobs,
    nowMs,
    lastRunMs,
    enabled: settings.enabled,
    minIntervalSeconds: settings.minIntervalSeconds,
  });
  if (!decision.run) return { ran: false, reason: decision.reason, inFlight: decision.inFlight };

  // Stamp BEFORE the sweep, not after. Two prompts submitted in quick succession would otherwise both
  // see an old stamp and both call GitHub; stamping first makes the debounce hold even when a sweep is
  // still in flight.
  wState({ lastRunMs: nowMs, lastResult: null }, file);

  const reconcile = deps.runReconcile ?? (await import("../reconcile.js")).runReconcile;
  const ceilingMs = timeoutForEvent(deps.event, settings);
  let timer;
  try {
    const sweep = reconcile({ staleSeconds: settings.staleSeconds, nowMs });
    // The timer is deliberately NOT unref'd: a hung sweep keeps nothing else on the event loop, so an
    // unref'd timer would let the loop drain and the timeout would never fire — the exact case this
    // race exists to catch. It is cleared in `finally` instead, and the hook script exits explicitly.
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ __timedOut: true }), ceilingMs);
    });
    const res = /** @type {any} */ (await Promise.race([sweep, timeout]));
    if (res?.__timedOut) {
      return {
        ran: true,
        timedOut: true,
        reason: `timed out after ${ceilingMs}ms`,
        inFlight: decision.inFlight,
      };
    }
    const out = {
      ran: true,
      reason: decision.reason,
      inFlight: decision.inFlight,
      scanned: res?.scanned ?? 0,
      fixed: res?.fixed ?? 0,
    };
    wState({ lastRunMs: nowMs, lastResult: { scanned: out.scanned, fixed: out.fixed } }, file);
    return out;
  } catch (e) {
    return {
      ran: true,
      reason: "reconcile failed",
      inFlight: decision.inFlight,
      error: e?.message ?? String(e),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One-line, human-readable outcome for the hook log. Deliberately ASCII-only: this string is written
 *  to hooks.log and read back with `type`/`cat` in a Windows console, where a UTF-8 em dash renders as
 *  mojibake and makes a healthy log line look like a crash. */
export function formatHookOutcome(r) {
  if (!r.ran) return `skip - ${r.reason}`;
  if (r.timedOut) return `partial - ${r.reason} (${r.inFlight} in flight; sweep left running)`;
  if (r.error) return `error - ${r.error}`;
  return `refreshed - scanned ${r.scanned}, advanced ${r.fixed} (${r.inFlight} in flight)`;
}
