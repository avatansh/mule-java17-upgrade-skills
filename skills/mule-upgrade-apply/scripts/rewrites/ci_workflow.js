// rewrites/ci_workflow.js — port of dwl::rewriteCiWorkflow.
// Bump the Java version in a GitHub Actions workflow using actions/setup-java
// (e.g. `java-version: '8'` -> `java-version: '17'`). Surrounding quotes/spacing preserved.
// Other CI mechanisms (matrix `java:`, JAVA_VERSION env var) are out of scope for this rewrite
// (the assess skill surfaces them as warnings instead).

/**
 * @param {string} yamlText
 * @param {string} toJavaVersion e.g. "17"
 * @returns {string}
 */
export function rewriteCiWorkflow(yamlText, toJavaVersion) {
  return yamlText.replace(
    /(java-version:[ \t]*["']?)([0-9]+)(["']?)/g,
    (_m, pre, _num, post) => `${pre}${toJavaVersion}${post}`
  );
}
