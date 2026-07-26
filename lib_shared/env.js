// env.js — auto-load `.env` on every skill/CLI/server run.
//
// Import this module FIRST (before anything reads process.env) in every CLI entrypoint, skill
// script, and the server. It walks up from the repo toward the filesystem root looking for a
// `.env` file and loads it with Node's native process.loadEnvFile (Node >= 20.6). A missing
// `.env` is non-fatal — real environments (CI, the hosted server) inject vars directly, so the
// bootstrap must never throw when the file is absent.
//
// Idempotent: the first import loads `.env`; later imports are no-ops. Existing process.env
// values always win over `.env` (process.loadEnvFile does not overwrite already-set vars in the
// way we want, so we load into a temp and only fill gaps).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let _loaded = false;

/** Find the nearest `.env` walking up from `startDir` to the fs root. Returns path or null. */
function findEnvFile(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Load `.env` once. Values already present in process.env are preserved (env wins over file),
 * so CI / container / Agentforce-injected secrets are never clobbered by a stale local file.
 * @param {string} [fromDir] directory to start the search from (defaults to this file's dir)
 * @returns {string|null} the loaded path, or null when no `.env` was found
 */
export function loadEnv(fromDir) {
  if (_loaded) return null;
  _loaded = true;
  const start = fromDir ?? path.dirname(fileURLToPath(import.meta.url));
  const envPath = findEnvFile(start);
  if (!envPath) return null;

  // Snapshot pre-existing keys so we can restore precedence (process.env wins).
  const preexisting = { ...process.env };
  try {
    if (typeof process.loadEnvFile === "function") {
      process.loadEnvFile(envPath);
    } else {
      // Fallback for Node < 20.6: minimal KEY=VALUE parser (no export, no interpolation).
      const text = fs.readFileSync(envPath, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (!(m[1] in process.env)) process.env[m[1]] = v;
      }
    }
  } catch {
    return null; // never fatal
  }
  // Restore precedence: any key that already existed keeps its original value.
  for (const k of Object.keys(preexisting)) process.env[k] = preexisting[k];
  return envPath;
}

// Auto-run on import so a bare `import "../../../lib_shared/env.js"` is enough.
loadEnv();
