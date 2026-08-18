#!/usr/bin/env node
// .cursor/hooks/refresh-jobs.mjs — keep upgrade-job status fresh without an inbound GitHub webhook.
//
// Wired in .cursor/hooks.json to two events:
//   sessionStart        — one sweep when the session opens, catching every PR / CI / deploy transition
//                         that happened while Cursor was closed (the deliveries a webhook would have made)
//   beforeSubmitPrompt  — a debounced sweep right before the model reasons, so the agent reads current
//                         state instead of the user having to ask "check status now"
//
// Contract this script holds to, because it sits in front of the user's prompt:
//   * ALWAYS exit 0. A hook failure must never block a prompt. (Which is also why hooks.json leaves
//     failClosed off — the default fail-open is the behaviour we want here.)
//   * NEVER outlive the configured timeout. The bounded race lives in runHookRefresh.
//   * Say nothing on stdout beyond `{}`. sessionStart / beforeSubmitPrompt have no documented output
//     fields to populate, so this hook is a pure side effect on the job store; the agent picks the
//     refreshed state up through the normal get_job_status path.
//   * Stay silent in the common case. Observability goes to a log file, not the transcript.
//
// Written as Node rather than bash+jq on purpose: this repo already requires Node, whereas jq and bash
// are not present on a default Windows machine, and a hook that silently no-ops on half the team's
// laptops is worse than no hook.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

/** Read stdin to completion. Hooks deliver their event JSON here, and leaving the pipe unread can
 *  block the writer, so it is always drained even when the payload is not needed. */
async function readStdin() {
  try {
    if (process.stdin.isTTY) return {};
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Append one line to the hook log, capped so it cannot grow without bound. Fully non-fatal. */
function log(line) {
  try {
    const home =
      process.env.MULE_UPGRADE_HOME ||
      path.join(process.env.USERPROFILE || process.env.HOME || ".", ".mule-upgrade");
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, "hooks.log");
    try {
      if (fs.statSync(file).size > 256 * 1024) fs.rmSync(file);
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    /* logging is best-effort */
  }
}

/** The event name, taken from our own `--event` argument in hooks.json rather than from a stdin field.
 *  The argument is something this repo controls, so the timeout ceiling never depends on the exact
 *  shape of the hook payload; the stdin fields are only a fallback. */
function eventName(payload) {
  const i = process.argv.indexOf("--event");
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return payload?.hook_event_name ?? payload?.event ?? "unknown";
}

async function main() {
  const payload = await readStdin();
  const name = eventName(payload);

  // pathToFileURL, not a bare path: on Windows `import("C:/...")` reads "C:" as a URL scheme and
  // throws ERR_UNSUPPORTED_ESM_URL_SCHEME.
  const libUrl = pathToFileURL(
    path.join(repoRoot, "skills", "mule-upgrade-job", "scripts", "lib", "hook_refresh.js")
  );
  const { runHookRefresh, formatHookOutcome } = await import(libUrl.href);

  // The event name selects the timeout ceiling: tight before a prompt (the user is waiting on it),
  // more generous at session open (a one-off wait that buys a full catch-up).
  const result = await runHookRefresh({ event: name });
  const outcome = formatHookOutcome(result);
  // Only log the interesting outcomes. "no jobs in flight" is the steady state and would otherwise be
  // the only thing in the log.
  if (result.ran || result.error) log(`[${name}] ${outcome}`);
}

try {
  await main();
} catch (e) {
  log(`[fatal, ignored] ${e?.message ?? e}`);
}

process.stdout.write("{}");
process.exit(0);
