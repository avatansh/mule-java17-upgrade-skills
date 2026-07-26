// rewrites/parent_pom.js — port of dwl::parentPomRewrite.
// Pin the connector versions MANAGED by a shared parent/BOM pom to the Java-17 matrix,
// preserving every other byte. Only connectors the parent already MANAGES are touched (via a
// <properties> value referenced by dependencyManagement, or a literal inline <version>).
// When at least one connector is pinned, the parent/BOM's OWN <version> is minor-bumped.
// A ${ref} inline version is driven by its property, so it is handled by the property path.

import { lt, bumpMinor } from "../../../../lib_shared/semver.js";
import { rewritePomVersion } from "./pom_version.js";

/** Remove the first <parent>…</parent> block so the pom's OWN coords can be isolated. */
function stripParentBlock(pomText) {
  return pomText.replace(/<parent>[\s\S]*?<\/parent>/, "");
}

/** The pom's OWN { artifactId, version } after the <parent> block is removed, else null. */
function projectCoords(pomText) {
  const noParent = stripParentBlock(pomText);
  const m = noParent.match(
    /<artifactId>\s*([^<]*?)\s*<\/artifactId>\s*<version>\s*([^<]*?)\s*<\/version>/
  );
  if (!m) return null;
  return { artifactId: (m[1] ?? "").trim(), version: (m[2] ?? "").trim() };
}

/** Only matrix connectors carrying full coordinates + a property key are eligible. */
function connRules(matrix) {
  return (matrix.connectors ?? []).filter((r) => r.groupId && r.artifactId && r.property);
}

/** Raw inner text of the FIRST <prop>…</prop> occurrence (null when absent/malformed). */
function propInner(pomText, prop) {
  const open = `<${prop}>`;
  const close = `</${prop}>`;
  if (!pomText.includes(open)) return null;
  const after = pomText.slice(pomText.indexOf(open) + open.length);
  const idx = after.indexOf(close);
  if (idx === -1) return null;
  const inner = after.slice(0, idx);
  return inner.includes("<") ? null : inner; // close tag not found before next element
}

/** Literal inline <version> for g:a, "REF" when it is a ${…} placeholder, or null. */
function inlineDepVersion(pomText, g, a) {
  const blocks = pomText.match(/<dependency>[\s\S]*?<\/dependency>/g) ?? [];
  const hit = blocks.find(
    (b) => b.includes(`<groupId>${g}</groupId>`) && b.includes(`<artifactId>${a}</artifactId>`)
  );
  if (!hit || !hit.includes("<version>")) return null;
  const v = hit.slice(hit.indexOf("<version>") + 9);
  const inner = v.slice(0, v.indexOf("</version>")).trim();
  return /^\s*\$\{.+\}\s*$/.test(inner) ? "REF" : inner;
}

/** Compute the edit list: one edit per managed connector below target. */
function computeParentEdits(pomText, matrix, pomPath) {
  const seen = new Set();
  const out = [];
  for (const r of connRules(matrix)) {
    const prop = String(r.property);
    const g = String(r.groupId);
    const a = String(r.artifactId);
    const pInner = propInner(pomText, prop);
    const pTrim = pInner != null ? pInner.trim() : null;
    const inline = pInner == null ? inlineDepVersion(pomText, g, a) : null;
    let edit = null;
    if (pInner != null && lt(pTrim, String(r.set))) {
      edit = { kind: "pomProperty", mode: "prop", file: pomPath, property: prop,
        groupId: g, artifactId: a, from: pTrim, to: String(r.set), inner: pInner, change: true };
    } else if (inline != null && inline !== "REF" && lt(inline, String(r.set))) {
      edit = { kind: "depVersion", mode: "inline", file: pomPath, property: prop,
        groupId: g, artifactId: a, from: inline, to: String(r.set), change: true };
    }
    if (edit) {
      const key = `${g}:${a}`;
      if (!seen.has(key)) { seen.add(key); out.push(edit); }
    }
  }
  return out;
}

/** Apply the edits: literal property replacements first, then inline version blocks. */
function applyParentEdits(pomText, edits) {
  let afterProps = pomText;
  for (const e of edits.filter((x) => x.mode === "prop")) {
    afterProps = afterProps.split(`<${e.property}>${e.inner}</${e.property}>`).join(
      `<${e.property}>${String(e.to)}</${e.property}>`
    );
  }
  const inlineEdits = edits.filter((x) => x.mode === "inline");
  if (inlineEdits.length === 0) return afterProps;
  return afterProps.replace(/<dependency>[\s\S]*?<\/dependency>/g, (block) => {
    const hit = inlineEdits.find(
      (e) =>
        block.includes(`<groupId>${e.groupId}</groupId>`) &&
        block.includes(`<artifactId>${e.artifactId}</artifactId>`)
    );
    if (!hit) return block;
    return block.replace(/<version>[^<]*<\/version>/, `<version>${String(hit.to)}</version>`);
  });
}

/**
 * Rewrite a parent/BOM pom text, pinning managed connectors and (when any were pinned)
 * minor-bumping the parent/BOM's OWN literal <version>.
 * @returns {{text:string, edits:Array}}
 */
export function rewriteParentPom(pomText, matrix, pomPath = "pom.xml") {
  const edits = computeParentEdits(pomText, matrix, pomPath);
  const afterConnectors = applyParentEdits(pomText, edits);
  const connEdits = edits.map((e) => ({
    kind: e.kind, file: e.file, property: e.property, groupId: e.groupId,
    artifactId: e.artifactId, from: e.from, to: e.to, change: true,
  }));
  const coords = projectCoords(pomText);
  const doBump =
    edits.length > 0 &&
    coords != null &&
    (coords.version ?? "") !== "" &&
    !/^\s*\$\{.+\}\s*$/.test(String(coords.version));
  const newVer = doBump ? bumpMinor(String(coords.version)) : null;
  const finalText = doBump
    ? rewritePomVersion(afterConnectors, String(coords.artifactId), String(newVer))
    : afterConnectors;
  const versionEdit = doBump
    ? [{ kind: "pomVersion", file: pomPath, artifactId: String(coords.artifactId),
        from: String(coords.version), to: String(newVer), change: true }]
    : [];
  return { text: finalText, edits: [...connEdits, ...versionEdit] };
}
