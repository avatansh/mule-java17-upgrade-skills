#!/usr/bin/env node
// parent_pom_cli.js — CLI driver for SKILL 4 (mule-upgrade-parent-pom).
//
//   node parent_pom_cli.js --repo-url <url> [--mode api|local] [--pom-path p] [--branch b]
//                          [--owner o --repo r] [--repo-root path] [--jira T] [--jira-base-url u]
//                          --env <dev|local|prod> [--no-fetch] [--no-job]
//                          [--slack] [--jira-mode none|comment|create]
//   --env is REQUIRED (or set MULE_UPGRADE_ENV) — no default, mirrors Mule's -Denv
//   Notifications are OPT-IN: without --slack / --jira-mode nothing is posted and no ticket is
//   created, even when a Slack webhook and Jira token are configured.
//   Runs as a TRACKED job BY DEFAULT (single-flight lock + job record + FAILED_* taxonomy + pollable
//   status), like the app upgrade. CONFLICT → exit 4.
//   --no-job       opt out to the original one-shot (no lock, no job) — intended for tests/dry runs.
//   --detect-only  READ-ONLY: report what the pom inherits (<parent>/imported BOMs) + a connector
//                  edit preview and STOP (no lock, no PR). Used by the chained flow to recommend
//                  upgrading the BOM first. Prints a DETECTED result; exit 0.
//   Chained flow (repoint this pom's <parent> at a newly-bumped BOM/parent + bump own version):
//   --parent-ref-artifact <a> --parent-ref-version <v> [--parent-ref-group <g>] [--bump-own-version]
//
//   FINAL chained step — amend an app's ALREADY-OPEN PR to use the new parent-pom version:
//   node parent_pom_cli.js --update-app-job <appJobId> --parent-ref-artifact <a>
//                          --parent-ref-version <v> [--parent-ref-group <g>] [--pom-path p]
//                          [--mode api|local] [--repo-root path] [--jira T]
//   Adds ONE commit onto the open PR branch; prints PR_UPDATED | NO_CHANGE. No --env required.
//
// Prints the ParentPomUpgradeResult JSON. Exit codes: 0 ok (NO_CHANGE / PR_OPEN),
// 4 CONFLICT (--job, repo already locked), 5 VALIDATION, 2 usage, 1 other.

import { upgradeParentPom, runParentPomJob, updateOpenPrParentRef } from "./parent_pom.js";
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
function fail(code, msg) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

/**
 * notifyPrefsFromArgs(args): translate the opt-in notification flags into a notifyPrefs object.
 * Notifications are silent by default — configured Slack/Jira credentials are capability, not consent.
 *   --slack             → post Slack lifecycle alerts for this job
 *   --jira-mode <mode>  → none (default) | comment (on --jira's ticket) | create (open one first)
 */
function notifyPrefsFromArgs(args) {
  const mode = args["jira-mode"];
  if (mode != null && mode !== true && !["none", "comment", "create"].includes(mode)) {
    fail(2, `--jira-mode must be one of none|comment|create (got "${mode}")`);
  }
  return { slack: Boolean(args.slack), jira: mode === true ? "none" : (mode ?? "none") };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // FINAL chained step: amend an app's already-open PR to use the new parent-pom version. This path
  // targets a tracked APP job (not a parent-pom repo) and needs no --env / --repo-url.
  if (args["update-app-job"]) {
    if (!args["parent-ref-version"]) return fail(2, "--update-app-job requires --parent-ref-version");
    try {
      const result = await updateOpenPrParentRef({
        appJobId: args["update-app-job"],
        parentRef: {
          groupId: args["parent-ref-group"] || undefined,
          artifactId: args["parent-ref-artifact"] || undefined,
          toVersion: args["parent-ref-version"],
        },
        // OMIT by default → updateOpenPrParentRef derives the app's own pom path from the tracked
        // job (never blindly repo-root pom.xml). Only forward --pom-path if explicitly given.
        pomPath: args["pom-path"] || undefined,
        mode: args.mode || "api",
        repoRoot: args["repo-root"] || null,
        jiraTicketId: args.jira || null,
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    } catch (e) {
      if (e.code === "VALIDATION") return fail(5, `VALIDATION: ${e.message}`);
      return fail(1, `ERROR: ${e.stack || e.message}`);
    }
  }

  if (!args["repo-url"] && !(args.owner && args.repo)) {
    return fail(2, "requires --repo-url OR (--owner and --repo)");
  }
  let environment;
  try {
    environment = requireEnv(args.env); // mandatory: --env or MULE_UPGRADE_ENV, no default
  } catch (e) {
    return fail(2, e.message);
  }
  try {
    // Tracked by default; --no-job opts back into the untracked one-shot (tests/dry runs).
    const runner = args["no-job"] ? upgradeParentPom : runParentPomJob;
    // Chained flow: build the parent-ref intent when a target version is supplied.
    const parentRef = args["parent-ref-version"]
      ? {
          groupId: args["parent-ref-group"] || undefined,
          artifactId: args["parent-ref-artifact"] || undefined,
          toVersion: args["parent-ref-version"],
        }
      : null;
    const result = await runner({
      repoUrl: args["repo-url"] || null,
      owner: args.owner || null,
      repo: args.repo || null,
      pomPath: args["pom-path"] || null,
      branch: args.branch || null,
      environment,
      jiraTicketId: args.jira || null,
      jiraBaseUrl: args["jira-base-url"] || process.env.JIRA_BASE_URL || "",
      notifyPrefs: notifyPrefsFromArgs(args),
      mode: args.mode || "api",
      repoRoot: args["repo-root"] || null,
      detectOnly: Boolean(args["detect-only"]),
      parentRef,
      bumpOwnVersion: Boolean(args["bump-own-version"]),
      matrixOpts: {
        noFetch: Boolean(args["no-fetch"]),
      },
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    // CONFLICT is a distinct exit code so callers can detect a single-flight collision.
    if (result.status === "CONFLICT") process.exit(4);
    if (typeof result.status === "string" && result.status.startsWith("FAILED_")) process.exit(5);
  } catch (e) {
    if (e.code === "VALIDATION") return fail(5, `VALIDATION: ${e.message}`);
    return fail(1, `ERROR: ${e.stack || e.message}`);
  }
}

main();
