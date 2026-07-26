// rewrites/munit_runtime.js — port of dwl::rewriteMunitRuntime.
// Replace all <runtimeVersion>…</runtimeVersion> values with the target runtime. No-op if absent.

/**
 * @param {string} pomText
 * @param {string} toRuntime e.g. "4.9.18"
 * @returns {string}
 */
export function rewriteMunitRuntime(pomText, toRuntime) {
  return pomText.replace(
    /<runtimeVersion>[^<]*<\/runtimeVersion>/g,
    `<runtimeVersion>${toRuntime}</runtimeVersion>`
  );
}
