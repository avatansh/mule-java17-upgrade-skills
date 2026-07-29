---
name: mule-upgrade-mcp
description: >-
  Run the Java 17 upgrade suite as a hosted MCP + REST server so remote agents (e.g.
  Agentforce) can drive it over the network. Exposes the 13 upgrade tools over MCP
  JSON-RPC and a plain REST facade, plus HMAC-verified CI/CD webhooks. Use this when
  the user says things like "start the MCP server", "expose the upgrade tools to
  Agentforce", "run the upgrade server", "how do agents call these tools remotely",
  or "set up the webhook endpoint for CI results". For a local one-shot upgrade run
  inside an IDE, use the mule-upgrade orchestrator skill directly instead.
---

# mule-upgrade-mcp (hosted server)

Ports the Platform Lifecycle Orchestrator's shared HTTP listener + `mcp:tool-listener`
into a single Node `http.Server`. One process, one port, four surfaces:

| Surface | Route | Auth | Purpose |
|---------|-------|------|---------|
| **MCP JSON-RPC** | `POST /mcp` (config `mcp.endpointPath`) | Bearer | `initialize` / `tools/list` / `tools/call` |
| **REST facade** | `GET /api/v1/tools`, `POST /api/v1/tools/{name}` | Bearer | call a tool directly without JSON-RPC |
| **CI/CD webhooks** | `POST /webhook`, `POST /webhook/cd-result` | **HMAC** | drive the job state machine from CI results |
| **Health** | `GET /health` | open | liveness probe |

The MCP + REST surfaces share the **bearer guard**; the webhooks use **HMAC** (never the
bearer), exactly like the Mule app. Everything auto-loads the `.env` file via
`lib_shared/env.js`, so a bare `node server/server.js` picks up config + secrets with no
extra flags.

## Run

> **CRITICAL — the server is NOT inside this skill folder.** `server/server.js` lives at the
> **suite root** (the cloned `mule-java17-upgrade-skills`), *not* under
> `…/skills/mule-upgrade-mcp/`. Running `node server/server.js` from the skill directory fails with
> `Cannot find module …\skills\mule-upgrade-mcp\server\server.js` (`MODULE_NOT_FOUND`). **Never
> construct a `server/` path under this skill.** Use the launcher below (it resolves the suite root
> from its own location) or point directly at the clone.

**Execution contract for the agent:**
1. **Start it with the launcher**, using the *absolute path to this skill's* `scripts/start_server.mjs`
   (the same directory this `SKILL.md` was loaded from). The launcher walks up to the suite root and
   starts `server/server.js` there — cwd-independent:
   ```bash
   node "<this-skill-dir>/scripts/start_server.mjs"
   ```
   Example on this machine (skill symlinked into the Vibes global store):
   ```powershell
   node "C:\Users\avatansh.sharma\AppData\Roaming\Code\User\globalStorage\salesforce.mule-dx-vscode\Rules\skills\mule-upgrade-mcp\scripts\start_server.mjs"
   ```
2. **Run it in the BACKGROUND / as a long-running task.** It is a server — it does not return; it
   listens until stopped. Do not wait for it to "complete."
3. If the launcher reports it can't find the server, the skill was **copied, not symlinked** — see the
   fallback and the fix note below.

**Fallback — run directly from the clone** (when you know the suite root; `server/` is a sibling of
`skills/`, never a child):

```bash
node "<suite-root>/server/server.js"
# e.g. node "C:\Workspaces\7.25\mule-java17-upgrade-skills\server\server.js"
```

Expected startup (to stderr):

```text
[mule-java17-upgrade-skills] listening on http://0.0.0.0:8080
  Environment  : dev (config-dev.yaml + config-secure-dev.yaml)
  MCP JSON-RPC : POST /mcp
  REST tools   : GET /api/v1/tools · POST /api/v1/tools/{name}
  Webhooks     : POST /webhook · POST /webhook/cd-result (HMAC)
  Health       : GET /health · GET /metrics
  Bearer auth  : OFF (open — set MCP_BEARER_TOKEN to require)
```

Then confirm from a second terminal: `curl -s localhost:8080/health`.

Port resolves from `MCP_SERVER_PORT`, else config `http.port`, else `8080`. Host from
config `http.host`, else `0.0.0.0`.

> **Prerequisites (fail-fast):** the server refuses to boot without `MULE_UPGRADE_ENV` (exit code 2)
> and reads secrets/config from the suite-root `.env` + `config-<env>.yaml` (needs `MULE_CONFIG_KEY`).
> Set these in the **suite root** `.env`, and run `npm ci` in the clone once. See `docs/SETUP-VIBES.md`.
>
> **Why `MODULE_NOT_FOUND` happens and how to fix it for good:** Vibes skills should be **symlinked**
> into the skills directory, never copied. When copied, only `SKILL.md` (and now `scripts/`) exist in
> isolation — the sibling `server/`, `lib_shared/`, and `config/` at the suite root are unreachable.
> Re-install every skill as a symlink to the single clone (see `docs/SETUP-VIBES.md` → Option A →
> "symlink"), then reload the window. After that the launcher resolves the suite root correctly.

## Auth model

- **Bearer** — `MCP_BEARER_TOKEN`. When **unset the guard is OFF** (open, for local dev).
  When set, clients must send `Authorization: Bearer <token>`; the compare is
  constant-time. This protects `/mcp` and `/api/v1/*`.
- **HMAC** — `GITHUB_WEBHOOK_SECRET` (decrypted from `github.webhookSecret`). The server
  computes `sha256=<hex HMAC-SHA256(secret, rawBody)>` over the **exact received bytes**
  and constant-time-compares it against:
  - `x-hub-signature-256` on `POST /webhook`
  - `x-cd-signature-256` on `POST /webhook/cd-result` (plus a transitional
    `x-cd-token == secret` fallback for CD pipelines that can't HMAC-sign yet).
- Delivery **de-dup**: `x-delivery-id` / `x-github-delivery` (else a sha256 of the body)
  is recorded via `jobstore.markOnce`; a repeated delivery short-circuits to the last-known
  job status without re-applying the transition.

## The 13 tools

Six are parity with the Mule MCP tools; the rest (`upgrade_parent_pom`,
`update_open_pr_parent_ref`, `reconcile`, `rollback`, `scan_fleet`, `scan_notify`,
`resolve_versions`, `check_drift`) are added:

| Tool | Does |
|------|------|
| `assess_app` | Assess a repo/app → LEAN ChangePlan (incl. `connectorsInApp[]`) + verbatim deployed-state check (no writes). Version menu / drift are opt-in (`includeVersions` / `includeDrift`) |
| `start_upgrade` | Full pipeline: assess → apply → commit → PR → job PR_OPEN (accepts `versionStrategy` + `connectorSelections` + `deployedApiName` + `parentRef`) |
| `get_job_status` | Job record + status message + `nextPollSeconds`; auto-refreshes live PR/CI state and attaches a live Runtime Manager `deployedState` |
| `reapply_job` | Re-seed coordinates under a fresh jobId |
| `delete_job` | Remove record, clear branch index, release lock |
| `upgrade_parent_pom` | Parent/BOM pom minor-bump + connector pinning → PR (tracked job) |
| `update_open_pr_parent_ref` | Fold the app's `<parent>` version repoint into an already-open upgrade PR (chained parent/BOM flow) |
| `reconcile` | Sweep stale jobs (poll PR/CI, verify deploy, release locks) |
| `rollback` | Revert a job's PR (revert branch + revert PR) |
| `scan_fleet` | Audit the Anypoint fleet for apps still on old Mule/Java → candidate list |
| `scan_notify` | Fleet scan + de-duped Slack alert when new stale apps appear |
| `resolve_versions` | App-SCOPED per-connector version menu (current + matrix pin + first-compatible + latest-in-major + latest), live-enriched, non-fatal |
| `check_drift` | Advisory audit of whether the bundled matrix is stale (gating pins + connector staleness vs live data); never writes the matrix |

Every tool's `inputSchema` is enforced by the **schema-contract guard** (`server/lib/schema.js`)
*before* the handler runs. On MCP a violation is a JSON-RPC `-32602` with a `problems` list;
on REST it's `400 {error, problems}`. A handler that throws a domain error surfaces as an MCP
tool-error result (`isError:true`) — not a protocol error — and on REST maps
`NOT_FOUND→404 / VALIDATION→400 / CONFLICT→409 / else 500`.

## Talking to it

MCP handshake + list:

```bash
curl -sX POST localhost:8080/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
curl -sX POST localhost:8080/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

Call a tool over MCP:

```bash
curl -sX POST localhost:8080/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call",
       "params":{"name":"get_job_status","arguments":{"jobId":"job-…"}}}'
```

Or over REST (identical validation + result payload):

```bash
curl -s localhost:8080/api/v1/tools
curl -sX POST localhost:8080/api/v1/tools/assess_app \
  -H 'content-type: application/json' \
  -d '{"owner":"acme","repo":"orders-api"}'
```

With a bearer token set, add `-H "authorization: Bearer $MCP_BEARER_TOKEN"`.

## Webhooks (CI → job store)

A CI/CD job posts its result back so the state machine advances without polling:

```bash
BODY='{"jobId":"job-…","result":"failure","stage":"test"}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" -r | cut -d' ' -f1)"
curl -sX POST localhost:8080/webhook/cd-result \
  -H "x-cd-signature-256: $SIG" -H 'content-type: application/json' -d "$BODY"
```

`stage:test`+`failure` parks the job at `MUNIT_FAILED`; a dependency-guard failure →
`DEP_GUARD_FAILED`; `stage:deploy`+`success` → `DEPLOYED` (optionally confirmed against
Anypoint when a deploy verifier is wired in). All webhook handling is non-fatal to the
server: a handler returns `{statusCode, body}` and never crashes the listener.

## Files

- `server/server.js` — the HTTP server + routing (`route`, `createServer` exported for tests).
- `server/lib/mcp.js` — JSON-RPC 2.0 dispatcher (`handleRpc`).
- `server/lib/tools.js` — the 13-tool catalog + handlers.
- `server/lib/schema.js` — dependency-free JSON-Schema validator (the contract guard).
- `server/lib/auth.js` — bearer guard + webhook HMAC verify.
- `server/lib/webhook.js` — CI/CD callback → `ci_ingest` bridge with delivery de-dup.
- Tests: `tests/server.test.js`.

See `docs/SETUP-AGENTFORCE.md` for wiring this server into Agentforce as an external MCP
endpoint, and `docs/SETUP-IDE.md` for the local (no-server) skill workflow.
