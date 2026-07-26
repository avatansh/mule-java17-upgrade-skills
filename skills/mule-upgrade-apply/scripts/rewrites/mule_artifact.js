// rewrites/mule_artifact.js — port of dwl::rewriteMuleArtifact.
// Set minMuleVersion and (re)add javaSpecificationVersions, PRESERVING every other key.
// The two managed keys are removed then re-added (so they land at the end, deduped) and the
// object is re-serialised as pretty JSON.

/**
 * @param {string} currentText raw mule-artifact.json text
 * @param {string} minMuleVersion e.g. "4.9.0"
 * @param {Array<string>} javaSpecVersions e.g. ["17"]
 * @returns {string}
 */
export function rewriteMuleArtifact(currentText, minMuleVersion, javaSpecVersions) {
  const current = currentText && currentText.trim() ? JSON.parse(currentText) : {};
  const base = { ...current };
  delete base.minMuleVersion;
  delete base.javaSpecificationVersions;
  const merged = { ...base, minMuleVersion, javaSpecificationVersions: javaSpecVersions };
  return JSON.stringify(merged, null, 2);
}
