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
import { lt } from "./semver.js";
import { cached } from "./cache.js";

// Default cross-process cache TTLs (seconds). Overridable via config; see cache.* / matrix.refreshSeconds.
const DEFAULT_VERSIONS_TTL_S = 43200; // 12h — a connector's published-version list changes slowly
const DEFAULT_MATRIX_TTL_S = 86400; //   24h — falls back to matrix/registry.refreshSeconds per family

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

// Pick the highest semver from a list of "X.Y.Z" strings. Reuses semver.lt (the shared major→minor
// →patch comparison) rather than the old lossy vnum() packing, which capped each segment at ~999 and
// mis-ordered versions like 1.1000.0. A single linear max pass keeps the highest by lt().
export function highestSemver(versions) {
  const list = (versions ?? []).map(String).filter(Boolean);
  if (!list.length) return null;
  return list.reduce((hi, v) => (lt(hi, v) ? v : hi));
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
 * parsePomDependencies(xml): regex-parse a Maven POM string (no XML dep) into its <properties> map and
 * its <dependencies> edges, classifying each edge's version as literal / `${property}`-ref / BOM-managed.
 *
 * Only the top-level <dependencies> block is read (NOT <dependencyManagement>, whose versions apply to
 * OTHER poms, not this artifact's own deps). Each edge reports:
 *   • version    — the resolved literal version if the <version> is a plain string, else null
 *   • versionRef — the property NAME when <version> is `${name}`, else null
 *   • managed    — true when the dep declares NO <version> (its version is BOM/parent-managed)
 * @param {string} xml
 * @returns {{properties:Object<string,string>, dependencies:Array<{groupId,artifactId,version,versionRef,managed}>}}
 */
export function parsePomDependencies(xml) {
  const text = String(xml ?? "");
  // <properties> … </properties> (first block only — the project's own props).
  /** @type {Object<string,string>} */
  const properties = {};
  const propsBlock = (text.match(/<properties>([\s\S]*?)<\/properties>/i) ?? [])[1];
  if (propsBlock) {
    for (const m of propsBlock.matchAll(/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g)) {
      properties[m[1]] = m[2];
    }
  }
  // Isolate the top-level <dependencies> block, EXCLUDING any inside <dependencyManagement>.
  let depsScope = text;
  const dmBlock = text.match(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/i);
  if (dmBlock) depsScope = text.replace(dmBlock[0], "");
  const depsBlock = (depsScope.match(/<dependencies>([\s\S]*?)<\/dependencies>/i) ?? [])[1] ?? "";

  const dependencies = [];
  for (const m of depsBlock.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const b = m[1];
    const grab = (tag) => (b.match(new RegExp(`<${tag}>\\s*([^<]*?)\\s*<\\/${tag}>`, "i")) ?? [])[1] ?? null;
    const groupId = grab("groupId");
    const artifactId = grab("artifactId");
    if (!groupId || !artifactId) continue;
    const rawVer = grab("version");
    const refMatch = rawVer ? rawVer.match(/^\$\{\s*([\w.-]+)\s*\}$/) : null;
    dependencies.push({
      groupId,
      artifactId,
      version: rawVer && !refMatch ? rawVer : null,
      versionRef: refMatch ? refMatch[1] : null,
      managed: rawVer == null, // no <version> → version comes from a BOM/parent
    });
  }
  return { properties, dependencies };
}

/**
 * ExchangeClient — thin wrapper around a bearer-providing AnypointClient + fetch.
 */
export class ExchangeClient {
  /**
   * @param {object} [opts]
   * @param {any} [opts.anypoint]  AnypointClient instance (provides baseUrl + _getToken + configured)
   * @param {Function} [opts.fetchImpl]
   * @param {string} [opts.mavenBaseUrl]  Exchange Maven-facade host (else anypoint.mavenBase config / default)
   * @param {string} [opts.graphUrl]      Exchange GraphQL endpoint (else anypoint.graphUrl config / baseUrl default)
   * @param {number} [opts.timeoutMs]     per-request fetch deadline in ms (AbortController); 0 disables
   */
  constructor({ anypoint, fetchImpl, mavenBaseUrl, graphUrl, timeoutMs = 10000 } = {}) {
    this.anypoint = anypoint;
    this.fetch = fetchImpl ?? anypoint?.fetch ?? globalThis.fetch;
    // Platform base (token/ARM) — the UI host. Kept for reference/back-compat.
    this.baseUrl = anypoint?.baseUrl ?? "https://anypoint.mulesoft.com";
    // Exchange Maven FACADE host — a DIFFERENT host from the platform UI. The UI host returns the
    // SPA HTML (200) for any /api/v3/maven path, which then fails YAML parsing; the artifacts live on
    // maven.anypoint.mulesoft.com (same host Mule's pf-load-matrix and `mvn deploy` use).
    this.mavenBaseUrl = mavenBaseUrl ?? cfg("anypoint.mavenBase", "https://maven.anypoint.mulesoft.com");
    // Exchange GraphQL endpoint (Platform query). Used to enumerate a connector's published versions —
    // the Maven-facade maven-metadata.xml 404s for premium connectors, but Graph resolves them all.
    this.graphUrl =
      graphUrl ?? cfg("anypoint.graphUrl", `${this.baseUrl}/graph/api/v1/graphql`);
    this.timeoutMs = timeoutMs;
  }

  configured() {
    return Boolean(this.anypoint?.configured?.());
  }

  /**
   * _timedFetch(url, init): this.fetch with an AbortController deadline of this.timeoutMs, so a
   * hung Exchange host can't stall the run indefinitely (the stored timeout was previously never
   * applied). A timeout surfaces as a thrown AbortError, which every caller already degrades
   * non-fatally. A falsy/non-positive timeoutMs disables the deadline.
   * @param {string} url
   * @param {object} [init]
   */
  async _timedFetch(url, init = {}) {
    if (!(this.timeoutMs > 0) || typeof AbortController === "undefined") {
      return this.fetch(url, init);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async _get(path) {
    const token = await this.anypoint._getToken();
    const res = await this._timedFetch(`${this.mavenBaseUrl}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status && res.status >= 400) throw new Error(`Exchange GET ${path} → HTTP ${res.status}`);
    const body = await res.text();
    // Guard: a wrong host/path (or an unauthenticated redirect) returns the Anypoint SPA HTML with a
    // 200, which would otherwise blow up YAML/XML parsing with a misleading error. Fail cleanly.
    const ct = res.headers?.get?.("content-type") ?? "";
    if (/text\/html/i.test(ct) || /^\s*<(?:!doctype|html)\b/i.test(body)) {
      throw new Error(`Exchange GET ${path} returned HTML, not the artifact (wrong endpoint or auth redirect)`);
    }
    return body;
  }

  /**
   * _graphQuery(query): POST a GraphQL query to the Exchange Platform endpoint with the Anypoint
   * bearer. Returns the parsed `data` object. Throws on HTTP >= 400, a non-JSON/HTML body, or a
   * top-level `errors` array (so callers' try/catch can degrade non-fatally).
   * @param {string} query
   * @returns {Promise<any>}
   */
  async _graphQuery(query) {
    const token = await this.anypoint._getToken();
    const res = await this._timedFetch(this.graphUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query }),
    });
    if (res.status && res.status >= 400) throw new Error(`Exchange GraphQL → HTTP ${res.status}`);
    const body = await res.text();
    const ct = res.headers?.get?.("content-type") ?? "";
    if (/text\/html/i.test(ct) || /^\s*<(?:!doctype|html)\b/i.test(body)) {
      throw new Error("Exchange GraphQL returned HTML, not JSON (wrong endpoint or auth redirect)");
    }
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error("Exchange GraphQL returned a non-JSON body");
    }
    if (Array.isArray(json.errors) && json.errors.length) {
      throw new Error(`Exchange GraphQL error: ${json.errors[0]?.message ?? "unknown"}`);
    }
    return json.data;
  }

  // Build the Exchange Maven-FACADE asset path. The facade is org-scoped and Exchange asset groupId IS
  // the orgId, so the org appears twice: /api/v3/organizations/{org}/maven/{groupId=org}/{asset}/{ver}/…
  _assetPath(id, version) {
    const cls = id.classifier ? `-${id.classifier}` : "";
    return `/api/v3/organizations/${id.orgId}/maven/${id.orgId}/${id.assetId}/${version}/${id.assetId}-${version}${cls}.${id.packaging}`;
  }

  /**
   * fetchPom(groupId, artifactId, version): download + parse a connector's published POM from the
   * Exchange Maven FACADE (the same host `mvn` uses). Unlike the org-scoped asset path, connector
   * POMs live under the flat groupId-keyed layout: /api/v3/maven/{groupId}/{artifactId}/{version}/…
   *
   * B12: connectorGaps needs to know whether a connector's dependency versions are HARD-CODED, driven
   * by a `${property}`, or BOM-managed (no <version> at all). This parses each <dependency> block and
   * classifies it, plus captures the pom's own <properties> so a caller can resolve a `${property}`.
   *
   * FULLY NON-FATAL: any network/auth/parse failure returns { ok:false, reason }.
   * @param {string} groupId
   * @param {string} artifactId
   * @param {string} version
   * @returns {Promise<{ok:true, groupId, artifactId, version, properties:Object<string,string>,
   *   dependencies:Array<{groupId, artifactId, version:(string|null), versionRef:(string|null), managed:boolean}>}
   *   | {ok:false, reason:string}>}
   */
  async fetchPom(groupId, artifactId, version) {
    if (!this.configured()) return { ok: false, reason: "anypoint not configured" };
    if (!groupId || !artifactId || !version)
      return { ok: false, reason: "groupId, artifactId and version are required" };
    try {
      const token = await this.anypoint._getToken();
      const path = `/api/v3/maven/${groupId}/${artifactId}/${version}/${artifactId}-${version}.pom`;
      const res = await this._timedFetch(`${this.mavenBaseUrl}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "follow",
      });
      if (res.status && res.status >= 400) throw new Error(`Exchange POM GET → HTTP ${res.status}`);
      const body = await res.text();
      if (!/<project[\s>]/i.test(body)) throw new Error("response is not a Maven POM");
      return { ok: true, groupId, artifactId, version, ...parsePomDependencies(body) };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /**
   * graphDependencies(groupId, artifactId, version): the connector's ONE-LEVEL (direct) dependency
   * edges as reported by the Exchange Graph API, with each edge's version already resolved.
   *
   * B13: LOCKED at connector-level — a single level of expansion (direct deps only), NOT a full
   * transitive Maven tree. Graph's `assets{ dependencies{ groupId assetId version } }` field returns
   * exactly the direct edges with concrete versions; we do NOT recurse. When `version` is supplied we
   * return the edges for that exact version row; otherwise the highest-matching row Graph ranks first.
   *
   * FULLY NON-FATAL: any network/auth/parse failure returns { ok:false, reason }.
   * @param {string} groupId    expected groupId (disambiguates same-named assets); may be ""/null
   * @param {string} artifactId the connector's Exchange assetId (matched EXACTLY)
   * @param {string} [version]  restrict to this exact published version (else first matching row)
   * @returns {Promise<{ok:true, groupId, artifactId, version, dependencies:Array<{groupId, assetId, version}>}
   *   | {ok:false, reason:string}>}
   */
  async graphDependencies(groupId, artifactId, version) {
    if (!this.configured()) return { ok: false, reason: "anypoint not configured" };
    if (!artifactId) return { ok: false, reason: "artifactId required" };
    try {
      const PAGE = 100;
      const MAX_PAGES = 30; // same offset backstop as listVersions
      const term = JSON.stringify(String(artifactId));
      let matched = null;
      for (let page = 0; page < MAX_PAGES && !matched; page++) {
        const offset = page * PAGE;
        const data = await this._graphQuery(
          `query { assets(query:{ searchTerm:${term}, limit:${PAGE}, offset:${offset} }){ groupId assetId version dependencies { groupId assetId version } } }`
        );
        const rows = Array.isArray(data?.assets) ? data.assets : [];
        for (const r of rows) {
          if (r?.assetId !== artifactId) continue;
          if (groupId && r.groupId && r.groupId !== groupId) continue;
          if (version && String(r.version) !== String(version)) continue;
          matched = r; // exact-version row (or, when no version given, the first assetId match)
          break;
        }
        if (rows.length < PAGE) break; // last page reached
      }
      if (!matched) return { ok: false, reason: "connector/version not found on Exchange Graph" };
      const dependencies = (Array.isArray(matched.dependencies) ? matched.dependencies : [])
        .filter((d) => d && d.assetId)
        .map((d) => ({
          groupId: d.groupId ? String(d.groupId) : null,
          assetId: String(d.assetId),
          version: d.version != null ? String(d.version) : null,
        }));
      return { ok: true, groupId: matched.groupId ?? groupId ?? null, artifactId, version: String(matched.version), dependencies };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  async _resolveVersion(id) {
    if (id.source === "exchange-latest") {
      const meta = parseMavenMetadata(
        await this._get(`/api/v3/organizations/${id.orgId}/maven/${id.orgId}/${id.assetId}/maven-metadata.xml`)
      );
      return highestSemver(meta.versions) ?? meta.latest ?? meta.release ?? id.version;
    }
    return id.version; // pinned
  }

  /**
   * listVersions(groupId, artifactId): enumerate a connector's published versions via the Exchange
   * GraphQL API. Used by EPIC B's connector-version resolver to offer the operator a CHOICE (matrix
   * pin / latest-in-major / latest).
   *
   * WHY Graph, not maven-metadata.xml: the org-scoped Maven-facade maven-metadata path 404s for
   * premium connectors (com.mulesoft.connectors) — it only serves assets the caller's org actually
   * owns/mirrors. The GraphQL `assets(query:{searchTerm})` search resolves EVERY published connector
   * (OSS + premium) the token can see on Exchange.
   *
   * The Graph `SearchAsset` input only accepts `searchTerm`/`type`/`limit`/`offset` — it REJECTS
   * groupId/assetId as filters — and a single page is relevance-ranked + truncated (a lone limit:100
   * page for mule-http-connector peaked at 1.5.15, missing the real 1.11.3). So we PAGINATE fully by
   * offset, keep only rows whose assetId matches EXACTLY (and, when supplied, groupId), and dedup —
   * that reliably reaches the true latest. FULLY NON-FATAL: any network/auth/parse failure returns
   * { ok:false, reason } so the caller falls back to the bundled matrix version.
   *
   * @param {string} groupId    expected groupId (used to disambiguate same-named assets); may be ""/null
   * @param {string} artifactId the connector's Exchange assetId (matched EXACTLY)
   * @returns {Promise<{ok:true, versions:string[], latest:(string|null), release:(string|null)} | {ok:false, reason:string}>}
   */
  async listVersions(groupId, artifactId) {
    if (!this.configured()) return { ok: false, reason: "anypoint not configured" };
    if (!artifactId) return { ok: false, reason: "artifactId required" };
    // Cross-process disk cache: the per-connector Graph pagination is the single biggest repeat cost of
    // `assess --versions` / resolve_versions. Only ok:true results are stored, so a transient outage
    // never gets pinned; MULE_UPGRADE_REFRESH=1 (or cache.enabled:false) bypasses.
    const ttlMs = Number(cfg("cache.versionsTtlSeconds", DEFAULT_VERSIONS_TTL_S)) * 1000;
    return cached("exchange-versions", `${groupId || ""}:${artifactId}`, ttlMs, () => this._listVersionsLive(groupId, artifactId), {
      shouldCache: (r) => r?.ok === true,
    });
  }

  /** @returns {Promise<{ok:true, versions:string[], latest:(string|null), release:(string|null)} | {ok:false, reason:string}>} */
  async _listVersionsLive(groupId, artifactId) {
    try {
      const PAGE = 100;
      const MAX_PAGES = 30; // 3000 rows — far beyond any connector's version count; loop backstop
      const term = JSON.stringify(String(artifactId)); // safely quote for the GraphQL literal
      const versions = new Set();
      for (let page = 0; page < MAX_PAGES; page++) {
        const offset = page * PAGE;
        const data = await this._graphQuery(
          `query { assets(query:{ searchTerm:${term}, limit:${PAGE}, offset:${offset} }){ groupId assetId version } }`
        );
        const rows = Array.isArray(data?.assets) ? data.assets : [];
        for (const r of rows) {
          if (r?.assetId !== artifactId) continue;
          if (groupId && r.groupId && r.groupId !== groupId) continue;
          if (r.version) versions.add(String(r.version));
        }
        if (rows.length < PAGE) break; // last page reached
      }
      const list = [...versions];
      if (!list.length) return { ok: false, reason: "no versions from Exchange Graph" };
      const latest = highestSemver(list);
      return { ok: true, versions: list, latest, release: latest };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /**
   * fetchAsset(family): download + parse the YAML asset for "matrix" | "registry".
   * @param {string} family
   * @returns {Promise<{ok:true, data:any, version:any, source:any} | {ok:false, reason:any, version?:any}>}  NEVER throws.
   */
  async fetchAsset(family) {
    const id = configFor(family);
    if (!String(id.source).startsWith("exchange")) return { ok: false, reason: "source is classpath" };
    if (!this.configured()) return { ok: false, reason: "anypoint not configured" };
    if (!id.orgId || !id.assetId) return { ok: false, reason: "exchange orgId/assetId not configured" };
    // Cross-process disk cache for the matrix/registry asset (incl. the maven-metadata resolve for
    // exchange-latest). TTL from <family>.refreshSeconds (matrix/registry already expose it). Only
    // ok:true is stored; the key pins the exact asset identity so an env/version change misses cleanly.
    const ttlMs =
      Number(cfg(`${family}.refreshSeconds`, cfg("cache.matrixTtlSeconds", DEFAULT_MATRIX_TTL_S))) * 1000;
    const key = `${family}:${id.orgId}:${id.assetId}:${id.source}:${id.version || ""}:${id.classifier}:${id.packaging}`;
    return cached("exchange-asset", key, ttlMs, () => this._fetchAssetLive(family, id), {
      shouldCache: (r) => r?.ok === true,
    });
  }

  /** @returns {Promise<{ok:true, data:any, version:any, source:any} | {ok:false, reason:any, version?:any}>} */
  async _fetchAssetLive(family, id) {
    try {
      const version = await this._resolveVersion(id);
      if (!version) return { ok: false, reason: "could not resolve asset version" };
      const body = await this._get(this._assetPath(id, version));
      const data = yaml.load(body);
      if (data == null || typeof data !== "object")
        return { ok: false, reason: "asset parsed to non-object" };
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
