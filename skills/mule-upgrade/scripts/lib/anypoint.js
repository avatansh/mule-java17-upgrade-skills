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
    this.tokenPath = opts.tokenPath ?? env.ANYPOINT_TOKEN_PATH ?? cfg("anypoint.tokenPath", DEFAULT_TOKEN_PATH);
    this.refreshSeconds = Number(
      opts.refreshSeconds ?? env.ANYPOINT_TOKEN_REFRESH_SECONDS ?? cfg("anypoint.tokenRefreshSeconds", DEFAULT_REFRESH_SECONDS)
    );
    const healthy = opts.healthyStatuses ?? env.ANYPOINT_HEALTHY_STATUSES ?? cfg("anypoint.verify.healthyStatuses", DEFAULT_HEALTHY);
    this.healthyStatuses = (Array.isArray(healthy) ? healthy.join(",") : String(healthy))
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    this.fetch = opts.fetchImpl ?? globalThis.fetch;
    // Injectable clock (ms) so token-cache bucketing is testable; Date.now() by default.
    this.now = opts.now ?? (() => Date.now());
    this._tokenCache = null; // { bucket, token }
    this._envCache = new Map(); // envName(upper) → envId  (per org, JVM lifetime)
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
    return token;
  }

  async _resolveEnvId(envName, token) {
    const key = String(envName).toUpperCase();
    if (this._envCache.has(key)) return this._envCache.get(key);
    const res = await this.fetch(
      `${this.baseUrl}/accounts/api/organizations/${this.orgId}/environments`,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } }
    );
    const json = JSON.parse(await res.text());
    const data = json.data ?? [];
    const match = data.find((e) => (e.name ?? "").toUpperCase() === key);
    const envId = match?.id ?? "";
    this._envCache.set(key, envId);
    return envId;
  }

  /**
   * verifyDeployment({app, env}): read AMC deployment + classify. NEVER throws.
   * @returns {{verified, found, status, healthy, runtimeVersion, skipped?, error?}}
   */
  async verifyDeployment({ app, env: envName }) {
    const unverified = { verified: false, found: false, status: "UNKNOWN", healthy: false, runtimeVersion: null };
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
        dep.target?.deploymentSettings?.runtimeVersion ?? dep.currentRuntimeVersion ?? dep.runtimeVersion ?? null;
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
   * @returns {{reachable, found, status, runtimeVersion}}
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
   * @returns {{hasApiPolicies:boolean, matched:boolean, checked:boolean, error?:string}}
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
   * listEnvironments(): all environments for the org, as [{id, name, type}]. NEVER throws;
   * any error yields []. Reuses the same /accounts endpoint _resolveEnvId reads.
   * @returns {Promise<Array<{id:string,name:string,type:string}>>}
   */
  async listEnvironments() {
    if (!this.configured()) return [];
    try {
      const token = await this._getToken();
      const res = await this.fetch(
        `${this.baseUrl}/accounts/api/organizations/${this.orgId}/environments`,
        { method: "GET", headers: { Authorization: `Bearer ${token}` } }
      );
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
          dep.target?.deploymentSettings?.runtimeVersion ?? dep.currentRuntimeVersion ?? dep.runtimeVersion ?? null;
        const status = String(dep.application?.status ?? dep.status ?? "").toUpperCase();
        const { muleVersion, javaVersion } = parseRuntimeVersion(runtimeVersion);
        return { name: dep.name ?? "", muleVersion, javaVersion, runtimeVersion, status, environment: envName };
      });
    } catch {
      return [];
    }
  }
}

/**
 * parseRuntimeVersion("4.4.0:8-java") yields {muleVersion:"4.4.0", javaVersion:8}. Tolerates a bare
 * "4.4.0" (javaVersion null), "4.9.18:17" and "4.6.0:8-java" shapes. NEVER throws.
 * @param {string|null} rv
 * @returns {{muleVersion:string|null, javaVersion:number|null}}
 */
export function parseRuntimeVersion(rv) {
  if (!rv || typeof rv !== "string") return { muleVersion: null, javaVersion: null };
  const [base, javaPart] = rv.split(":");
  const muleVersion = (base ?? "").trim() || null;
  let javaVersion = null;
  if (javaPart) {
    const m = /(\d+)/.exec(javaPart); // "8-java" yields 8, "17" yields 17
    if (m) javaVersion = Number(m[1]);
  }
  return { muleVersion, javaVersion };
}

/**
 * makeDeployVerifier(client): adapt AnypointClient into the reconcile.js verifyDeploy signature
 * `(rec) => {status:"healthy"|"unhealthy"|"unknown"}`, using rec.appName + rec.environment.
 */
export function makeDeployVerifier(client) {
  return async (rec) => {
    const v = await client.verifyDeployment({ app: rec.appName, env: rec.environment });
    if (!v.verified || v.status === "UNKNOWN") return { status: "unknown", detail: v };
    return { status: v.healthy ? "healthy" : "unhealthy", detail: v };
  };
}
