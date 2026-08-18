// format_cve.js — human-readable rendering of a CVE scan.
//
// The ordering is deliberate: what YOU must do comes first, what the upgrade already handles comes last.
// A scanner that leads with 60 resolved advisories buries the two that need a decision.

const ICON = { CRITICAL: "[CRIT]", HIGH: "[HIGH]", MEDIUM: "[MED ]", LOW: "[LOW ]", UNKNOWN: "[ ?  ]" };

function line(f) {
  const cve = f.cve?.length ? ` (${f.cve.join(", ")})` : "";
  const head = `${ICON[f.severity] ?? "[ ?  ]"} ${f.package} ${f.currentVersion} — ${f.id}${cve}`;
  const detail =
    f.status === "action-required"
      ? `    fix: upgrade to ${f.minimumFix} or later` +
        (f.plannedVersion ? ` (the upgrade plan only reaches ${f.plannedVersion})` : "")
      : f.status === "no-fix-available"
        ? f.fixedOnOtherBranchOnly
          ? `    fix: NONE for this branch. Fixed only on other branches (${f.fixedVersions.join(", ")}) — ` +
            `moving there may mean a downgrade, so this needs a deliberate decision.`
          : "    fix: none published — needs mitigation or a documented acceptance"
        : `    fixed by the upgrade (plan moves this to ${f.plannedVersion})`;
  const why = f.summary ? `\n    ${f.summary.split("\n")[0].slice(0, 160)}` : "";
  return `${head}\n${detail}${why}`;
}

export function formatCve(res) {
  const out = [];
  const s = res.summary ?? {};
  out.push(`Vulnerability scan — ${res.appName ?? res.appPath ?? "app"}`);
  out.push("=".repeat(64));

  if (res.ok === false) {
    out.push(`SCAN DID NOT RUN: ${res.reason ?? "unknown reason"}`);
    return out.join("\n");
  }

  out.push(
    `Scanned ${res.scanned?.dependencies ?? 0} declared coordinate(s) — ` +
      `${s.total ?? 0} advisory match(es): ${s.critical ?? 0} critical, ${s.high ?? 0} high, ` +
      `${s.medium ?? 0} medium, ${s.low ?? 0} low, ${s.unknown ?? 0} unknown.`
  );
  if (res.planCompared && res.plannedCoordinateCount > 0) {
    out.push(
      `The upgrade plan resolves ${s.resolvedByUpgrade ?? 0} of them. ` +
        `${s.actionRequired ?? 0} still need action; ${s.noFixAvailable ?? 0} have no published fix.`
    );
  } else if (res.planCompared) {
    // A real finding in its own right, and NOT the same as a failed comparison.
    out.push(
      "The upgrade plan moves no scanned dependency version, so none of these findings are fixed by it. " +
        "Each one needs its own bump."
    );
  } else {
    out.push("No upgrade plan was compared, so nothing is credited to the upgrade.");
  }

  const bucket = (status) => (res.findings ?? []).filter((f) => f.status === status);
  const sections = [
    ["ACTION REQUIRED — a fix exists but the upgrade does not reach it", bucket("action-required")],
    ["NO FIX AVAILABLE — decide on mitigation or acceptance", bucket("no-fix-available")],
    ["RESOLVED BY THE UPGRADE — no action needed", bucket("resolved-by-upgrade")],
  ];
  for (const [title, list] of sections) {
    if (!list.length) continue;
    out.push("", `${title} (${list.length})`, "-".repeat(64));
    for (const f of list) out.push(line(f));
  }

  if (!res.findings?.length) out.push("", "No known advisories matched the declared coordinates.");

  if (res.unresolved?.length) {
    out.push("", `NOT QUERYABLE (${res.unresolved.length}) — no resolvable version`, "-".repeat(64));
    for (const u of res.unresolved.slice(0, 20)) out.push(`  ${u.package}  (declared in ${u.declaredIn})`);
    if (res.unresolved.length > 20) out.push(`  … and ${res.unresolved.length - 20} more`);
  }

  // Always printed, never conditional on findings: an empty result is exactly when someone is most
  // likely to read this as "we are secure".
  out.push("", "SCOPE AND LIMITS", "-".repeat(64));
  for (const l of res.limitations ?? []) out.push(`  - ${l}`);
  if (res.complete === false) out.push("  - This scan is INCOMPLETE (see warnings); counts may be understated.");

  if (res.warnings?.length) {
    out.push("", `Warnings (${res.warnings.length})`, "-".repeat(64));
    for (const w of res.warnings.slice(0, 15)) out.push(`  ! ${w}`);
    if (res.warnings.length > 15) out.push(`  … and ${res.warnings.length - 15} more`);
  }
  return out.join("\n");
}
