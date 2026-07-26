// rewrites/pom_properties.js — port of dwl::rewritePomProperties.
// Surgically rewrite Maven <property> VALUES without reformatting the file. Only tags named
// in `edits` change; every other byte is preserved. addIfAbsent edits whose tag is NOT present
// are INSERTED into <properties> (creating the block before </project> when none exists).

/**
 * @param {string} pomText raw pom.xml text (already decoded)
 * @param {Array<{property:string,to:string,addIfAbsent?:boolean}>} edits
 * @returns {string}
 */
export function rewritePomProperties(pomText, edits) {
  // tag name -> new value
  const editMap = {};
  for (const e of edits) editMap[e.property] = String(e.to);

  // 1) Replace target property tags already present, preserving every other byte.
  const replaced = pomText.replace(
    /<([A-Za-z0-9_.-]+)>([^<]*)<\/\1>/g,
    (whole, tag) => (editMap[tag] != null ? `<${tag}>${editMap[tag]}</${tag}>` : whole)
  );

  // 2) Add-if-absent: only flagged edits whose tag was NOT present in the ORIGINAL text.
  const additions = edits
    .filter((e) => (e.addIfAbsent ?? false) && !pomText.includes(`<${e.property}>`))
    .map((e) => `    <${e.property}>${String(e.to)}</${e.property}>`);

  if (additions.length === 0) return replaced;

  const closeProps = "</properties>";
  if (replaced.includes(closeProps)) {
    const idx = replaced.indexOf(closeProps);
    return (
      replaced.slice(0, idx) +
      additions.join("\n") +
      "\n  </properties>" +
      replaced.slice(idx + closeProps.length)
    );
  }
  // No <properties> block — create one just before </project>.
  const closeProj = "</project>";
  const idx = replaced.indexOf(closeProj);
  if (idx === -1) return replaced; // malformed; leave untouched
  return (
    replaced.slice(0, idx) +
    "  <properties>\n" +
    additions.join("\n") +
    "\n  </properties>\n" +
    "</project>" +
    replaced.slice(idx + closeProj.length)
  );
}
