// rewrites/pom_version.js — port of dwl::rewritePomVersion.
// Bump the app module's OWN <project><version>. Rewrites ONLY the value inside the EXISTING
// <version> tag that belongs to the project's own <artifactId>. No tag is added.
// No-op when the project artifactId is not followed by a <version> (inherited /
// declared-before-artifactId / ${property}-driven).
//
// Real poms interpose <name>, <packaging>, <description>, <url>, and XML comments BETWEEN the
// project's <artifactId> and its <version> (e.g. Exchange BOMs require a <name>). The matcher
// tolerates any run of such leaf nodes/comments so the bump is not silently skipped.

// A run of interposed leaf elements (<tag>text</tag>, no nested children) and XML comments that may
// sit between </artifactId> and <version> — e.g. an Exchange BOM puts a <name> (and comments) there.
// NO capturing groups — safe to splice into other patterns without shifting their group indices.
// Reused by rewrites/parent_pom.js (projectCoords) so detection and rewrite agree on what counts as
// "the project's own version".
//
// CRITICAL: the run must NOT match a <version> or <artifactId> element itself. It is greedy, so if it
// were allowed to consume <version>…</version> as a "leaf node" it would swallow the project's REAL
// version (line 17 in a BOM: <version>1.0.0-SNAPSHOT</version>) and backtrack to a LATER, unrelated
// <version> (e.g. a plugin's <version>${some.plugin.version}</version>), mis-identifying the coords and
// silently skipping the own-version bump. The negative lookahead pins the following <version> to the
// project's own.
export const INTERPOSED_LEAF_NODES = String.raw`(?:\s*(?:<!--[\s\S]*?-->|<(?!(?:version|artifactId)\b)[A-Za-z][\w.:-]*>[^<]*<\/[A-Za-z][\w.:-]*>))*\s*`;

/**
 * @param {string} pomText
 * @param {string} projectArtifactId
 * @param {string} newVersion
 * @returns {string}
 */
export function rewritePomVersion(pomText, projectArtifactId, newVersion) {
  const target = String(projectArtifactId ?? "").trim();
  if (target === "") return pomText;
  const re = new RegExp(
    String.raw`(<artifactId>\s*([^<]*?)\s*<\/artifactId>\s*${INTERPOSED_LEAF_NODES}<version>)\s*[^<]*?\s*(<\/version>)`,
    "g"
  );
  return pomText.replace(re, (whole, g1, g2, g3) =>
    String(g2 ?? "").trim() === target ? `${g1 ?? ""}${newVersion}${g3 ?? ""}` : whole
  );
}
