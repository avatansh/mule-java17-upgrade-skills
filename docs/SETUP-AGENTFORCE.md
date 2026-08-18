# Setup — Hosted MCP server for Agentforce (remote)

Run the upgrade suite as a **hosted server** that exposes the 13 tools over MCP JSON-RPC + a
REST facade, so a remote agent — **Agentforce** or any MCP client — can drive upgrades over the
network. This guide stands up the server, secures it, wires the CI/CD webhook callback, and
connects Agentforce.

> **In a hurry?** Jump to [§9 — Quick start: expose these tools to an Agentforce agent
> (end-to-end)](#9-quick-start-expose-these-tools-to-an-agentforce-agent-end-to-end): validate
> with MCP Inspector → expose over HTTPS → register in the Agentforce Registry → build + test one agent.

> For hands-on, interactive upgrades inside an IDE (no server), see
> [SETUP-IDE.md](./SETUP-IDE.md). The server reuses the exact same skill scripts underneath.

---

## 1. What you're standing up

One Node `http.Server` (`server/server.js`) with four surfaces on a single port:

| Surface | Route | Auth |
|---------|-------|------|
| MCP JSON-RPC | `POST /mcp` | Bearer |
| REST facade | `GET /api/v1/tools`, `POST /api/v1/tools/{name}` | Bearer |
| CI/CD webhooks | `POST /webhook`, `POST /webhook/cd-result` | **HMAC** |
| Health | `GET /health` | open |

The 13 tools: `assess_app`, `resolve_versions`, `check_drift`, `start_upgrade`, `get_job_status`,
`reapply_job`, `delete_job`, `upgrade_parent_pom`, `update_open_pr_parent_ref`, `reconcile`,
`rollback`, `scan_fleet`, `scan_notify`. Every call is validated against the tool's JSON Schema
(the **schema-contract guard**) before the handler runs.

**Confirm-before-write.** For a human-in-the-loop agent, call `start_upgrade` with `dryRun: true`
first: it assesses and returns the full plan (`PLAN_PREVIEW` — file edits, connector choices,
warnings, deployed-state) while acquiring **no lock**, creating **no job**, and opening **no PR**.
Show the preview, get an explicit yes, then re-call with the identical arguments and `dryRun: false`
to execute. See `AGENTS.md` at the repo root for the full guardrails and intent→tool routing.

---

## 2. Prerequisites

- **Node.js ≥ 24** on the host.
- A network path from Agentforce (and your CI) to the host — a public URL or tunnel (a reverse
  proxy terminating TLS in front is strongly recommended; the server speaks plain HTTP).
- The same secrets as the IDE flow: `MULE_CONFIG_KEY` (to read encrypted YAML) or plaintext
  `GITHUB_TOKEN` etc.

```bash
git clone <this-repo> mule-java17-upgrade-skills
cd mule-java17-upgrade-skills
npm ci
node --test          # sanity check
```

> **Where do these commands run, and do I need the Salesforce CLI?** In a **plain terminal on the
> host**, from the cloned suite root — not inside any DX/Anypoint runtime. You do **not** need the
> Salesforce / `sf` / `sfdx` CLI; this suite (and its server) only use `node` (required) and
> `git` + `gh` (local-mode PRs). SF CLI, and any *"Token exchange timed out"* against the Anypoint
> **DX** server, are unrelated to this suite.

---

## 2a. Smoke-test the server locally, end-to-end (no live credentials needed)

Before exposing anything, prove the server runs on your own machine. Every downstream call
(GitHub, Anypoint, Slack, Jira, connector-matrix fetch) is env-gated and degrades gracefully, so a
bare local server is fully testable:

```bash
npm ci && node --test                 # full test suite — no secrets, no network

# minimal .env for a locked-down LOCAL test (see §3); keep test jobs isolated:
#   MCP_BEARER_TOKEN=local-test-token
#   MULE_UPGRADE_ENV=dev
#   MULE_UPGRADE_HOME=./.local-jobstore

node server/server.js                  # → listening on http://0.0.0.0:8080
```

In a second terminal, drive the 12 tools over the loopback interface — no TLS, no tunnel:

```bash
TOKEN=local-test-token
curl -s localhost:8080/health
curl -sX POST localhost:8080/mcp -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'                    # expect 13 tools

# call a read-only tool end-to-end against a throwaway clone (assess writes nothing).
# assess_app requires appName; pass repo for local-clone mode:
curl -sX POST localhost:8080/api/v1/tools/assess_app -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"appName":"orders-api","repo":"/path/to/target-app"}'
```

Missing GitHub/Anypoint/Slack creds simply make the corresponding tool skip or return a clear
error — never a crash. Once this works locally, put TLS in front (§4) and connect Agentforce (§5).

---

## 3. Configure `.env` (auto-loaded)

```bash
cp .env.example .env
```

Set at minimum:

```dotenv
# read the encrypted secrets shipped in config/config-secure-<env>.yaml
MULE_CONFIG_KEY=<16/24/32-char AES key>
MULE_UPGRADE_ENV=dev

# REQUIRE a bearer token on MCP + REST (leave empty ONLY for a locked-down local test)
MCP_BEARER_TOKEN=<long-random-string>

# port (default 8080)
MCP_SERVER_PORT=8080

# HMAC secret for the CI/CD webhook (also decryptable from github.webhookSecret in the YAML)
GITHUB_WEBHOOK_SECRET=<shared-hmac-secret>
```

`server/server.js` auto-loads `.env` via `lib_shared/env.js`. In a container/hosting platform you
can instead inject these as real environment variables (they override the YAML), and skip shipping
`MULE_CONFIG_KEY` entirely.

> **Security:**
> - When `MCP_BEARER_TOKEN` is **unset the bearer guard is OFF (open)** — never expose such an
>   instance to a network. Always set a strong token for any hosted deployment.
> - Webhooks are authenticated by **HMAC**, not the bearer. Keep `GITHUB_WEBHOOK_SECRET` secret.
> - Never commit `.env` or the real `MULE_CONFIG_KEY`.

---

## 4. Run the server

```bash
node server/server.js
# [mule-java17-upgrade-skills] listening on http://0.0.0.0:8080
#   MCP JSON-RPC : POST /mcp
#   REST tools   : GET /api/v1/tools · POST /api/v1/tools/{name}
#   Webhooks     : POST /webhook · POST /webhook/cd-result (HMAC)
#   Health       : GET /health
#   Bearer auth  : ON
```

Smoke-test locally (with the bearer token):

```bash
TOKEN="$MCP_BEARER_TOKEN"
curl -s localhost:8080/health
curl -sX POST localhost:8080/mcp -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
curl -sX POST localhost:8080/mcp -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

Run it as a long-lived service behind TLS (systemd unit, container, or your platform of choice).
`GET /health` is unauthenticated for load-balancer probes.

---

## 5. Connect Agentforce (overview)

Agentforce reaches this server as an **external MCP server** registered in the **Agentforce
Registry** (Salesforce Setup). Two hard requirements from Salesforce:

- **Public HTTPS + Streamable HTTP transport.** Expose `https://<host>/mcp` over TLS. The server
  speaks JSON-RPC request/response over `POST /mcp` (`initialize` → `tools/list` → `tools/call`),
  which is the non-streaming Streamable-HTTP shape Agentforce needs.
- **OAuth 2.0 for authentication.** The Registry wizard authenticates through a Named Credential +
  External Credential that *it generates* — it does **not** accept a static header. This server
  ships a **static bearer** guard (`MCP_BEARER_TOKEN`), so for the native Registry path you put an
  **OAuth-capable proxy/gateway in front** that terminates Salesforce's OAuth token and injects the
  upstream `Authorization: Bearer <MCP_BEARER_TOKEN>` (see §9, Part C).

Once connected, Agentforce calls `initialize` then `tools/list` (the 13 tools appear with their
input schemas); invoking a tool sends `tools/call`. Schema violations surface as JSON-RPC `-32602`
and domain failures as `isError:true` tool results.

Prefer plain REST over JSON-RPC (Apex/Flow callouts or External Services)? Point those at
`POST /api/v1/tools/{name}` with the same bearer header — identical validation and result payloads.

> **For the full click-by-click walkthrough** — validate with MCP Inspector, expose over HTTPS,
> register in the Registry, and build + test one agent — see **§9 Quick start** at the end.

---

## 6. Wire the CI/CD callback (event-driven deploy tail)

With a hosted server you can drive the job state machine from CI **push** instead of polling.
The reusable workflow `.github/workflows/ci-result.yml` posts an HMAC-signed result to
`POST /webhook/cd-result`. From an upgraded target repo's own pipeline:

```yaml
jobs:
  notify:
    if: always()
    uses: <owner>/mule-java17-upgrade-skills/.github/workflows/ci-result.yml@main
    with:
      job_id: ${{ needs.meta.outputs.job_id }}   # the jobId from the upgrade PR
      stage: test                                 # test | dependency-guard | deploy
      result: ${{ needs.munit.result }}           # success | failure
    secrets:
      server_url: ${{ secrets.UPGRADE_SERVER_URL }}       # https://<host>/webhook/cd-result
      webhook_secret: ${{ secrets.UPGRADE_WEBHOOK_SECRET }} # == GITHUB_WEBHOOK_SECRET
```

The signature is sent as `x-cd-signature-256: sha256=<hmac>` and verified against the raw body;
a `x-delivery-id` de-dups retries. Stage semantics:

- `stage=test` + `failure` → job parks at **MUNIT_FAILED**
- `stage=dependency-guard` + `failure` → **DEP_GUARD_FAILED** (+ violations report)
- `stage=deploy` + `success` → **DEPLOYED** (optionally confirmed against Anypoint); `failure` →
  **FAILED_DEPLOY**

> If you can't push callbacks, you don't need the webhook at all — run `reconcile` / the
> `poll` subcommand on a timer to poll `gh` + Anypoint. The state machine is identical either way.

---

## 7. Kick off upgrades from CI (optional)

`.github/workflows/upgrade.yml` is a `workflow_dispatch` shim that runs the orchestrator CLI in
CI — the same `start` pipeline, no IDE. Configure repo/org secrets it reads
(`UPGRADE_GITHUB_TOKEN`, `MULE_CONFIG_KEY`, `ANYPOINT_CLIENT_ID/SECRET`, `SLACK_WEBHOOK_URL`) and
dispatch with the app name + mode. All user inputs flow through quoted `env:` (never interpolated
into the shell) to avoid injection.

`.github/workflows/test.yml` runs the Node test suite on every push/PR.

---

## 8. Troubleshooting

- **401 on `/mcp` or `/api/v1/*`** → missing/incorrect `Authorization: Bearer` header, or
  `MCP_BEARER_TOKEN` mismatch.
- **401 on `/webhook/cd-result`** → HMAC mismatch: the CI `webhook_secret` must equal the
  server's `GITHUB_WEBHOOK_SECRET`, and the signature must be computed over the exact body bytes.
- **`-32602` from a tool call** → arguments failed the schema-contract guard; check the
  `data.problems` list in the error.
- **Tool returns `isError:true`** → a domain failure (e.g. `NOT_FOUND` for an unknown jobId); the
  text content carries `{error, code}`.
- **Server open with no auth** → you left `MCP_BEARER_TOKEN` empty; set it before exposing.

---

## 9. Quick start: expose these tools to an Agentforce agent (end-to-end)

The shortest path from a running server to a working Agentforce agent that can assess and upgrade
Mule apps. Assumes you already have an **Agentforce-enabled Salesforce org** and the **MCP
Inspector** (`@modelcontextprotocol/inspector`).

| Part | You do | Result |
|------|--------|--------|
| A | Validate the MCP surface with MCP Inspector (bearer) | Prove all 13 tools list + call |
| B | Expose the server over public HTTPS | A `https://…/mcp` URL |
| C | Put OAuth 2.0 in front (Registry requirement) | An OAuth-guarded endpoint |
| D | Register it in the Agentforce Registry | Named/External Credential + Permission Set |
| E | Assign the generated Permission Set | The agent user can call the tools |
| F | Build one agent (Topic + Actions + instructions) | A conversational upgrade agent |
| G | Test it in the preview | Assess → dry-run → confirm → PR |

### Part A — Validate the MCP surface with MCP Inspector (5 min, local)

Do this *before* touching Salesforce — it isolates "is my MCP server correct?" from "is my
Salesforce wiring correct?". With the server running locally (`node server/server.js`, bearer set):

```bash
npx @modelcontextprotocol/inspector
```

In the Inspector UI:

1. **Transport Type:** `Streamable HTTP`.
2. **URL:** `http://localhost:8080/mcp`.
3. **Authentication:** add a request header `Authorization` = `Bearer <MCP_BEARER_TOKEN>`.
4. Click **Connect** → the `initialize` handshake runs.
5. **Tools → List Tools** → you should see all **13** tools with their input schemas.
6. **Run a read-only tool:** `assess_app` with
   `{ "appName": "orders-api", "owner": "acme", "repo": "orders-api", "environment": "dev" }` →
   expect `ASSESSED` (or a clear `401: Bad credentials` if `GITHUB_TOKEN` isn't set — that's the
   tool working, just missing creds).
7. **Exercise the confirm-before-write gate:** `start_upgrade` with `"dryRun": true` → `PLAN_PREVIEW`,
   nothing written.

> This server implements **request/response JSON-RPC** (no server-initiated SSE streaming).
> Inspector's Streamable HTTP transport handles that fine, and Agentforce's request/response calls
> don't need SSE.

### Part B — Expose the server over public HTTPS

Agentforce runs in Salesforce's cloud, so `localhost` won't do — it needs a public TLS URL.

- **Fast tunnel (demo / PoC):**
  ```bash
  cloudflared tunnel --url http://localhost:8080
  # or
  ngrok http 8080
  ```
  Your MCP endpoint is then `https://<random>.trycloudflare.com/mcp` (or the ngrok host).
- **Production:** run `node server/server.js` as a service behind a TLS reverse proxy (Caddy/nginx)
  or your platform's ingress. `GET /health` stays open for probes.

Re-run Part A against the public `https://…/mcp` URL to confirm reachability + auth.

### Part C — Put OAuth 2.0 in front (the Registry's auth requirement)

The Agentforce Registry authenticates to an external MCP server with **OAuth 2.0** (it generates a
Named/External Credential and sends a token) — it will not send a fixed `Authorization: Bearer`
header. This server's guard is a **static bearer**, so bridge the two:

1. Stand up a thin **OAuth-capable gateway / reverse proxy** in front of `…/mcp` that:
   - **Validates** the OAuth 2.0 access token Salesforce presents (use the **client-credentials**
     grant — a service account; no per-user identity is needed for upgrades), and
   - **Injects** the upstream `Authorization: Bearer <MCP_BEARER_TOKEN>` when forwarding to Node.
2. Register the **gateway's** `/mcp` URL in the Registry (Part D), with its OAuth token URL +
   client id/secret + scope.

> **Shortcut for a private internal PoC:** on a locked-down tunnel you can run Node with
> `MCP_BEARER_TOKEN` unset (guard OFF) behind the OAuth gateway so the gateway is the only auth
> layer — but never expose an unauthenticated server on an open network.
>
> **Roadmap note:** native OAuth-token validation can be added in `server/lib/auth.js` so no proxy
> is needed; today static bearer + gateway is the supported pattern.

### Part D — Register the server in the Agentforce Registry

1. Salesforce **Setup** → Quick Find → **Agentforce Registry** (labels vary by release; it's the
   "MCP Servers" / external-tool registry).
2. **New** → follow the guided wizard.
3. **Server URL:** your public `https://<gateway-host>/mcp`. **Transport:** Streamable HTTP.
4. **Authentication:** OAuth 2.0 (client credentials) → token endpoint, client id, client secret, scope.
5. **Select tools to register.** Start small, then expand:
   - `assess_app`, `resolve_versions` — read-only, safe.
   - `start_upgrade` — the action (keep the dry-run gate; see Part F).
   - `get_job_status`, `reconcile` — track progress.
   - `rollback`, `scan_fleet` — optional; add `upgrade_parent_pom` / `update_open_pr_parent_ref`
     only once the basic flow works.
6. Finish. Salesforce auto-creates a **Named Credential**, an **External Credential**, and a
   **Permission Set** (usually "*<ServerName>* - Permission Set").
7. **Setup → Named Credentials → your NC → External Credential → Principals** → edit the principal
   and confirm the OAuth **client id / secret** are populated.

### Part E — Assign the generated Permission Set

The step that's easy to miss and looks like "the agent has no tools":

1. Setup → **Permission Sets** → open "*<ServerName>* - Permission Set".
2. **Manage Assignments → Add Assignment** → assign to **yourself** (to manage) *and* to the
   **agent's user** (the bot/agent user). Without this the agent can't invoke the MCP tools.

### Part F — Build one agent (Topic + Actions + instructions)

1. **Agentforce Studio / Agent Builder** → open an existing agent or create a new one.
2. Add a **Topic**, e.g. *"MuleSoft Java 17 Upgrades"*, described as *"Assess, plan, execute,
   track, and roll back MuleSoft application upgrades to Java 17 / Mule 4.9 LTS."*
3. Under the topic, add **Actions** = the MCP tools you registered in Part D.
4. Paste **Topic Instructions** that encode this suite's guardrails:

```text
You upgrade MuleSoft apps to Java 17 by calling the registered MCP tools only.

ALWAYS:
- Ask for the Anypoint environment (dev | test | prod). Never assume it.
- Start with assess_app (read-only). Summarize: current runtime/Java -> 4.9.18 / Java 17,
  the file-edit count, and each warning in one plain sentence.
- Before any change, call start_upgrade with dryRun:true and SHOW the PLAN_PREVIEW.
- Only after the user explicitly says "yes / go ahead", call start_upgrade with dryRun:false
  using the identical arguments. "Looks good but change X" is NOT a yes — loop back.
- Track with get_job_status (it auto-refreshes). A passing MUnit stays PR_OPEN; status moves
  to DEPLOYING on merge, then DEPLOYED after Anypoint verification.

NEVER:
- Invent connector/runtime versions, hand-write a pom, or fabricate a plan — report only what
  the tools return.
- Proceed past connectorGaps / missingFromMatrix silently — raise them as human-judgement items.
- Print secrets or tokens.

If a tool returns an error, report it verbatim and stop.
```

5. **Save** and **Activate** the agent (and topic).

### Part G — Test it in the conversation preview

Open the agent's **Conversation Preview** and try, in order:

- *"Assess orders-api for Java 17 in dev — owner acme, repo orders-api."* → calls `assess_app`.
- *"Show me the upgrade plan."* → `start_upgrade { dryRun: true }` → `PLAN_PREVIEW` (nothing written).
- *"Yes, go ahead."* → `start_upgrade { dryRun: false }` → `PR_OPEN` with the PR URL + `jobId`.
- *"What's the status of job <jobId>?"* → `get_job_status` → live PR/CI/deploy state.

### Agentforce-specific troubleshooting

- **Registration fails / "authentication required":** the Registry needs OAuth 2.0 — a static
  bearer alone won't register. Put the OAuth gateway in front (Part C) and register that URL.
- **No tools appear after registering:** the endpoint must be public HTTPS with Streamable HTTP
  transport. Re-validate the exact `…/mcp` URL in MCP Inspector (Part A) first.
- **Agent says it can't perform the action / "insufficient access":** assign the generated
  Permission Set to the *agent's* user (Part E), not just yourself.
- **Tool call rejected with `-32602` (invalid arguments):** the agent omitted a required field
  (commonly `environment`). Tighten the Topic Instructions to always collect it.
- **Upstream 401 behind the gateway:** the proxy isn't injecting
  `Authorization: Bearer <MCP_BEARER_TOKEN>`, or the token doesn't match the server's `MCP_BEARER_TOKEN`.
- **Works in Inspector but not in Agentforce:** the difference is almost always Part C (OAuth) or
  Part E (permission set) — the MCP surface itself is already proven by Part A.
