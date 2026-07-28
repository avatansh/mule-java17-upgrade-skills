// tools/diagnose.mjs — one-shot, READ-ONLY diagnostic for the two things that bit the last Vibes run:
//   (A) Anypoint Runtime Manager "not found" — resolve creds, list environments + deployments, and
//       locate an app by EXACT name across every env (so a wrong/blank env label can't hide it).
//   (B) parent/BOM own-version bump — fetch the REAL bom / parent-pom / app poms from GitHub and run
//       the actual rewrite engine, printing every edit (connector pins + own <version> bump + chained
//       parent-ref repoint) so you can see exactly what a PR would contain.
//
// It NEVER writes anything (no PR, no job, no file). Secrets are used but never printed (only lengths).
//
// Run from the suite root. Every --*-pom flag is OPTIONAL — pass only the poms you have. The common
// real-world shape is an app + a parent-pom in a DIFFERENT repo and NO BOM:
//   node tools/diagnose.mjs --app lead-to-contacts-demo-api \
//        --app-pom    https://github.com/avatansh/customer-web-eapi \
//        --parent-pom https://github.com/avatansh/platform-parent-pom
//
// Monorepo (edge case) or a full 3-level chain, if you have them:
//   node tools/diagnose.mjs --app lead-to-contacts-demo-api \
//        --bom        https://github.com/avatansh/mule-apps/tree/develop/bom \
//        --parent-pom https://github.com/avatansh/mule-apps/tree/develop/parent-pom \
//        --app-pom    https://github.com/avatansh/mule-apps/tree/develop/customer-web-eapi
//
// Needs .env (MULE_CONFIG_KEY + MULE_UPGRADE_ENV) and config/config-secure-<env>.yaml, exactly like
// the suite. For GitHub reads it uses the decrypted github.token from the secure config. Each URL may
// point at a different repo — the poms do NOT need to share a repo.

import { get, loadConfig, requireEnv } from "../lib_shared/config.js";
import { AnypointClient } from "../skills/mule-upgrade/scripts/lib/anypoint.js";
import { GitHubApi } from "../skills/mule-upgrade-pr/scripts/lib/gh_api.js";
import { resolveMatrix } from "../skills/mule-upgrade-assess/scripts/lib/matrix_fetch.js";
import {
  rewriteParentPom,
  projectCoords,
  isPlaceholder,
} from "../skills/mule-upgrade-apply/scripts/rewrites/parent_pom.js";
import { detectInheritance, inheritanceSummary } from "../skills/mule-upgrade-parent-pom/scripts/lib/inheritance.js";
import { resolveRepoCoords, resolvePomPath } from "../skills/mule-upgrade-parent-pom/scripts/lib/repo_url.js";

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      a[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    }
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const line = (s = "") => process.stdout.write(s + "\n");
const H = (s) => line("\n" + "=".repeat(78) + "\n" + s + "\n" + "=".repeat(78));

async function readPom(gh, url) {
  const coords = resolveRepoCoords({ repoUrl: url });
  const pomPath = resolvePomPath(null, coords);
  const branch = coords.urlBranch || "main";
  const resp = await gh.getContents(coords.owner, coords.repo, pomPath, branch);
  const text = Buffer.from(String(resp.content).replace(/[\r\n\t ]/g, ""), "base64").toString("utf-8");
  return { coords, pomPath, branch, text };
}

async function main() {
  const env = requireEnv(args.env);
  line(`Environment (config selector): ${env}`);
  loadConfig({ force: true });

  // ── secret presence (never print values) ───────────────────────────────────────────────
  H("0) Credentials & config (values NOT printed)");
  const safe = (dotted) => {
    try {
      const v = get(dotted, "");
      return v ? `set (len ${String(v).length})` : "MISSING";
    } catch (e) {
      return `ERROR (${e.message})`;
    }
  };
  line(`  anypoint.clientId      : ${safe("anypoint.clientId")}`);
  line(`  anypoint.clientSecret  : ${safe("anypoint.clientSecret")}`);
  line(`  anypoint.defaultOrgId  : ${get("anypoint.defaultOrgId", "MISSING")}`);
  line(`  anypoint.apiBase       : ${get("anypoint.apiBase", "(default)")}`);
  line(`  anypoint.environmentName (optional default): ${get("anypoint.environmentName", "(unset)")}`);
  line(`  github.token           : ${safe("github.token")}`);

  // ── (A) ARM ────────────────────────────────────────────────────────────────────────────
  H("A) Anypoint Runtime Manager");
  const anypoint = new AnypointClient();
  line(`  configured(): ${anypoint.configured()}`);
  if (anypoint.configured()) {
    // token (print only that we got one + its length)
    let token = "";
    try {
      token = await anypoint._getToken();
      line(`  token: ${token ? `obtained (len ${token.length})` : "EMPTY — check clientId/clientSecret/org & connected-app scopes"}`);
    } catch (e) {
      line(`  token: ERROR — ${e.message}`);
    }

    const envs = await anypoint.listEnvironments();
    line(`  environments visible to org ${get("anypoint.defaultOrgId", "?")}: ${envs.length}`);
    for (const e of envs) line(`    · ${e.name}  (id ${e.id}, type ${e.type})`);
    if (!envs.length) {
      line("  ⚠ No environments — the connected app likely has NO access to this org, or the orgId is a");
      line("    different business group than where the app is deployed. Fix the org/business-group.");
    }

    for (const e of envs) {
      const deps = await anypoint.listDeployments({ env: e.name });
      line(`  deployments in "${e.name}": ${deps.length}`);
      for (const d of deps) line(`    · ${d.name}  [${d.runtimeVersion ?? "?"} / status ${d.status}]`);
    }

    const appName = typeof args.app === "string" ? args.app : null;
    if (appName) {
      line(`\n  Looking up "${appName}" (verbatim) across all environments…`);
      const across = await anypoint.findDeploymentAcrossEnvs({ app: appName });
      if (across.found) {
        line(`  ✅ FOUND in "${across.environment}": runtime ${across.runtimeVersion} / Java ${across.javaVersion}, status ${across.status}`);
      } else {
        line(`  ❌ NOT found: ${across.reason}`);
        line("     → If the name in Runtime Manager exactly matches this string, the org/business-group");
        line("       is the likely culprit (deployments list above is what these creds can actually see).");
      }
    } else {
      line("  (pass --app <exact RM name> to test a verbatim lookup)");
    }
  }

  // ── (B) parent/BOM rewrite ───────────────────────────────────────────────────────────────
  H("B) parent/BOM own-version bump (real poms, dry rewrite — nothing written)");
  const gh = new GitHubApi();
  const { matrix } = await resolveMatrix({});
  const targets = [
    ["BOM", args.bom],
    ["parent-pom", args["parent-pom"]],
    ["app", args["app-pom"]],
  ].filter(([, u]) => typeof u === "string");

  for (const [label, url] of targets) {
    try {
      const { pomPath, text } = await readPom(gh, url);
      const inh = detectInheritance(text);
      line(`\n  ${label}  (${pomPath})`);
      line(`    inherits: ${inheritanceSummary(inh) || "(nothing shared)"}`);

      // Reveal exactly what own-version detection sees — this is what governs the own-version bump.
      const coords = projectCoords(text);
      let mismatch = false;
      if (!coords) {
        mismatch = true;
        line("    own coords: NOT DETECTED — the pom's own <artifactId>…<version> could not be located");
        line("      (version may sit BEFORE <artifactId>, or be separated by a non-leaf block). → bump SKIPPED.");
      } else {
        const ph = isPlaceholder(coords.version);
        if (ph) mismatch = true;
        line(`    own coords: artifactId="${coords.artifactId}" version="${coords.version}"${ph ? "  ← PLACEHOLDER (${...})" : ""}`);
        if (ph) line("      → own-version bump is SKIPPED for a ${...} placeholder.");
      }
      // When detection is off, dump the pom HEADER (public code, no secrets) so the layout is visible.
      if (mismatch || args["dump-header"]) {
        const cut = ["<dependencyManagement", "<dependencies", "<build"]
          .map((t) => text.indexOf(t))
          .filter((i) => i >= 0);
        const end = cut.length ? Math.min(...cut) : Math.min(text.length, 1800);
        line("    ----- pom header (verbatim, up to first dependencies/build block) -----");
        for (const l of text.slice(0, end).split(/\r?\n/)) line("    | " + l);
        line("    ----- end pom header -----");
      }

      // default (non-chained) rewrite: connector pins + own-version bump when anything changes
      const r = rewriteParentPom(text, matrix, pomPath);
      const hadVersion = r.edits.some((e) => e.kind === "pomVersion");
      if (!r.edits.length) {
        line("    → NO edits (already meets the matrix). A version bump only fires when something changes.");
      } else {
        for (const e of r.edits) {
          if (e.kind === "pomVersion") line(`    → OWN VERSION bump: ${e.from} -> ${e.to}`);
          else if (e.kind === "pomParentVersion") line(`    → parent ref ${e.artifactId}: ${e.from} -> ${e.to}`);
          else line(`    → connector ${e.artifactId}: ${e.from} -> ${e.to}`);
        }
        if (!hadVersion)
          line(`    ⚠ ${r.edits.length} connector edit(s) but NO own-version bump — see 'own coords' line above for why.`);
      }
    } catch (e) {
      line(`\n  ${label}: ERROR reading/rewriting — ${e.message}`);
    }
  }

  H("Done. This run wrote nothing.");
}

main().catch((e) => {
  process.stderr.write(`DIAGNOSE ERROR: ${e.stack || e.message}\n`);
  process.exit(1);
});
