# Setup — MuleSoft Vibes (Anypoint Code Builder)

Run the Java-17 upgrade suite inside **MuleSoft Vibes**, the AI dev agent embedded in
**Anypoint Code Builder** (VS Code–based; also runs in Cursor / Windsurf / Trae). Vibes natively
speaks the **Agent Skills / Claude Code `SKILL.md`** format *and* can connect to an external MCP
server, so this suite plugs in two ways with no code changes:

- **Option A — Skills** (recommended): drop the `SKILL.md` skills into Vibes' skills directory;
  Vibes activates them by trigger phrase via its `use_skill` tool. No server, no ports.
- **Option B — Remote MCP server**: run `server/server.js` and register it in Vibes as a remote
  MCP server; the 12 tools appear with their schemas. Best for the stateful tools + HMAC webhooks,
  or if your Vibes runtime sandboxes skill script execution.

> Sibling guides: [SETUP-IDE.md](./SETUP-IDE.md) (generic Claude Code) ·
> [SETUP-AGENTFORCE.md](./SETUP-AGENTFORCE.md) (hosted server for Agentforce). Vibes reuses the
> exact same skill scripts and job store underneath.
>
> **Wiring ALL four live integrations (Anypoint + GitHub + Jira + Slack) and testing every
> function in Vibes?** See **[WIRE-LIVE-INTEGRATIONS.md](./WIRE-LIVE-INTEGRATIONS.md)** — the
> full credential-wiring + per-tool live-test runbook.

---

## 1. Prerequisites

| Need | Why |
|------|-----|
| **Anypoint Code Builder** with **MuleSoft Vibes** enabled | the host agent |
| **Node.js ≥ 24** on the machine ACB runs on | runs the skill scripts / the server |
| **git** + **gh** (authenticated) | `local` mode: branch/commit/push/PR |
| A **GitHub token** (`GITHUB_TOKEN`) | `api` mode: Git Data API commits + PRs |
| *(optional)* Anypoint / Slack / Jira creds | deploy verify + notifications (env-gated) |

Clone the suite somewhere ACB can reach and install its one dependency:

```bash
git clone <this-repo> mule-java17-upgrade-skills
cd mule-java17-upgrade-skills
npm ci
node --test          # sanity: the whole suite should pass
```

Configure secrets the same way as the IDE flow — copy `.env.example` to `.env` and set at least
`MULE_CONFIG_KEY` (to read the encrypted YAML) and `MULE_UPGRADE_ENV`. `.env` auto-loads via
`lib_shared/env.js`. **Never commit `.env` or the real key.**

> **Where do the commands run, and do I need the Salesforce CLI?** Every `node …` command below
> runs in a **plain terminal on the machine ACB/Vibes runs on**, from the cloned suite root — not
> inside any DX/Anypoint runtime. You do **not** need the Salesforce / `sf` / `sfdx` CLI; this
> suite only uses `node` (required) and `git` + `gh` (local-mode PRs). SF CLI, and any *"Token
> exchange timed out"* against the Anypoint **DX** server, are a separate concern.

---

## 1a. Test it locally, end-to-end (before wiring Vibes)

Prove the pipeline works from a terminal first — it isolates suite problems from Vibes-integration
problems, and needs **no live credentials** (every network call degrades gracefully):

```bash
cd mule-java17-upgrade-skills
npm ci && node --test                                   # 310 tests, no secrets/network needed

# assess a throwaway Mule 4.6–4.8 / Java 8|11 clone (read-only, fully offline):
node skills/mule-upgrade-assess/scripts/assess.js --repo /path/to/target-app --no-fetch

# safe dry runs (no creds required):
node skills/mule-upgrade-assess/scripts/lib/matrix_drift.js --no-fetch     # advisory drift audit
node skills/mule-upgrade-scan/scripts/scan_notify.js --dry-run             # fleet scan digest

# a real upgrade → PR (local mode needs git+gh; api mode needs GITHUB_TOKEN):
node skills/mule-upgrade/scripts/upgrade.js start --app orders-api --mode local --repo /path/to/clone
```

Set `MULE_UPGRADE_HOME=./.local-jobstore` in `.env` to keep test jobs out of your real store, then
`cat ./.local-jobstore/jobs/*.json` to watch the state machine. Missing GitHub/Anypoint/Slack/Jira
creds cause the matching step to skip or error clearly — never a crash. See
[SETUP-IDE.md §7](./SETUP-IDE.md) for the full step-by-step walkthrough. Once this works, wire Vibes
via Option A or B below.

---

## Option A — Install as Vibes Skills (recommended)

Vibes reads the same `SKILL.md` format this suite ships (name + trigger-phrase `description`
frontmatter, plus `scripts/` and `references/`). Install into one of two scopes:

- **Workspace scope** — `.a4drules/skills/` at the root of the ACB workspace. Committable, so the
  whole team gets the skills with the repo. **Use this for project-pinned upgrades.**
- **Global scope** — Vibes' global skills storage (or the Claude Code target `.claude/skills`),
  so the skills trigger in every workspace.

### A.1 — Copy the 8 skills into the workspace

From the root of the ACB workspace where you want the skills available:

```bash
mkdir -p .a4drules/skills

# point at wherever you cloned the suite
SUITE=/path/to/mule-java17-upgrade-skills

# copy each skill folder verbatim (SKILL.md + scripts/ + references/)
cp -R "$SUITE"/skills/mule-upgrade-agent       .a4drules/skills/
cp -R "$SUITE"/skills/mule-upgrade             .a4drules/skills/
cp -R "$SUITE"/skills/mule-upgrade-assess      .a4drules/skills/
cp -R "$SUITE"/skills/mule-upgrade-apply       .a4drules/skills/
cp -R "$SUITE"/skills/mule-upgrade-pr          .a4drules/skills/
cp -R "$SUITE"/skills/mule-upgrade-parent-pom  .a4drules/skills/
cp -R "$SUITE"/skills/mule-upgrade-job         .a4drules/skills/
cp -R "$SUITE"/skills/mule-upgrade-scan        .a4drules/skills/
# mule-upgrade-mcp documents the hosted server — copy it only if you also run Option B
```

The layout Vibes expects:

```
<workspace>/
└── .a4drules/
    └── skills/
        ├── mule-upgrade-agent/      # interactive conductor — "walk me through the Java 17 upgrade"
        ├── mule-upgrade/            # orchestrator — "upgrade <app> to Java 17"
        │   ├── SKILL.md
        │   └── scripts/…
        ├── mule-upgrade-assess/
        ├── mule-upgrade-apply/
        ├── mule-upgrade-pr/
        ├── mule-upgrade-parent-pom/
        ├── mule-upgrade-job/
        └── mule-upgrade-scan/       # fleet audit + proactive Slack push
```

> **Important — shared scripts:** the skill scripts import from the suite's `lib_shared/`,
> `config/`, and `server/` directories, which live at the **suite root**, not inside each skill.
> The cleanest install is to keep the cloned suite intact and **symlink** the skill folders into
> `.a4drules/skills/` (so `../../lib_shared` still resolves), rather than copying folders out of
> the tree:
>
> ```bash
> ln -s "$SUITE"/skills/mule-upgrade            .a4drules/skills/mule-upgrade
> ln -s "$SUITE"/skills/mule-upgrade-assess     .a4drules/skills/mule-upgrade-assess
> # …and so on for the other 6
> ```
>
> On Windows use `mklink /D` (Command Prompt as admin) or `New-Item -ItemType SymbolicLink`.
> If you must copy instead of symlink, also copy the suite's `lib_shared/`, `config/`, and
> `server/` next to the skills and adjust the relative `import` paths accordingly.

### A.2 — Reload and confirm

1. Reload the ACB window (or restart Vibes) so it re-scans the skills directory.
2. Open the Vibes Skills panel — the 8 skills should appear under **Workspace** scope.
3. Vibes activates a matching skill through its `use_skill` tool when your prompt matches a
   skill's trigger phrases.

### A.3 — Drive it in natural language

| You say to Vibes | Skill it uses |
|------------------|---------------|
| "Assess this repo for the Java 17 upgrade" | `mule-upgrade-assess` |
| "Upgrade orders-api to Java 17 and open a PR" | `mule-upgrade` (orchestrator) |
| "What's the status of job job-…?" | `mule-upgrade-job` |
| "Poll the merge/deploy tail" | `mule-upgrade` (`poll`) |
| "Upgrade the shared parent/BOM pom in …" | `mule-upgrade-parent-pom` |
| "Roll back the PR for job job-…" | `mule-upgrade-job` |
| "Scan the fleet for apps still on old Mule/Java" (and alert me on Slack) | `mule-upgrade-scan` |

Each `SKILL.md` documents the exact `node …` command; Vibes runs it and reports the ChangePlan /
PR / job outcome.

> **Runtime note:** these skills execute `node` scripts under `scripts/`. That works when the
> Vibes runtime permits skill script execution (the normal Claude Code skills behavior). If your
> Vibes instance restricts skills to instructions-only, the `SKILL.md` prose still guides the
> agent, but run the scripts through **Option B** (the MCP server) instead.

---

## Option B — Register the hosted MCP server

Use this for the 12 tools as first-class Vibes tools (with per-tool auto-approve/timeout controls)
and for event-driven CI/CD via the HMAC webhook — or whenever skill script execution is sandboxed.

### B.1 — Start the server

```bash
cd /path/to/mule-java17-upgrade-skills
MCP_BEARER_TOKEN=<long-random-string> node server/server.js
# listening on http://0.0.0.0:8080  →  MCP JSON-RPC at POST /mcp
```

Set `MCP_BEARER_TOKEN` for any non-local exposure (unset = open). Put TLS in front for a remote host.

### B.2 — Add it in Vibes (Remote MCP Server)

**Via the UI:** Vibes → **MCP Servers → Remote Servers → Add a Remote MCP Server**

- **Server Name:** `mule-java17-upgrade`
- **Service URL:** `http://localhost:8080/mcp` (or your `https://<host>/mcp`)
- **Header:** `Authorization: Bearer <MCP_BEARER_TOKEN>`

**Or edit `a4d_mcp_settings.json`** directly:

```jsonc
{
  "mcpServers": {
    "mule-java17-upgrade": {
      "type": "streamableHttp",
      "url": "http://localhost:8080/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_BEARER_TOKEN>"
      }
    }
  }
}
```

### B.3 — Confirm

Reload Vibes; the server's 12 tools appear in the **Installed** tab — `assess_app`,
`start_upgrade`, `get_job_status`, `reapply_job`, `delete_job`, `upgrade_parent_pom`,
`reconcile`, `rollback`, `scan_fleet`, `scan_notify`, `resolve_versions`, `check_drift` — each with
enable/auto-approve/timeout
controls. Invoke them by asking
Vibes to assess/upgrade an app; it calls the tool and returns the JSON result. Wire the CI/CD
webhook exactly as in [SETUP-AGENTFORCE.md](./SETUP-AGENTFORCE.md) §6.

---

## 3. Which option should I use?

| If you want… | Use |
|--------------|-----|
| Hands-on upgrades pinned to a project, no server | **Option A** (workspace skills) |
| The skills available in every ACB workspace | **Option A** (global scope) |
| First-class tools with per-tool controls + HMAC webhook / event-driven CD | **Option B** (MCP server) |
| Skill script execution is sandboxed in your Vibes instance | **Option B** |

Both share the identical skill scripts and the `~/.mule-upgrade/` JSON job store, so you can mix
them (e.g. skills for assess/upgrade, server for the webhook-driven deploy tail).

---

## 4. Troubleshooting

- **Skills don't appear** → confirm the folders are under `.a4drules/skills/<skill>/SKILL.md`
  and reload the ACB window; check the frontmatter `name:` parses.
- **`Cannot find module '../../lib_shared/…'`** → you copied skill folders out of the suite tree;
  symlink them instead, or copy `lib_shared/`, `config/`, `server/` alongside and fix the imports.
- **"cannot decrypt secure property"** → `MULE_CONFIG_KEY` missing/wrong in the suite's `.env`.
- **Remote MCP server won't connect / 401** → check the Service URL ends in `/mcp` and the
  `Authorization: Bearer` header matches `MCP_BEARER_TOKEN`; some Vibes builds prompt for OAuth on
  `www-authenticate` — a static bearer header avoids that path.
- **API-mode 401/403 from GitHub** → `GITHUB_TOKEN` missing or lacks `repo` scope; `gh auth login`
  for local mode.

---

## References

- MuleSoft Vibes: <https://docs.mulesoft.com/anypoint-code-builder/mulesoft-vibes>
- Vibes Skills: <https://docs.mulesoft.com/anypoint-code-builder/vibes-skills>
- Vibes MCP servers: <https://docs.mulesoft.com/anypoint-code-builder/vibes-mcp-server>
- Agent Skills spec: <https://agentskills.io/specification>
