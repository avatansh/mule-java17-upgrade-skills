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

/** Normalise an env name into the suffix used by a per-env key var (e.g. "dev" → "DEV"). */
function envKeySuffix(env) {
  return String(env || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
}

/**
 * Resolve the AES decryption key for a given environment, "set once, auto-selected per env".
 * Precedence (first non-empty wins):
 *   1. explicit opts.key            (tests / programmatic override)
 *   2. MULE_CONFIG_KEY_<ENV>        (per-env key, e.g. MULE_CONFIG_KEY_PROD) — lets one .env
 *                                    hold a distinct key per environment; the active env auto-picks
 *   3. MULE_CONFIG_KEY              (single key shared across envs — the common case here)
 * Returns "" when none is set, so key-free operations still work and the throw is deferred to the
 * moment a secret is actually READ.
 * @param {string} env
 * @param {string} [optKey]
 * @returns {string}
 */
export function resolveKey(env, optKey) {
  if (optKey != null && optKey !== "") return optKey;
  const perEnv = process.env[`MULE_CONFIG_KEY_${envKeySuffix(env)}`];
  if (perEnv) return perEnv;
  return process.env.MULE_CONFIG_KEY ?? "";
}

/** The environments this suite ships config file pairs for. Kept in sync with config/. */
export const KNOWN_ENVS = ["dev", "local", "prod"];

/**
 * Resolve the active environment from an explicit invocation input, falling back to the
 * loaded MULE_UPGRADE_ENV. Returns null when NEITHER is supplied — callers that require an
 * explicit env (every user-facing entrypoint) use requireEnv() to turn that into a fail-fast.
 * An arg-parser "present-but-valueless" flag (boolean `true`) is treated as absent.
 * @param {string|boolean} [explicit]  e.g. the value of a --env flag
 * @returns {string|null}
 */
export function resolveEnv(explicit) {
  if (typeof explicit === "string" && explicit !== "") return explicit;
  const fromEnv = process.env.MULE_UPGRADE_ENV;
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
  return null;
}

/**
 * Require an explicit environment at an invocation boundary — faithful to the Mule app, which
 * refused to start without `-Denv`/`mule.env`. The env may be SUPPLIED two ways (both count as an
 * explicit input): the `--env <e>` flag at the command/tool call, or `MULE_UPGRADE_ENV` loaded
 * from the process env / `.env`. There is NO silent "dev" default. On success it also PINS
 * `process.env.MULE_UPGRADE_ENV` so every downstream config read in this run resolves the same env.
 * @param {string|boolean} [explicit]  the --env flag value (or a request field)
 * @param {object} [opts]
 * @param {string} [opts.flag="--env"]  flag name to cite in the error
 * @param {boolean} [opts.validate=true] reject envs with no shipped config file pair
 * @returns {string} the resolved, non-empty environment
 * @throws {Error} code VALIDATION when no env was supplied (or an unknown one, when validate)
 */
export function requireEnv(explicit, opts = {}) {
  const flag = opts.flag || "--env";
  const env = resolveEnv(explicit);
  if (!env) {
    // When the caller's flag IS the env var (e.g. the server boots off MULE_UPGRADE_ENV), don't
    // print the redundant "pass X or set X"; otherwise cite both the flag and the env var.
    const how =
      flag === "MULE_UPGRADE_ENV"
        ? `set MULE_UPGRADE_ENV <${KNOWN_ENVS.join("|")}>`
        : `pass ${flag} <${KNOWN_ENVS.join("|")}> or set MULE_UPGRADE_ENV`;
    const e = new Error(
      `environment is required: ${how} (in your .env or the process env). There is no default — ` +
        `this mirrors the Mule app's mandatory -Denv selector.`
    );
    e.code = "VALIDATION";
    throw e;
  }
  if (opts.validate !== false && !KNOWN_ENVS.includes(env)) {
    const e = new Error(
      `unknown environment "${env}": expected one of ${KNOWN_ENVS.join(", ")} ` +
        `(each has a config-<env>.yaml + config-secure-<env>.yaml pair).`
    );
    e.code = "VALIDATION";
    throw e;
  }
  // Pin it so downstream loadConfig()/get()/cfg() in this process resolve the SAME env, and so the
  // per-env key (MULE_CONFIG_KEY_<ENV>) selection is consistent across every skill call in the run.
  process.env.MULE_UPGRADE_ENV = env;
  return env;
}

/**
 * Load and return the fully-resolved, decrypted config object for the active environment.
 * Cached after first call. Pass {force:true} to reload (e.g. after changing MULE_UPGRADE_ENV).
 *
 * @param {object} [opts]
 * @param {string} [opts.env]   override MULE_UPGRADE_ENV
 * @param {string} [opts.key]   override the resolved key (used by tests)
 * @param {boolean} [opts.force]
 * @returns {object}
 */
export function loadConfig(opts = {}) {
  if (_cache && !opts.force && !opts.env && !opts.key) return _cache;
  const env = opts.env || process.env.MULE_UPGRADE_ENV || "dev";
  const key = resolveKey(env, opts.key);

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
    const env = opts.env || process.env.MULE_UPGRADE_ENV || "dev";
    return decryptSecure(secureCipherText(node), resolveKey(env, opts.key));
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
