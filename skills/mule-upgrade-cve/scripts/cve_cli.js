#!/usr/bin/env node
// cve_cli.js — CLI for the vulnerability scan (SKILL 12).
//
// Read-only by construction: this skill queries a public advisory database and reports. There is no
// --confirm because there is nothing to confirm — it never edits a pom, opens a PR, or deploys.

import { scanVulnerabilities } from "./cve.js";
import { formatCve } from "./format_cve.js";

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

// Source flags mirror assess.js EXACTLY (--repo for local, --owner/--repo-name/--branch for github).
const USAGE = `Usage (local):   cve_cli.js scan --repo <clone-dir> [--app-path sub/dir] [options]
Usage (github):  cve_cli.js scan --source github --repo-url <url> [options]
                 cve_cli.js scan --source github --owner <o> --repo-name <r> [--branch b] [options]

Source:
  --source <github|local>   where to read the app from (default: local, or github if --owner/--repo-url)
  --repo <clone-dir>        local checkout      (source=local)
  --repo-url <url>          GitHub URL          (source=github)
  --owner <o>               GitHub owner        (source=github)
  --repo-name <r>           GitHub repository   (source=github)
  --branch <b>              branch              (source=github, default the repo default branch)
  --app-path <path>         app directory inside the repo (default ".")

Scan:
  --no-compare-plan         skip the upgrade-plan comparison (faster; loses the
                            "already fixed by the upgrade" split)
  --refresh                 bypass the OSV cache
  --max-vuln-details <n>    cap advisory detail fetches (default 250)
  --fail-on <severity>      exit non-zero when an ACTION-REQUIRED finding at or above
                            this severity exists: critical|high|medium|low

Output:
  --json                    machine-readable result

Notes:
  Only DECLARED coordinates are scanned (direct deps, dependencyManagement, plugins). Transitive
  dependencies are NOT resolved — that needs a real Maven build. Findings are a lower bound.
`;

const SEVERITY_ORDER = { low: 1, medium: 2, high: 3, critical: 4 };

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!cmd || args.help || cmd !== "scan") return fail(2, USAGE);

  const failOn = args["fail-on"];
  if (failOn != null && failOn !== true && !SEVERITY_ORDER[String(failOn).toLowerCase()]) {
    return fail(2, `--fail-on must be one of critical|high|medium|low (got "${failOn}")`);
  }

  try {
    const res = await scanVulnerabilities({
      // Absent --source, resolveSource() infers github from --owner/--repo-url and local otherwise,
      // exactly as assess does. Defaulting to "github" here would break `--repo <dir>` on its own.
      source: args.source && args.source !== true ? args.source : undefined,
      repo: args.repo,
      repoUrl: args["repo-url"],
      owner: args.owner,
      repoName: args["repo-name"],
      branch: args.branch,
      appPath: args["app-path"],
      comparePlan: !args["no-compare-plan"],
      refresh: Boolean(args.refresh),
      maxVulnDetails: args["max-vuln-details"] != null && args["max-vuln-details"] !== true ? Number(args["max-vuln-details"]) : undefined,
    });

    if (args.json) process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    else process.stdout.write(formatCve(res) + "\n");

    // A gate is only meaningful on findings someone can act on: no-fix-available and
    // resolved-by-upgrade must not fail a build, or the gate gets disabled within a week.
    if (failOn && failOn !== true) {
      const floor = SEVERITY_ORDER[String(failOn).toLowerCase()];
      const breaching = (res.findings ?? []).filter(
        (f) => f.status === "action-required" && (SEVERITY_ORDER[f.severity.toLowerCase()] ?? 0) >= floor
      );
      if (breaching.length) {
        process.stderr.write(
          `\n${breaching.length} action-required finding(s) at or above ${String(failOn).toUpperCase()}.\n`
        );
        process.exit(1);
      }
    }
    process.exit(res.ok === false ? 1 : 0);
  } catch (e) {
    return fail(1, `cve scan failed: ${e.message}`);
  }
}

main();
