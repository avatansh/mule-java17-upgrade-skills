// lib_shared/dates.js — canonical timestamp helper ported from dwl::dates.

/** nowUtc(): current instant as canonical UTC ISO-8601, e.g. "2026-07-07T12:00:00Z". */
export function nowUtc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
