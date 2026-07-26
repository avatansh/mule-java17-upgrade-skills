// config.js — layered configuration loader, faithful to the Mule property system.
//
// Mirrors the Mule app's property layering exactly:
//   1. config-<env>.yaml  (env-varying overrides)   ← loaded FIRST, WINS
//   2. config.yaml        (environment constants)    ← base defaults
//   3. config-secure-<env>.yaml (![...] AES values)  ← merged in, decrypted at runtime
//
// `env` comes from MULE_UPGRADE_ENV (default "dev"), matching the -Denv / mule.env selector.
// Secure `![...]` values are decrypted lazily via MULE_CONFIG_KEY (never written to disk/logs).
//
// Any plaintext value in a *-secure file (not wrapped in ![...]) is passed through as-is, so a
// developer can point at unencrypted local creds without the key. A missing secure file is fine.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { isSecureValue, secureCipherText, decryptSecure } from "./secure_props.js";
import "./env.js"; // ensure .env is loaded before we read MULE_CONFIG_KEY / MULE_UPGRADE_ENV

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Resolved per call (not cached at import) so MULE_CONFIG_DIR set after import is honored — the
// hosted server and tests both rely on pointing this at a specific directory at runtime.
function configDir() {
  return process.env.MULE_CONFIG_DIR || path.join(REPO_ROOT, "config");
}

/** Deep-merge plain objects; `over` wins. Arrays/scalars are replaced, not concatenated. */
function deepMerge(base, over) {
  if (Array.isArray(over) || typeof over !== "object" || over === null) return over;
  const out = { ...(base && typeof base === "object" ? base : {}) };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in out && typeof out[k] === "object" && !Array.isArray(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function readYaml(file) {
  try {
    return yaml.load(fs.readFileSync(file, "utf8")) ?? {};
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/** Recursively decrypt every ![...] leaf; plaintext leaves pass through. */
function decryptTree(node, key) {
  if (Array.isArray(node)) return node.map((n) => decryptTree(n, key));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = decryptTree(v, key);
    return out;
  }
  if (isSecureValue(node)) return decryptSecure(secureCipherText(node), key);
  return node;
}

let _cache = null;

/**
 * Load and return the fully-resolved, decrypted config object for the active environment.
 * Cached after first call. Pass {force:true} to reload (e.g. after changing MULE_UPGRADE_ENV).
 *
 * @param {object} [opts]
 * @param {string} [opts.env]   override MULE_UPGRADE_ENV
 * @param {string} [opts.key]   override MULE_CONFIG_KEY (used by tests)
 * @param {boolean} [opts.force]
 * @returns {object}
 */
export function loadConfig(opts = {}) {
  if (_cache && !opts.force && !opts.env && !opts.key) return _cache;
  const env = opts.env || process.env.MULE_UPGRADE_ENV || "dev";
  const key = opts.key ?? process.env.MULE_CONFIG_KEY ?? "";

  const dir = configDir();
  const base = readYaml(path.join(dir, "config.yaml")) ?? {};
  const envOverrides = readYaml(path.join(dir, `config-${env}.yaml`)) ?? {};
  const secure = readYaml(path.join(dir, `config-secure-${env}.yaml`)) ?? {};

  // env overrides win over constants; secure values merged on top (decrypted lazily below).
  let merged = deepMerge(base, envOverrides);
  merged = deepMerge(merged, secure);

  // Decrypt only when a secret placeholder actually exists AND a key is available. If secrets are
  // present but no key is set, defer the throw to the moment a secret is READ (getSecret), so
  // key-free operations (e.g. local-mode assess) still work.
  const resolved = key ? decryptTree(merged, key) : merged;
  resolved.__env = env;
  resolved.__hasKey = !!key;
  if (!opts.env && !opts.key) _cache = resolved;
  return resolved;
}

/**
 * Read a dotted config path, e.g. get("anypoint.tokenPath"). Decrypts a secure leaf on demand
 * (throwing a clear VALIDATION error if the key is missing). Returns `fallback` when absent.
 */
export function get(dotted, fallback = undefined, opts = {}) {
  const cfg = loadConfig(opts);
  const parts = dotted.split(".");
  let node = cfg;
  for (const p of parts) {
    if (node && typeof node === "object" && p in node) node = node[p];
    else return fallback;
  }
  if (isSecureValue(node)) {
    return decryptSecure(secureCipherText(node), opts.key ?? process.env.MULE_CONFIG_KEY ?? "");
  }
  return node ?? fallback;
}

/** Convenience: true when a value exists (after resolution) and is non-empty. */
export function has(dotted, opts = {}) {
  const v = get(dotted, undefined, opts);
  return v !== undefined && v !== null && v !== "";
}

/** Reset the cache (tests). */
export function _resetConfigCache() {
  _cache = null;
}
