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
import { runReconcile } from "./reconcile.js";

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

function main() {
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
      const rec = getJob(args.job);
      if (!rec) throw notFound(args.job);
      out(buildJobStatus(rec, typeof args["jira-base-url"] === "string" ? args["jira-base-url"] : ""));
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
      const res = runReconcile({
        staleSeconds: args["stale-seconds"] ? Number(args["stale-seconds"]) : undefined,
        nowMs: args["now-ms"] ? Number(args["now-ms"]) : undefined,
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
  try {
    main();
  } catch (err) {
    console.error(`JOB ERROR: ${err?.message ?? err}`);
    process.exit(err?.exitCode ?? 1);
  }
}
