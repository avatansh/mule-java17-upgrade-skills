// rewrites/munit_arglines.js — port of dwl::rewriteMunitArgLines.
// Tier-0 Java-17 hygiene: strip <argLine> entries carrying JPMS flags (--add-opens /
// --add-exports / --add-modules) but ONLY inside MUnit plugin blocks. A now-empty <argLines>
// wrapper is removed. Idempotent: no flags present → unchanged.

const MUNIT_PLUGIN_ARTIFACTS = ["munit-maven-plugin", "munit-extensions-maven-plugin"];

/** True when an <argLine> element's text carries any configured JPMS flag. */
function carriesFlag(argLineXml, flags) {
  return (flags ?? []).some((f) => argLineXml.includes(String(f)));
}

/** Strip offending <argLine> elements (and a now-empty <argLines> wrapper) from ONE plugin block. */
function cleanMunitBlock(block, flags) {
  const noBadLines = block.replace(/<argLine>[\s\S]*?<\/argLine>/g, (m) => (carriesFlag(m, flags) ? "" : m));
  return noBadLines.replace(/<argLines>\s*<\/argLines>/g, "");
}

/**
 * @param {string} pomText
 * @param {Array<string>} flags matrix.removeMunitJpmsFlags
 * @returns {string}
 */
export function rewriteMunitArgLines(pomText, flags) {
  if (!flags || flags.length === 0) return pomText;
  return pomText.replace(/<plugin>[\s\S]*?<\/plugin>/g, (block) => {
    const isMunit = MUNIT_PLUGIN_ARTIFACTS.some((a) => block.includes(`<artifactId>${a}</artifactId>`));
    return isMunit ? cleanMunitBlock(block, flags) : block;
  });
}
