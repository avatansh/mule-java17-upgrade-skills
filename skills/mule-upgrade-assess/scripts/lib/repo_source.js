// lib/repo_source.js — repo source abstraction (EPIC A).
//
// The assess pipeline reads a repository two ways:
//   1. a LOCAL clone on disk (fs walk + fs.readFileSync)
//   2. a GITHUB repo over the REST API with NO local clone (git-trees + contents API)
//
// Both are exposed behind one interface so assess.js is source-agnostic:
//   await source.listTree()        → { tree:[{path,type:"blob"|"tree"}], truncated:boolean }
//   await source.prime(paths)      → warm an internal cache for those repo-relative paths
//   source.readSync(relPath)       → string | null   (SYNCHRONOUS UTF-8 read, null if missing)
//   source.label                   → human-readable origin (for logs/summaries)
//
// Why prime + readSync (not a single async read): the assess engine (buildChain, scanFlags) and its
// unit tests read files SYNCHRONOUSLY via a `readFile:(rel)=>string|null` callback. Rather than
// thread `await` through the whole engine, the github source PRE-FETCHES the small set of files the
// engine will touch (every pom.xml + .java in the tree, plus the located mule-artifact/CI paths)
// concurrently into a cache, after which readSync serves them with zero I/O — identical semantics to
// the local fs reader. The local source needs no priming (fs is already synchronous).
//
// The tree shape is IDENTICAL for both sources (GitHub git-trees "blob"/"tree" types are the
// vocabulary the local walker already mirrors), so topology.analyzeTree + buildChain consume either.

import fs from "node:fs";
import path from "node:path";

// Directories never worth walking / listing in a local clone (mirror of assess.js IGNORE_DIRS).
const IGNORE_DIRS = new Set([".git", "node_modules", "target", ".idea", ".vscode"]);

/**
 * localSource(repoRoot) — read a repository from a local directory on disk.
 * @param {string} repoRoot path to the clone root
 */
export function localSource(repoRoot) {
  const root = repoRoot;
  return {
    kind: "local",
    label: `local:${path.resolve(root)}`,
    async listTree() {
      const out = [];
      const walk = (abs, rel) => {
        let entries;
        try {
          entries = fs.readdirSync(abs, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (e.isDirectory() && IGNORE_DIRS.has(e.name)) continue;
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          const childAbs = path.join(abs, e.name);
          if (e.isDirectory()) {
            out.push({ path: childRel, type: "tree" });
            walk(childAbs, childRel);
          } else if (e.isFile()) {
            out.push({ path: childRel, type: "blob" });
          }
        }
      };
      walk(root, "");
      return { tree: out, truncated: false };
    },
    // fs is synchronous — nothing to pre-fetch.
    async prime() {
      /* no-op */
    },
    readSync(rel) {
      if (!rel) return null;
      try {
        return fs.readFileSync(path.join(root, rel), "utf8");
      } catch {
        return null;
      }
    },
  };
}

/**
 * githubSource({owner, repo, ref, gh}) — read a repository over the GitHub REST API, no clone.
 * @param {object} o
 * @param {string} o.owner   repo owner/org
 * @param {string} o.repo    repo name
 * @param {string} [o.ref]   branch/tag/commit sha (default branch resolved lazily if omitted)
 * @param {import("../../../mule-upgrade-pr/scripts/lib/gh_api.js").GitHubApi} o.gh GitHubApi instance
 */
export function githubSource({ owner, repo, ref = null, gh }) {
  if (!owner || !repo) throw new Error("githubSource requires owner and repo");
  if (!gh) throw new Error("githubSource requires a GitHubApi instance (gh)");

  let resolvedRef = ref; // filled in on first use if not supplied
  const cache = new Map(); // rel -> string|null (populated by prime(); served by readSync())

  async function ensureRef() {
    if (resolvedRef) return resolvedRef;
    const info = await gh.getRepo(owner, repo);
    resolvedRef = info?.default_branch || "main";
    return resolvedRef;
  }

  // Fetch a single file's UTF-8 contents (null on 404 / non-text). Throws on non-404 errors so a
  // transient/auth failure is not silently swallowed into a spurious NO_CHANGE.
  async function fetchOne(rel) {
    const r = await ensureRef();
    try {
      const rec = await gh.getContents(owner, repo, rel, r);
      if (rec && rec.encoding === "base64" && typeof rec.content === "string") {
        return Buffer.from(rec.content, "base64").toString("utf8");
      }
      if (rec && typeof rec.content === "string") return rec.content;
      return null;
    } catch (e) {
      if (e?.status && e.status !== 404) throw e;
      return null;
    }
  }

  return {
    kind: "github",
    get label() {
      return `github:${owner}/${repo}@${resolvedRef ?? ref ?? "(default)"}`;
    },
    async listTree() {
      const r = await ensureRef();
      const record = await gh.getTree(owner, repo, r, { recursive: true });
      const tree = (record?.tree ?? [])
        // git-trees returns blob | tree | commit (submodule). Keep only blob/tree; the assess
        // engine only cares about files (blob) and directories (tree).
        .filter((e) => e.type === "blob" || e.type === "tree")
        .map((e) => ({ path: e.path, type: e.type }));
      return { tree, truncated: !!record?.truncated };
    },
    // Concurrently fetch each path into the cache. De-dupes and skips already-cached paths so it is
    // safe to call more than once (e.g. after locating mule-artifact.json / the CI workflow).
    async prime(paths = []) {
      const todo = [...new Set(paths.filter(Boolean))].filter((p) => !cache.has(p));
      await Promise.all(
        todo.map(async (rel) => {
          cache.set(rel, await fetchOne(rel));
        })
      );
    },
    readSync(rel) {
      if (!rel) return null;
      return cache.has(rel) ? cache.get(rel) : null;
    },
  };
}
