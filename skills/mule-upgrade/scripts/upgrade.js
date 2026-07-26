#!/usr/bin/env node
// upgrade.js — CLI driver for SKILL 6 (mule-upgrade orchestrator).
//
// Subcommands:
//   start   — run the full pipeline (assess → lock → apply → commit+PR → notify) for one app.
//   poll    — the deploy-monitoring tail: run reconcile once (or --watch on a timer) to advance
//             PR_OPEN → DEPLOYING → DEPLOYED using gh + Anypoint verify. POLLING ONLY (no webhooks).
//
// start prints the outcome JSON. Exit codes: 0 ok (incl. ALREADY_UPGRADED / PR_OPEN),
// 4 CONFLICT (upgrade in progress), 5 FAILED_*, 2 usage, 1 other.

import { runUpgrade } from "./orchestrate.js";
import { runReconcile } from "../../mule-upgrade-job/scripts/reconcile.js";
import { AnypointClient, makeDeployVerifier } from "./lib/anypoint.js";
import { slackNotify } from "./lib/notify.js";
import { resolveCoordinates } from "../../../lib_shared/coordinates.js";
import { GitHubApi } from "../../mule-upgrade-pr/scripts/lib/gh_api.js";

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

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (cmd === "start") {
    if (!args.app) return fail(2, "start requires --app");
    if (!args.repo && args.mode !== "api") return fail(2, "start requires --repo (local clone for assess/apply)");
    try {
      // Resolve coordinates from --coords if given, else via pf-resolve-coordinates parity:
      // registry (app-registry.yaml) → request overrides → config convention → live default-branch.
      let coords = jsonArg(args, "coords");
      if (!coords) {
        const request = {};
        if (args.owner) request.owner = args.owner;
        if (args["repo-name"]) request.repo = args["repo-name"]; // --repo is a local path; repo *name* is separate
        if (args["app-path"]) request.appPath = args["app-path"];
        if (args["org-id"]) request.orgId = args["org-id"];
        if (args.branch) request.branch = args.branch;
        // Live branch discovery only in api mode (needs a token); silently skipped otherwise.
        let getRepo;
        if ((args.mode || "api") === "api" && process.env.GITHUB_TOKEN) {
          const gh = new GitHubApi();
          getRepo = (o, r) => gh.getRepo(o, r);
        }
        coords = await resolveCoordinates({ appName: args.app, request, deps: { getRepo } });
      }
      const result = await runUpgrade({
        appName: args.app,
        environment: args.env || "dev",
        jiraTicketId: args.jira || null,
        mode: args.mode || "api",
        coords,
        repo: args.repo,
        repoRoot: args["repo-root"] || args.repo,
        headSha: args["head-sha"],
        jiraBaseUrl: args["jira-base-url"] || process.env.JIRA_BASE_URL || "",
        assessOpts: {
          appPath: args["app-path"],
          releaseNotesUrl: args["release-notes-url"],
          noFetch: Boolean(args["no-fetch"]),
        },
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      if (result.status === "CONFLICT") process.exit(4);
      if (String(result.status).startsWith("FAILED")) process.exit(5);
    } catch (e) {
      fail(1, `ERROR: ${e.stack || e.message}`);
    }
    return;
  }

  if (cmd === "poll") {
    const staleSeconds = Number(args["stale-seconds"] ?? 0); // 0 → treat every job as pollable now
    const client = new AnypointClient();
    const verifyDeploy = makeDeployVerifier(client);
    const notify = (ev) => slackNotify(`:gear: reconcile: ${ev}`);
    const once = async () => {
      const res = await runReconcile({
        staleSeconds,
        nowMs: Date.parse(new Date().toISOString()),
        verifyDeploy,
        notify: (ev) => void notify(ev),
      });
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      return res;
    };
    if (args.watch) {
      // one-shot watch loop; for production use the /loop skill or OS cron instead of this.
      const intervalMs = Number(args.interval ?? 30) * 1000;
      const tick = async () => {
        try {
          await once();
        } catch (e) {
          process.stderr.write(`reconcile tick error: ${e.message}\n`);
        }
      };
      await tick();
      setInterval(tick, intervalMs);
      return; // keep process alive
    }
    await once();
    return;
  }

  fail(
    2,
    "usage:\n" +
      "  node upgrade.js start --app <name> [--env <env>] [--mode api|local] [--coords <json>]\n" +
      "         coords auto-resolve (registry→request→config→live branch) unless --coords given:\n" +
      "         [--owner o] [--repo-name r] [--app-path p] [--org-id id] [--branch b]\n" +
      "         [--repo <local-clone-path>] [--repo-root <path>] [--head-sha <sha>] [--jira <t>] [--jira-base-url <u>] [--release-notes-url <u>] [--no-fetch]\n" +
      "  node upgrade.js poll [--stale-seconds N] [--watch --interval <sec>]"
  );
}

main();
