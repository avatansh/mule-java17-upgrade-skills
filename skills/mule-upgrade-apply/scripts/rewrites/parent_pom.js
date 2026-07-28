// rewrites/parent_pom.js — port of dwl::parentPomRewrite.
// Pin the connector versions MANAGED by a shared parent/BOM pom to the Java-17 matrix,
// preserving every other byte. Only connectors the parent already MANAGES are touched (via a
// <properties> value referenced by dependencyManagement, or a literal inline <version>).
// When at least one connector is pinned, the parent/BOM's OWN <version> is minor-bumped.
// A ${ref} inline version is driven by its property, so it is handled by the property path.

import { lt, bumpMinor } from "../../../../lib_shared/semver.js";
import { rewritePomVersion, INTERPOSED_LEAF_NODES } from "./pom_version.js";

/** Remove the first <parent>…</parent> block so the pom's OWN coords can be isolated. */
function stripParentBlock(pomText) {
  return pomText.replace(/<parent>[\s\S]*?<\/parent>/, "");
}

// The pom's OWN <artifactId> followed by its <version>, tolerating interposed <name>/<packaging>/
// comments (e.g. an Exchange BOM puts <name> between them). Must stay in lock-step with
// rewritePomVersion so what we DETECT is exactly what we can REWRITE.
const OWN_COORDS_RE = new RegExp(
  String.raw`<artifactId>\s*([^<]*?)\s*<\/artifactId>\s*${INTERPOSED_LEAF_NODES}<version>\s*([^<]*?)\s*<\/version>`
);

/** The pom's OWN { artifactId, version } after the <parent> block is removed, else null. */
export function projectCoords(pomText) {
  const noParent = stripParentBlock(pomText);
  const m = noParent.match(OWN_COORDS_RE);
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
      edit = {
        kind: "pomProperty",
        mode: "prop",
        file: pomPath,
        property: prop,
        groupId: g,
        artifactId: a,
        from: pTrim,
        to: String(r.set),
        inner: pInner,
        change: true,
      };
    } else if (inline != null && inline !== "REF" && lt(inline, String(r.set))) {
      edit = {
        kind: "depVersion",
        mode: "inline",
        file: pomPath,
        property: prop,
        groupId: g,
        artifactId: a,
        from: inline,
        to: String(r.set),
        change: true,
      };
    }
    if (edit) {
      const key = `${g}:${a}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(edit);
      }
    }
  }
  return out;
}

/** Apply the edits: literal property replacements first, then inline version blocks. */
function applyParentEdits(pomText, edits) {
  let afterProps = pomText;
  for (const e of edits.filter((x) => x.mode === "prop")) {
    afterProps = afterProps
      .split(`<${e.property}>${e.inner}</${e.property}>`)
      .join(`<${e.property}>${String(e.to)}</${e.property}>`);
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

/** True when a version string is a Maven ${property} placeholder (driven elsewhere, never literal-bumped). */
export function isPlaceholder(v) {
  return /^\s*\$\{.+\}\s*$/.test(String(v ?? ""));
}

/** The literal <version> inside the FIRST <parent> block, or null (used to record a from-version). */
function currentParentVersion(pomText) {
  const m = pomText.match(/<parent>[\s\S]*?<\/parent>/);
  if (!m) return null;
  const vm = m[0].match(/<version>\s*([^<]*?)\s*<\/version>/);
  return vm ? vm[1].trim() : null;
}

/**
 * rewriteParentRefVersion — set the <version> INSIDE a pom's first <parent> block (its BOM/parent
 * reference), matched by groupId+artifactId. Byte-preserving except the parent version value. This
 * is how the chained flow points a parent-pom at a newly-bumped BOM (or an app at a new parent-pom)
 * without touching the project's own coordinates. No-op when the parent block does not match.
 * @param {string} pomText
 * @param {{groupId?:string, artifactId?:string}} ref
 * @param {string} newVersion
 * @returns {string}
 */
export function rewriteParentRefVersion(pomText, ref = {}, newVersion) {
  const wantG = ref.groupId != null ? String(ref.groupId).trim() : "";
  const wantA = ref.artifactId != null ? String(ref.artifactId).trim() : "";
  return pomText.replace(/<parent>[\s\S]*?<\/parent>/, (block) => {
    const g = (block.match(/<groupId>\s*([^<]*?)\s*<\/groupId>/) || [])[1] ?? "";
    const a = (block.match(/<artifactId>\s*([^<]*?)\s*<\/artifactId>/) || [])[1] ?? "";
    if (wantG !== "" && g.trim() !== wantG) return block;
    if (wantA !== "" && a.trim() !== wantA) return block;
    return block.replace(/(<version>)\s*[^<]*?\s*(<\/version>)/, `$1${String(newVersion)}$2`);
  });
}

/**
 * Rewrite a parent/BOM pom text. Pins managed connectors to the matrix and minor-bumps the pom's OWN
 * literal <version> when anything changed. The optional `chained` intent extends this for the
 * parent to BOM to app flow:
 *   · parentRef {groupId, artifactId, toVersion} — repoint this pom's <parent> at a new BOM/parent
 *     version (emits a `pomParentVersion` edit).
 *   · bumpOwnVersion — force the OWN-version minor bump even when NO connectors changed (e.g. the
 *     only reason to release is that the inherited BOM moved).
 * The own-version bump fires when connectors changed OR the parent ref changed OR bumpOwnVersion is
 * set (and the own version is a literal, not a ${placeholder}).
 * @param {string} pomText
 * @param {object} matrix
 * @param {string} [pomPath]
 * @param {{parentRef?:{groupId?:string,artifactId?:string,toVersion:string}, bumpOwnVersion?:boolean}} [chained]
 * @returns {{text:string, edits:Array}}
 */
export function rewriteParentPom(pomText, matrix, pomPath = "pom.xml", chained = {}) {
  const { parentRef = null, bumpOwnVersion = false } = chained;

  const edits = computeParentEdits(pomText, matrix, pomPath);
  let text = applyParentEdits(pomText, edits);
  const connEdits = edits.map((e) => ({
    kind: e.kind,
    file: e.file,
    property: e.property,
    groupId: e.groupId,
    artifactId: e.artifactId,
    from: e.from,
    to: e.to,
    change: true,
  }));

  // Chained: repoint the <parent> reference at the newly-bumped BOM/parent version.
  const parentRefEdits = [];
  if (parentRef && parentRef.toVersion != null && String(parentRef.toVersion) !== "") {
    const from = currentParentVersion(text);
    const before = text;
    text = rewriteParentRefVersion(
      text,
      { groupId: parentRef.groupId, artifactId: parentRef.artifactId },
      String(parentRef.toVersion)
    );
    if (text !== before) {
      parentRefEdits.push({
        kind: "pomParentVersion",
        file: pomPath,
        groupId: parentRef.groupId ?? null,
        artifactId: parentRef.artifactId ?? null,
        from,
        to: String(parentRef.toVersion),
        change: true,
      });
    }
  }

  const coords = projectCoords(pomText);
  const somethingChanged = edits.length > 0 || parentRefEdits.length > 0 || bumpOwnVersion;
  const doBump =
    somethingChanged && coords != null && (coords.version ?? "") !== "" && !isPlaceholder(coords.version);
  const newVer = doBump ? bumpMinor(String(coords.version)) : null;
  if (doBump) text = rewritePomVersion(text, String(coords.artifactId), String(newVer));
  const versionEdit = doBump
    ? [
        {
          kind: "pomVersion",
          file: pomPath,
          artifactId: String(coords.artifactId),
          from: String(coords.version),
          to: String(newVer),
          change: true,
        },
      ]
    : [];

  return { text, edits: [...connEdits, ...parentRefEdits, ...versionEdit] };
}
