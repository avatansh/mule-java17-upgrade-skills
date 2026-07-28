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
 * jiraCreateIssue({appName, jobId}): auto-create a migration ticket (pf-jira-create-issue).
 * Only fires when JIRA_AUTO_CREATE=true and creds+projectKey present. Returns {key} or {skipped}.
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
