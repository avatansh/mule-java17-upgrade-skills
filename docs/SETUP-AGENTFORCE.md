# Setup — Hosted MCP server for Agentforce (remote)

Run the upgrade suite as a **hosted server** that exposes the 10 tools over MCP JSON-RPC + a
REST facade, so a remote agent — **Agentforce** or any MCP client — can drive upgrades over the
network. This guide stands up the server, secures it, wires the CI/CD webhook callback, and
connects Agentforce.

> For hands-on, one-app-at-a-time upgrades inside an IDE (no server), see
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

The 10 tools: `assess_app`, `start_upgrade`, `get_job_status`, `reapply_job`, `delete_job`,
`upgrade_parent_pom`, `reconcile`, `rollback`, `scan_fleet`, `scan_notify`. Every call is validated
against the tool's JSON Schema (the **schema-contract guard**) before the handler runs.

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
npm ci && node --test                 # 191 tests — no secrets, no network

# minimal .env for a locked-down LOCAL test (see §3); keep test jobs isolated:
#   MCP_BEARER_TOKEN=local-test-token
#   MULE_UPGRADE_ENV=dev
#   MULE_UPGRADE_HOME=./.local-jobstore

node server/server.js                  # → listening on http://0.0.0.0:8080
```

In a second terminal, drive the 10 tools over the loopback interface — no TLS, no tunnel:

```bash
TOKEN=local-test-token
curl -s localhost:8080/health
curl -sX POST localhost:8080/mcp -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'                    # expect 10 tools

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

## 5. Connect Agentforce

Agentforce consumes this as an **external MCP endpoint**:

1. Expose the server at an HTTPS URL (reverse proxy / tunnel).
2. In Agentforce, register a new **MCP server / external tool provider** pointing at
   `https://<host>/mcp`.
3. Set the auth header **`Authorization: Bearer <MCP_BEARER_TOKEN>`**.
4. Agentforce calls `initialize` then `tools/list`; the 10 tools appear with their input schemas.
   Invoking a tool sends `tools/call`; results come back as MCP content (JSON), with schema
   violations surfaced as JSON-RPC `-32602` and domain failures as `isError:true` tool results.

If your Agentforce integration prefers plain REST over JSON-RPC, point it at
`POST /api/v1/tools/{name}` with the same bearer header — identical validation and result payload.

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
