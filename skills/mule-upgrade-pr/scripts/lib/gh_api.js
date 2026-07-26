// lib/gh_api.js — a thin GitHub REST client for the Git Data API path (api mode).
// Mirrors the exact endpoint sequence pf-atomic-commit / pf-open-pr / pf-rollback use:
//   GET  /repos/{o}/{r}/commits/{ref}            → current HEAD sha (stale-plan check)
//   GET  /repos/{o}/{r}/git/matching-refs/heads/{base}
//   POST /repos/{o}/{r}/git/refs                 → create branch
//   POST /repos/{o}/{r}/git/blobs                → one per file
//   POST /repos/{o}/{r}/git/trees                → base_tree=headSha
//   POST /repos/{o}/{r}/git/commits              → parents=[headSha]
//   PATCH /repos/{o}/{r}/git/refs/heads/{branch} → move ref to commit
//   POST /repos/{o}/{r}/pulls                    → open PR
//
// Uses global fetch (Node ≥18). Auth via GITHUB_TOKEN. `fetchImpl` is injectable for tests.

const API = "https://api.github.com";

export class GitHubApi {
  constructor({ token = process.env.GITHUB_TOKEN, fetchImpl = globalThis.fetch, baseUrl = API } = {}) {
    if (!token) throw new Error("GITHUB_TOKEN is required for api mode");
    this.token = token;
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl;
  }

  async request(method, path, body) {
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "mule-java17-upgrade-skills",
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(`GitHub ${method} ${path} → ${res.status}: ${json?.message ?? text}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  headSha(owner, repo, ref) {
    return this.request("GET", `/repos/${owner}/${repo}/commits/${ref}`).then((c) => c.sha);
  }
  matchingRefs(owner, repo, base) {
    return this.request("GET", `/repos/${owner}/${repo}/git/matching-refs/heads/${base}`).then((refs) =>
      (refs ?? []).map((r) => r.ref)
    );
  }
  createRef(owner, repo, branch, sha) {
    return this.request("POST", `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }
  createBlob(owner, repo, content) {
    return this.request("POST", `/repos/${owner}/${repo}/git/blobs`, { content, encoding: "utf-8" }).then(
      (b) => b.sha
    );
  }
  createTree(owner, repo, baseTree, entries) {
    return this.request("POST", `/repos/${owner}/${repo}/git/trees`, {
      base_tree: baseTree,
      tree: entries.map((e) => ({ path: e.path, mode: "100644", type: "blob", sha: e.blobSha })),
    }).then((t) => t.sha);
  }
  createCommit(owner, repo, message, treeSha, parents) {
    return this.request("POST", `/repos/${owner}/${repo}/git/commits`, {
      message,
      tree: treeSha,
      parents,
    }).then((c) => c.sha);
  }
  updateRef(owner, repo, branch, sha, force = false) {
    return this.request("PATCH", `/repos/${owner}/${repo}/git/refs/heads/${branch}`, { sha, force });
  }
  openPr(owner, repo, { title, head, base, body, draft = false }) {
    return this.request("POST", `/repos/${owner}/${repo}/pulls`, {
      title,
      head,
      base,
      body,
      maintainer_can_modify: true,
      draft,
    });
  }
  getCommit(owner, repo, sha) {
    return this.request("GET", `/repos/${owner}/${repo}/git/commits/${sha}`);
  }
  getCommitFull(owner, repo, ref) {
    return this.request("GET", `/repos/${owner}/${repo}/commits/${ref}`);
  }
  getRepo(owner, repo) {
    return this.request("GET", `/repos/${owner}/${repo}`);
  }
  // Contents API — used by parent-pom to read a pom at {path}@{ref}. Returns the raw record
  // ({content, encoding, ...}); callers base64-decode. `ref` selects branch/tag/sha.
  getContents(owner, repo, path, ref) {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    return this.request("GET", `/repos/${owner}/${repo}/contents/${path}${q}`);
  }
}
