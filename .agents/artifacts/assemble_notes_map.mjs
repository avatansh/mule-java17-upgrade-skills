// assemble_notes_map.mjs — merge hand-verified matrix-connector slugs with the auto-resolved catalog
// into the shipped connector-notes-map.yaml. Pure file IO (reads raw JSON + writes YAML); no network.
// Hand-curated entries are AUTHORITATIVE and win on artifactId collision.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.join(__dirname, "connector-notes-map.raw.json");
const OUT = path.resolve(__dirname, "..", "..", "skills", "mule-upgrade-assess", "references", "connector-notes-map.yaml");
const RN = "https://docs.mulesoft.com/release-notes";
const CBASE = `${RN}/connector`;

// The 15 matrix connectors — slugs hand-verified live (HTTP 200 + parseable compatibility table),
// EXCEPT apikit whose notes are split per-version with no single compat table (parse yields nothing
// → matrix-only fallback; still mapped so the URL is discoverable). groupId from P0 Graph resolution.
const CURATED = [
  { artifactId: "mule-http-connector", groupId: "org.mule.connectors", url: `${CBASE}/connector-http` },
  { artifactId: "mule-db-connector", groupId: "org.mule.connectors", url: `${CBASE}/connector-db` },
  { artifactId: "mule-sockets-connector", groupId: "org.mule.connectors", url: `${CBASE}/connector-sockets` },
  { artifactId: "mule-objectstore-connector", groupId: "org.mule.connectors", url: `${CBASE}/object-store-connector-release-notes-mule-4` },
  { artifactId: "mule-json-module", groupId: "org.mule.modules", url: `${CBASE}/json-module-release-notes` },
  { artifactId: "mule-oauth-module", groupId: "org.mule.modules", url: `${CBASE}/oauth-module-release-notes` },
  { artifactId: "mule-tracing-module", groupId: "org.mule.modules", url: `${CBASE}/tracing-module-release-notes` },
  { artifactId: "mule-validation-module", groupId: "org.mule.modules", url: `${RN}/mule-runtime/module-validation` },
  { artifactId: "mule-xml-module", groupId: "org.mule.modules", url: `${RN}/mule-runtime/module-xml` },
  { artifactId: "mule-secure-configuration-property-module", groupId: "com.mulesoft.modules", url: `${RN}/mule-runtime/secure-properties` },
  { artifactId: "mule-apikit-module", groupId: "org.mule.modules", url: `${RN}/apikit/apikit-release-notes`, note: "per-version notes; no single compatibility table (matrix-only fallback)" },
  { artifactId: "mule4-slack-connector", groupId: "com.mulesoft.connectors", url: `${CBASE}/slack-connector-release-notes-mule-4` },
  { artifactId: "mule4-gmail-connector", groupId: "com.mulesoft.connectors", url: `${CBASE}/gmail-connector-release-notes-mule-4` },
  { artifactId: "mule-twilio-connector", groupId: "com.mulesoft.connectors", url: `${CBASE}/twilio-connector-release-notes-mule-4` },
  { artifactId: "mule-salesforce-connector", groupId: "com.mulesoft.connectors", url: `${CBASE}/salesforce-connector-release-notes-mule-4` },
];

const raw = JSON.parse(fs.readFileSync(RAW, "utf8"));
const curatedIds = new Set(CURATED.map((c) => c.artifactId));

// Auto-resolved entries (exclude any colliding with a curated artifactId).
const auto = raw.results
  .filter((r) => r.artifactId && !curatedIds.has(r.artifactId))
  .map((r) => ({ artifactId: r.artifactId, groupId: r.groupId, url: r.url, source: "auto" }))
  .sort((a, b) => a.artifactId.localeCompare(b.artifactId));

const connectors = [
  ...CURATED.map((c) => ({ ...c, source: "curated" })),
  ...auto,
];

const doc = {
  schemaVersion: "1.0",
  description:
    "Maps a connector's POM artifactId to its MuleSoft release-notes URL, so the assessor fetches the " +
    "correct per-connector OpenJDK/Mule-runtime compatibility table instead of guessing a slug. " +
    "'curated' entries are the matrix connectors with hand-verified slugs (authoritative); 'auto' " +
    "entries are resolved from the docs index joined with an exact Exchange-Graph artifactId match.",
  generated: "one-time from docs release-notes index + Exchange GraphQL (see .agents/artifacts/build_notes_map.mjs)",
  connectors,
};

const header =
  "# connector-notes-map.yaml — POM artifactId → release-notes URL (see 'description').\n" +
  "# Regenerate: node .agents/artifacts/build_notes_map.mjs && node .agents/artifacts/assemble_notes_map.mjs\n" +
  "# Curated (matrix) slugs are hand-verified; auto entries are best-effort enrichment.\n";
fs.writeFileSync(OUT, header + yaml.dump(doc, { lineWidth: 120, noRefs: true }));
console.log(`wrote ${OUT}`);
console.log(`  curated=${CURATED.length} auto=${auto.length} total=${connectors.length}`);
