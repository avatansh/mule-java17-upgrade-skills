#!/usr/bin/env node
// matrix_update_cli.js — CLI driver for SKILL mule-upgrade-matrix-update.
//
//   node matrix_update_cli.js [--apply] [--no-connectors] [--no-fetch] [--json]
//
//   default        DRY-RUN: gather drift, print the proposed matrix bumps, write NOTHING.
//   --apply        write the proposed bumps to references/compatibility-matrix.yaml (text-preserving).
//   --no-connectors gating pins only (skip the connector latest-in-major bumps).
//   --no-fetch     skip all network → nothing to propose (drift unchecked).
//   --json         emit the raw report JSON instead of the human summary.
//
// Exit codes: 0 ok (whether or not anything was proposed/written), 1 error.
// This NEVER auto-writes: the curated matrix is the authoritative Java-17-safe floor and only an
// explicit --apply adopts a bump.

import { runMatrixUpdate, formatMatrixUpdate } from "./matrix_update.js";

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (a.startsWith("--")) out[a.slice(2)] = true;
    else out._.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await runMatrixUpdate({
    apply: Boolean(args.apply),
    includeConnectors: !args["no-connectors"],
    noFetch: Boolean(args["no-fetch"]),
  });

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatMatrixUpdate(report) + "\n");
    if (report.warnings.length) {
      process.stderr.write("\nAdvisories:\n" + report.warnings.map((w) => `  - ${w}`).join("\n") + "\n");
    }
  }
}

main().catch((e) => {
  process.stderr.write(`ERROR: ${e.stack || e.message}\n`);
  process.exit(1);
});
