# Getting started from zero — every step a new user does before using these skills E2E

This guide assumes you know **nothing** about the project yet. Follow it top to bottom once; after
that, day-to-day use is just steps 8–9. Nothing here requires the Salesforce/`sf` CLI.

> **The 30-second summary.** The skills read their secrets (GitHub token, Anypoint creds, Slack
> webhook, Jira creds) from files that are **already committed** to the repo in *encrypted* form.
> To use them you do two things, **once**: (1) create a small text file named `.env` at the repo
> root containing **one decryption key** and **one environment name**, and (2) install Node. That's
> the whole setup. Everything below just spells that out and shows how to verify it.

---

## What is the `.env` file? (plain-English)

- `.env` is an ordinary **text file** named exactly `.env` (a dot, then `env` — no other extension).
- It lives at the **root of the suite**, i.e. right next to `package.json`:
  `C:\Workspaces\7.25\mule-java17-upgrade-skills\.env`
- It holds **`NAME=value` lines**, one per line. The scripts read it automatically on every run
  (`lib_shared/env.js` loads it), so you never type these values on the command line.
- It is **git-ignored** (listed in `.gitignore`), so it is never committed and your key never leaves
  your machine. **Never paste the real key into any other file** (especially not `.env.example`).

Think of `.env` as *your private copy of the settings* that the shared, committed config files
reference but deliberately leave blank.

---

## Why is a key even needed? (how config + secrets fit together)

The repo ships **layered config** under `config/`, mirroring the original Mule app:

| File (committed) | Contains | Example keys |
|------------------|----------|--------------|
| `config.yaml` | constants, same everywhere | `github.apiBase`, matrix TTLs |
| `config-<env>.yaml` | per-environment **non-secret** values | `github.defaultOwner: avatansh`, `slack.channel: #java17-upgrades`, `jira.baseUrl` |
| `config-secure-<env>.yaml` | per-environment **secrets, AES-encrypted** | `github.token`, `anypoint.clientId/Secret`, `slack.webhookUrl`, `jira.email/apiToken` |

`<env>` is one of **`dev` / `local` / `prod`**. The secrets in `config-secure-<env>.yaml` look like
`"![dpXfQHnk…]"` — the `![...]` wrapper means "AES-encrypted". They are useless without the key.

So the **only secret you must supply** is the **AES decryption key** (`MULE_CONFIG_KEY`). Give the
scripts that one key and they decrypt every `![...]` value at runtime, wiring GitHub + Anypoint +
Slack + Jira all at once. (In this repo, **one key decrypts all three environments**.)

---

## Step 1 — Install Node.js ≥ 24

The scripts run on Node. Check what you have:

```bash
node -v
```

If it prints `v24.x` (or higher) you're set. If it errors or is older, install Node 24+ from
<https://nodejs.org> (LTS), reopen your terminal, and check again. (This repo was verified on
`v24.18.0`.)

> **Which terminal?** Any plain terminal works — Windows **PowerShell**, **Command Prompt (cmd)**,
> or **Git Bash**. Commands below are shown in a generic form; where the syntax differs by shell,
> both are given.

---

## Step 2 — Get the suite onto your machine

You already have it at `C:\Workspaces\7.25\mule-java17-upgrade-skills`. If a teammate needs a fresh
copy:

```bash
git clone <this-repo-url> mule-java17-upgrade-skills
```

Open a terminal **in that folder**. All commands below are run from there (the "suite root").

- PowerShell/cmd: `cd C:\Workspaces\7.25\mule-java17-upgrade-skills`
- Git Bash: `cd /c/Workspaces/7.25/mule-java17-upgrade-skills`

---

## Step 3 — Install dependencies + prove the code is healthy

```bash
npm ci
node --test
```

`node --test` should end with **`pass 290` / `fail 0`**. This needs **no key, no network, no
secrets** — it just proves the checkout is intact. If this fails, stop and fix it before wiring
anything.

---

## Step 4 — Create your `.env` file (the one setup step)

Copy the template `.env.example` to a new file called `.env` **at the suite root**:

- **PowerShell:** `Copy-Item .env.example .env`
- **cmd:** `copy .env.example .env`
- **Git Bash / macOS / Linux:** `cp .env.example .env`

You now have `C:\Workspaces\7.25\mule-java17-upgrade-skills\.env`.

> **Creating it by hand instead?** Open Notepad, paste the two lines from Step 5, then
> **File → Save As**, set *Save as type* to **All Files**, and name it exactly `.env` (Notepad would
> otherwise save `.env.txt`, which will NOT work). Save it in the suite root.

---

## Step 5 — Put two values in `.env`

Open `.env` in any editor (VS Code, Notepad). You only need **two** lines to be non-empty:

```dotenv
MULE_CONFIG_KEY=<paste the AES key here>
MULE_UPGRADE_ENV=dev
```

- **`MULE_CONFIG_KEY`** — the AES key that was used to encrypt `config-secure-*.yaml`. It is a
  16-, 24-, or 32-character string. **Ask whoever set up the repo for this key** (it is intentionally
  NOT stored anywhere in git). Paste it after the `=` with no quotes and no spaces.
- **`MULE_UPGRADE_ENV`** — which environment to use: `dev`, `local`, or `prod`. Use **`dev`** unless
  told otherwise — the `dev` config already points at the real GitHub owner, Slack channel, Jira
  site, and Anypoint org.

Leave everything else in the file as-is (the other lines are optional and explained in Step 10).
Save the file.

> **Don't have the AES key?** You can instead paste **plaintext** credentials and skip the key
> entirely — see Step 10, "Option B". Most users should just get the key; it's the least to paste.

---

## Step 6 — Understand how the key and env get resolved (so nothing is magic)

You set two values once; here is exactly what happens on **every** run, automatically:

1. **Finding `.env`.** `lib_shared/env.js` looks for `.env` by walking **up from its own location**
   toward the drive root — *not* from your current directory. So it finds the suite-root `.env` no
   matter which folder you launch from (or where Vibes launches it). It loads once, and **anything
   already set in your real environment wins** over the file (so CI can inject values).

2. **Resolving the environment (`MULE_UPGRADE_ENV`).** The environment is **mandatory** — there is
   no silent default (this mirrors the Mule app's required `-Denv`). It is taken from **either** the
   `--env <dev|local|prod>` flag on the command **or** `MULE_UPGRADE_ENV` in your `.env`. If neither
   is present, the command **stops immediately** with
   `environment is required: pass --env <dev|local|prod> or set MULE_UPGRADE_ENV`. Once resolved, it
   picks the matching `config-<env>.yaml` + `config-secure-<env>.yaml` pair.

3. **Resolving the key (`MULE_CONFIG_KEY`).** To decrypt a `![...]` value, the loader picks the key
   in this order (first non-empty wins):
   1. an explicit key passed in code (tests only),
   2. `MULE_CONFIG_KEY_<ENV>` — e.g. `MULE_CONFIG_KEY_PROD` — *only if* an environment was encrypted
      with its own distinct key,
   3. `MULE_CONFIG_KEY` — the single shared key (**your case**).

   Because all three environments here share one key, `MULE_CONFIG_KEY` alone covers dev/local/prod.

4. **Reading a credential.** Each integration resolves a secret as: **plaintext env var → decrypted
   YAML value → built-in default.** So the one key wires all four integrations, and any single
   secret can still be overridden with a plaintext env var if you prefer.

**Net effect:** set the key + env once in `.env`; every skill, CLI, and the server thereafter loads
the right files and decrypts on its own. You are never prompted again.

---

## Step 7 — Verify your `.env` actually works (60-second smoke test)

Confirm the two values are seen and the environment resolves. From the suite root:

```bash
node -e "import('./lib_shared/config.js').then(c=>{const env=c.requireEnv(process.env.MULE_UPGRADE_ENV,{flag:'MULE_UPGRADE_ENV'});console.log('env =',env,'| key length =',(process.env.MULE_CONFIG_KEY||'').length,'| github.token resolves =', c.has('github.token'));})"
```

Expected: something like `env = dev | key length = 32 | github.token resolves = true`.

- `github.token resolves = true` means the key **decrypted** a secret — you're wired. 🎉
- If you see `environment is required` → `MULE_UPGRADE_ENV` isn't set (recheck Step 5, and that the
  file is named `.env` not `.env.txt`).
- If key length is `0` → the key line is empty; paste the key.
- If it throws `cannot decrypt` / `must be 16/24/32 characters` → the key is wrong length or wrong
  value; get the correct key.

> This command prints only a **length** and a **boolean** — it never prints the secret itself.

---

## Step 8 — Run a skill end-to-end (first real use)

Now use the skills. Two representative commands (run from the suite root):

```bash
# Read-only assessment of a local clone of a Mule app (safe; writes nothing but plan.json):
node skills/mule-upgrade-assess/scripts/assess.js --repo C:\path\to\a-mule-app --env dev --out plan.json

# The full pipeline — assess → PR, firing GitHub + Jira + Slack (api mode uses the decrypted token):
node skills/mule-upgrade/scripts/upgrade.js start --app orders-api --env dev --mode api --owner avatansh --repo-name <a-test-repo>
```

Because `MULE_UPGRADE_ENV=dev` is in `.env`, the `--env dev` above is redundant but harmless — it's
shown so you see the mandatory flag. (For `scan`/`scan_notify`, note `--env` means the *Anypoint
environment list* to scan, **not** the config selector — those take the config env from
`MULE_UPGRADE_ENV`.)

For the full per-skill command catalog and live-integration test sweep, see
[WIRE-LIVE-INTEGRATIONS.md](./WIRE-LIVE-INTEGRATIONS.md) §2.6.

---

## Step 9 — (Optional) Use the skills inside MuleSoft Vibes

Once the terminal tests pass, wire the skills into Vibes (Anypoint Code Builder). The critical rule:
**symlink** the skill folders into `.a4drules/skills/` — do **not** copy them — so each skill's
`../../lib_shared` still resolves back into the suite and finds your one `.env`. Full instructions
(both the Skills install and the MCP-server option) are in
[SETUP-VIBES.md](./SETUP-VIBES.md) and [WIRE-LIVE-INTEGRATIONS.md](./WIRE-LIVE-INTEGRATIONS.md) §3.

---

## Step 10 — Optional `.env` settings (only if you need them)

Everything below is optional; the two lines from Step 5 are enough for normal use.

| Variable | What it does | When to set it |
|----------|--------------|----------------|
| `MULE_CONFIG_KEY_DEV` / `_LOCAL` / `_PROD` | per-environment AES key | only if an env was re-encrypted with a *different* key |
| `MULE_UPGRADE_HOME` | where job records are stored (default `~/.mule-upgrade`) | set to e.g. `./.local-jobstore` for throwaway test runs |
| `MCP_BEARER_TOKEN` | bearer token clients must present to the MCP/HTTP server | only if you run the server (Vibes Option B) and want auth |
| `MCP_SERVER_PORT` | server port (default `8080`) | only if 8080 is taken |

**Option B — no key, use plaintext creds instead.** If you don't have the AES key, leave
`MULE_CONFIG_KEY` empty and uncomment/fill these instead (each overrides the encrypted YAML):

```dotenv
MULE_UPGRADE_ENV=dev
GITHUB_TOKEN=ghp_xxx                 # needs 'repo' scope
ANYPOINT_CLIENT_ID=xxx
ANYPOINT_CLIENT_SECRET=xxx
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=xxx
```

You can mix approaches (e.g. the key for Anypoint/Slack, a fresh `GITHUB_TOKEN` for GitHub).

---

## The complete checklist (what every new user does)

**One-time, per machine:**

1. Install Node.js ≥ 24 (`node -v`).
2. Get the suite (clone) and `cd` into it.
3. `npm ci` then `node --test` → `pass 290`.
4. Copy `.env.example` → `.env` at the suite root.
5. In `.env`, set `MULE_CONFIG_KEY=<the AES key>` and `MULE_UPGRADE_ENV=dev`.
6. Smoke-test with the Step 7 one-liner → `github.token resolves = true`.
7. *(optional)* Symlink the skills into Vibes (`.a4drules/skills/`).

**Every time you use a skill afterwards:**

8. Open a terminal in the suite root (the `.env` is picked up automatically).
9. Run the skill / CLI, always with a resolvable environment — `--env dev` on the command **or**
   `MULE_UPGRADE_ENV` in `.env` (you already set it, so you can omit the flag).

That's it. The key and environment are supplied once and reused on every run — you are never
prompted, in a terminal or in Vibes.

---

## Troubleshooting

| Symptom | Cause & fix |
|---------|-------------|
| `environment is required: pass --env …` | No env resolved. Add `MULE_UPGRADE_ENV=dev` to `.env`, or pass `--env dev`. Check the file is `.env`, not `.env.txt`. |
| `cannot decrypt secure property` / `MULE_CONFIG_KEY must be 16/24/32 characters` | Wrong/empty key. Paste the correct AES key into `.env`, or use plaintext creds (Option B). |
| `unknown environment "staging"` | Only `dev`/`local`/`prod` have config files. Use one of those. |
| The scripts don't seem to read `.env` | It must be at the **suite root** (next to `package.json`) and named exactly `.env`. Confirm with the Step 7 smoke test. |
| GitHub `401/403` | Token rotated or lacks `repo` scope. Set a fresh plaintext `GITHUB_TOKEN` in `.env`, or `gh auth login` for local mode. |
| Skills don't appear in Vibes | You copied instead of symlinked. Symlink so `../../lib_shared` (and your `.env`) resolve. |
