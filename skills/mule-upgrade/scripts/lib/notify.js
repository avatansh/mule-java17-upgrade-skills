// lib/notify.js — Slack + Jira notifications (port of system/notify.xml).
//
// Every function here is NON-FATAL and env-gated, exactly like the Mule <try>-wrapped notify
// sub-flows: a notification outage must never fail the upgrade pipeline. Each returns a small
// {sent, skipped?, error?} result the orchestrator can log but never throws.
//
//   Slack : POST to SLACK_WEBHOOK_URL   (pf-notify / pf-notify-failure / pf-notify-event)
//   Jira  : POST /rest/api/3/issue/{key}/comment  (pf-jira-comment) — ADF doc body
//           POST /rest/api/3/issue                 (pf-jira-create-issue) — auto-create ticket
//
// Auth: JIRA_BASE_URL + JIRA_EMAIL + JIRA_API_TOKEN (basic). All optional — absent → skipped.
//
// Credentials resolve from ENV first (SLACK_WEBHOOK_URL / JIRA_* — plaintext, so a developer can
// override without the key), then the layered config (`slack.webhookUrl` / `slack.channel` /
// `jira.baseUrl` / `jira.email` / `jira.apiToken` / `jira.projectKey` / `jira.issueType` /
// `jira.autoCreate`, decrypted from the secure YAML via MULE_CONFIG_KEY). Absent everywhere →
// the notification is cleanly skipped, never a hard failure.

import { get } from "../../../../lib_shared/config.js";
import { getJob as defaultGetJob, patchJob as defaultPatchJob } from "../../../mule-upgrade-job/scripts/jobstore.js";

const env = process.env;

// Read a config value, swallowing any decrypt/lookup error (missing key etc.) → fallback.
function cfg(dotted, fallback) {
  try {
    const v = get(dotted, undefined);
    return v === undefined || v === null || v === "" ? fallback : v;
  } catch {
    return fallback;
  }
}

// ── per-run notification preferences (OPT-IN) ───────────────────────────────────────────
// Credentials being present is NOT consent. A configured Slack webhook / Jira token only makes
// delivery *possible*; the caller must still ask for it. So every job carries an explicit
// `notifyPrefs`, and anything missing or malformed resolves to SILENT. A code path that forgets to
// thread prefs through can therefore never spam a channel or open a ticket on its own.
//
// The interactive conductor asks ONCE at the start of a session and reuses the answer for every job it
// starts. There is deliberately no session object here: the answer is stamped on each job record at
// creation, which is stricter than session scope — an opted-out job stays silent forever, in any later
// reconcile sweep, status refresh, or webhook, from any process. The trade-off is that it cannot be
// changed retroactively; flipping the preference affects newly created jobs only.
//
//   slack : true → post lifecycle alerts for this job
//   jira  : "none"    → never touch Jira (default)
//           "comment" → comment on the SUPPLIED jiraTicketId, but never create one
//           "create"  → create a migration ticket when none was supplied, then comment on it

/** The opt-in default: no Slack, no Jira. */
export const NOTIFY_DEFAULTS = Object.freeze({ slack: false, jira: "none" });

/**
 * resolveNotifyPrefs(prefs): normalize a per-run preference object to {slack:boolean, jira:string}.
 * Unknown/absent input → NOTIFY_DEFAULTS (silent), so opt-in is the only way to enable delivery.
 * @param {{slack?:any, jira?:any}|null|undefined} prefs
 * @returns {{slack:boolean, jira:"none"|"comment"|"create"}}
 */
export function resolveNotifyPrefs(prefs) {
  const p = prefs && typeof prefs === "object" ? prefs : {};
  const jira = p.jira === "create" || p.jira === "comment" ? p.jira : "none";
  return { slack: p.slack === true, jira };
}

async function postJson(fetchImpl, url, headers, body) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`POST ${url} → ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

/** slackNotify(text): post a message to SLACK_WEBHOOK_URL. Non-fatal + self-guarding. */
export async function slackNotify(
  text,
  {
    fetchImpl = globalThis.fetch,
    webhookUrl = env.SLACK_WEBHOOK_URL ?? cfg("slack.webhookUrl", ""),
    channel = env.SLACK_CHANNEL ?? cfg("slack.channel", ""),
  } = {}
) {
  if (!webhookUrl) return { sent: false, skipped: "no SLACK_WEBHOOK_URL" };
  try {
    await postJson(fetchImpl, webhookUrl, {}, channel ? { channel, text } : { text });
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

/** jiraComment(ticket, text, url?): post an ADF comment. Non-fatal; skips when no ticket/creds. */
export async function jiraComment(
  jiraTicketId,
  text,
  linkUrl = null,
  {
    fetchImpl = globalThis.fetch,
    baseUrl = env.JIRA_BASE_URL ?? cfg("jira.baseUrl", ""),
    email = env.JIRA_EMAIL ?? cfg("jira.email", ""),
    token = env.JIRA_API_TOKEN ?? cfg("jira.apiToken", ""),
  } = {}
) {
  if (!jiraTicketId) return { sent: false, skipped: "no jiraTicketId" };
  if (!baseUrl || !email || !token) return { sent: false, skipped: "no Jira creds" };
  const hasUrl = typeof linkUrl === "string" && linkUrl !== "";
  const content = [{ type: "text", text: String(text) }];
  if (hasUrl) {
    content.push({ type: "text", text: "  " });
    content.push({ type: "text", text: linkUrl, marks: [{ type: "link", attrs: { href: linkUrl } }] });
  }
  const body = { body: { type: "doc", version: 1, content: [{ type: "paragraph", content }] } };
  const auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
  try {
    await postJson(
      fetchImpl,
      `${baseUrl}/rest/api/3/issue/${jiraTicketId}/comment`,
      { Authorization: auth },
      body
    );
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

/**
 * jiraCreateIssue({appName, jobId}, {autoCreate}): create a migration ticket (pf-jira-create-issue).
 * Requires creds+projectKey AND consent. Consent is either the ambient JIRA_AUTO_CREATE / config
 * `jira.autoCreate` (both default false), or an explicit `autoCreate: true` passed by a caller whose
 * operator chose `notifyPrefs.jira = "create"` for this run. Returns {key} or {skipped}.
 */
export async function jiraCreateIssue(
  { appName, jobId },
  {
    fetchImpl = globalThis.fetch,
    baseUrl = env.JIRA_BASE_URL ?? cfg("jira.baseUrl", ""),
    email = env.JIRA_EMAIL ?? cfg("jira.email", ""),
    token = env.JIRA_API_TOKEN ?? cfg("jira.apiToken", ""),
    projectKey = env.JIRA_PROJECT_KEY ?? cfg("jira.projectKey", ""),
    issueType = env.JIRA_ISSUE_TYPE ?? cfg("jira.issueType", "Task"),
    autoCreate = (env.JIRA_AUTO_CREATE ?? String(cfg("jira.autoCreate", "false"))) === "true",
  } = {}
) {
  if (!autoCreate) return { created: false, skipped: "autoCreate off" };
  if (!baseUrl || !email || !token || !projectKey)
    return { created: false, skipped: "no Jira creds/projectKey" };
  const body = {
    fields: {
      project: { key: projectKey },
      issuetype: { name: issueType },
      summary: `Java 17 upgrade: ${appName ?? "unknown app"}`,
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: `Automated migration ticket for app '${appName ?? "unknown"}' (job ${jobId ?? "?"}).`,
              },
            ],
          },
        ],
      },
    },
  };
  const auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
  try {
    const created = await postJson(fetchImpl, `${baseUrl}/rest/api/3/issue`, { Authorization: auth }, body);
    return { created: true, key: created.key };
  } catch (e) {
    return { created: false, error: e.message };
  }
}

// ── prebuilt message bodies (mirror the DWL text) ────────────────────────────────────────
export function prOpenedSlackText({ appName, prUrl, jobId, jiraTicketId, jiraBaseUrl = "", warnings = [] }) {
  let t =
    `:rocket: *Java 17 upgrade PR ready* — ${appName}\n${prUrl ?? "(no url)"}\n` +
    `Job ${jobId} • status PR_OPEN`;
  if (jiraTicketId) t += `\nJira: <${jiraBaseUrl}/browse/${jiraTicketId}|${jiraTicketId}>`;
  if (Array.isArray(warnings) && warnings.length) {
    t += `\n\n:warning: *Warnings*\n` + warnings.map((w) => `• ${w}`).join("\n");
  }
  return t;
}

/**
 * @param {object} opts
 * @param {any} opts.appName
 * @param {any} opts.jobId
 * @param {any} opts.status
 * @param {any} opts.error
 * @param {any} opts.jiraTicketId
 * @param {string} [opts.jiraBaseUrl]
 * @param {any} [opts.revertPrUrl]
 */
export function failureSlackText({
  appName,
  jobId,
  status,
  error,
  jiraTicketId,
  jiraBaseUrl = "",
  revertPrUrl,
}) {
  let t = `:x: *Java 17 upgrade FAILED* — ${appName}\nJob ${jobId} • status ${status}\nError: ${error}`;
  if (jiraTicketId) t += `\nJira: <${jiraBaseUrl}/browse/${jiraTicketId}|${jiraTicketId}>`;
  if (revertPrUrl) t += `\n:leftwards_arrow_with_hook: Rollback PR: ${revertPrUrl}`;
  return t;
}

// ── job STATE-CHANGE notifier (Slack + Jira on every lifecycle transition) ───────────────────────
//
// WHY: PR_OPEN and hard-failures are alerted inline by orchestrate.js at submit time, but everything
// AFTER that (merge → DEPLOYING → DEPLOYED, MUnit/dep-guard park & resume, PR closed-unmerged, deploy
// failure, crash → interrupted) is discovered LATER by the reconcile sweep — which usually runs only
// when someone calls get_job_status ("check status now") or the reconcile tool. Without a notifier
// wired into those paths, those state changes were silent. This factory produces the `notify(event,
// rec)` hook that reconcile / ci_ingest already call, so a Slack alert + Jira comment fire on EACH
// transition, even one that surfaces during a status read.
//
// Opt-in: each alert is gated on the job's own `notifyPrefs` (see resolveNotifyPrefs), so a run whose
// operator declined Slack/Jira stays silent no matter which sweep discovers its transitions.
//
// Exactly-once per status: it re-reads the authoritative record and compares against a persisted
// `notifiedStatus`. Repeated status polls that don't change the enum do NOT re-alert; sub-stage-only
// updates (e.g. MUNIT_PASSED while the enum stays PR_OPEN) are intentionally not separately alerted.
// orchestrate.js seeds `notifiedStatus` for the PR_OPEN / failure alerts it sends itself, so this
// notifier never duplicates them.

/** Human-facing Slack copy per job status. Unknown statuses fall back to a neutral line. */
const STATUS_SLACK = {
  PR_OPEN: { emoji: ":rocket:", label: "PR open — ready for review/merge" },
  MUNIT_FAILED: { emoji: ":warning:", label: "MUnit tests failed — paused for a human fix" },
  DEP_GUARD_FAILED: { emoji: ":warning:", label: "Java 17 dependency guard failed — paused for a human fix" },
  DEPLOYING: { emoji: ":hourglass_flowing_sand:", label: "PR merged — building & deploying" },
  DEPLOYED: { emoji: ":white_check_mark:", label: "Deployed & verified on Anypoint" },
  CLOSED: { emoji: ":no_entry_sign:", label: "PR closed without merging — lock released" },
  FAILED_DEPLOY: { emoji: ":x:", label: "Deployment failed / unhealthy on Anypoint" },
  FAILED_INTERRUPTED: { emoji: ":x:", label: "Interrupted (crash/restart before PR) — re-submit to retry" },
  FAILED_ASSESS: { emoji: ":x:", label: "Assessment failed" },
  FAILED_COMMIT: { emoji: ":x:", label: "Commit / transform failed" },
  NO_CHANGE: { emoji: ":information_source:", label: "No changes required — already on target" },
  ROLLED_BACK: { emoji: ":leftwards_arrow_with_hook:", label: "Rolled back (revert PR opened)" },
};

/** Fast-transient early stages (mirror reconcile's EARLY_STAGES) — never alerted on their own. */
const SILENT_STATUSES = new Set(["PROCESSING", "COMMITTING", "COMMITTED"]);

/**
 * jobTransitionSlackText(rec-ish): compose the Slack line for a job that just entered `status`.
 * @param {object} o
 * @param {string} o.status
 * @param {any} [o.appName]
 * @param {any} [o.jobId]
 * @param {any} [o.prUrl]
 * @param {any} [o.jiraTicketId]
 * @param {string} [o.jiraBaseUrl]
 * @param {any} [o.error]
 */
export function jobTransitionSlackText({ status, appName, jobId, prUrl, jiraTicketId, jiraBaseUrl = "", error }) {
  const meta = STATUS_SLACK[status] ?? { emoji: ":information_source:", label: `status ${status}` };
  let t = `${meta.emoji} *Java 17 upgrade — ${appName ?? "app"}*: ${meta.label}\nJob ${jobId} • status ${status}`;
  if (prUrl) t += `\nPR: ${prUrl}`;
  if (jiraTicketId) t += `\nJira: <${jiraBaseUrl}/browse/${jiraTicketId}|${jiraTicketId}>`;
  if (error && /FAIL/.test(String(status))) t += `\nError: ${error}`;
  return t;
}

/**
 * makeJobNotifier(deps): build the `(event, rec) => Promise<void>` hook consumed by reconcile.js and
 * ci_ingest.js. On each call it re-reads the job, and if the current status differs from the last
 * `notifiedStatus`, it fires Slack + a Jira comment (both non-fatal / env-gated) and records the new
 * `notifiedStatus`. NEVER throws — a notification outage must not break a reconcile sweep or a status
 * read.
 *
 * @param {object} [deps]
 * @param {(id:string)=>any}      [deps.getJob]      job reader (default: real job store)
 * @param {(id:string,p:object)=>any} [deps.patchJob] job patcher (default: real job store)
 * @param {(text:string)=>Promise<any>} [deps.slack] Slack sender (default: slackNotify)
 * @param {(ticket:any,text:string,url?:any)=>Promise<any>} [deps.jira] Jira commenter (default: jiraComment)
 * @param {string} [deps.jiraBaseUrl]
 * @returns {(event:any, rec:any)=>Promise<void>}
 */
export function makeJobNotifier(deps = {}) {
  const getJob = deps.getJob ?? defaultGetJob;
  const patchJob = deps.patchJob ?? defaultPatchJob;
  const slack = deps.slack ?? slackNotify;
  const jira = deps.jira ?? jiraComment;
  const jiraBaseUrl = deps.jiraBaseUrl ?? env.JIRA_BASE_URL ?? cfg("jira.baseUrl", "");

  return async function notifyJobTransition(_event, recArg) {
    try {
      const jobId = recArg?.jobId;
      if (!jobId) return;
      // Re-read the authoritative record: callers pass either the pre- or post-transition rec, so the
      // store is the single source of truth for the CURRENT status.
      const rec = getJob(jobId) ?? recArg;
      const status = rec?.status;
      if (!status || SILENT_STATUSES.has(status)) return;
      if (rec.notifiedStatus === status) return; // exactly-once per distinct status

      // Honor the per-run opt-in recorded on the job. A job created without prefs is silent, so a
      // sweep can never announce a run whose operator didn't ask for announcements. Returning BEFORE
      // the patch leaves the dedupe slot free, so enabling prefs later still alerts on the next change.
      const prefs = resolveNotifyPrefs(rec.notifyPrefs);
      const wantSlack = prefs.slack;
      const wantJira = prefs.jira !== "none" && Boolean(rec.jiraTicketId);
      if (!wantSlack && !wantJira) return;

      if (wantSlack) {
        await slack(
          jobTransitionSlackText({
            status,
            appName: rec.appName,
            jobId,
            prUrl: rec.prUrl,
            jiraTicketId: rec.jiraTicketId,
            jiraBaseUrl,
            error: rec.error,
          })
        );
      }
      if (wantJira) {
        const meta = STATUS_SLACK[status];
        await jira(
          rec.jiraTicketId,
          `Java 17 upgrade status: ${status}${meta ? ` — ${meta.label}` : ""} (job ${jobId}).`,
          rec.prUrl ?? null
        );
      }
      patchJob(jobId, { notifiedStatus: status, lastNotifiedAt: new Date().toISOString() });
    } catch {
      /* non-fatal — notifications must never break a sweep or a status read */
    }
  };
}
