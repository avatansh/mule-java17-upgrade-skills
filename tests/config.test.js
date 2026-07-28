// tests/config.test.js — config loader + secure-props AES round-trip + layering.
//   · secure_props: encrypt→decrypt round-trip, IV-prefix handling, key-length + missing-key errors.
//   · config: env overrides win over constants; secure ![...] decrypts; dotted get()/has().
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { encryptSecure, decryptSecure, isSecureValue, secureCipherText } from "../lib_shared/secure_props.js";
import {
  loadConfig,
  get,
  has,
  _resetConfigCache,
  resolveEnv,
  requireEnv,
  resolveKey,
  KNOWN_ENVS,
} from "../lib_shared/config.js";

const KEY = "0123456789abcdef0123456789abcdef"; // 32 chars → AES-256 (a test key, not a real secret)

// ── secure_props round-trip ─────────────────────────────────────────────────────────────────
test("secure_props: encrypt→decrypt round-trips (AES-256-CBC, IV-prefixed)", () => {
  const plain = "s3cr3t-value!";
  const b64 = encryptSecure(plain, KEY);
  assert.equal(decryptSecure(b64, KEY), plain);
});

test("secure_props: fixed IV yields deterministic ciphertext (IV really is the prefix)", () => {
  const iv = Buffer.alloc(16, 7);
  const a = encryptSecure("hello", KEY, iv);
  const b = encryptSecure("hello", KEY, iv);
  assert.equal(a, b);
  // first 16 bytes of the payload are exactly the IV
  assert.deepEqual(Buffer.from(a, "base64").subarray(0, 16), iv);
});

test("secure_props: isSecureValue / secureCipherText detect ![...]", () => {
  assert.equal(isSecureValue("![abc]"), true);
  assert.equal(isSecureValue("plain"), false);
  assert.equal(secureCipherText("![abc]"), "abc");
  assert.equal(secureCipherText("plain"), null);
});

test("secure_props: missing key throws VALIDATION", () => {
  assert.throws(
    () => decryptSecure("whatever", ""),
    (e) => e.code === "VALIDATION"
  );
});

test("secure_props: wrong key length throws VALIDATION", () => {
  assert.throws(
    () => decryptSecure(encryptSecure("x", KEY), "short"),
    (e) => e.code === "VALIDATION"
  );
});

// ── mandatory environment selector (Mule -Denv parity) ───────────────────────────────────────
test("resolveEnv: explicit string wins; boolean/empty ignored; falls back to MULE_UPGRADE_ENV", () => {
  const prev = process.env.MULE_UPGRADE_ENV;
  try {
    process.env.MULE_UPGRADE_ENV = "prod";
    assert.equal(resolveEnv("dev"), "dev"); // explicit wins
    assert.equal(resolveEnv(true), "prod"); // valueless flag → treated as absent → env
    assert.equal(resolveEnv(""), "prod"); // empty → env
    assert.equal(resolveEnv(undefined), "prod");
    delete process.env.MULE_UPGRADE_ENV;
    assert.equal(resolveEnv(undefined), null); // neither supplied → null
  } finally {
    if (prev === undefined) delete process.env.MULE_UPGRADE_ENV;
    else process.env.MULE_UPGRADE_ENV = prev;
  }
});

test("requireEnv: throws VALIDATION when no env supplied (no silent default)", () => {
  const prev = process.env.MULE_UPGRADE_ENV;
  delete process.env.MULE_UPGRADE_ENV;
  try {
    assert.throws(
      () => requireEnv(undefined),
      (e) => e.code === "VALIDATION" && /environment is required/.test(e.message)
    );
  } finally {
    if (prev === undefined) delete process.env.MULE_UPGRADE_ENV;
    else process.env.MULE_UPGRADE_ENV = prev;
  }
});

test("requireEnv: rejects an unknown env, accepts a known one and pins MULE_UPGRADE_ENV", () => {
  const prev = process.env.MULE_UPGRADE_ENV;
  delete process.env.MULE_UPGRADE_ENV;
  try {
    assert.throws(
      () => requireEnv("staging"),
      (e) => e.code === "VALIDATION" && /unknown environment/.test(e.message)
    );
    for (const env of KNOWN_ENVS) {
      assert.equal(requireEnv(env), env);
      assert.equal(process.env.MULE_UPGRADE_ENV, env); // pinned for downstream reads
    }
    // validate:false lets an ad-hoc env through (used by tests / non-shipped envs)
    delete process.env.MULE_UPGRADE_ENV;
    assert.equal(requireEnv("qa", { validate: false }), "qa");
  } finally {
    if (prev === undefined) delete process.env.MULE_UPGRADE_ENV;
    else process.env.MULE_UPGRADE_ENV = prev;
  }
});

test("resolveKey: per-env key wins over generic; generic is the fallback", () => {
  const prevGen = process.env.MULE_CONFIG_KEY;
  const prevProd = process.env.MULE_CONFIG_KEY_PROD;
  try {
    process.env.MULE_CONFIG_KEY = "generic-key";
    delete process.env.MULE_CONFIG_KEY_PROD;
    assert.equal(resolveKey("prod"), "generic-key"); // no per-env → generic
    process.env.MULE_CONFIG_KEY_PROD = "prod-key";
    assert.equal(resolveKey("prod"), "prod-key"); // per-env wins
    assert.equal(resolveKey("dev"), "generic-key"); // other env still generic
    assert.equal(resolveKey("prod", "explicit"), "explicit"); // opts.key beats all
  } finally {
    if (prevGen === undefined) delete process.env.MULE_CONFIG_KEY;
    else process.env.MULE_CONFIG_KEY = prevGen;
    if (prevProd === undefined) delete process.env.MULE_CONFIG_KEY_PROD;
    else process.env.MULE_CONFIG_KEY_PROD = prevProd;
  }
});

// ── config layering + decrypt ───────────────────────────────────────────────────────────────
// Build a throwaway config dir with a known key so we never touch the real encrypted secrets.
function writeTempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
  fs.writeFileSync(
    path.join(dir, "config.yaml"),
    'github:\n  apiBase: "https://api.github.com"\n  defaultBranch: "develop"\nnaming:\n  repoEqualsAppName: "true"\n'
  );
  fs.writeFileSync(
    path.join(dir, "config-dev.yaml"),
    'github:\n  defaultOwner: "acme"\n  defaultBranch: "main"\n' // overrides constant develop→main
  );
  const token = encryptSecure("ghp_test_token", KEY);
  fs.writeFileSync(path.join(dir, "config-secure-dev.yaml"), `github:\n  token: "![${token}]"\n`);
  return dir;
}

test("config: env override wins over constant; secure value decrypts; get()/has()", () => {
  const dir = writeTempConfig();
  const prevDir = process.env.MULE_CONFIG_DIR;
  process.env.MULE_CONFIG_DIR = dir;
  _resetConfigCache();
  try {
    const cfg = loadConfig({ env: "dev", key: KEY, force: true });
    assert.equal(cfg.github.defaultBranch, "main"); // dev override beat constant develop
    assert.equal(cfg.github.apiBase, "https://api.github.com"); // constant preserved
    assert.equal(cfg.github.token, "ghp_test_token"); // decrypted
    assert.equal(get("github.defaultOwner", null, { env: "dev", key: KEY }), "acme");
    assert.equal(has("github.token", { env: "dev", key: KEY }), true);
    assert.equal(has("github.nonexistent", { env: "dev", key: KEY }), false);
  } finally {
    if (prevDir === undefined) delete process.env.MULE_CONFIG_DIR;
    else process.env.MULE_CONFIG_DIR = prevDir;
    _resetConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("config: without key, secret stays as ![...] until read (deferred throw)", () => {
  const dir = writeTempConfig();
  const prevDir = process.env.MULE_CONFIG_DIR;
  const prevKey = process.env.MULE_CONFIG_KEY;
  process.env.MULE_CONFIG_DIR = dir;
  delete process.env.MULE_CONFIG_KEY;
  _resetConfigCache();
  try {
    const cfg = loadConfig({ env: "dev", key: "", force: true });
    assert.equal(isSecureValue(cfg.github.token), true); // not decrypted, but non-fatal to load
    // reading the secret without a key throws VALIDATION
    assert.throws(
      () => get("github.token", undefined, { env: "dev", key: "" }),
      (e) => e.code === "VALIDATION"
    );
    // a non-secret value is still readable with no key
    assert.equal(get("github.defaultOwner", null, { env: "dev", key: "" }), "acme");
  } finally {
    if (prevDir === undefined) delete process.env.MULE_CONFIG_DIR;
    else process.env.MULE_CONFIG_DIR = prevDir;
    if (prevKey !== undefined) process.env.MULE_CONFIG_KEY = prevKey;
    _resetConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
