// secure_props.js — port of MuleSoft `secure-properties-tool.jar` (algorithm=AES, mode=CBC).
//
// The Mule secure-properties tool, when run as `encrypt AES CBC <key> <value>`, produces a
// base64 string whose first 16 bytes are a random IV and whose remaining bytes are the
// AES/CBC/PKCS5Padding ciphertext. The key string's raw UTF-8 bytes are used directly as the
// AES key, so a 32-character key selects AES-256. Secure values are referenced in the YAML as
// `![<base64>]`. This module decrypts them at RUNTIME using the key from the MULE_CONFIG_KEY
// environment variable — the plaintext is never written to disk or logged.

import crypto from "node:crypto";

const SECURE_RE = /^!\[(.*)\]$/s;

/** True when a config value is a Mule secure placeholder `![...]`. */
export function isSecureValue(v) {
  return typeof v === "string" && SECURE_RE.test(v.trim());
}

/** Extract the base64 payload from `![...]`, or null when not a secure value. */
export function secureCipherText(v) {
  if (typeof v !== "string") return null;
  const m = v.trim().match(SECURE_RE);
  return m ? m[1] : null;
}

/**
 * Decrypt one Mule AES/CBC secure value.
 * @param {string} cipherB64  the base64 inside `![...]` (IV-prefixed ciphertext)
 * @param {string} key        the encrypt key (UTF-8 bytes; 16/24/32 chars → AES-128/192/256)
 * @returns {string} UTF-8 plaintext
 */
export function decryptSecure(cipherB64, key) {
  if (!key) {
    const e = new Error(
      "MULE_CONFIG_KEY is not set. Secure (![...]) properties cannot be decrypted. " +
        "Set MULE_CONFIG_KEY in your .env to the AES key used to encrypt config-secure-*.yaml."
    );
    e.code = "VALIDATION";
    throw e;
  }
  const keyBuf = Buffer.from(key, "utf8");
  if (![16, 24, 32].includes(keyBuf.length)) {
    const e = new Error(
      `MULE_CONFIG_KEY must be 16, 24, or 32 characters (got ${keyBuf.length}); ` +
        "AES requires a 128/192/256-bit key."
    );
    e.code = "VALIDATION";
    throw e;
  }
  const algo = `aes-${keyBuf.length * 8}-cbc`;
  const raw = Buffer.from(cipherB64, "base64");
  const iv = raw.subarray(0, 16);
  const ciphertext = raw.subarray(16);
  const decipher = crypto.createDecipheriv(algo, keyBuf, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Encrypt a value the same way the Mule tool does (IV-prefixed AES/CBC, base64). Provided so
 * tests can round-trip without shelling out to the jar, and so operators can add new secrets.
 * @param {string} plaintext
 * @param {string} key
 * @param {Buffer} [iv]  16-byte IV; supply for deterministic tests, else a random IV is used.
 * @returns {string} base64 payload to wrap in `![...]`
 */
export function encryptSecure(plaintext, key, iv) {
  const keyBuf = Buffer.from(key, "utf8");
  const useIv = iv ?? crypto.randomBytes(16);
  const algo = `aes-${keyBuf.length * 8}-cbc`;
  const cipher = crypto.createCipheriv(algo, keyBuf, useIv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return Buffer.concat([useIv, ct]).toString("base64");
}
