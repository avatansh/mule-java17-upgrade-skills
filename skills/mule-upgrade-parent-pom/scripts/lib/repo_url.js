// lib/repo_url.js — port of the "DW Resolve owner/repo" transform in parent-pom-upgrade.xml.
//
// ALWAYS parse repoUrl (when present) for owner/repo/branch/pomPath, THEN let an explicit
// owner/repo override only owner/repo. This deliberately mirrors the Mule fix: the caller often
// passes BOTH a /tree/<branch>/<dir> repoUrl AND its own owner+repo; a short-circuit that ignored
// the URL when owner+repo were present would discard the URL's branch + sub-path and read the root
// pom.xml on the default branch (spurious NO_CHANGE). Parsing the URL unconditionally keeps the
// branch + pomPath intact regardless of which fields the caller sends.

/**
 * resolveRepoCoords({repoUrl, owner, repo}) → {owner, repo, urlBranch, urlPomPath}
 * Any field may be null. urlBranch/urlPomPath are only populated from a /tree|blob/ URL.
 */
export function resolveRepoCoords({ repoUrl = null, owner = null, repo = null } = {}) {
  // Normalise: drop .git suffix, query/fragment, trailing slashes, then the scheme.
  const clean = String(repoUrl ?? "")
    .replace(/\.git\/?$/, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
  const noProto = clean.replace(/^[A-Za-z]+:\/\//, "");
  const segs0 = noProto === "" ? [] : noProto.split("/").filter((s) => s !== "");
  // If the first segment looks like a host (contains a dot, e.g. github.com), drop it.
  const segs = (segs0[0] ?? "").includes(".") ? segs0.slice(1) : segs0;
  const urlOwner = segs[0] ?? null;
  const urlRepo = segs[1] ?? null;
  // A GitHub web URL may embed branch + sub-path: /<owner>/<repo>/tree|blob/<branch>/<sub-path...>
  const marker = segs[2] ?? "";
  const isTree = marker === "tree" || marker === "blob";
  const urlBranch = isTree ? (segs[3] ?? null) : null;
  const rest = isTree ? segs.slice(4) : [];
  const restStr = rest.join("/");
  const lastSeg = rest[rest.length - 1] ?? "";
  // A trailing file (has a dot) is the pom path itself; a directory implies <dir>/pom.xml.
  const urlPomPath = restStr === "" ? null : lastSeg.includes(".") ? restStr : `${restStr}/pom.xml`;

  const outOwner = owner != null && String(owner) !== "" ? String(owner) : urlOwner;
  const outRepo = repo != null && String(repo) !== "" ? String(repo) : urlRepo;
  return { owner: outOwner, repo: outRepo, urlBranch, urlPomPath };
}

/**
 * resolvePomPath(pomPath, coords) — explicit pomPath wins, else the URL-embedded sub-path,
 * else "pom.xml". (Mirrors the separate "PV SET pomPath (after repoCoords)" step, which had to
 * run after repoCoords committed so the URL sub-path could actually win over the default.)
 */
export function resolvePomPath(pomPath, coords) {
  if (pomPath != null && String(pomPath) !== "") return String(pomPath);
  return String(coords.urlPomPath ?? "pom.xml");
}
