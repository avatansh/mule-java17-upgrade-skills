// lib_shared/semver.js — semver helpers ported from dwl::assessment / dwl::parentPomRewrite.
// Simple "a < b" over major.minor.patch, tolerant of non-numeric tails and missing segments.

/** toNums("1.2.3-SNAPSHOT") -> [1,2,3]; strips any non-numeric tail per segment. */
export function toNums(v) {
  return String(v ?? "0")
    .split(".")
    .map((s) => s.trim().replace(/[^0-9].*/, ""))
    .map((s) => Number(s === "" ? "0" : s));
}

/** lt(a,b): true when semver a is strictly less than b (major, then minor, then patch). */
export function lt(a, b) {
  const x = toNums(a);
  const y = toNums(b);
  const x0 = x[0] ?? 0, x1 = x[1] ?? 0, x2 = x[2] ?? 0;
  const y0 = y[0] ?? 0, y1 = y[1] ?? 0, y2 = y[2] ?? 0;
  return (
    x0 < y0 ||
    (x0 === y0 && x1 < y1) ||
    (x0 === y0 && x1 === y1 && x2 < y2)
  );
}

/**
 * bumpMinor(v): increment the MINOR segment (reset patch to 0), preserving any -qualifier.
 *   "1.0.0" -> "1.1.0";  "1.0.3-SNAPSHOT" -> "1.1.0-SNAPSHOT";  "2.3" -> "2.4.0";  "1" -> "1.1.0"
 */
export function bumpMinor(v) {
  const s = String(v ?? "");
  const hasQual = s.includes("-");
  const core = hasQual ? s.slice(0, s.indexOf("-")) : s;
  const qualifier = hasQual ? "-" + s.slice(s.indexOf("-") + 1) : "";
  const parts = core.split(".");
  const minor = Number(parts[1] ?? "0") + 1;
  return `${parts[0] ?? "0"}.${minor}.0${qualifier}`;
}

/** isRef("${x}") -> true; a Maven property placeholder value. */
export function isRef(v) {
  return v != null && /^\s*\$\{.+\}\s*$/.test(String(v));
}

/** refName("${munit.version}") -> "munit.version" */
export function refName(v) {
  return String(v).trim().replace(/^\$\{/, "").replace(/\}$/, "");
}
