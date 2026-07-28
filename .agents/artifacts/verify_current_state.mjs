// verify_current_state.mjs — READ-ONLY: confirm CURRENT runtime behavior of Exchange + release-notes.
import { ExchangeClient, configFor } from "../../lib_shared/exchange.js";
import { AnypointClient } from "../../skills/mule-upgrade/scripts/lib/anypoint.js";
import { connectorReleaseNotesUrl } from "../../skills/mule-upgrade-assess/scripts/lib/resolve_versions.js";

console.log("=== A) Exchange matrix fetch (live) ===");
const ex = new ExchangeClient({ anypoint: new AnypointClient() });
console.log("mavenBaseUrl:", ex.mavenBaseUrl);
console.log("configFor(matrix):", JSON.stringify(configFor("matrix")));
const r = await ex.fetchAsset("matrix");
console.log("fetchAsset(matrix) →", JSON.stringify({ ok: r.ok, reason: r.reason, version: r.version, connectors: r.data?.connectors?.length }));

console.log("\n=== B) listVersions for salesforce (live) ===");
const lv = await ex.listVersions("com.mulesoft.connectors", "mule-salesforce-connector");
console.log("listVersions →", JSON.stringify({ ok: lv.ok, reason: lv.reason, count: lv.versions?.length }));

console.log("\n=== C) current slug URLs vs reality ===");
for (const a of ["mule-http-connector","mule-salesforce-connector","mule-db-connector","mule4-slack-connector"]) {
  console.log(`  ${a} → ${connectorReleaseNotesUrl(a)}`);
}
console.log("\n=== DONE ===");
