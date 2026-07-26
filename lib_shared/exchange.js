// exchange.js — Anypoint Exchange Maven-facade client (port of reference-data.xml's
// sf-exchange-http-get + pf-load-matrix / pf-load-registry Exchange branches).
//
// Fetches a governed YAML asset (compatibility matrix or app-registry) from the Exchange Maven
// facade over HTTPS, authenticated with the Anypoint Connected App bearer (reused from
// AnypointClient). Supports two sourcing modes, mirroring the Mule config `*.source`:
//
//   • exchange         — download the PINNED `*.exchange.version`.
//   • exchange-latest  — read maven-metadata.xml, pick the HIGHEST published SEMVER version
//                        (NOT <release>/<latest>, which can lag behind the newest upload), then
//                        download that.
//
// FULLY NON-FATAL: any network/auth/parse failure — and, for the matrix, an empty connectors
// block — returns { ok:false, reason } so the caller falls back to the bundled classpath copy.
// This is the JS twin of the Mule <on-error-continue> + connectorless safety-net branches.
//
// Credentials/base come from the injected AnypointClient (env → config). Asset identity
// (orgId/assetId/version/classifier/packaging) is read from config per family via configFor().

import yaml from "js-yaml";
import { get } from "./config.js";

// Read a config value, swallowing lookup/decrypt errors → fallback.
function cfg(dotted, fallback) {
  try {
    const v = get(dotted, undefined);
    return v === undefined || v === null || v === "" ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * Resolve the Exchange asset identity + source mode for a family ("matrix" | "registry").
 * @returns {{source, orgId, assetId, version, classifier, packaging}}
 */
export function configFor(family) {
  return {
    source: String(cfg(`${family}.source`, "classpath")),
    orgId: cfg(`${family}.exchange.orgId`, ""),
    assetId: cfg(`${family}.exchange.assetId`, ""),
    version: cfg(`${family}.exchange.version`, ""),
    classifier: String(cfg(`${family}.exchange.classifier`, "")),
    packaging: String(cfg(`${family}.exchange.packaging`, "yaml")),
  };
}

// Pick the highest semver from a list of "X.Y.Z" strings (mirrors the DW vnum ordering).
export function highestSemver(versions) {
  const vnum = (v) => {
    const p = String(v)
      .split(".")
      .map((s) => Number(s) || 0);
    return (p[0] || 0) * 1e6 + (p[1] || 0) * 1e3 + (p[2] || 0);
  };
  const list = (versions ?? []).map(String).filter(Boolean);
  if (!list.length) return null;
  return list.slice().sort((a, b) => vnum(a) - vnum(b))[list.length - 1];
}

// Extract <version> entries + <latest>/<release> from a maven-metadata.xml string (regex-based;
// no XML dep). Returns { versions:[], latest, release }.
export function parseMavenMetadata(xml) {
  const text = String(xml ?? "");
  const versions = [...text.matchAll(/<version>\s*([^<\s]+)\s*<\/version>/g)].map((m) => m[1]);
  const latest = (text.match(/<latest>\s*([^<\s]+)\s*<\/latest>/) ?? [])[1] ?? null;
  const release = (text.match(/<release>\s*([^<\s]+)\s*<\/release>/) ?? [])[1] ?? null;
  return { versions, latest, release };
}

/**
 * ExchangeClient — thin wrapper around a bearer-providing AnypointClient + fetch.
 * @param {object} opts
 * @param {object} opts.anypoint  AnypointClient instance (provides baseUrl + _getToken + configured)
 * @param {Function} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs=10000]
 */
export class ExchangeClient {
  constructor({ anypoint, fetchImpl, timeoutMs = 10000 } = {}) {
    this.anypoint = anypoint;
    this.fetch = fetchImpl ?? anypoint?.fetch ?? globalThis.fetch;
    this.baseUrl = anypoint?.baseUrl ?? "https://anypoint.mulesoft.com";
    this.timeoutMs = timeoutMs;
  }

  configured() {
    return Boolean(this.anypoint?.configured?.());
  }

  async _get(path) {
    const token = await this.anypoint._getToken();
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status && res.status >= 400) throw new Error(`Exchange GET ${path} → HTTP ${res.status}`);
    return await res.text();
  }

  // Build the Maven-facade asset path: /api/v3/maven/{org}/{asset}/{ver}/{asset}-{ver}[-classifier].{pkg}
  _assetPath(id, version) {
    const cls = id.classifier ? `-${id.classifier}` : "";
    return `/api/v3/maven/${id.orgId}/${id.assetId}/${version}/${id.assetId}-${version}${cls}.${id.packaging}`;
  }

  async _resolveVersion(id) {
    if (id.source === "exchange-latest") {
      const meta = parseMavenMetadata(await this._get(`/api/v3/maven/${id.orgId}/${id.assetId}/maven-metadata.xml`));
      return highestSemver(meta.versions) ?? meta.latest ?? meta.release ?? id.version;
    }
    return id.version; // pinned
  }

  /**
   * fetchAsset(family): download + parse the YAML asset for "matrix" | "registry".
   * @returns {{ok:true, data, version, source} | {ok:false, reason}}  NEVER throws.
   */
  async fetchAsset(family) {
    const id = configFor(family);
    if (!String(id.source).startsWith("exchange")) return { ok: false, reason: "source is classpath" };
    if (!this.configured()) return { ok: false, reason: "anypoint not configured" };
    if (!id.orgId || !id.assetId) return { ok: false, reason: "exchange orgId/assetId not configured" };
    try {
      const version = await this._resolveVersion(id);
      if (!version) return { ok: false, reason: "could not resolve asset version" };
      const body = await this._get(this._assetPath(id, version));
      const data = yaml.load(body);
      if (data == null || typeof data !== "object") return { ok: false, reason: "asset parsed to non-object" };
      // Matrix safety-net: an empty connectors block would silently skip connector pinning → reject.
      if (family === "matrix" && (!Array.isArray(data.connectors) || data.connectors.length === 0)) {
        return { ok: false, reason: "exchange matrix has empty connectors block", version };
      }
      return { ok: true, data, version, source: id.source };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }
}
