// verify_listversions.mjs — READ-ONLY. Uses only global fetch (no shell, no child process).
import { AnypointClient } from "../../skills/mule-upgrade/scripts/lib/anypoint.js";
import { ExchangeClient } from "../../lib_shared/exchange.js";
const anypoint = new AnypointClient();
const ex = new ExchangeClient({ anypoint });
for (const [g, a, expect] of [
  ["org.mule.connectors", "mule-http-connector", "1.11.3"],
  ["com.mulesoft.connectors", "mule-salesforce-connector", ">=10.19.2"],
  ["org.mule.connectors", "mule-db-connector", ">=1.14.6"],
]) {
  const r = await ex.listVersions(g, a);
  console.log(`${a}: ok=${r.ok} count=${r.ok ? r.versions.length : "-"} latest=${r.latest ?? r.reason} (expect ${expect})`);
}
console.log("=== DONE ===");
