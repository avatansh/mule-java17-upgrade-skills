// lib/pom_chain.js — port of dwl::pomChain.
// Walks a Maven pom inheritance chain (app → parent → grandparent/BOM). Every function is
// pure: raw text, paths, and the tree path list are passed in explicitly.
//
// The chain entries keep BOTH the parsed object AND the raw text (`pomText`), mirroring the
// Mule app's rehydrate concern: repeated <dependency>/<plugin> keys must survive, so consumers
// re-parse from pomText rather than trust a possibly-collapsed object.

import { parsePom, asArray } from "./pom_parse.js";

/** Drop the last path segment (parent directory step). */
function removeLastSeg(arr) {
  return arr.length <= 1 ? [] : arr.slice(0, arr.length - 1);
}

/**
 * Resolve a relative parent path against the directory of the current pom, collapsing
 * "." and ".." segments. normalizePath("a/b/pom.xml", "../pom.xml") -> "a/pom.xml".
 */
export function normalizePath(currentPomPath, relPath) {
  const dir = currentPomPath.includes("/") ? currentPomPath.slice(0, currentPomPath.lastIndexOf("/")) : "";
  const combined = dir === "" ? relPath : dir + "/" + relPath;
  const parts = combined.split("/").filter((p) => p !== "" && p !== ".");
  const acc = [];
  for (const seg of parts) {
    if (seg === ".." && acc.length > 0) {
      acc.length = removeLastSeg(acc).length; // pop one
    } else {
      acc.push(seg);
    }
  }
  return acc.join("/");
}

/** Base64-decode GitHub Contents-API file content to a UTF-8 string. */
export function decodePom(base64Content) {
  const clean = String(base64Content ?? "").replace(/[\r\n\t ]/g, "");
  return Buffer.from(clean, "base64").toString("utf8");
}

/**
 * Read a Maven <properties> value by NAME. Returns the string value or null.
 * @param {object} pom parsed pom ({ project: {...} })
 * @param {string} prop property name
 */
export function propOf(pom, prop) {
  const props = pom?.project?.properties;
  if (!props || typeof props !== "object") return null;
  const v = props[prop];
  if (v === undefined || v === null) return null;
  // A leaf property is a string; an object here would be malformed — coerce defensively.
  return typeof v === "object" ? null : String(v);
}

/**
 * Resolve the next parent pom path IN THIS REPO. Honours Maven's default (<parent> with no
 * <relativePath> ⇒ ../pom.xml) and directory-form relativePath (append /pom.xml). Returns null
 * when there is no parent or the parent lives outside the repo tree.
 */
export function nextParentPath(parsedPom, currentPomPath, treePaths) {
  const parentEl = parsedPom?.project?.parent;
  if (parentEl == null || parentEl === "") return null;
  const rawRel =
    parentEl.relativePath === undefined || parentEl.relativePath === null
      ? null
      : String(parentEl.relativePath);
  const relForResolve = rawRel === null || rawRel === "" ? "../pom.xml" : rawRel;
  const resolved = normalizePath(currentPomPath, relForResolve);
  const resolvedFile = /.*pom\.xml$/.test(resolved) ? resolved : resolved + "/pom.xml";
  return treePaths.includes(resolvedFile) ? resolvedFile : null;
}

/**
 * Initialise the chain from the app pom.
 * @param {string} rawContent app pom.xml text (already decoded)
 * @param {string} appPomPath the app pom path
 * @param {string[]} treePaths every path in the repo tree
 * @returns {{appPomText:any, chain:Array<{path:any,pom:any,pomText:any}>, nextParentPath:any}}
 */
export function initChain(rawContent, appPomPath, treePaths) {
  const parsedPom = parsePom(rawContent);
  return {
    appPomText: rawContent,
    chain: [{ path: appPomPath, pom: parsedPom, pomText: rawContent }],
    nextParentPath: nextParentPath(parsedPom, appPomPath, treePaths),
  };
}

/**
 * Append the next parent pom to an existing chain.
 * @param {string} rawContent
 * @param {string} parentPath
 * @param {Array<{path:any,pom:any,pomText:any}>} chain
 * @param {string[]} treePaths
 * @returns {{appPomText?:any, chain:Array<{path:any,pom:any,pomText:any}>, nextParentPath:any}}
 */
export function appendParent(rawContent, parentPath, chain, treePaths) {
  const parsedPom = parsePom(rawContent);
  return {
    chain: [...chain, { path: parentPath, pom: parsedPom, pomText: rawContent }],
    nextParentPath: nextParentPath(parsedPom, parentPath, treePaths),
  };
}

// ── shared pom accessors (repeated-key-safe via asArray) ────────────────────────────────

/** All <dependency> entries under <dependencies>. */
export function dependenciesOf(pom) {
  return asArray(pom?.project?.dependencies?.dependency);
}
/** All <dependency> entries under <dependencyManagement><dependencies>. */
export function managedDependenciesOf(pom) {
  return asArray(pom?.project?.dependencyManagement?.dependencies?.dependency);
}
/** All <plugin> entries under <build><plugins>. */
export function pluginsOf(pom) {
  return asArray(pom?.project?.build?.plugins?.plugin);
}
/** All <plugin> entries under <build><pluginManagement><plugins>. */
export function managedPluginsOf(pom) {
  return asArray(pom?.project?.build?.pluginManagement?.plugins?.plugin);
}
