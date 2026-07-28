// jobstore.js — SKILL 5 job store. A dependency-free JSON mirror of the Mule app's Object Store
// partitions, so the entire stateful lifecycle (create → status transitions → PR/branch tracking →
// reconcile → delete) survives across the many separate skill invocations a single upgrade spans.
//
// Object Store → JSON-file mapping (root defaults to ~/.mule-upgrade/, override via MULE_UPGRADE_HOME):
//   jobStore          → jobs/<jobId>.json                    (the job record; key = jobId)
//   locksStore        → locks/lock__<app>.json               (single-flight; value = jobId)
//   indexStore        → index/branch__<branch>.json          (branch → jobId correlation)
//   idempotencyStore  → idem/<key>.json                      (poll/callback dedup markers)
//
// Object Store keys ("lock::app", "branch::migrate/x") contain characters illegal in Windows
// filenames (":" and "/"), so keys are encoded to safe filenames; the original key is stored inside.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { nowUtc } from "../../../lib_shared/dates.js";

// ── paths ─────────────────────────────────────────────────────────────────────────────
export function storeRoot() {
  return process.env.MULE_UPGRADE_HOME || path.join(os.homedir(), ".mule-upgrade");
}
const partitions = {
  jobs: () => path.join(storeRoot(), "jobs"),
  locks: () => path.join(storeRoot(), "locks"),
  index: () => path.join(storeRoot(), "index"),
  idem: () => path.join(storeRoot(), "idem"),
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Encode an OS key ("lock::app", "branch::migrate/x-1") into a safe, reversible filename stem.
// Illegal filename chars (/ \ : * ? " < > |) → "_"; if that collapses distinct keys, a short hash
// keeps them unique.
function encodeKey(key) {
  const safe = String(key).replace(/[/\\:*?"<>|]/g, "_");
  const h = crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8);
  return `${safe}.${h}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Atomic write: write to a temp file in the same dir, then rename over the target.
function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// ── generic partition ops ───────────────────────────────────────────────────────────────
// jobStore is keyed by jobId directly (jobIds are already filename-safe: "job-<uuid>").
function jobFile(jobId) {
  return path.join(partitions.jobs(), `${jobId}.json`);
}
function lockFile(appName) {
  return path.join(partitions.locks(), `${encodeKey(`lock::${appName}`)}.json`);
}
function branchFile(branch) {
  return path.join(partitions.index(), `${encodeKey(`branch::${branch}`)}.json`);
}
function idemFile(key) {
  return path.join(partitions.idem(), `${encodeKey(key)}.json`);
}

// ── job records ─────────────────────────────────────────────────────────────────────────
/** newJobId(): "job-<uuid>" (mirrors 'job-' ++ uuid()). */
export function newJobId() {
  return `job-${crypto.randomUUID()}`;
}

/** getJob(jobId): the record or null (mirrors os:retrieve → OS:KEY_NOT_FOUND). */
export function getJob(jobId) {
  return readJson(jobFile(jobId));
}

/** listJobs(): every persisted job record (mirrors os:retrieve-all-keys + retrieve). */
export function listJobs() {
  const dir = partitions.jobs();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".json"))
    .map((n) => readJson(path.join(dir, n)))
    .filter(Boolean);
}

/** putJob(rec): overwrite the full record (mirrors os:store key=jobId). */
export function putJob(rec) {
  if (!rec?.jobId) throw new Error("putJob: record has no jobId");
  writeJson(jobFile(rec.jobId), rec);
  return rec;
}

/**
 * createJob(opts): acquire the single-flight lock, then persist a PROCESSING record.
 * Mirrors post-jobs.xml: os:retrieve lock (throws if held → 409 CONFLICT) → os:store lock=jobId
 * → os:store job record.
 *
 * The lock is claimed on `lockKey` when supplied, else `appName`. This lets a MONOREPO run several
 * independent module upgrades at once: an app upgrade locks on the app name, while a parent/BOM
 * upgrade locks on `<repo>::<pomPath>` (e.g. `mule-apps::bom/pom.xml` vs `mule-apps::parent-pom/pom.xml`),
 * so a BOM PR, a parent-pom PR, and the app PR can all be open on the same repo concurrently — while
 * two upgrades of the SAME pom still single-flight. The chosen key is persisted as `record.lockKey`
 * so every release path (reconcile, ci_ingest, deleteJob) frees the exact key that was claimed.
 * @returns {{jobId, record}}
 * @throws {Error} code "CONFLICT" with .existingJobId when the key is already locked.
 */
export function createJob({
  appName,
  environment = null,
  jiraTicketId = null,
  approvedChangePlan = null,
  coords = null,
  changePlan = null,
  jobId = newJobId(),
  lockKey = null,
}) {
  if (!appName) throw new Error("createJob: appName is required");
  const key = lockKey || appName;
  const existing = acquireLock(key, jobId);
  if (existing !== jobId) {
    const err = new Error(
      `An upgrade for "${key}" is already in progress (jobId=${existing}). ` +
        `Wait for it to complete or fail before starting a new one.`
    );
    err.code = "CONFLICT";
    err.existingJobId = existing;
    throw err;
  }
  const ts = nowUtc();
  const record = {
    jobId,
    status: "PROCESSING",
    appName,
    lockKey: key,
    environment,
    jiraTicketId,
    approvedChangePlan,
    coords,
    changePlan,
    createdAt: ts,
    updatedAt: ts,
    prUrl: null,
    branchName: null,
    completedAt: null,
    error: null,
  };
  putJob(record);
  return { jobId, record };
}

/**
 * setStatus(jobId, targetStatus, extra): merge status + updatedAt (+ any extra fields) onto the
 * persisted record. Mirrors pf-set-status. Terminal statuses stamp completedAt when absent.
 * @returns updated record (or null if the job is gone)
 */
export const TERMINAL = new Set([
  "DEPLOYED",
  "NO_CHANGE",
  "CLOSED",
  "FAILED_ASSESS",
  "FAILED_COMMIT",
  "FAILED_DEPLOY",
  "FAILED_INTERRUPTED",
]);

export function setStatus(jobId, targetStatus, extra = {}) {
  const rec = getJob(jobId);
  if (!rec) return null;
  const updated = { ...rec, ...extra, status: targetStatus, updatedAt: nowUtc() };
  if (TERMINAL.has(targetStatus) && updated.completedAt == null) {
    updated.completedAt = updated.updatedAt;
  }
  putJob(updated);
  return updated;
}

/** patchJob(jobId, fields): merge arbitrary fields + bump updatedAt, without changing status. */
export function patchJob(jobId, fields = {}) {
  const rec = getJob(jobId);
  if (!rec) return null;
  const updated = { ...rec, ...fields, updatedAt: nowUtc() };
  putJob(updated);
  return updated;
}

// ── locks (locksStore) ────────────────────────────────────────────────────────────────
// A held lock is STALE (and may be stolen) when either:
//   · its holder job no longer exists, or is already in a terminal status (the holder crashed or
//     finished without releasing — mirrors reconcile's FAILED_INTERRUPTED lock recovery), or
//   · the lock file is older than LOCK_TTL_MS (a crashed run whose record was also lost).
// This makes the single-flight lock self-healing so a dead job never permanently blocks re-runs.
const LOCK_TTL_MS = 6 * 60 * 60 * 1000; // 6h — far longer than any real upgrade run

/**
 * lockIsStale(held, nowMs): whether a held-lock record can be safely stolen. Exported for tests.
 * @param {{jobId?:string, at?:string}|null} held  the parsed lock file
 * @param {number} [nowMs]
 */
export function lockIsStale(held, nowMs = Date.now()) {
  if (!held) return true;
  const holder = held.jobId ? getJob(held.jobId) : null;
  if (!holder) return true; // holder record gone → orphaned lock
  if (TERMINAL.has(holder.status)) return true; // holder finished/failed without releasing
  const at = held.at ? Date.parse(held.at) : NaN;
  if (!Number.isNaN(at) && nowMs - at > LOCK_TTL_MS) return true; // aged out
  return false;
}

/**
 * acquireLock(appName, jobId): claim the single-flight lock. Returns the jobId that HOLDS the
 * lock afterwards — equal to the passed jobId when acquired, or the pre-existing holder on
 * contention. Best-effort atomicity via wx (exclusive create). A STALE lock (dead/terminal holder
 * or aged past LOCK_TTL_MS) is stolen so a crashed job can't block the app forever.
 */
export function acquireLock(appName, jobId) {
  const file = lockFile(appName);
  ensureDir(path.dirname(file));
  const record = () =>
    JSON.stringify({ key: `lock::${appName}`, appName, jobId, at: nowUtc() }, null, 2);
  try {
    // wx: fail if the file already exists → detects a held lock without a read/write race.
    fs.writeFileSync(file, record(), { flag: "wx" });
    return jobId;
  } catch (e) {
    if (e.code === "EEXIST") {
      const held = readJson(file);
      if (lockIsStale(held)) {
        // Steal: overwrite atomically. The prior holder is dead/terminal/aged, so this is safe.
        writeJson(file, JSON.parse(record()));
        return jobId;
      }
      return held?.jobId ?? "unknown";
    }
    throw e;
  }
}

/** lockHolder(appName): the jobId currently holding the app lock, or null. */
export function lockHolder(appName) {
  return readJson(lockFile(appName))?.jobId ?? null;
}

/**
 * releaseLock(appName): idempotent release (mirrors pf-release-lock: os:contains then os:remove).
 * @returns true if a lock was removed, false if none existed.
 */
export function releaseLock(appName) {
  const file = lockFile(appName);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

// ── branch index (indexStore) ───────────────────────────────────────────────────────────
/** putBranchIndex(branch, jobId): correlate a branch → jobId (mirrors 'branch::' ++ branch). */
export function putBranchIndex(branch, jobId) {
  writeJson(branchFile(branch), { key: `branch::${branch}`, branch, jobId, at: nowUtc() });
}
/** jobIdForBranch(branch): the jobId a branch maps to, or null. */
export function jobIdForBranch(branch) {
  return readJson(branchFile(branch))?.jobId ?? null;
}
/** removeBranchIndex(branch): idempotent delete of the branch→jobId entry. */
export function removeBranchIndex(branch) {
  const file = branchFile(branch);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

// ── idempotency markers (idempotencyStore) ──────────────────────────────────────────────
/**
 * markOnce(key, value): store a dedup marker if absent; returns true if THIS call created it
 * (i.e. first time — proceed), false if it already existed (i.e. duplicate — skip). Mirrors the
 * os:contains → os:store idempotency guard used for webhook/callback/notify dedup.
 */
export function markOnce(key, value = true) {
  const file = idemFile(key);
  ensureDir(path.dirname(file));
  try {
    fs.writeFileSync(file, JSON.stringify({ key, value, at: nowUtc() }, null, 2), { flag: "wx" });
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
}
/** seen(key): whether an idempotency marker exists. */
export function seen(key) {
  return fs.existsSync(idemFile(key));
}

// ── delete (delete-job.xml) ─────────────────────────────────────────────────────────────
/**
 * deleteJob(jobId): remove the record, clear its branch index entry, and release the app lock —
 * but ONLY if the lock is still held BY THIS job (never steal another job's lock). Mirrors
 * delete-job.xml. Throws NOT_FOUND when the job is absent.
 * @returns {{deleted:boolean, branchCleared:boolean, lockReleased:boolean}}
 */
export function deleteJob(jobId) {
  const rec = getJob(jobId);
  if (!rec) {
    const err = new Error(`No job found with id ${jobId}.`);
    err.code = "NOT_FOUND";
    throw err;
  }
  fs.rmSync(jobFile(jobId), { force: true });
  const branchCleared = rec.branchName ? removeBranchIndex(rec.branchName) : false;
  let lockReleased = false;
  // Free the exact key this job claimed (lockKey for monorepo per-module jobs; appName otherwise).
  const key = rec.lockKey ?? rec.appName;
  if (key && lockHolder(key) === jobId) {
    lockReleased = releaseLock(key);
  }
  return { deleted: true, branchCleared, lockReleased };
}

/**
 * reapplyJob(jobId): reseed a fresh PROCESSING job from a prior job's coords/changePlan under a
 * NEW jobId, re-acquiring the app lock. Mirrors the reapply admin action. Throws NOT_FOUND if the
 * source job is missing, CONFLICT if the app is currently locked by another live job.
 * @returns {{jobId, record}} of the new job.
 */
export function reapplyJob(jobId) {
  const src = getJob(jobId);
  if (!src) {
    const err = new Error(`No job found with id ${jobId}.`);
    err.code = "NOT_FOUND";
    throw err;
  }
  return createJob({
    appName: src.appName,
    lockKey: src.lockKey ?? null,
    environment: src.environment,
    jiraTicketId: src.jiraTicketId,
    approvedChangePlan: src.approvedChangePlan,
    coords: src.coords,
    changePlan: src.changePlan,
  });
}

// paths exported for tests/tooling
export const _paths = { jobFile, lockFile, branchFile, idemFile, partitions, encodeKey };
