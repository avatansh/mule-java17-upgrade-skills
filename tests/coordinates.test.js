// tests/coordinates.test.js — pf-resolve-coordinates parity.
//   · 3-tier precedence (registry → request → convention) per field
//   · allow-list enforcement (enforceAllowList → APP_NOT_REGISTERED)
//   · owner/repo post-resolution validation
//   · branch waterfall + live default-branch discovery + cache + fallback
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveCoordinates,
  discoverDefaultBranch,
  _resetBranchCache,
} from "../lib_shared/coordinates.js";

// A stub config reader: `cfg(dotted, fallback)` reads from a plain object of dotted keys.
function cfgFrom(map) {
  return (k, fb) => (k in map ? map[k] : fb);
}

const CONVENTION = {
  "github.defaultOwner": "acme",
  "github.defaultBranch": "main",
  "anypoint.defaultOrgId": "org-default",
  "naming.repoEqualsAppName": "true",
  "naming.appPathAtRoot": "true",
  "registry.enforceAllowList": "false",
};

test("tier 1: registry entry wins over convention", async () => {
  _resetBranchCache();
  const registry = { billing: { owner: "acme-corp", repo: "Mule-Apps", appPath: "billing-eapi", orgId: "org-1", defaultBranch: "develop" } };
  const c = await resolveCoordinates({
    appName: "billing",
    registry,
    deps: { cfg: cfgFrom(CONVENTION) },
  });
  assert.deepEqual(c, {
    appName: "billing",
    owner: "acme-corp",
    repo: "Mule-Apps",
    appPath: "billing-eapi",
    orgId: "org-1",
    defaultBranch: "develop",
    fromRegistry: true,
  });
});

test("tier 2: request override beats convention when no registry entry", async () => {
  _resetBranchCache();
  const c = await resolveCoordinates({
    appName: "orders",
    registry: {},
    request: { owner: "me", repo: "custom-repo", appPath: "sub", orgId: "org-req", branch: "feature" },
    deps: { cfg: cfgFrom(CONVENTION) },
  });
  assert.equal(c.owner, "me");
  assert.equal(c.repo, "custom-repo");
  assert.equal(c.appPath, "sub");
  assert.equal(c.orgId, "org-req");
  assert.equal(c.defaultBranch, "feature");
  assert.equal(c.fromRegistry, false);
});

test("tier 3: convention fills owner/repo/appPath/orgId", async () => {
  _resetBranchCache();
  const c = await resolveCoordinates({
    appName: "orders",
    registry: {},
    deps: { cfg: cfgFrom(CONVENTION) },
    discoverBranch: false, // no getRepo → config default
  });
  assert.equal(c.owner, "acme"); // github.defaultOwner
  assert.equal(c.repo, "orders"); // repoEqualsAppName
  assert.equal(c.appPath, "."); // appPathAtRoot
  assert.equal(c.orgId, "org-default"); // anypoint.defaultOrgId
  assert.equal(c.defaultBranch, "main"); // github.defaultBranch
});

test("registry entry precedence is per-field (registry owner + convention appPath)", async () => {
  _resetBranchCache();
  const registry = { orders: { owner: "acme-corp" } }; // only owner set
  const c = await resolveCoordinates({
    appName: "orders",
    registry,
    deps: { cfg: cfgFrom(CONVENTION) },
    discoverBranch: false,
  });
  assert.equal(c.owner, "acme-corp"); // from registry
  assert.equal(c.repo, "orders"); // convention (repoEqualsAppName)
  assert.equal(c.appPath, "."); // convention (appPathAtRoot)
});

test("naming toggles off: repoEqualsAppName=false & appPathAtRoot=false → null when unspecified", async () => {
  _resetBranchCache();
  const cfg = cfgFrom({ ...CONVENTION, "naming.repoEqualsAppName": "false", "naming.appPathAtRoot": "false" });
  // repo cannot resolve → VALIDATION
  await assert.rejects(
    () => resolveCoordinates({ appName: "orders", registry: {}, deps: { cfg } }),
    (e) => e.code === "VALIDATION" && e.errorType === "APP_NOT_REGISTERED"
  );
});

test("allow-list: enforceAllowList=true + app absent → APP_NOT_REGISTERED", async () => {
  _resetBranchCache();
  const cfg = cfgFrom({ ...CONVENTION, "registry.enforceAllowList": "true" });
  await assert.rejects(
    () => resolveCoordinates({ appName: "ghost", registry: {}, deps: { cfg } }),
    (e) => e.code === "VALIDATION" && e.errorType === "APP_NOT_REGISTERED" && /allow-list/.test(e.message)
  );
});

test("allow-list: enforceAllowList=true + app present → resolves", async () => {
  _resetBranchCache();
  const cfg = cfgFrom({ ...CONVENTION, "registry.enforceAllowList": "true" });
  const registry = { known: { owner: "o", repo: "r" } };
  const c = await resolveCoordinates({ appName: "known", registry, deps: { cfg }, discoverBranch: false });
  assert.equal(c.owner, "o");
  assert.equal(c.repo, "r");
});

test("owner missing (no default) → VALIDATION", async () => {
  _resetBranchCache();
  const cfg = cfgFrom({ ...CONVENTION, "github.defaultOwner": undefined });
  await assert.rejects(
    () => resolveCoordinates({ appName: "orders", registry: {}, deps: { cfg } }),
    (e) => e.code === "VALIDATION"
  );
});

test("appName is required", async () => {
  _resetBranchCache();
  await assert.rejects(
    () => resolveCoordinates({ registry: {}, deps: { cfg: cfgFrom(CONVENTION) } }),
    (e) => e.code === "VALIDATION"
  );
});

test("branch discovery: live getRepo default_branch wins over config default", async () => {
  _resetBranchCache();
  let calls = 0;
  const getRepo = async (o, r) => {
    calls++;
    return { default_branch: "trunk" };
  };
  const c = await resolveCoordinates({
    appName: "orders",
    registry: {},
    deps: { cfg: cfgFrom(CONVENTION), getRepo },
  });
  assert.equal(c.defaultBranch, "trunk");
  assert.equal(calls, 1);
});

test("branch discovery: getRepo error → config default (non-fatal)", async () => {
  _resetBranchCache();
  const getRepo = async () => {
    throw new Error("404");
  };
  const c = await resolveCoordinates({
    appName: "orders",
    registry: {},
    deps: { cfg: cfgFrom(CONVENTION), getRepo },
  });
  assert.equal(c.defaultBranch, "main");
});

test("branch discovery: request branch short-circuits (no getRepo call)", async () => {
  _resetBranchCache();
  let calls = 0;
  const getRepo = async () => {
    calls++;
    return { default_branch: "trunk" };
  };
  const c = await resolveCoordinates({
    appName: "orders",
    registry: {},
    request: { branch: "hotfix" },
    deps: { cfg: cfgFrom(CONVENTION), getRepo },
  });
  assert.equal(c.defaultBranch, "hotfix");
  assert.equal(calls, 0);
});

test("discoverDefaultBranch memoizes per owner/repo", async () => {
  _resetBranchCache();
  let calls = 0;
  const getRepo = async () => {
    calls++;
    return { default_branch: "trunk" };
  };
  const a = await discoverDefaultBranch("o", "r", { getRepo, configDefault: "main" });
  const b = await discoverDefaultBranch("o", "r", { getRepo, configDefault: "main" });
  assert.equal(a, "trunk");
  assert.equal(b, "trunk");
  assert.equal(calls, 1); // second call served from cache
});
