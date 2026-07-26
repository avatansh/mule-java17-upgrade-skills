// rewrites/dep_versions.js — port of dwl::rewriteDepVersions.
// Surgically pin <version> of specific <dependency> entries (matched by groupId+artifactId).
// Existing inline <version> (literal or ${…}) is REPLACED; a BOM-managed dep with no <version>
// gets one INSERTED after its first </artifactId>. Unmatched deps are untouched.

/**
 * @param {string} pomText
 * @param {Array<{groupId:string,artifactId:string,to:string}>} edits
 * @returns {string}
 */
export function rewriteDepVersions(pomText, edits) {
  return pomText.replace(/<dependency>[\s\S]*?<\/dependency>/g, (block) => {
    const hit = edits.find(
      (e) =>
        block.includes(`<groupId>${e.groupId}</groupId>`) &&
        block.includes(`<artifactId>${e.artifactId}</artifactId>`)
    );
    if (!hit) return block;
    if (block.includes("<version>")) {
      return block.replace(/<version>[^<]*<\/version>/, `<version>${String(hit.to)}</version>`);
    }
    // BOM-managed dependency (no <version>) → insert one after the FIRST </artifactId>.
    const marker = "</artifactId>";
    const idx = block.indexOf(marker);
    return (
      block.slice(0, idx) +
      marker +
      `\n            <version>${String(hit.to)}</version>` +
      block.slice(idx + marker.length)
    );
  });
}
