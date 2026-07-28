// verify_b12_b13.mjs — live end-to-end check of the SHIPPED ExchangeClient.fetchPom + graphDependencies
// (B12/B13) against real Exchange. Uses the real config-backed AnypointClient. Read-only.
import { AnypointClient } from "../../skills/mule-upgrade/scripts/lib/anypoint.js";
import { ExchangeClient } from "../../lib_shared/exchange.js";

const ex = new ExchangeClient({ anypoint: new AnypointClient() });
console.log("configured:", ex.configured());

// B13 — one-level deps at an exact version (salesforce 10.19.2).
const deps = await ex.graphDependencies("com.mulesoft.connectors", "mule-salesforce-connector", "10.19.2");
console.log("\n[B13] graphDependencies(salesforce@10.19.2):", deps.ok ? "OK" : `FAIL ${deps.reason}`);
if (deps.ok) console.log("  version:", deps.version, " edges:", deps.dependencies.map((d) => `${d.assetId}@${d.version}`).join(", "));

// B12 — POM fetch + version-management classification (salesforce 10.19.2).
const pom = await ex.fetchPom("com.mulesoft.connectors", "mule-salesforce-connector", "10.19.2");
console.log("\n[B12] fetchPom(salesforce@10.19.2):", pom.ok ? "OK" : `FAIL ${pom.reason}`);
if (pom.ok) {
  const lit = pom.dependencies.filter((d) => d.version).length;
  const ref = pom.dependencies.filter((d) => d.versionRef).length;
  const mgd = pom.dependencies.filter((d) => d.managed).length;
  console.log(`  deps: ${pom.dependencies.length}  literal:${lit} \${prop}:${ref} BOM:${mgd}  props:${Object.keys(pom.properties).length}`);
  const sample = pom.dependencies.filter((d) => d.versionRef).slice(0, 3).map((d) => `${d.artifactId}=\${${d.versionRef}}`);
  if (sample.length) console.log("  sample prop-versioned:", sample.join(", "));
}

console.log("\n=== DONE ===");
