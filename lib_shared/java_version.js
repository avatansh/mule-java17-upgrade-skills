// java_version.js — comparing Java version tokens, which semver cannot do.
//
// Java versions are not semver and the historical naming is genuinely ambiguous. All of these mean
// Java 8: "1.8", "8", "1.8.0_402", "8.0.402". Plain `lt()` gets this wrong in the worst way — it reads
// "1.8" as major 1 and concludes 1.8 < 11 (right answer, wrong reason) but also that "1.8" < "1.9"
// while ranking "9" above "11". Any comparison of Java versions therefore has to normalise to a MAJOR
// first, which is the only number that matters for a runtime/compiler target.
//
// This exists so the engine can be retargeted (Java 17 → 21 → whatever comes next) by changing the
// matrix alone. Before it, "which Java versions count as stale?" was a hand-maintained enumeration
// (`in: ["1.8","8","11"]`) that silently needed a new entry — "17" — the day the target became 21.
// Deriving staleness from `installed < target` removes that maintenance step entirely.

/**
 * The Java MAJOR encoded in a version token, or null when it isn't a Java version.
 *   "1.8" | "1.8.0_402" | "8" | "8.0.402"  → 8
 *   "11" | "11.0.22"                       → 11
 *   "17" | "17.0.9+9"                      → 17
 *   "21-ea" | "21.0.1"                     → 21
 * The legacy `1.x` prefix is only stripped for 1.2–1.8 (real legacy Java), so a genuine "1.9" of
 * something else isn't silently reinterpreted.
 * @param {string|number|null|undefined} v
 * @returns {number|null}
 */
export function javaMajor(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const legacy = s.match(/^1\.([2-8])(?:[._].*)?$/);
  if (legacy) return Number(legacy[1]);
  const m = s.match(/^(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * True when Java version `a` is strictly older than `b`. Unparseable input is NOT treated as older —
 * that would make an unknown version look stale and trigger a spurious bump.
 * @param {string|number} a
 * @param {string|number} b
 */
export function javaLt(a, b) {
  const x = javaMajor(a);
  const y = javaMajor(b);
  if (x == null || y == null) return false;
  return x < y;
}

/** True when two tokens denote the same Java major ("1.8" and "8" are equal). */
export function javaEq(a, b) {
  const x = javaMajor(a);
  const y = javaMajor(b);
  return x != null && x === y;
}

/**
 * The `@JavaVersionSupport` majors a Mule extension should declare to run on `target` while staying
 * loadable on the older runtimes it already supports: every LTS from 8 up to and including the target.
 * @param {string|number} target
 * @returns {number[]}
 */
export function supportedJavaMajors(target) {
  const t = javaMajor(target);
  if (t == null) return [8, 11, 17];
  return [8, 11, 17, 21].filter((v) => v <= t);
}
