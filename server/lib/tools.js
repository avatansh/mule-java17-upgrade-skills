// server/lib/tools.js — the tool registry exposed over MCP (tools/list, tools/call) AND the REST
// facade. Each entry = { name, description, inputSchema (JSON Schema), handler(args) -> result }.
//
// 10 tools:
//   PARITY with the Mule MCP server (6):
//     assess_app          -> mule-upgrade-assess/assess()
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
//
// Handlers translate the flat tool `args` into each skill's option shape and return a plain object
// (the server serialises it). A handler that throws surfaces as a structured tool error upstream;
// domain "soft failures" (CONFLICT, ALREADY_UPGRADED, NO_CHANGE) come back as normal result objects,
// mirroring the Mule flows that return a 2xx envelope with a status field.

import { assess } from "../../skills/mule-upgrade-assess/scripts/assess.js";
import { runUpgrade } from "../../skills/mule-upgrade/scripts/orchestrate.js";
import { buildJobStatus } from "../../skills/mule-upgrade-job/scripts/status.js";
import { getJob, reapplyJob, deleteJob } from "../../skills/mule-upgrade-job/scripts/jobstore.js";
import { runReconcile } from "../../skills/mule-upgrade-job/scripts/reconcile.js";
import { upgradeParentPom } from "../../skills/mule-upgrade-parent-pom/scripts/parent_pom.js";
import { rollbackApi } from "../../skills/mule-upgrade-pr/scripts/rollback.js";
import { scanFleet } from "../../skills/mule-upgrade-scan/scripts/scan.js";
import { scanAndNotify } from "../../skills/mule-upgrade-scan/scripts/scan_notify.js";
import { resolveCoordinates } from "../../lib_shared/coordinates.js";

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

// Shared request-override sub-schema (owner/repo/appPath/orgId/branch), used by assess/upgrade.
const REQUEST_OVERRIDES = {
  owner: { type: "string", description: "GitHub owner/org override (used only when the app is not in the registry)." },
  repo: { type: "string", description: "GitHub repository override (used only when the app is not in the registry)." },
  appPath: { type: "string", description: 'Path to the Mule module within the repo (e.g. "." for repo root).' },
  orgId: { type: "string", description: "Anypoint organization ID override (registry/convention fallback otherwise)." },
  branch: { type: "string", description: "Explicit branch. Highest precedence over registry default / discovered default." },
};

export const TOOLS = [
  {
    name: "assess_app",
    description:
      "Assess a MuleSoft application's Java 17 upgrade readiness. Resolves repo coordinates, walks the " +
      "pom inheritance chain against the compatibility matrix, and returns a byte-level ChangePlan plus warnings.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["appName"],
      properties: {
        appName: { type: "string", description: "Name of the MuleSoft application as it appears in Anypoint Runtime Manager." },
        environment: { type: "string", description: "Anypoint environment where the app runs (e.g. Production, Staging, Development)." },
        jiraTicketId: { type: "string", description: "Optional Jira ticket ID to link the assessment to a migration ticket." },
        repo: { type: "string", description: "Local clone path to assess (local mode). When omitted, coordinates are resolved and API mode is used." },
        headSha: { type: "string", description: "Repo HEAD at assess time (stale-plan anchor)." },
        ...REQUEST_OVERRIDES,
      },
    },
    async handler(args) {
      const coords = await resolveCoordinates({
        appName: args.appName,
        request: { owner: args.owner, repo: args.repo, appPath: args.appPath, orgId: args.orgId, branch: args.branch },
      });
      const { result, matrixSource, matrixWarnings } = await assess({
        repo: args.repo,
        appName: args.appName,
        appPath: coords.appPath ?? undefined,
        environment: args.environment,
        orgId: coords.orgId ?? undefined,
        headSha: args.headSha,
      });
      return { status: "ASSESSED", appName: args.appName, coords, matrixSource, matrixWarnings, result };
    },
  },

  {
    name: "start_upgrade",
    description:
      "Submit an approved Java 17 upgrade job. Runs the full pipeline synchronously (assess -> lock -> apply -> " +
      "commit -> open PR) and returns the job outcome (PR_OPEN, ALREADY_UPGRADED, CONFLICT, or FAILED_*).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["appName"],
      properties: {
        appName: { type: "string", description: "Name of the MuleSoft application to upgrade." },
        environment: { type: "string", description: "Anypoint environment to upgrade the application in." },
        jiraTicketId: { type: "string", description: "Optional Jira ticket ID to link this migration to." },
        approvedChangePlan: { type: "object", description: "Optional, audit-only. Recorded on the job record; the worker re-runs assessment and drives edits from its own fileEdits." },
        mode: { type: "string", enum: ["api", "local"], description: 'Commit mode: "api" (GitHub Git Data API, default) or "local" (git/gh over a clone).' },
        repo: { type: "string", description: "Local clone root (required for local mode; also used as the assess tree source)." },
        headSha: { type: "string", description: "Repo HEAD at assess time (stale-plan anchor)." },
        ...REQUEST_OVERRIDES,
      },
    },
    async handler(args) {
      const coords = await resolveCoordinates({
        appName: args.appName,
        request: { owner: args.owner, repo: args.repo, appPath: args.appPath, orgId: args.orgId, branch: args.branch },
      });
      return await runUpgrade({
        appName: args.appName,
        environment: args.environment,
        jiraTicketId: args.jiraTicketId ?? null,
        approvedChangePlan: args.approvedChangePlan ?? null,
        mode: args.mode ?? "api",
        repo: args.repo,
        headSha: args.headSha,
        coords: { owner: coords.owner, repo: coords.repo, defaultBranch: coords.defaultBranch },
        assessOpts: { appPath: coords.appPath ?? undefined, environment: args.environment, orgId: coords.orgId ?? undefined },
      });
    },
  },

  {
    name: "get_job_status",
    description: "Fetch the current status of an upgrade job by jobId (status message, nextPollSeconds, dep-guard/munit sub-stage).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobId"],
      properties: {
        jobId: { type: "string", description: "The job identifier returned by start_upgrade." },
        jiraBaseUrl: { type: "string", description: "Optional Jira base URL to render a ticket link in the status payload." },
      },
    },
    async handler(args) {
      const rec = getJob(args.jobId);
      if (!rec) throw notFoundError(args.jobId);
      return buildJobStatus(rec, args.jiraBaseUrl ?? "");
    },
  },

  {
    name: "reapply_job",
    description: "Reseed a new upgrade job from an existing job's coordinates (retry a failed/closed migration with a fresh jobId).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobId"],
      properties: { jobId: { type: "string", description: "The source job identifier to reseed from." } },
    },
    async handler(args) {
      if (!getJob(args.jobId)) throw notFoundError(args.jobId);
      const { jobId, record } = reapplyJob(args.jobId);
      return { status: "REAPPLIED", jobId, record };
    },
  },

  {
    name: "delete_job",
    description: "Delete a job record, clear its branch index, and release its app lock (idempotent cleanup).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobId"],
      properties: { jobId: { type: "string", description: "The job identifier to delete." } },
    },
    async handler(args) {
      if (!getJob(args.jobId)) throw notFoundError(args.jobId);
      return { status: "DELETED", ...deleteJob(args.jobId) };
    },
  },

  {
    name: "upgrade_parent_pom",
    description:
      "Upgrade a shared parent/BOM pom.xml: pin the connector versions it manages to the Java 17 matrix, minor-bump " +
      "its own version, and open a PR. Returns NO_CHANGE when the BOM already meets the matrix.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repoUrl: { type: "string", description: "Repository URL, optionally with /tree/<branch>/<subpath> to pin branch + pom directory." },
        owner: { type: "string", description: "GitHub owner (alternative to repoUrl)." },
        repo: { type: "string", description: "GitHub repository (alternative to repoUrl)." },
        pomPath: { type: "string", description: 'Path to the parent pom (default "pom.xml" or the URL-embedded sub-path).' },
        branch: { type: "string", description: "Base branch (else URL branch, else repo default)." },
        environment: { type: "string", description: "Log-only environment label." },
        jiraTicketId: { type: "string", description: "Optional Jira ticket ID." },
        mode: { type: "string", enum: ["api", "local"], description: 'Commit mode ("api" default).' },
        repoRoot: { type: "string", description: "Local clone root (local mode)." },
      },
    },
    async handler(args) {
      if (!args.repoUrl && !(args.owner && args.repo)) {
        throw validationError("Provide repoUrl or owner+repo.", ["repoUrl", "owner", "repo"]);
      }
      return await upgradeParentPom({
        repoUrl: args.repoUrl,
        owner: args.owner,
        repo: args.repo,
        pomPath: args.pomPath,
        branch: args.branch,
        environment: args.environment ?? null,
        jiraTicketId: args.jiraTicketId ?? null,
        mode: args.mode ?? "api",
        repoRoot: args.repoRoot,
      });
    },
  },

  {
    name: "reconcile",
    description:
      "Run the self-healing sweep over stale jobs: poll PR merge state and CI checks (gh), verify deployments, and " +
      "advance / fail-interrupt jobs. Replaces the Mule reconcile scheduler; run on a timer or on demand.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        staleSeconds: { type: "number", description: "Idle seconds before a job is considered stale (defaults to config)." },
      },
    },
    async handler(args) {
      return runReconcile({ staleSeconds: args.staleSeconds });
    },
  },

  {
    name: "rollback",
    description:
      "Open a revert PR restoring the pre-upgrade tree for a failed deployment (recreates the upgrade commit's first-parent tree).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobId"],
      properties: {
        jobId: { type: "string", description: "The job whose upgrade commit should be reverted." },
        upgradeCommitSha: { type: "string", description: "Override the commit to revert (defaults to the job record's commitSha)." },
      },
    },
    async handler(args) {
      const rec = getJob(args.jobId);
      if (!rec) throw notFoundError(args.jobId);
      const upgradeCommitSha = args.upgradeCommitSha ?? rec.commitSha;
      if (!upgradeCommitSha) throw validationError(`Job ${args.jobId} has no commitSha to roll back.`, ["upgradeCommitSha"]);
      if (!rec.coords?.owner || !rec.coords?.repo) throw validationError(`Job ${args.jobId} has no repo coordinates.`);
      const res = await rollbackApi({
        coords: { owner: rec.coords.owner, repo: rec.coords.repo, defaultBranch: rec.coords.defaultBranch ?? rec.coords.branch },
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
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        environments: {
          type: "array",
          items: { type: "string" },
          description: "Restrict the scan to these environment names (e.g. [\"Production\"]). Omit to scan all environments.",
        },
        staleMuleBelow: { type: "string", description: 'Mule versions strictly below this are flagged (default "4.5.0").' },
        targetJava: { type: "number", description: "Java majors below this are flagged (default 17)." },
        resolveRepos: { type: "boolean", description: "Map stale app names to GitHub repos (default true)." },
      },
    },
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
    name: "scan_notify",
    description:
      "Proactive push: run the fleet scan and, when apps that need the Java 17 upgrade have CHANGED since the last " +
      "run (newly stale, changed reason, or resolved), push a Slack message. De-duplicated against remembered state " +
      "so re-running on a timer never re-spams the same list. Intended to be called on a schedule (cron / loop / CI). " +
      "Non-fatal and env-gated: no SLACK_WEBHOOK_URL means the push is cleanly skipped.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        environments: {
          type: "array",
          items: { type: "string" },
          description: "Restrict the scan to these environment names. Omit to scan all environments.",
        },
        alwaysNotify: { type: "boolean", description: "Push the full current list every run (periodic digest), ignoring the change diff." },
        dryRun: { type: "boolean", description: "Compute and return the message without sending to Slack or persisting the baseline." },
      },
    },
    async handler(args) {
      return await scanAndNotify({
        environments: args.environments,
        alwaysNotify: args.alwaysNotify,
        dryRun: args.dryRun,
      });
    },
  },
];

/** Map of name -> tool for O(1) dispatch. */
export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The tools/list payload shape (name/description/inputSchema only). */
export function toolCatalog() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}
