// rewrites/pom_version.js — port of dwl::rewritePomVersion.
// Bump the app module's OWN <project><version>. Rewrites ONLY the value inside the EXISTING
// <version> tag that immediately follows the project's own <artifactId>. No tag is added.
// No-op when the project artifactId is not immediately followed by a <version> (inherited /
// declared-before-artifactId / ${property}-driven).

/**
 * @param {string} pomText
 * @param {string} projectArtifactId
 * @param {string} newVersion
 * @returns {string}
 */
export function rewritePomVersion(pomText, projectArtifactId, newVersion) {
  const target = String(projectArtifactId ?? "").trim();
  if (target === "") return pomText;
  return pomText.replace(
    /(<artifactId>\s*([^<]*?)\s*<\/artifactId>\s*<version>)\s*[^<]*?\s*(<\/version>)/g,
    (whole, g1, g2, g3) =>
      String(g2 ?? "").trim() === target ? `${g1 ?? ""}${newVersion}${g3 ?? ""}` : whole
  );
}
