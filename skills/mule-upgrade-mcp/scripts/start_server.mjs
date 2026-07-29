// start_server.mjs — robust launcher for the hosted MCP/REST server.
//
// WHY THIS EXISTS: the server lives at the SUITE ROOT (`server/server.js`), NOT inside this skill
// folder. When the skill is invoked from Vibes/Agentforce, a naive `node server/server.js` resolves
// relative to the skill directory (…/Rules/skills/mule-upgrade-mcp/server/server.js) which does not
// exist → `Cannot find module … MODULE_NOT_FOUND`. This launcher instead resolves the suite root from
// its OWN location (…/skills/mule-upgrade-mcp/scripts/ → ../../.. ), so it works no matter the cwd —
// PROVIDED the skill is SYMLINKED into the Vibes skills dir (not copied). A copy breaks the link back
// to the clone, and neither the server nor lib_shared/config would be reachable anyway.
//
// It spawns the server as its own long-lived process (stdio inherited) and forwards the exit code +
// signals, so "start the MCP server" is a single, cwd-independent command.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// scripts → mule-upgrade-mcp → skills → SUITE ROOT
const suiteRoot = path.resolve(here, "..", "..", "..");
const serverPath = path.join(suiteRoot, "server", "server.js");

if (!existsSync(serverPath)) {
  process.stderr.write(
    "[mule-upgrade-mcp] Cannot locate the server at:\n" +
      `  ${serverPath}\n\n` +
      "The hosted server lives at the SUITE ROOT, not inside this skill. This launcher resolved the\n" +
      "suite root relative to itself, so this almost always means the skill was COPIED into the Vibes\n" +
      "skills directory instead of SYMLINKED. Re-install the skill as a symlink to the cloned suite so\n" +
      "`server/`, `lib_shared/`, and `config/` resolve. See docs/SETUP-VIBES.md (Option A → symlink),\n" +
      "or run the server directly from the clone:  node <suite-root>/server/server.js\n"
  );
  process.exit(1);
}

// The server requires MULE_UPGRADE_ENV (it fails fast otherwise) and auto-loads the suite's .env via
// lib_shared/env.js. Spawn with cwd = suite root so the suite-root .env and config files resolve.
const child = spawn(process.execPath, [serverPath], {
  cwd: suiteRoot,
  stdio: "inherit",
  env: process.env,
});

// Forward Ctrl-C / termination to the server so it shuts down cleanly with the launcher.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on("error", (err) => {
  process.stderr.write(`[mule-upgrade-mcp] failed to start the server: ${err?.message ?? err}\n`);
  process.exit(1);
});
