#!/usr/bin/env node
// batch_cli.js — CLI for the batch upgrade (SKILL 11).
//
//   preview  — dry-run a selection, group shared parent poms, write NOTHING (the default posture)
//   run      — same, then execute the app-pom-routed apps (requires --confirm)
//
// Selection comes from either --apps (explicit) or --from-scan (the fleet-scan candidate list).
// One --env for the whole batch: concurrency across APPS, not across environments.

import { runBatchUpgrade, formatBatch } from "./batch.js";
import { requireEnv } from "../../../lib_shared/config.js";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      out[key] = val;
    } else out._.push(a);
  }
  return out;
}
function jsonArg(args, name, fallback) {
  if (args[name] != null && args[name] !== true) return JSON.parse(args[name]);
  return fallback;
}
function fail(code, msg) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

/** Same opt-in translation as upgrade.js — silent unless explicitly asked, applied to every app. */
function notifyPrefsFromArgs(args) {
  const mode = args["jira-mode"];
  if (mode != null && mode !== true && !["none", "comment", "create"].includes(mode)) {
    fail(2, `--jira-mode must be one of none|comment|create (got "${mode}")`);
  }
  return { slack: Boolean(args.slack), jira: mode === true ? "none" : (mode ?? "none") };
}

/**
 * --apps accepts either a comma-separated name list ("a,b,c") or a JSON array for per-app overrides
 * ('[{"appName":"a","owner":"o","repo":"r","appPath":"apps/a"}]').
 */
function appsFromArgs(args) {
  const raw = args.apps;
  if (raw == null || raw === true) return [];
  const s = String(raw).trim();
  if (s.startsWith("[")) {
    try {
      return JSON.parse(s);
    } catch (e) {
      return fail(2, `--apps looked like JSON but did not parse: ${e.message}`);
    }
  }
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((appName) => ({ appName }));
}

const USAGE = `Usage:
  batch_cli.js preview --env <env> (--apps <a,b,c>|--apps <json>|--from-scan) [options]
  batch_cli.js run     --env <env> (--apps ...|--from-scan) --confirm [options]

Selection:
  --apps <a,b,c>          explicit app names (coordinates resolve via the registry/convention waterfall)
  --apps <json-array>      per-app overrides: [{"appName":"a","owner":"o","repo":"r","appPath":"apps/a"}]
  --from-scan              take the fleet-scan candidate list (skips apps with no repo mapping)

Execution:
  --env <env>              REQUIRED. ONE environment for the whole batch.
  --confirm                REQUIRED by \`run\`. Without it, \`run\` behaves as \`preview\`.
  --concurrency <n>        apps in flight at once (default config batch.concurrency, 3)
  --stop-on-failure        don't start further apps once one fails
  --include-parent-pom     also execute apps whose gaps are managed upstream (NOT recommended:
                           N apps sharing one parent pom need a chained flow, not N parallel edits)
  --mode <api|local>       default api
  --version-strategy <s>   min (default) | first-compatible | latest-in-major | latest | manual
  --connector-selections <json>

Notifications (opt-in, applied to EVERY app in the batch):
  --slack                  post Slack lifecycle alerts
  --jira <KEY>             ticket to comment on (one ticket for the whole batch)
  --jira-mode <mode>       none (default) | comment | create

Output:
  --json                   machine-readable result
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!cmd || args.help || !["preview", "run"].includes(cmd)) return fail(2, USAGE);

  let environment;
  try {
    environment = requireEnv(args.env);
  } catch (e) {
    return fail(2, e.message);
  }

  const apps = appsFromArgs(args);
  if (!apps.length && !args["from-scan"]) {
    return fail(2, "select apps with --apps <a,b,c> (or a JSON array), or use --from-scan");
  }

  // `run` without --confirm degrades to a preview rather than silently opening N PRs.
  const confirm = cmd === "run" && args.confirm === true;
  if (cmd === "run" && !confirm) {
    process.stderr.write(
      "run requires --confirm to write anything — showing the preview instead (nothing will be written).\n"
    );
  }

  try {
    const res = await runBatchUpgrade({
      apps,
      fromScan: Boolean(args["from-scan"]),
      environment,
      mode: args.mode || "api",
      confirm,
      concurrency: args.concurrency,
      stopOnFailure: Boolean(args["stop-on-failure"]),
      includeParentPomRouted: Boolean(args["include-parent-pom"]),
      versionStrategy: args["version-strategy"],
      connectorSelections: jsonArg(args, "connector-selections"),
      jiraTicketId: args.jira && args.jira !== true ? args.jira : null,
      notifyPrefs: notifyPrefsFromArgs(args),
      repoRoot: args["repo-root"],
    });
    if (args.json) process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    else process.stdout.write(formatBatch(res) + "\n");
    // Exit non-zero when anything failed, so CI can gate on a batch.
    process.exit(res.summary?.failed ? 1 : 0);
  } catch (e) {
    return fail(1, `batch failed: ${e.message}`);
  }
}

main();
