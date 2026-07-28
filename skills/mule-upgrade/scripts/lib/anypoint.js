// lib/anypoint.js — Anypoint Platform clients (port of system/anypoint.xml).
//
//   pf-get-anypoint-token → client_credentials bearer, TTL-bucketed cache (~55 min, in-memory).
//   pf-verify-deployment  → resolve env name → envId, read the app's AMC deployment, classify health.
//   pf-read-deployment    → Batch A #1: thin normaliser over verify for the ASSESS cross-check.
//   pf-read-api-policies  → Batch A #6: resolve API Manager instance by assetId, count ENABLED policies.
//
// Every network path is NON-FATAL: any platform/network/schema error yields an "unverified /
// unreachable" shape so callers fall back to the CI/source signal rather than block a job (matches
// the Mule on-error-continue handlers). Credentials resolve from ENV first (ANYPOINT_CLIENT_ID/…),
// then the layered config (`anypoint.clientId` / `clientSecret` / `defaultOrgId`, decrypted from the
// secure YAML via MULE_CONFIG_KEY). If nothing is configured, the client reports configured()=false
// and all reads short-circuit to the unverified shape.

import { get } from "../../../../lib_shared/config.js";
import { readEntry, writeEntry } from "../../../../lib_shared/cache.js";
import crypto from "node:crypto";

const env = process.env;
const DEFAULT_BASE = "https://anypoint.mulesoft.com";
const DEFAULT_TOKEN_PATH = "/accounts/api/v2/oauth2/token";
const DEFAULT_HEALTHY = "RUNNING,APPLIED,STARTED";
const DEFAULT_REFRESH_SECONDS = 3300; // 55 min — below the platform's 60-min token TTL

// Read a config value, swallowing any decrypt/lookup error (missing key etc.) → fallback.
function cfg(dotted, fallback) {
  try {
    const v = get(dotted, undefined);
    return v === undefined || v === null || v === "" ? fallback : v;
  } catch {
    return fallback;
  }
}

export class AnypointClient {
  constructor(opts = {}) {
    this.clientId = opts.clientId ?? env.ANYPOINT_CLIENT_ID ?? cfg("anypoint.clientId", "");
    this.clientSecret = opts.clientSecret ?? env.ANYPOINT_CLIENT_SECRET ?? cfg("anypoint.clientSecret", "");
    this.orgId = opts.orgId ?? env.ANYPOINT_ORG_ID ?? cfg("anypoint.defaultOrgId", "");
    this.baseUrl = opts.baseUrl ?? env.ANYPOINT_BASE_URL ?? cfg("anypoint.apiBase", DEFAULT_BASE);
    this.tokenPath =
      opts.tokenPath ?? env.ANYPOINT_TOKEN_PATH ?? cfg("anypoint.tokenPath", DEFAULT_TOKEN_PATH);
    this.refreshSeconds = Number(
      opts.refreshSeconds ??
        env.ANYPOINT_TOKEN_REFRESH_SECONDS ??
        cfg("anypoint.tokenRefreshSeconds", DEFAULT_REFRESH_SECONDS)
    );
    const healthy =
      opts.healthyStatuses ??
      env.ANYPOINT_HEALTHY_STATUSES ??
      cfg("anypoint.verify.healthyStatuses", DEFAULT_HEALTHY);
    this.healthyStatuses = (Array.isArray(healthy) ? healthy.join(",") : String(healthy))
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    this.fetch = opts.fetchImpl ?? globalThis.fetch;
    // Injectable clock (ms) so token-cache bucketing is testable; Date.now() by default.
    this.now = opts.now ?? (() => Date.now());
    this._tokenCache = null; // { bucket, token }  in-memory hot path (MCP server lifetime)
    this._envCache = new Map(); // envName(upper) → envId  (per org, JVM lifetime)
    // Cross-process token disk cache toggle: opts wins, else config cache.tokenToDisk (default on).
    // Lets a fresh CLI/Vibes process reuse a still-valid bearer instead of re-minting one every run.
    this.tokenToDisk =
      opts.tokenToDisk != null ? Boolean(opts.tokenToDisk) : String(cfg("cache.tokenToDisk", "true")) !== "false";
  }

  // Opaque, stable disk-cache key for the bearer — hashed so the clientId never lands in a filename.
  _tokenDiskKey() {
    return crypto
      .createHash("sha256")
      .update(`${this.clientId}\u0000${this.orgId}\u0000${this.baseUrl}\u0000${this.tokenPath}`)
      .digest("hex")
      .slice(0, 32);
  }

  configured() {
    return Boolean(this.clientId && this.clientSecret && this.orgId);
  }

  // Time-bucketed key: the bearer is fetched at most once per refreshSeconds window.
  _tokenBucket() {
    return Math.floor(this.now() / 1000 / this.refreshSeconds);
  }

  async _getToken() {
    const bucket = this._tokenBucket();
    if (this._tokenCache && this._tokenCache.bucket === bucket && this._tokenCache.token) {
      return this._tokenCache.token;
    }
    // Cap the disk TTL at refreshSeconds (~55 min) — comfortably below the platform's 60-min token TTL.
    const ttlMs = Math.max(1000, this.refreshSeconds * 1000);
    if (this.tokenToDisk) {
      const hit = readEntry("anypoint-token", this._tokenDiskKey(), { ttlMs });
      if (hit && typeof hit === "string") {
        this._tokenCache = { bucket, token: hit };
        return hit;
      }
    }
    const res = await this.fetch(`${this.baseUrl}${this.tokenPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    const json = JSON.parse(await res.text());
    const token = json.access_token || "";
    this._tokenCache = { bucket, token };
    // Persist owner-only (0600) so a concurrent/next process skips the token round-trip. Non-fatal.
    if (this.tokenToDisk && token) {
      writeEntry("anypoint-token", this._tokenDiskKey(), token, { ttlMs, secret: true });
    }
    return token;
  }

  async _resolveEnvId(envName, token) {
    const key = String(envName).toUpperCase();
    if (this._envCache.has(key)) return this._envCache.get(key);
    const res = await this.fetch(`${this.baseUrl}/accounts/api/organizations/${this.orgId}/environments`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = JSON.parse(await res.text());
    const data = json.data ?? [];
    const match = data.find((e) => (e.name ?? "").toUpperCase() === key);
    const envId = match?.id ?? "";
    this._envCache.set(key, envId);
    return envId;
  }

  /**
   * verifyDeployment({app, env}): read AMC deployment + classify. NEVER throws.
   * @param {object} opts
   * @param {string} opts.app
   * @param {string} opts.env
   * @returns {Promise<{verified:any, found:any, status:any, healthy:any, runtimeVersion:any, skipped?:any, error?:any}>}
   */
  async verifyDeployment({ app, env: envName }) {
    const unverified = {
      verified: false,
      found: false,
      status: "UNKNOWN",
      healthy: false,
      runtimeVersion: null,
    };
    if (!this.configured()) return { ...unverified, skipped: "anypoint not configured" };
    try {
      const token = await this._getToken();
      const envId = await this._resolveEnvId(envName, token);
      const res = await this.fetch(
        `${this.baseUrl}/amc/application-manager/api/v2/organizations/${this.orgId}/environments/${envId}/deployments`,
        { method: "GET", headers: { Authorization: `Bearer ${token}` } }
      );
      const deployments = JSON.parse(await res.text());
      const items = deployments.items ?? deployments.data ?? [];
      const dep = items.find((d) => (d.name ?? "") === app);
      if (!dep) return { ...unverified, verified: true };
      const status = String(dep.application?.status ?? dep.status ?? "").toUpperCase();
      const runtimeVersion =
        dep.target?.deploymentSettings?.runtimeVersion ??
        dep.currentRuntimeVersion ??
        dep.runtimeVersion ??
        null;
      return {
        verified: true,
        found: true,
        status,
        healthy: this.healthyStatuses.includes(status),
        runtimeVersion,
      };
    } catch (e) {
      return { ...unverified, error: e.message };
    }
  }

  /**
   * readDeployment({app, env}): Batch A #1 (pf-read-deployment) — thin normaliser over
   * verifyDeployment so the ASSESS flow can compare the REAL deployed runtime vs the source pom.
   * NEVER throws (verifyDeployment already swallows errors).
   * @param {object} opts
   * @param {string} opts.app
   * @param {string} opts.env
   * @returns {Promise<{reachable:any, found:any, status:any, runtimeVersion:any}>}
   */
  async readDeployment({ app, env: envName }) {
    const v = await this.verifyDeployment({ app, env: envName });
    return {
      reachable: (v.status ?? "UNKNOWN") !== "UNKNOWN" || Boolean(v.found),
      found: Boolean(v.found),
      status: v.status ?? "UNKNOWN",
      runtimeVersion: v.runtimeVersion ?? null,
    };
  }

  /**
   * readApiPolicies({app, env}): Batch A #6 (pf-read-api-policies) — resolve the app's API Manager
   * instance by assetId (defensive across the grouped `assets[].apis[]` and flat `instances[]`
   * schemas), read its applied policies, and report whether ≥1 policy is ENABLED. NEVER throws;
   * ANY error → {hasApiPolicies:false, checked:false} (leaves the assessment's placeholder intact).
   * @param {object} opts
   * @param {string} opts.app
   * @param {string} opts.env
   * @returns {Promise<{hasApiPolicies:boolean, matched:boolean, checked:boolean, skipped?:any, error?:string, enabledCount?:any}>}
   */
  async readApiPolicies({ app, env: envName }) {
    const off = { hasApiPolicies: false, matched: false, checked: false };
    if (!this.configured()) return { ...off, skipped: "anypoint not configured" };
    try {
      const token = await this._getToken();
      const envId = await this._resolveEnvId(envName, token);
      const apisRes = await this.fetch(
        `${this.baseUrl}/apimanager/api/v1/organizations/${this.orgId}/environments/${envId}/apis`,
        { method: "GET", headers: { Authorization: `Bearer ${token}` } }
      );
      const r = JSON.parse(await apisRes.text());
      // Flatten to {id, key} where key = lower(assetId|exchangeAssetName), across both schemas.
      const grouped = Array.isArray(r.assets) ? r.assets : [];
      let flat;
      if (grouped.length) {
        flat = grouped.flatMap((a) =>
          (a.apis ?? []).map((api) => ({
            id: api.id ?? null,
            key: String(a.assetId ?? a.exchangeAssetName ?? "").toLowerCase(),
          }))
        );
      } else {
        flat = (r.instances ?? []).map((api) => ({
          id: api.id ?? null,
          key: String(api.assetId ?? api.exchangeAssetName ?? "").toLowerCase(),
        }));
      }
      const appKey = String(app ?? "").toLowerCase();
      const match = flat.find(
        (x) => x.id != null && x.key !== "" && (x.key.includes(appKey) || appKey.includes(x.key))
      );
      if (!match) return { hasApiPolicies: false, matched: false, checked: true };

      const polRes = await this.fetch(
        `${this.baseUrl}/apimanager/api/v1/organizations/${this.orgId}/environments/${envId}/apis/${match.id}/policies`,
        { method: "GET", headers: { Authorization: `Bearer ${token}` } }
      );
      const p = JSON.parse(await polRes.text());
      const pols = Array.isArray(p.policies) ? p.policies : Array.isArray(p) ? p : [];
      const enabled = pols.filter((x) => !(x.disabled ?? false)).length;
      return { hasApiPolicies: enabled > 0, matched: true, checked: true, enabledCount: enabled };
    } catch (e) {
      return { ...off, error: e.message };
    }
  }

  /**
   * describeDeployment({app, env}): EPIC C — a VERBATIM deployed-state lookup. Reads the app's AMC
   * deployment in the given environment matching the supplied name EXACTLY (no fuzzy/contains match,
   * unlike the fleet scanner) and returns the running runtime/Java/status/replicas/last-deploy so the
   * assessor can show what is actually deployed. NEVER throws; every non-found / unreachable path
   * returns a shape with `found:false` and a `reason` string so the caller can always surface WHY.
   *
   * ARM exposes the runtime + Java version + status + replica count + last-modified timestamp — it does
   * NOT expose the deployed connector versions (those are baked into the app archive, not the
   * deployment descriptor), so this check informs the runtime/Java picture only, never connector pins.
   *
   * @param {object} opts
   * @param {string} opts.app  the deployed application name, matched VERBATIM
   * @param {string} opts.env  environment NAME (resolved to envId internally)
   * @returns {Promise<{found:boolean, reason?:string, name?:string, status?:string, runtimeVersion?:string|null, muleVersion?:string|null, javaVersion?:number|null, replicas?:number|null, lastDeploy?:string|null, environment?:string}>}
   */
  async describeDeployment({ app, env: envName }) {
    const name = String(app ?? "").trim();
    if (!name) return { found: false, reason: "no deployed application name provided" };
    if (!this.configured()) return { found: false, reason: "anypoint not configured (credentials absent)" };
    try {
      const token = await this._getToken();
      const envId = await this._resolveEnvId(envName, token);
      if (!envId) return { found: false, reason: `environment "${envName}" not found in the org` };
      const res = await this.fetch(
        `${this.baseUrl}/amc/application-manager/api/v2/organizations/${this.orgId}/environments/${envId}/deployments`,
        { method: "GET", headers: { Authorization: `Bearer ${token}` } }
      );
      const deployments = JSON.parse(await res.text());
      const items = deployments.items ?? deployments.data ?? [];
      const dep = items.find((d) => (d.name ?? "") === name); // VERBATIM — exact name match
      if (!dep) {
        return {
          found: false,
          reason: `no deployment named "${name}" in environment "${envName}"`,
        };
      }
      const runtimeVersion =
        dep.target?.deploymentSettings?.runtimeVersion ??
        dep.currentRuntimeVersion ??
        dep.runtimeVersion ??
        null;
      const status = String(dep.application?.status ?? dep.status ?? "").toUpperCase() || "UNKNOWN";
      const { muleVersion, javaVersion } = parseRuntimeVersion(runtimeVersion);
      const replicas =
        dep.target?.replicas ??
        dep.replicas ??
        dep.application?.vCores?.replicas ??
        dep.application?.replicas ??
        null;
      const lastDeploy =
        dep.lastModifiedDate ?? dep.lastSuccessfulRuntimeVersion?.updatedAt ?? dep.updatedAt ?? null;
      return {
        found: true,
        name,
        status,
        runtimeVersion,
        muleVersion,
        javaVersion,
        replicas: replicas == null ? null : Number(replicas),
        lastDeploy,
        environment: envName,
      };
    } catch (e) {
      return { found: false, reason: `deployment lookup failed: ${e.message}` };
    }
  }

  /**
   * findDeploymentAcrossEnvs({app}): search EVERY environment in the org for a deployment whose name
   * matches `app` VERBATIM, returning the first match (a describeDeployment shape, incl. `environment`)
   * or a {found:false, reason} with the list of environments searched. This is the safety net for the
   * common demo mistake of a correct app name but the wrong/blank environment label: the operator
   * gives the exact Runtime Manager name and we locate it wherever it actually runs. NEVER throws.
   * @param {object} opts
   * @param {string} opts.app  deployed application name, matched verbatim
   * @returns {Promise<object>} describeDeployment result (found:true) or {found:false, reason, searched}
   */
  async findDeploymentAcrossEnvs({ app }) {
    const name = String(app ?? "").trim();
    if (!name) return { found: false, reason: "no deployed application name provided" };
    if (!this.configured()) return { found: false, reason: "anypoint not configured (credentials absent)" };
    try {
      const envs = await this.listEnvironments();
      if (!envs.length) return { found: false, reason: "no environments visible to these credentials" };
      for (const e of envs) {
        const d = await this.describeDeployment({ app: name, env: e.name });
        if (d.found) return d; // describeDeployment stamps `environment` on the hit
      }
      return {
        found: false,
        reason: `no deployment named "${name}" in any of ${envs.length} environment(s): ${envs
          .map((e) => e.name)
          .join(", ")}`,
        searched: envs.map((e) => e.name),
      };
    } catch (e) {
      return { found: false, reason: `cross-environment lookup failed: ${e.message}` };
    }
  }

  /**
   * listEnvironments(): all environments for the org, as [{id, name, type}]. NEVER throws;
   * any error yields []. Reuses the same /accounts endpoint _resolveEnvId reads.
   * @returns {Promise<Array<{id:string,name:string,type:string}>>}
   */
  async listEnvironments() {
    if (!this.configured()) return [];
    try {
      const token = await this._getToken();
      const res = await this.fetch(`${this.baseUrl}/accounts/api/organizations/${this.orgId}/environments`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = JSON.parse(await res.text());
      const data = json.data ?? [];
      // warm the name→id cache while we're here
      for (const e of data) if (e?.name && e?.id) this._envCache.set(String(e.name).toUpperCase(), e.id);
      return data.map((e) => ({ id: e.id ?? "", name: e.name ?? "", type: e.type ?? "" }));
    } catch {
      return [];
    }
  }

  /**
   * listDeployments({env}): every AMC (CloudHub 2.0 / Runtime Fabric) app in ONE environment,
   * normalised to {name, muleVersion, javaVersion, runtimeVersion, status, environment}. NEVER
   * throws; any error yields []. (CloudHub 1.0 / hybrid apps live behind other endpoints and are
   * NOT covered here — see mule-upgrade-scan for the coverage caveat.)
   * @param {object} args
   * @param {string} args.env  environment NAME (resolved to envId internally)
   * @returns {Promise<Array<object>>}
   */
  async listDeployments({ env: envName }) {
    if (!this.configured()) return [];
    try {
      const token = await this._getToken();
      const envId = await this._resolveEnvId(envName, token);
      if (!envId) return [];
      const res = await this.fetch(
        `${this.baseUrl}/amc/application-manager/api/v2/organizations/${this.orgId}/environments/${envId}/deployments`,
        { method: "GET", headers: { Authorization: `Bearer ${token}` } }
      );
      const deployments = JSON.parse(await res.text());
      const items = deployments.items ?? deployments.data ?? [];
      return items.map((dep) => {
        const runtimeVersion =
          dep.target?.deploymentSettings?.runtimeVersion ??
          dep.currentRuntimeVersion ??
          dep.runtimeVersion ??
          null;
        const status = String(dep.application?.status ?? dep.status ?? "").toUpperCase();
        const { muleVersion, javaVersion } = parseRuntimeVersion(runtimeVersion);
        return {
          name: dep.name ?? "",
          muleVersion,
          javaVersion,
          runtimeVersion,
          status,
          environment: envName,
        };
      });
    } catch {
      return [];
    }
  }
}

/**
 * parseRuntimeVersion(rv): split a CloudHub/RTF runtime label into {muleVersion, javaVersion}.
 * NEVER throws. The Java version is ONLY taken from an explicit `java` token or a bare integer patch —
 * never from a build/patch number — so the many real shapes all resolve correctly:
 *   · "4.4.0:8-java"        → {4.4.0, 8}    (Java BEFORE the "java" keyword — legacy)
 *   · "4.9.19:9-java17"     → {4.9.19, 17}  (Java AFTER "java"; the leading "9" is a PATCH, not Java)
 *   · "4.9.18:17"           → {4.9.18, 17}  (bare integer suffix = Java)
 *   · "4.4.0:20250919-6"    → {4.4.0, null} (build timestamp+patch, NO Java info)
 *   · "4.4.0"               → {4.4.0, null} (no suffix)
 * @param {string|null} rv
 * @returns {{muleVersion:string|null, javaVersion:number|null}}
 */
export function parseRuntimeVersion(rv) {
  if (!rv || typeof rv !== "string") return { muleVersion: null, javaVersion: null };
  const [base, ...restParts] = rv.split(":");
  const muleVersion = (base ?? "").trim() || null;
  const javaPart = restParts.join(":").trim();
  let javaVersion = null;
  if (javaPart) {
    const after = /java\s*(\d+)/i.exec(javaPart); // "9-java17" / "java17" → 17 (preferred)
    const before = /(\d+)\s*-?\s*java\b/i.exec(javaPart); // "8-java" → 8
    if (after) javaVersion = Number(after[1]);
    else if (before) javaVersion = Number(before[1]);
    else if (/^\d+$/.test(javaPart)) javaVersion = Number(javaPart); // bare "17"; NOT "20250919-6"
    // else: no discernible Java token (e.g. a build timestamp) → leave null
  }
  return { muleVersion, javaVersion };
}

/**
 * makeDeployVerifier(client): adapt AnypointClient into the reconcile.js verifyDeploy signature
 * `(rec) => {status:"healthy"|"unhealthy"|"unknown"}`, using rec.appName + rec.environment.
 *
 * N+1 batching: a reconcile sweep may hold several DEPLOYING jobs in the SAME environment, and a naive
 * per-job verifyDeployment() re-fetches that environment's ENTIRE deployment list once per job. Instead
 * this verifier fetches each environment's list ONCE (via listDeployments) and matches every job for
 * that env against the cached list in memory. The cache lives for the life of the returned function; a
 * caller running repeated sweeps (the poll watch loop) MUST call `verify.reset()` at the start of each
 * sweep so a later sweep sees fresh platform state rather than the previous sweep's snapshot.
 *
 * Classification matches the previous verifyDeployment-based mapping exactly:
 *   · app not in the env list (or the list is empty / unreachable) → "unknown"
 *   · app found, status ∈ healthyStatuses                          → "healthy"
 *   · app found, status ∉ healthyStatuses                          → "unhealthy"
 */
export function makeDeployVerifier(client) {
  // env(upper) → Promise<Array<{name,status,...}>>. Promise-valued so concurrent jobs for the same env
  // share the single in-flight fetch rather than each launching their own.
  const listByEnv = new Map();
  const listFor = (envName) => {
    const key = String(envName ?? "").toUpperCase();
    if (!listByEnv.has(key)) listByEnv.set(key, client.listDeployments({ env: envName }));
    return listByEnv.get(key);
  };
  const verify = async (rec) => {
    const items = (await listFor(rec.environment)) ?? [];
    const dep = items.find((d) => (d.name ?? "") === rec.appName);
    if (!dep) return { status: "unknown", detail: { found: false } };
    const status = String(dep.status ?? "").toUpperCase();
    const healthy = client.healthyStatuses.includes(status);
    return { status: healthy ? "healthy" : "unhealthy", detail: dep };
  };
  // Drop the per-env cache so the next sweep re-reads platform state. Called by runReconcile per sweep.
  verify.reset = () => listByEnv.clear();
  return verify;
}
