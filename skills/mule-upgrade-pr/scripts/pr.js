#!/usr/bin/env node
// pr.js — CLI driver for SKILL 3 (mule-upgrade-pr).
//
// Subcommands:
//   commit   --mode local|api  ...   → commit staged files on a fresh branch + open a PR
//   rollback --mode api        ...   → open a revert PR restoring the pre-upgrade tree
//
// Inputs that are structured (coords, changePlan, files) are passed as JSON, either inline via
// --<name> '<json>' or from a file via --<name>-file <path>. Staged files are
// [{path, content}] OR [{path, contentFile}] (contentFile is read from disk).
//
// On success prints the result JSON to stdout. Exit codes: 0 ok, 2 usage, 4 stale-plan/conflict,
// 5 validation, 1 other.

import fs from "node:fs";
import { commitAndPrApi, commitAndPrLocal } from "./commit_pr.js";
import { rollbackApi } from "./rollback.js";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      out[key] = val;
    } else {
      out._.push(a);
    }
  }
  return out;
}

// Resolve a JSON arg from --name (inline) or --name-file (path). Returns undefined if neither given.
function jsonArg(args, name, fallback) {
  if (args[name] != null && args[name] !== true) return JSON.parse(args[name]);
  const fileKey = `${name}-file`;
  if (args[fileKey] != null && args[fileKey] !== true) {
    return JSON.parse(fs.readFileSync(args[fileKey], "utf8"));
  }
  return fallback;
}

// Materialise staged files: each entry may carry inline `content` or a `contentFile` path.
function resolveStagedFiles(list) {
  return (list ?? []).map((f) => {
    if (typeof f.content === "string") return { path: f.path, content: f.content };
    if (typeof f.contentFile === "string") {
      return { path: f.path, content: fs.readFileSync(f.contentFile, "utf8") };
    }
    throw Object.assign(new Error(`staged file ${f.path} has neither content nor contentFile`), {
      code: "VALIDATION",
    });
  });
}

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function exitForError(e) {
  if (e.code === "STALE_PLAN" || e.code === "CONFLICT") fail(4, `CONFLICT: ${e.message}`);
  if (e.code === "VALIDATION") fail(5, `VALIDATION: ${e.message}`);
  fail(1, `ERROR: ${e.stack || e.message}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (cmd === "commit") {
    const mode = args.mode || "api";
    const coords = jsonArg(args, "coords");
    const changePlan = jsonArg(args, "change-plan") || jsonArg(args, "changePlan");
    const stagedFiles = resolveStagedFiles(jsonArg(args, "files", []));
    const common = {
      changePlan,
      stagedFiles,
      appName: args.app,
      jobId: args.job || "job",
      jiraTicketId: args.jira || null,
      jiraBaseUrl: args["jira-base-url"] || "",
      warnings: jsonArg(args, "warnings", []),
      enforceStalePlan: args["no-stale-guard"] ? false : true,
    };
    if (!coords && mode === "api") return fail(2, "commit --mode api requires --coords JSON");
    if (!changePlan) return fail(2, "commit requires --change-plan JSON (or --change-plan-file)");
    if (!args.app) return fail(2, "commit requires --app");

    try {
      const result = await (mode === "local"
        ? commitAndPrLocal({
            ...common,
            repoRoot: args["repo-root"] || process.cwd(),
            defaultBranch: args["default-branch"],
            push: args["no-push"] ? false : true,
            coords, // used by the REST fallback if `gh` is unavailable (else derived from the remote)
          })
        : commitAndPrApi({ ...common, coords }));
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } catch (e) {
      exitForError(e);
    }
    return;
  }

  if (cmd === "rollback") {
    const coords = jsonArg(args, "coords");
    if (!coords) return fail(2, "rollback requires --coords JSON");
    if (!args["commit-sha"]) return fail(2, "rollback requires --commit-sha (the upgrade commit)");
    if (!args.branch) return fail(2, "rollback requires --branch (the upgrade branch)");
    try {
      const result = await rollbackApi({
        coords,
        upgradeCommitSha: args["commit-sha"],
        branchName: args.branch,
        appName: args.app,
        jobId: args.job || "job",
        jiraTicketId: args.jira || null,
        jiraBaseUrl: args["jira-base-url"] || "",
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } catch (e) {
      exitForError(e);
    }
    return;
  }

  fail(
    2,
    "usage:\n" +
      "  node pr.js commit   --mode local|api --app <name> --coords <json> --change-plan <json> --files <json> [--job <id>] [--jira <t>] [--jira-base-url <u>] [--warnings <json>] [--no-stale-guard]\n" +
      "  node pr.js commit   --mode local --repo-root <path> [--default-branch <b>] [--no-push]\n" +
      "  node pr.js rollback --coords <json> --commit-sha <sha> --branch <b> --app <name> [--job <id>] [--jira <t>] [--jira-base-url <u>]"
  );
}

main();
