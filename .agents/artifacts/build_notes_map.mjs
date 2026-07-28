// build_notes_map.mjs — G2 generator. READ-ONLY against network. Uses only global fetch (no shell,
// no child process). Produces connector-notes-map.raw.json: for every connector on the docs
// release-notes index, resolve its POM artifactId by generating candidate artifactIds from the
// slug + display name and EXACT-verifying each against Exchange Graph (connector groups only).
//
// Why this shape: release-notes pages carry NO Maven coordinates, and a display-name Graph search is
// relevance-ranked toward deprecated Mule-3 modules — so a fuzzy top-hit is wrong. But Graph reliably
// EXACT-matches a known assetId. So we turn "guess the artifactId" into "verify candidates", which is
// deterministic. Runs candidate batches concurrently with a small pool; writes incrementally.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AnypointClient } from "../../skills/mule-upgrade/scripts/lib/anypoint.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "connector-notes-map.raw.json");
const INDEX = "https://docs.mulesoft.com/release-notes/connector/anypoint-connector-release-notes";
const NOTES_BASE = "https://docs.mulesoft.com/release-notes/connector";
const GRAPH = "https://anypoint.mulesoft.com/graph/api/v1/graphql";
const CONN = new Set(["org.mule.connectors", "com.mulesoft.connectors", "org.mule.modules", "com.mulesoft.modules"]);

const token = await new AnypointClient()._getToken();
console.log(`token len=${token.length}`);
async function gql(q) {
  const r = await fetch(GRAPH, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ query: q }) });
  try { return JSON.parse(await r.text()); } catch { return {}; }
}
async function httpGet(url) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 25000);
  try { const r = await fetch(url, { signal: c.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 probe", Accept: "text/html" } }); return { status: r.status, html: await r.text() }; }
  catch { return { status: 0, html: "" }; } finally { clearTimeout(t); }
}
const vnum = (v) => String(v).split(".").map((n) => Number(n) || 0).reduce((s, n, i) => s + n * [1e6, 1e3, 1][i], 0);

// 1) index (slug, displayName) pairs
const idx = await httpGet(INDEX);
const pairs = [...idx.html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
  .map((m) => ({ slug: m[1].replace(/[#?].*$/, ""), name: m[2].replace(/<[^>]+>/g, "").trim() }))
  .filter((a) => /release-notes/.test(a.slug) && a.name && !/anypoint-connector-release-notes/.test(a.slug));
const seen = new Set();
const conns = pairs.filter((p) => (seen.has(p.slug) ? false : (seen.add(p.slug), true)));
console.log(`index connectors: ${conns.length}`);

// 2) candidate artifactIds from slug + display name
function candidates(slug, name) {
  const base = slug.replace(/-release-notes(-mule-4)?$/, "").replace(/^connector-/, "");
  const nm = name.toLowerCase().replace(/\s+connector.*$/, "").replace(/\s+module.*$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const stems = new Set([base, base.replace(/-connector$|-module$/, ""), nm]);
  const out = new Set();
  for (const s of stems) {
    if (!s) continue;
    for (const c of [`mule-${s}-connector`, `mule-${s}-module`, `mule4-${s}-connector`, `mule-${s}`, s, `${s}-connector`, `${s}-module`]) out.add(c);
  }
  return [...out];
}

// 3) verify a batch of candidates in ONE aliased Graph query; return exact connector-group matches.
async function verifyMany(cands) {
  if (!cands.length) return [];
  const q = `query {${cands.map((c, i) => `a${i}: assets(query:{searchTerm:${JSON.stringify(c)},limit:20}){groupId assetId version}`).join("\n")}}`;
  const j = await gql(q); const data = j?.data ?? {};
  const hits = [];
  cands.forEach((c, i) => {
    const rows = data[`a${i}`] || [];
    const matches = rows.filter((r) => r.assetId === c && CONN.has(r.groupId));
    if (matches.length) {
      const latest = matches.map((m) => m.version).sort((a, b) => vnum(a) - vnum(b)).pop();
      hits.push({ artifactId: c, groupId: matches[0].groupId, latest });
    }
  });
  return hits;
}

async function resolveOne(p) {
  const cands = candidates(p.slug, p.name);
  for (let k = 0; k < cands.length; k += 12) {
    const hits = await verifyMany(cands.slice(k, k + 12));
    if (hits.length) return { ...p, url: `${NOTES_BASE}/${p.slug}`, ...hits[0], candidatesTried: cands.length };
  }
  return { ...p, url: `${NOTES_BASE}/${p.slug}`, artifactId: null, groupId: null, candidatesTried: cands.length };
}

// concurrency pool
async function pool(items, size, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

let done = 0;
const results = await pool(conns, 6, async (p) => {
  const r = await resolveOne(p);
  done++;
  if (done % 10 === 0) console.log(`  ${done}/${conns.length} …`);
  return r;
});

const resolved = results.filter((r) => r.artifactId);
const unresolved = results.filter((r) => !r.artifactId);
fs.writeFileSync(OUT, JSON.stringify({ total: results.length, resolved: resolved.length, unresolved: unresolved.length, results }, null, 2));
console.log(`\nRESOLVED ${resolved.length}/${results.length}; UNRESOLVED ${unresolved.length}`);
console.log("unresolved:", JSON.stringify(unresolved.map((u) => u.slug)));
console.log(`wrote ${OUT}`);
console.log("=== DONE ===");
