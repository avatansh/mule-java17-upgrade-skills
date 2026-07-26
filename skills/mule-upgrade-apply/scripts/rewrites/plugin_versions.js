// rewrites/plugin_versions.js — port of dwl::rewritePluginVersions.
// Surgically pin <version> of specific <plugin> entries (matched by artifactId, optional groupId).
// Only the plugin's OWN (first) <version> is affected — nested dependency versions are left alone.
// A plugin with no <version> gets one INSERTED after its own </artifactId>.

/**
 * @param {string} pomText
 * @param {Array<{pluginArtifactId:string,pluginGroupId?:string|null,to:string}>} edits
 * @returns {string}
 */
export function rewritePluginVersions(pomText, edits) {
  return pomText.replace(/<plugin>[\s\S]*?<\/plugin>/g, (block) => {
    const hit = edits.find(
      (e) =>
        block.includes(`<artifactId>${e.pluginArtifactId}</artifactId>`) &&
        (e.pluginGroupId == null || block.includes(`<groupId>${e.pluginGroupId}</groupId>`))
    );
    if (!hit) return block;
    if (block.includes("<version>")) {
      // Anchored, non-greedy prefix guarantees we replace only the FIRST <version>
      // (the plugin's own), not a nested dependency's version.
      return block.replace(
        /^([\s\S]*?)<version>[^<]*<\/version>/,
        (_m, prefix) => `${prefix ?? ""}<version>${String(hit.to)}</version>`
      );
    }
    // Plugin with no version at all → insert after the plugin's own </artifactId>.
    const marker = "</artifactId>";
    const idx = block.indexOf(marker);
    return (
      block.slice(0, idx) +
      marker +
      `\n                <version>${String(hit.to)}</version>` +
      block.slice(idx + marker.length)
    );
  });
}
