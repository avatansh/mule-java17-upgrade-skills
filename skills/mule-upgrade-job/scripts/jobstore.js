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
 * createJob(opts): acquire the app lock single-flight, then persist a PROCESSING record.
 * Mirrors post-jobs.xml: os:retrieve lock (throws if held → 409 CONFLICT) → os:store lock=jobId
 * → os:store job record.
 * @returns {{jobId, record}}
 * @throws {Error} code "CONFLICT" with .existingJobId when the app is already locked.
 */
export function createJob({
  appName,
  environment = null,
  jiraTicketId = null,
  approvedChangePlan = null,
  coords = null,
  changePlan = null,
  jobId = newJobId(),
}) {
  if (!appName) throw new Error("createJob: appName is required");
  const existing = acquireLock(appName, jobId);
  if (existing !== jobId) {
    const err = new Error(
      `An upgrade for app "${appName}" is already in progress (jobId=${existing}). ` +
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
const TERMINAL = new Set([
  "DEPLOYED",
  "NO_CHANGE",
  "CLOSED",
  "FAILED_ASSESS",
  "FAILED_COMMIT",
  "FAILED_CI",
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
/**
 * acquireLock(appName, jobId): claim the single-flight lock. Returns the jobId that HOLDS the
 * lock afterwards — equal to the passed jobId when acquired, or the pre-existing holder on
 * contention. Best-effort atomicity via wx (exclusive create).
 */
export function acquireLock(appName, jobId) {
  const file = lockFile(appName);
  ensureDir(path.dirname(file));
  try {
    // wx: fail if the file already exists → detects a held lock without a read/write race.
    fs.writeFileSync(file, JSON.stringify({ key: `lock::${appName}`, appName, jobId, at: nowUtc() }, null, 2), {
      flag: "wx",
    });
    return jobId;
  } catch (e) {
    if (e.code === "EEXIST") {
      const held = readJson(file);
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
  if (rec.appName && lockHolder(rec.appName) === jobId) {
    lockReleased = releaseLock(rec.appName);
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
    environment: src.environment,
    jiraTicketId: src.jiraTicketId,
    approvedChangePlan: src.approvedChangePlan,
    coords: src.coords,
    changePlan: src.changePlan,
  });
}

// paths exported for tests/tooling
export const _paths = { jobFile, lockFile, branchFile, idemFile, partitions, encodeKey };
