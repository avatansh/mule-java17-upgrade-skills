// server/lib/tools.js — the tool registry exposed over MCP (tools/list, tools/call) AND the REST
// facade. Each entry = { name, description, inputSchema (JSON Schema), handler(args) -> result }.
//
// 14 tools:
//   PARITY with the Mule MCP server (6):
//     assess_app          -> mule-upgrade-assess/assess()   (LEAN by default; includeVersions/includeDrift opt-in)
//     start_upgrade       -> mule-upgrade/orchestrate.runUpgrade()
//     get_job_status      -> mule-upgrade-job/status.buildJobStatus()
//     reapply_job         -> mule-upgrade-job/jobstore.reapplyJob()
//     delete_job          -> mule-upgrade-job/jobstore.deleteJob()
//     upgrade_parent_pom  -> mule-upgrade-parent-pom/parent_pom.upgradeParentPom()
//   ADDED (skill-native, replace the polling side of the Mule reconcile scheduler + rollback flow):
//     reconcile           -> mule-upgrade-job/reconcile.runReconcile()
//     rollback            -> mule-upgrade-pr/rollback.rollbackApi()
//     scan_fleet          -> mule-upgrade-scan/scan.scanFleet()        (proactive fleet audit)
//     scan_notify         -> mule-upgrade-scan/scan_notify.scanAndNotify()  (proactive push: scan + Slack on change)
//     batch_upgrade       -> mule-upgrade-batch/batch.runBatchUpgrade()  (fan-out: N apps, one env, bounded pool)
//     scan_vulnerabilities -> mule-upgrade-cve/cve.scanVulnerabilities()  (read-only: OSV advisories + what the upgrade fixes)
//   THE FULL SPLIT (the lean assess broke the mega-response into three purpose-built tools):
//     resolve_versions    -> mule-upgrade-assess/resolveVersionsForApp()  (② the app-scoped version MENU, current-populated)
//     check_drift         -> mule-upgrade-assess/matrix_drift.runDriftCheck()  (③ advisory: matrix + connector staleness)
//
// Handlers translate the flat tool `args` into each skill's option shape and return a plain object
// (the server serialises it). A handler that throws surfaces as a structured tool error upstream;
// domain "soft failures" (CONFLICT, ALREADY_UPGRADED, NO_CHANGE) come back as normal result objects,
// mirroring the Mule flows that return a 2xx envelope with a status field.
//
// SINGLE SOURCE OF TRUTH for the input contracts: each tool's `inputSchema` is loaded from
// server/schemas/<name>.json via loadSchema(). The SAME object is what tools/list advertises to MCP
// clients AND what server/lib/schema.js validates requests against — so the advertised schema and the
// enforced schema can never drift (the exact failure mode that bit the Agentforce agent). To change a
// tool's contract, edit its JSON file; nothing here is hand-mirrored.

import { assess, resolveVersionsForApp } from "../../skills/mule-upgrade-assess/scripts/assess.js";
import { runDriftCheck } from "../../skills/mule-upgrade-assess/scripts/lib/matrix_drift.js";
import { runUpgrade } from "../../skills/mule-upgrade/scripts/orchestrate.js";
import { buildJobStatus } from "../../skills/mule-upgrade-job/scripts/status.js";
import { getJob, reapplyJob, deleteJob, TERMINAL } from "../../skills/mule-upgrade-job/scripts/jobstore.js";
import { runReconcile, reconcileJob } from "../../skills/mule-upgrade-job/scripts/reconcile.js";
import {
  AnypointClient,
  makeDeployVerifier,
  fetchDeployedState,
} from "../../skills/mule-upgrade/scripts/lib/anypoint.js";
import { makeJobNotifier } from "../../skills/mule-upgrade/scripts/lib/notify.js";
import { runParentPomJob, updateOpenPrParentRef } from "../../skills/mule-upgrade-parent-pom/scripts/parent_pom.js";
import { rollbackApi } from "../../skills/mule-upgrade-pr/scripts/rollback.js";
import { scanFleet } from "../../skills/mule-upgrade-scan/scripts/scan.js";
import { scanAndNotify } from "../../skills/mule-upgrade-scan/scripts/scan_notify.js";
import { runBatchUpgrade } from "../../skills/mule-upgrade-batch/scripts/batch.js";
import { scanVulnerabilities } from "../../skills/mule-upgrade-cve/scripts/cve.js";
import { resolveCoordinates } from "../../lib_shared/coordinates.js";
import { loadSchema } from "./schemas.js";

/**
 * @typedef {import("./schemas.js")} Schemas
 * @typedef {object} Tool
 * @property {string} name              unique tool name (matches its schema file)
 * @property {string} description       human/LLM-facing description advertised via tools/list
 * @property {object} inputSchema       JSON Schema (loaded from server/schemas/<name>.json)
 * @property {(args: object) => Promise<object>|object} handler  runs the tool; returns a plain result
 */

function notFoundError(jobId) {
  const e = new Error(`No job found with id ${jobId}.`);
  e.code = "NOT_FOUND";
  return e;
}
function validationError(message, fields) {
  const e = new Error(message);
  e.code = "VALIDATION";
  if (fields) e.invalidFields = fields;
  return e;
}

// Build the Anypoint deploy verifier used by the poll-driven paths (reconcile / get_job_status
// auto-refresh). Non-fatal: if Anypoint creds aren't configured, return undefined so runReconcile
// keeps its "unknown" default (a DEPLOYING job simply isn't advanced, never crashes).
function safeDeployVerifier() {
  try {
    return makeDeployVerifier(new AnypointClient());
  } catch {
    return undefined;
  }
}

/** @type {Tool[]} */
export const TOOLS = [
  {
    name: "assess_app",
    description:
      "Assess a MuleSoft application's Java 17 upgrade readiness. Resolves repo coordinates, walks the " +
      "pom inheritance chain against the compatibility matrix, and returns a byte-level ChangePlan plus warnings. " +
      "LEAN by default (fast): the ChangePlan carries connectorsInApp[] (each app connector's current vs matrix pin). " +
      "The rich connector version MENU is OPT-IN via includeVersions (or call resolve_versions); the matrix-drift " +
      "advisory is opt-in via includeDrift (or call check_drift).",
    inputSchema: loadSchema("assess_app"),
    async handler(args) {
      const coords = await resolveCoordinates({
        appName: args.appName,
        request: {
          owner: args.owner,
          repo: args.repo,
          appPath: args.appPath,
          orgId: args.orgId,
          branch: args.branch,
        },
      });
      // The hosted server has NO local clone — assess reads the repo over the GitHub REST API
      // (repo_source githubSource). Coordinates come from the resolver (owner/repo/branch/appPath).
      const { result, matrixSource, matrixWarnings, repoLabel, deployedStateCheck, matrixDrift, connectorChoices } =
        await assess({
          source: "github",
          owner: coords.owner,
          repoName: coords.repo,
          branch: coords.defaultBranch ?? undefined,
          appName: args.appName,
          appPath: coords.appPath ?? undefined,
          environment: args.environment,
          orgId: coords.orgId ?? undefined,
          headSha: args.headSha,
          // Echo the optional Jira ticket back on the assessment (a downstream start_upgrade / PR can cite it).
          jiraTicketId: args.jiraTicketId ?? undefined,
          // The Full Split — both default OFF (lean). Callers opt in, or use resolve_versions / check_drift.
          includeVersions: args.includeVersions === true,
          includeDrift: args.includeDrift === true,
          // EPIC C — verbatim deployed-state lookup (defaults to the app name when not given separately).
          deployedApiName: args.deployedApiName ?? args.appName,
        });
      const out = {
        status: "ASSESSED",
        appName: args.appName,
        coords,
        repoLabel,
        matrixSource,
        matrixWarnings,
        deployedStateCheck,
        result,
      };
      // Only surface the opt-in advisories when they were actually computed (keeps the lean payload lean).
      if (args.includeVersions === true) out.connectorChoices = connectorChoices ?? [];
      if (args.includeDrift === true && matrixDrift) out.matrixDrift = matrixDrift;
      return out;
    },
  },

  {
    name: "start_upgrade",
    description:
      "Submit an approved Java 17 upgrade job. Runs the full pipeline synchronously (assess -> lock -> apply -> " +
      "commit -> open PR) and returns the job outcome (PR_OPEN, ALREADY_UPGRADED, CONFLICT, or FAILED_*).",
    inputSchema: loadSchema("start_upgrade"),
    async handler(args) {
      const coords = await resolveCoordinates({
        appName: args.appName,
        request: {
          owner: args.owner,
          repo: args.repo,
          appPath: args.appPath,
          orgId: args.orgId,
          branch: args.branch,
        },
      });
      return await runUpgrade({
        appName: args.appName,
        environment: args.environment,
        jiraTicketId: args.jiraTicketId ?? null,
        // Per-run Slack/Jira opt-in. Absent → silent (resolveNotifyPrefs default-denies).
        notifyPrefs: args.notifyPrefs,
        approvedChangePlan: args.approvedChangePlan ?? null,
        mode: args.mode ?? "api",
        repo: args.repo,
        headSha: args.headSha,
        // EPIC D — dry-run confirmation gate: preview the plan without writing anything.
        dryRun: args.dryRun ?? false,
        coords: { owner: coords.owner, repo: coords.repo, defaultBranch: coords.defaultBranch },
        assessOpts: {
          appPath: coords.appPath ?? undefined,
          environment: args.environment,
          orgId: coords.orgId ?? undefined,
          // EPIC B — connector version CHOICE. Forwarded into assess so the ChangePlan pins the
          // operator-selected versions (default "min" keeps the curated matrix pins).
          versionStrategy: args.versionStrategy,
          connectorSelections: args.connectorSelections,
          // EPIC C — verbatim deployed-state lookup (defaults to the app name when not given separately).
          deployedApiName: args.deployedApiName ?? args.appName,
          // Chained flow: fold the app's <parent> repoint into THIS (first) app PR commit and show it in
          // the dry-run preview — no separate update_open_pr_parent_ref amend commit needed.
          parentRef: args.parentRef ?? undefined,
        },
      });
    },
  },

  {
    name: "get_job_status",
    description:
      "Fetch the current status of an upgrade job by jobId (status message, nextPollSeconds, dep-guard/munit " +
      "sub-stage). By default it AUTO-REFRESHES first: it polls the live PR state + CI checks (over the GitHub " +
      "token, no `gh` CLI needed) and verifies the deployment on Anypoint, so 'check status now' returns the " +
      "up-to-date status and surfaces which checks passed/failed. When Anypoint is configured it also attaches a " +
      "`deployedState` block read live from Runtime Manager (status/runtime/Java/environment + matchesTarget), so " +
      "deploy status is answerable from this tool even when the PR hasn't merged or the deploy ran out-of-band " +
      "(a separate CI/CD action). Pass refresh:false for a pure cache read.",
    inputSchema: loadSchema("get_job_status"),
    async handler(args) {
      if (!getJob(args.jobId)) throw notFoundError(args.jobId);
      let checks;
      if (args.refresh !== false) {
        // Non-fatal: any polling/network error still returns the last-known status from the cache.
        try {
          const r = await reconcileJob(args.jobId, {
            verifyDeploy: safeDeployVerifier(),
            // Fire Slack + Jira on any state change discovered during this auto-refresh (merge→deploy,
            // parked/resumed, closed-unmerged, deploy failed). De-duped per status, so a status read
            // that changes nothing stays silent.
            notify: makeJobNotifier(),
          });
          checks = r.checks;
        } catch {
          /* keep last-known status */
        }
      }
      const rec = getJob(args.jobId); // re-read: auto-refresh may have advanced it
      const out = buildJobStatus(rec, args.jiraBaseUrl ?? "");
      if (Array.isArray(checks) && checks.length) {
        // Surface the exact CI checks seen this refresh (e.g. test:success, dependency-guard:success),
        // so callers can report sub-status even when the enum stays PR_OPEN.
        out.checks = checks.map((c) => ({ stage: c.stage, result: c.result }));
      }
      // Reach out to Runtime Manager for a live deployed-state snapshot (advisory). Without this the
      // ARM check is gated behind DEPLOYING (post-merge) only, so a PR whose deploy ran out-of-band
      // (separate GitHub Action, no cd-result callback / PR check) could never report deploy status
      // from this tool — the caller had to fall back to a different platform tool. Non-terminal jobs
      // only; never fatal — a lookup error just omits the field.
      if (args.refresh !== false && rec && !TERMINAL.has(rec.status)) {
        try {
          const ds = await fetchDeployedState({ client: new AnypointClient(), rec });
          if (ds) out.deployedState = ds;
        } catch {
          /* advisory only — never block the status read */
        }
      }
      return out;
    },
  },

  {
    name: "reapply_job",
    description:
      "Reseed a new upgrade job from an existing job's coordinates (retry a failed/closed migration with a fresh jobId).",
    inputSchema: loadSchema("reapply_job"),
    async handler(args) {
      if (!getJob(args.jobId)) throw notFoundError(args.jobId);
      const { jobId, record } = reapplyJob(args.jobId);
      return { status: "REAPPLIED", jobId, record };
    },
  },

  {
    name: "delete_job",
    description:
      "Delete a job record, clear its branch index, and release its app lock (idempotent cleanup).",
    inputSchema: loadSchema("delete_job"),
    async handler(args) {
      if (!getJob(args.jobId)) throw notFoundError(args.jobId);
      return { status: "DELETED", ...deleteJob(args.jobId) };
    },
  },

  {
    name: "upgrade_parent_pom",
    description:
      "Upgrade a shared parent/BOM pom.xml: pin the connector versions it manages to the Java 17 matrix, minor-bump " +
      "its own version, and open a PR. Runs as a TRACKED job (single-flight lock + job record) so its status is " +
      "pollable via get_job_status/reconcile, just like an app upgrade. Returns NO_CHANGE (no job) when the BOM " +
      "already meets the matrix; CONFLICT when the repo already has an upgrade in progress. Pass detectOnly:true " +
      "for a READ-ONLY report of what the pom inherits (its <parent>/imported BOMs) + an edit preview, with no lock or PR.",
    inputSchema: loadSchema("upgrade_parent_pom"),
    async handler(args) {
      if (!args.repoUrl && !(args.owner && args.repo)) {
        throw validationError("Provide repoUrl or owner+repo.", ["repoUrl", "owner", "repo"]);
      }
      // Tracked by default: runParentPomJob assesses first (NO_CHANGE short-circuits with no job/lock),
      // then creates a job + repo lock and drives it to PR_OPEN. The generic get_job_status/reconcile
      // then report and advance it — there is no parent-pom-specific status path.
      return await runParentPomJob({
        repoUrl: args.repoUrl,
        owner: args.owner,
        repo: args.repo,
        pomPath: args.pomPath,
        branch: args.branch,
        environment: args.environment ?? null,
        jiraTicketId: args.jiraTicketId ?? null,
        // Per-run Slack/Jira opt-in. Absent → silent (resolveNotifyPrefs default-denies).
        notifyPrefs: args.notifyPrefs,
        mode: args.mode ?? "api",
        repoRoot: args.repoRoot,
        // Read-only detect (report inheritance + edit preview, no lock/PR) for the chained flow.
        detectOnly: args.detectOnly ?? false,
        // Chained flow: repoint this pom's <parent> at a new BOM/parent version and/or force an
        // own-version bump even with no connector edits (the parent-pom step of parent→BOM→app).
        parentRef: args.parentRef ?? null,
        bumpOwnVersion: args.bumpOwnVersion ?? false,
      });
    },
  },

  {
    name: "update_open_pr_parent_ref",
    description:
      "Chained-flow FINAL step: bump the <parent> version reference INSIDE an app's ALREADY-OPEN upgrade PR " +
      "(e.g. point customer-web-eapi at the newly-released parent-pom). Reads the app pom at the open PR's head " +
      "branch, repoints its <parent>, and adds ONE commit onto that same branch (GitHub attaches it to the PR). " +
      "Records the amendment on the app job; does NOT open a new PR or change the job's status. Returns PR_UPDATED " +
      "or NO_CHANGE.",
    inputSchema: loadSchema("update_open_pr_parent_ref"),
    async handler(args) {
      if (!args.appJobId) throw validationError("appJobId is required.", ["appJobId"]);
      if (!args.parentRef || !args.parentRef.toVersion) {
        throw validationError("parentRef.toVersion is required.", ["parentRef"]);
      }
      return await updateOpenPrParentRef({
        appJobId: args.appJobId,
        parentRef: args.parentRef,
        // Omit → derive the app's own pom path from the tracked job (never blindly repo-root pom.xml,
        // which committed to the wrong file in a multi-module repo). Only honor an explicit override.
        pomPath: args.pomPath,
        mode: args.mode ?? "api",
        repoRoot: args.repoRoot,
        jiraTicketId: args.jiraTicketId ?? null,
      });
    },
  },

  {
    name: "reconcile",
    description:
      "Run the self-healing sweep over stale jobs: poll PR merge state and CI checks (over the GitHub token, " +
      "falling back to the `gh` CLI), verify deployments on Anypoint, and advance / fail-interrupt jobs. " +
      "Defaults to staleSeconds:0 (poll every job now). Replaces the Mule reconcile scheduler; run on a timer or on demand.",
    inputSchema: loadSchema("reconcile"),
    async handler(args) {
      return runReconcile({
        staleSeconds: args.staleSeconds ?? 0,
        verifyDeploy: safeDeployVerifier(),
        // Push Slack + Jira on every transition this sweep applies (de-duped per status).
        notify: makeJobNotifier(),
      });
    },
  },

  {
    name: "rollback",
    description:
      "Open a revert PR restoring the pre-upgrade tree for a failed deployment (recreates the upgrade commit's first-parent tree).",
    inputSchema: loadSchema("rollback"),
    async handler(args) {
      const rec = getJob(args.jobId);
      if (!rec) throw notFoundError(args.jobId);
      const upgradeCommitSha = args.upgradeCommitSha ?? rec.commitSha;
      if (!upgradeCommitSha)
        throw validationError(`Job ${args.jobId} has no commitSha to roll back.`, ["upgradeCommitSha"]);
      if (!rec.coords?.owner || !rec.coords?.repo)
        throw validationError(`Job ${args.jobId} has no repo coordinates.`);
      const res = await rollbackApi({
        coords: {
          owner: rec.coords.owner,
          repo: rec.coords.repo,
          defaultBranch: rec.coords.defaultBranch ?? rec.coords.branch,
        },
        upgradeCommitSha,
        branchName: rec.branchName,
        appName: rec.appName,
        jobId: rec.jobId,
        jiraTicketId: rec.jiraTicketId ?? null,
      });
      return { status: "ROLLBACK_PR_OPEN", jobId: rec.jobId, ...res };
    },
  },

  {
    name: "scan_fleet",
    description:
      "Proactively scan the Anypoint Platform fleet (CloudHub 2.0 / Runtime Fabric) for apps that still run an old " +
      "Mule runtime (4.4 or older) or old Java (8/11) and need the Java 17 upgrade. Returns a count plus a candidate " +
      "list mapped to GitHub repos (unmappable apps are flagged needsCoordinates). Feed a candidate to start_upgrade.",
    inputSchema: loadSchema("scan_fleet"),
    async handler(args) {
      return await scanFleet({
        environments: args.environments,
        staleMuleBelow: args.staleMuleBelow,
        targetJava: args.targetJava,
        resolveRepos: args.resolveRepos,
      });
    },
  },

  {
    name: "batch_upgrade",
    description:
      "Upgrade MANY apps in one run (one environment). Previews every app concurrently first, holds back apps whose " +
      "connector versions live in a shared parent/BOM pom (they need a chained parent-pom flow, not N parallel edits), " +
      "then — ONLY with confirm:true — runs the rest through the normal pipeline with a bounded pool. Each app takes its " +
      "own <app>::<env> lock and gets its own tracked job + PR. Without confirm:true nothing is written. Failure is " +
      "isolated per app, so an N-app run always returns N outcomes.",
    inputSchema: loadSchema("batch_upgrade"),
    async handler(args) {
      return await runBatchUpgrade({
        apps: args.apps,
        fromScan: args.fromScan,
        environment: args.environment,
        environments: args.environments,
        mode: args.mode ?? "api",
        // Writes require an explicit confirm — the batch equivalent of start_upgrade's dry-run gate.
        confirm: args.confirm === true,
        concurrency: args.concurrency,
        stopOnFailure: args.stopOnFailure,
        includeParentPomRouted: args.includeParentPomRouted,
        versionStrategy: args.versionStrategy,
        connectorSelections: args.connectorSelections,
        jiraTicketId: args.jiraTicketId ?? null,
        // Applied to EVERY app. Absent → silent (resolveNotifyPrefs default-denies per job).
        notifyPrefs: args.notifyPrefs,
      });
    },
  },

  {
    name: "scan_vulnerabilities",
    description:
      "READ-ONLY security scan: look up an app's DECLARED Maven coordinates in the OSV.dev advisory database and " +
      "split the findings into what the Java upgrade already fixes, what still needs action (with the exact minimum " +
      "fix version), and what has no published fix at all. Never edits a pom, opens a PR, or deploys. IMPORTANT scope " +
      "limit that must be repeated to the user: only declared coordinates are scanned (direct dependencies, " +
      "dependencyManagement, plugins) — transitive dependencies are NOT resolved because that needs a real Maven " +
      "build, so results are a LOWER BOUND and an empty result is not a clean bill of health. Non-fatal: an OSV " +
      "outage degrades to a reported partial scan.",
    inputSchema: loadSchema("scan_vulnerabilities"),
    async handler(args) {
      return await scanVulnerabilities({
        // Left undefined when absent so resolveSource() infers the same way assess_app does.
        source: args.source,
        repo: args.repo,
        repoUrl: args.repoUrl,
        owner: args.owner,
        repoName: args.repoName,
        branch: args.branch,
        appPath: args.appPath,
        comparePlan: args.comparePlan !== false,
        refresh: args.refresh === true,
        maxVulnDetails: args.maxVulnDetails,
      });
    },
  },

  {
    name: "scan_notify",
    description:
      "Proactive push: run the fleet scan and, when apps that need the Java 17 upgrade have CHANGED since the last " +
      "run (newly stale, changed reason, or resolved), push a Slack message. De-duplicated against remembered state " +
      "so re-running on a timer never re-spams the same list. Intended to be called on a schedule (cron / loop / CI). " +
      "Non-fatal and env-gated: no SLACK_WEBHOOK_URL means the push is cleanly skipped.",
    inputSchema: loadSchema("scan_notify"),
    async handler(args) {
      return await scanAndNotify({
        environments: args.environments,
        alwaysNotify: args.alwaysNotify,
        dryRun: args.dryRun,
      });
    },
  },

  {
    name: "resolve_versions",
    description:
      "Resolve the connector version CHOICE menu for a specific app's Java 17 upgrade (the Full Split's step ②). " +
      "Walks the app's pom chain, then for ONLY the connectors the app actually references returns each one's current " +
      "version, the curated Java-17-safe pin (recommended), the first version marked Java-17-compatible in its " +
      "release-notes OpenJDK table, the latest published within the same major (safe patch bump), and the latest overall " +
      "(may be a breaking major). Live data from Anypoint Exchange + release-notes is ADVISORY: the curated matrix pin " +
      "stays the default and is never auto-overridden. Feed a chosen versionStrategy / connectorSelections to start_upgrade. " +
      "Fully non-fatal: with noFetch or no Anypoint creds it returns matrix-only choices (still app-scoped + current-populated).",
    inputSchema: loadSchema("resolve_versions"),
    async handler(args) {
      const coords = await resolveCoordinates({
        appName: args.appName,
        request: {
          owner: args.owner,
          repo: args.repo,
          appPath: args.appPath,
          orgId: args.orgId,
          branch: args.branch,
        },
      });
      const { choices, warnings, source, scope, repoLabel } = await resolveVersionsForApp({
        source: "github",
        owner: coords.owner,
        repoName: coords.repo,
        branch: coords.defaultBranch ?? undefined,
        appPath: coords.appPath ?? undefined,
        noFetch: args.noFetch,
      });
      // If the caller narrowed to specific artifactIds, honour it on top of the app scope.
      const filtered = Array.isArray(args.artifactIds) && args.artifactIds.length
        ? choices.filter((c) => args.artifactIds.includes(c.artifactId))
        : choices;
      return { status: "RESOLVED", source, appName: args.appName, coords, repoLabel, scope, connectorChoices: filtered, warnings };
    },
  },

  {
    name: "check_drift",
    description:
      "ADVISORY matrix-drift audit (the Full Split's step ③) — on-demand / scheduled, NOT run on every assess. " +
      "Audits whether the bundled compatibility matrix is trailing: the gating pins (runtime patch, mule-maven-plugin, " +
      "MUnit plugins) vs live Maven metadata, and — when includeConnectors — each connector pin vs its latest-in-major " +
      "from Exchange Graph. NEVER writes the matrix; the curated pins stay the Java-17-safe floor. With candidate:true it " +
      "also returns a PROPOSED candidate matrix (a review artifact, never persisted). Fully non-fatal: noFetch or absent " +
      "Anypoint creds degrade the gating check to 'unchecked' and connectors to 'unknown'.",
    inputSchema: loadSchema("check_drift"),
    async handler(args) {
      const { gating, connectors, candidate, warnings } = await runDriftCheck({
        noFetch: args.noFetch === true,
        includeConnectors: args.includeConnectors !== false,
        candidate: args.candidate === true,
      });
      return { status: "CHECKED", gating, connectors, candidate, warnings };
    },
  },
];

/** Map of name -> tool for O(1) dispatch. */
export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The tools/list payload shape (name/description/inputSchema only). */
export function toolCatalog() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}
