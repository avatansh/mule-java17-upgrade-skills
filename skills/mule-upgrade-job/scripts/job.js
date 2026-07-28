// job.js — SKILL 5 CLI driver over the JSON job store, status builder, and reconcile sweep.
//
// Subcommands (all print JSON to stdout):
//   create   --app <name> [--env <e>] [--jira <KEY>] [--coords <json>] [--change-plan <file>]
//   status   --job <jobId> [--jira-base-url <url>]     → buildJobStatus payload
//   set      --job <jobId> --status <S> [--field k=v ...]
//   get      --job <jobId>                             → raw record
//   list                                               → all records (summary)
//   lock     --app <name>                              → current lock holder
//   unlock   --app <name>                              → release lock
//   reapply  --job <jobId>                             → reseed new job
//   delete   --job <jobId>                             → remove record + clear index + release lock
//   reconcile [--stale-seconds N] [--now-ms N]         → run the sweep

import fs from "node:fs";
import {
  createJob,
  getJob,
  listJobs,
  setStatus,
  lockHolder,
  releaseLock,
  reapplyJob,
  deleteJob,
} from "./jobstore.js";
import { buildJobStatus } from "./status.js";
import { runReconcile, reconcileJob } from "./reconcile.js";
import { AnypointClient, makeDeployVerifier } from "../../mule-upgrade/scripts/lib/anypoint.js";

// Build the Anypoint deploy verifier for the poll-driven CLI paths (status --refresh / reconcile),
// mirroring server/lib/tools.js safeDeployVerifier(). Without it, runReconcile keeps its "unknown"
// verifyDeploy default (reconcile.js:324) and a DEPLOYING job checked from the CLI never advances to
// DEPLOYED / FAILED_DEPLOY — even with Anypoint fully configured. Non-fatal: if creds aren't present
// (ctor throws), return undefined so runReconcile keeps the "unknown" default and never crashes.
function safeDeployVerifier() {
  try {
    return makeDeployVerifier(new AnypointClient());
  } catch {
    return undefined;
  }
}

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      // --field k=v may repeat → collect into an array
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      if (k === "field") {
        (a.field ??= []).push(v);
      } else {
        a[k] = v;
      }
    } else {
      a._.push(argv[i]);
    }
  }
  return a;
}

function fieldsToObject(fieldArgs) {
  const out = {};
  for (const f of fieldArgs ?? []) {
    const idx = String(f).indexOf("=");
    if (idx < 0) continue;
    const k = f.slice(0, idx);
    const raw = f.slice(idx + 1);
    let val = raw;
    // best-effort typing: JSON first, else string
    try {
      val = JSON.parse(raw);
    } catch {
      /* keep string */
    }
    out[k] = val;
  }
  return out;
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

async function main() {
  const cmd = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  switch (cmd) {
    case "create": {
      if (!args.app) throw usage("create requires --app");
      const coords = typeof args.coords === "string" ? JSON.parse(args.coords) : null;
      const changePlan =
        typeof args["change-plan"] === "string"
          ? JSON.parse(fs.readFileSync(args["change-plan"], "utf8"))
          : null;
      const { jobId, record } = createJob({
        appName: args.app,
        environment: typeof args.env === "string" ? args.env : null,
        jiraTicketId: typeof args.jira === "string" ? args.jira : null,
        coords,
        changePlan,
      });
      out({ jobId, record });
      break;
    }
    case "status": {
      if (!args.job) throw usage("status requires --job");
      if (!getJob(args.job)) throw notFound(args.job);
      // --refresh (opt-in on the CLI): poll live PR/CI/deploy state before reading, mirroring the
      // MCP get_job_status auto-refresh. Non-fatal — a poll error still prints the last-known status.
      let checks;
      if (args.refresh) {
        try {
          // Wire the Anypoint verifier so a DEPLOYING job's deploy state is actually verified here,
          // matching the MCP get_job_status path (server/lib/tools.js:195).
          const r = await reconcileJob(args.job, { verifyDeploy: safeDeployVerifier() });
          checks = r.checks;
        } catch {
          /* keep last-known status */
        }
      }
      const rec = getJob(args.job);
      const status = buildJobStatus(rec, typeof args["jira-base-url"] === "string" ? args["jira-base-url"] : "");
      if (Array.isArray(checks) && checks.length) {
        status.checks = checks.map((c) => ({ stage: c.stage, result: c.result }));
      }
      out(status);
      break;
    }
    case "set": {
      if (!args.job || !args.status) throw usage("set requires --job and --status");
      const rec = setStatus(args.job, args.status, fieldsToObject(args.field));
      if (!rec) throw notFound(args.job);
      out(rec);
      break;
    }
    case "get": {
      if (!args.job) throw usage("get requires --job");
      const rec = getJob(args.job);
      if (!rec) throw notFound(args.job);
      out(rec);
      break;
    }
    case "list": {
      out(
        listJobs().map((r) => ({
          jobId: r.jobId,
          status: r.status,
          appName: r.appName,
          updatedAt: r.updatedAt,
          prUrl: r.prUrl ?? null,
        }))
      );
      break;
    }
    case "lock": {
      if (!args.app) throw usage("lock requires --app");
      out({ appName: args.app, holder: lockHolder(args.app) });
      break;
    }
    case "unlock": {
      if (!args.app) throw usage("unlock requires --app");
      out({ appName: args.app, released: releaseLock(args.app) });
      break;
    }
    case "reapply": {
      if (!args.job) throw usage("reapply requires --job");
      const { jobId, record } = reapplyJob(args.job);
      out({ jobId, record });
      break;
    }
    case "delete": {
      if (!args.job) throw usage("delete requires --job");
      out(deleteJob(args.job));
      break;
    }
    case "reconcile": {
      const res = await runReconcile({
        staleSeconds: args["stale-seconds"] ? Number(args["stale-seconds"]) : undefined,
        nowMs: args["now-ms"] ? Number(args["now-ms"]) : undefined,
        // Verify deployments on Anypoint (matches the MCP `reconcile` tool, server/lib/tools.js:306).
        verifyDeploy: safeDeployVerifier(),
      });
      out(res);
      break;
    }
    default:
      throw usage(`unknown subcommand: ${cmd ?? "(none)"}`);
  }
}

function usage(msg) {
  const e = new Error(
    `${msg}\nUsage: node job.js <create|status|set|get|list|lock|unlock|reapply|delete|reconcile> [flags]`
  );
  e.exitCode = 2;
  return e;
}
function notFound(jobId) {
  const e = new Error(`No job found with id ${jobId}.`);
  e.exitCode = 3;
  return e;
}

const isMain = process.argv[1] && process.argv[1].endsWith("job.js");
if (isMain) {
  main().catch((err) => {
    console.error(`JOB ERROR: ${err?.message ?? err}`);
    process.exit(err?.exitCode ?? 1);
  });
}
