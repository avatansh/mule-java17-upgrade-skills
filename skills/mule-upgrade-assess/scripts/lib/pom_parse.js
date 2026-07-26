// lib/pom_parse.js — a tiny, dependency-free XML→object parser tuned for Maven poms.
//
// Why hand-rolled: the assessment logic needs REPEATED elements (<dependency>, <plugin>,
// <property>) preserved as arrays — the Mule app fought the same "duplicate keys collapse"
// problem (see the rehydrate note in dwl::assessment). A generic Map-based parse would drop
// repeats. This parser keeps repeated sibling tags as arrays and is good enough for the shapes
// the matrix engine inspects (properties, dependencies, dependencyManagement, build/plugins,
// parent, project coordinates). It is NOT a general XML parser (ignores namespaces on values,
// CDATA, processing instructions) — poms don't need those for our reads.

/** Strip XML comments so they never interfere with element scanning. */
function stripComments(xml) {
  return xml.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Parse an XML string into a plain object. Repeated child elements become arrays.
 * Text-only elements become strings. Attributes are ignored. Returns { project: {...} }.
 */
export function parsePom(xmlText) {
  const xml = stripComments(String(xmlText ?? ""));
  const m = xml.match(/<project\b[^>]*>([\s\S]*)<\/project>/);
  const body = m ? m[1] : xml;
  return { project: parseChildren(body) };
}

/** Parse the children of an element body into an object. Repeated tags → arrays. */
function parseChildren(body) {
  const obj = {};
  let i = 0;
  const len = body.length;
  while (i < len) {
    const lt = body.indexOf("<", i);
    if (lt === -1) break;
    if (body[lt + 1] === "/" || body[lt + 1] === "?" || body[lt + 1] === "!") {
      const close = body.indexOf(">", lt);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    const gt = body.indexOf(">", lt);
    if (gt === -1) break;
    const rawTag = body.slice(lt + 1, gt);
    const selfClosing = rawTag.endsWith("/");
    const tagName = rawTag.replace(/\/$/, "").trim().split(/\s+/)[0];
    if (selfClosing) {
      addChild(obj, tagName, "");
      i = gt + 1;
      continue;
    }
    const closeIdx = findMatchingClose(body, gt + 1, tagName);
    if (closeIdx === -1) {
      i = gt + 1;
      continue;
    }
    const inner = body.slice(gt + 1, closeIdx);
    const value = inner.includes("<") ? parseChildren(inner) : decodeEntities(inner.trim());
    addChild(obj, tagName, value);
    i = closeIdx + `</${tagName}>`.length;
  }
  return obj;
}

/** Find index of the matching </tag>, handling nested <tag>…</tag> of the same name. */
function findMatchingClose(body, from, tag) {
  const open = new RegExp(`<${escapeRe(tag)}(\\s[^>]*)?>`, "g");
  const close = `</${tag}>`;
  let depth = 1;
  let pos = from;
  while (pos < body.length) {
    const nextClose = body.indexOf(close, pos);
    if (nextClose === -1) return -1;
    open.lastIndex = pos;
    const om = open.exec(body);
    const nextOpen = om ? om.index : -1;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      const tagEnd = body.indexOf(">", nextOpen);
      const isSelf = body.slice(nextOpen, tagEnd).endsWith("/");
      pos = tagEnd + 1;
      if (!isSelf) depth++;
    } else {
      depth--;
      if (depth === 0) return nextClose;
      pos = nextClose + close.length;
    }
  }
  return -1;
}

function addChild(obj, key, value) {
  if (obj[key] === undefined) obj[key] = value;
  else if (Array.isArray(obj[key])) obj[key].push(value);
  else obj[key] = [obj[key], value];
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Coerce a possibly-single / possibly-array node into an array. */
export function asArray(node) {
  if (node === undefined || node === null) return [];
  return Array.isArray(node) ? node : [node];
}
