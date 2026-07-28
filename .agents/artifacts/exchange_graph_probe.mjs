// exchange_graph_probe.mjs — READ-ONLY probe of the Anypoint Exchange Graph API.
// Reuses the suite's AnypointClient for auth (client_credentials). Prints NO secrets:
// only token length, HTTP statuses, content-types, and (redacted) response shapes.
//
// Goal: settle empirically whether ONE Exchange Graph query can carry, per connector:
//   - published versions
//   - dependencies / GAV / categories
//   - minMuleVersion (runtime floor)
//   - ANY Java-version (OpenJDK 8/11/17) compatibility field
//
// Usage: node .agents/artifacts/exchange_graph_probe.mjs
import { AnypointClient } from "../../skills/mule-upgrade/scripts/lib/anypoint.js";

const client = new AnypointClient();
console.log("configured():", client.configured());
console.log("baseUrl:", client.baseUrl);
if (!client.configured()) {
  console.log("NOT CONFIGURED — cannot probe. (Need ANYPOINT_* env or decrypted config.)");
  process.exit(0);
}

let token;
try {
  token = await client._getToken();
  console.log("token length:", (token || "").length, token ? "(obtained)" : "(EMPTY)");
} catch (e) {
  console.log("token error:", e?.message ?? String(e));
  process.exit(0);
}
if (!token) process.exit(0);

const HOSTS = [
  "https://anypoint.mulesoft.com",
  "https://maven.anypoint.mulesoft.com",
];
// Candidate Graph endpoints seen across Exchange API versions.
const GRAPH_PATHS = ["/graph/api/v1/graphql", "/graph/api/v2/graphql"];

async function post(url, body) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const ct = res.headers.get("content-type") || "";
    const text = await res.text();
    return { status: res.status, ct, text };
  } catch (e) {
    return { status: 0, ct: "", text: `FETCH ERROR: ${e?.message ?? e}` };
  }
}

function preview(text, n = 600) {
  return String(text).replace(/\s+/g, " ").slice(0, n);
}

// 1) Find a Graph endpoint that responds with JSON (not the SPA HTML shell).
console.log("\n=== STEP 1: locate a working Graph endpoint ===");
let graphUrl = null;
const introspectTypes = {
  query: `query { __schema { queryType { name } } }`,
};
for (const host of HOSTS) {
  for (const p of GRAPH_PATHS) {
    const url = `${host}${p}`;
    const r = await post(url, introspectTypes);
    const isJson = r.ct.includes("json");
    console.log(`  ${url} → ${r.status} ${r.ct.split(";")[0]} ${isJson ? "[JSON]" : "[not json]"}`);
    if (isJson && r.status < 400 && !graphUrl) {
      graphUrl = url;
      console.log("    body:", preview(r.text, 300));
    }
  }
}
if (!graphUrl) {
  console.log("\nNo Graph endpoint returned JSON. Cannot introspect. Stopping.");
  process.exit(0);
}
console.log("USING GRAPH URL:", graphUrl);

// 2) Introspect the Asset type: list its fields so we can see if Java/runtime compat is modeled.
console.log("\n=== STEP 2: introspect candidate types for compatibility fields ===");
const typeNames = ["Asset", "AssetVersion", "Version", "AssetVersioned", "Dependency"];
for (const tn of typeNames) {
  const r = await post(graphUrl, {
    query: `query($n:String!){ __type(name:$n){ name kind fields{ name type{ name kind ofType{ name } } } } }`,
    variables: { n: tn },
  });
  if (!r.ct.includes("json")) {
    console.log(`  ${tn}: non-json (${r.status})`);
    continue;
  }
  let j;
  try {
    j = JSON.parse(r.text);
  } catch {
    console.log(`  ${tn}: parse fail — ${preview(r.text, 200)}`);
    continue;
  }
  const t = j?.data?.__type;
  if (!t) {
    console.log(`  ${tn}: type not present. errors=${preview(JSON.stringify(j.errors ?? {}), 200)}`);
    continue;
  }
  const fields = (t.fields || []).map((f) => f.name);
  console.log(`  ${tn} (${t.kind}) fields [${fields.length}]:`, fields.join(", "));
  // Flag anything that smells like java/jdk/runtime/mule-version compatibility.
  const compat = fields.filter((f) => /java|jdk|runtime|mule|compat|minmule/i.test(f));
  if (compat.length) console.log(`    >>> compatibility-relevant fields:`, compat.join(", "));
}

// 3) Real asset query: fetch the Salesforce (premium) + HTTP (OSS) connectors and dump what comes back.
console.log("\n=== STEP 3: real asset query (Salesforce + HTTP connectors) ===");
const assetQuery = {
  query: `query {
    assets(query: { searchTerm: "salesforce connector", offset: 0, limit: 3 }) {
      groupId assetId version name type
      minMuleVersion
      versions
      dependencies { groupId assetId version }
      categories { key value }
    }
  }`,
};
const r3 = await post(graphUrl, assetQuery);
console.log(`  status ${r3.status} ${r3.ct.split(";")[0]}`);
console.log("  body:", preview(r3.text, 1500));

console.log("\n=== DONE ===");
