#!/usr/bin/env node
// matrix_update_cli.js — CLI driver for SKILL mule-upgrade-matrix-update.
//
//   node matrix_update_cli.js [--apply] [--targets 17,21|all] [--no-connectors] [--no-fetch] [--json]
//   node matrix_update_cli.js targets              list every Java target and whether it is curated
//   node matrix_update_cli.js diff <a> <b>         the version-level delta between two targets
//   node matrix_update_cli.js scaffold <major>     create a new (uncurated) target from the default
//
//   default        DRY-RUN: gather drift, print the proposed matrix bumps, write NOTHING.
//   --apply        write the proposed bumps to the chosen target file(s) (text-preserving).
//   --targets      which Java target(s) to touch. With more than one matrix present this is
//                  REQUIRED for a write — omitting it prints the choices and does nothing, because
//                  whether a bump is Java-specific or Java-neutral is the operator's call.
//   --no-connectors gating pins only (skip the connector latest-in-major bumps).
//   --no-fetch     skip all network → nothing to propose (drift unchecked).
//   --json         emit the raw report JSON instead of the human summary.
//
// Exit codes: 0 ok (whether or not anything was proposed/written), 1 error, 2 usage.
// This NEVER auto-writes: the curated matrix is the authoritative Java-safe floor and only an
// explicit --apply adopts a bump.

import fs from "node:fs";
import path from "node:path";
import { runMatrixUpdate, formatMatrixUpdate, formatTargetDiff } from "./matrix_update.js";
import {
  listTargets,
  scaffoldTarget,
  targetFileName,
  referencesDir,
  DEFAULT_MATRIX_FILE,
} from "../../mule-upgrade-assess/scripts/lib/matrix_targets.js";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    // A following non-flag token is this flag's value; otherwise it is a boolean switch.
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i++;
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

/** `--targets 17,21` / `--targets all` / absent → undefined (which makes runMatrixUpdate ask). */
function parseTargets(v) {
  if (v === undefined || v === true) return undefined;
  const s = String(v).trim();
  if (s.toLowerCase() === "all") return "all";
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function cmdTargets() {
  const targets = listTargets();
  if (!targets.length) {
    process.stdout.write("No compatibility matrix found.\n");
    return;
  }
  process.stdout.write("Java targets:\n");
  for (const t of targets) {
    const tags = [t.isDefault ? "default" : null, t.curated ? "curated" : "UNCURATED"]
      .filter(Boolean)
      .join(", ");
    process.stdout.write(
      `  Java ${String(t.javaVersion).padEnd(4)} ${path.basename(t.file).padEnd(38)} runtime ${String(t.runtime ?? "-").padEnd(10)} (${tags})\n`
    );
  }
}

function cmdScaffold(major) {
  if (!major) {
    process.stderr.write("scaffold requires a Java major, e.g. `scaffold 25`\n");
    process.exit(2);
  }
  const dir = referencesDir();
  const out = path.join(dir, targetFileName(major));
  if (fs.existsSync(out)) {
    process.stderr.write(`${path.basename(out)} already exists — refusing to overwrite it.\n`);
    process.exit(2);
  }
  const src = path.join(dir, DEFAULT_MATRIX_FILE);
  fs.writeFileSync(out, scaffoldTarget(fs.readFileSync(src, "utf8"), major));
  process.stdout.write(
    `Created ${path.basename(out)} from ${DEFAULT_MATRIX_FILE}.\n` +
      `Identity fields were copied verbatim; every version is "TODO" and the file is marked uncurated,\n` +
      `so the engine will refuse to run against it until you curate it. See references/MATRIX.md §5.\n`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [sub, ...rest] = args._;

  if (sub === "targets") return cmdTargets();
  if (sub === "scaffold") return cmdScaffold(rest[0]);
  if (sub === "diff") {
    if (rest.length < 2) {
      process.stderr.write("diff requires two targets, e.g. `diff 17 21`\n");
      process.exit(2);
    }
    process.stdout.write(formatTargetDiff(rest[0], rest[1]) + "\n");
    return;
  }
  if (sub !== undefined) {
    process.stderr.write(
      `Unknown command "${sub}". Expected one of: targets, diff, scaffold (or no command to run an update).\n`
    );
    process.exit(2);
  }

  const report = await runMatrixUpdate({
    apply: Boolean(args.apply),
    targets: parseTargets(args.targets),
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
