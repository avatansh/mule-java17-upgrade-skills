#!/usr/bin/env node
// parent_pom_cli.js — CLI driver for SKILL 4 (mule-upgrade-parent-pom).
//
//   node parent_pom_cli.js --repo-url <url> [--mode api|local] [--pom-path p] [--branch b]
//                          [--owner o --repo r] [--repo-root path] [--jira T] [--jira-base-url u]
//                          [--env e] [--release-notes-url u] [--no-fetch]
//
// Prints the ParentPomUpgradeResult JSON. Exit codes: 0 ok (NO_CHANGE / PR_OPEN),
// 5 VALIDATION, 2 usage, 1 other.

import { upgradeParentPom } from "./parent_pom.js";

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["repo-url"] && !(args.owner && args.repo)) {
    return fail(2, "requires --repo-url OR (--owner and --repo)");
  }
  try {
    const result = await upgradeParentPom({
      repoUrl: args["repo-url"] || null,
      owner: args.owner || null,
      repo: args.repo || null,
      pomPath: args["pom-path"] || null,
      branch: args.branch || null,
      environment: args.env || null,
      jiraTicketId: args.jira || null,
      jiraBaseUrl: args["jira-base-url"] || process.env.JIRA_BASE_URL || "",
      mode: args.mode || "api",
      repoRoot: args["repo-root"] || null,
      matrixOpts: {
        releaseNotesUrl: args["release-notes-url"],
        noFetch: Boolean(args["no-fetch"]),
      },
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (e) {
    if (e.code === "VALIDATION") return fail(5, `VALIDATION: ${e.message}`);
    return fail(1, `ERROR: ${e.stack || e.message}`);
  }
}

main();
