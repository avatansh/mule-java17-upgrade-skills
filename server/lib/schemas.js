// server/lib/schemas.js — the tool input schemas as a SINGLE SOURCE OF TRUTH.
//
// Each tool's JSON Schema lives as a standalone file in server/schemas/<toolName>.json. Both the MCP
// `inputSchema` (advertised to clients via tools/list) and the request validator (server/lib/schema.js,
// enforced before any handler runs) read from these SAME files. Publishing the schema as data — rather
// than hand-writing it twice — makes description/shape drift structurally impossible: there is exactly
// one artifact, and it is the thing shipped to clients AND the thing validated against.
//
// (This is the exact class of bug that bit the Agentforce agent, where the advertised schema and the
// enforced schema diverged and a field the model was told to send was silently rejected.)
//
// Loaded synchronously at import (dependency-free, mirroring config.js's fs+JSON approach). A malformed
// or missing schema file is a hard startup error — a broken contract must never boot.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "schemas");

/**
 * loadSchema(name): read and parse server/schemas/<name>.json.
 * @param {string} name  tool name (e.g. "assess_app")
 * @returns {object} the parsed JSON Schema
 * @throws {Error} when the file is missing or unparseable (a broken contract must fail fast)
 */
export function loadSchema(name) {
  const file = path.join(SCHEMA_DIR, `${name}.json`);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`tool schema not found: ${file} (${e.code || e.message})`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`tool schema is not valid JSON: ${file} (${e.message})`);
  }
}

/** listSchemaNames(): every tool name that has a published schema file (sorted). */
export function listSchemaNames() {
  return fs
    .readdirSync(SCHEMA_DIR)
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -".json".length))
    .sort();
}

/** The schema directory (exported for tests / tooling). */
export const schemaDir = SCHEMA_DIR;
