/**
 * Pure logic for the dependency-audit gate (TASK-100).
 *
 * The gate consumes `bun audit --json` output plus a **reviewed allowlist** of
 * accepted advisories. It is deliberately NOT a raw `bun audit` pass/fail:
 *
 *   - A finding at/above the configured severity `threshold` that is NOT on the
 *     allowlist fails the gate. This is what makes the gate resilient to
 *     "unreviewed advisory churn": a newly published advisory (on unchanged
 *     dependencies) surfaces as a build failure a human must consciously triage
 *     — either remediate it, or add a reviewed, time-bounded allowlist entry.
 *   - Every allowlist entry carries an `expires` date. An expired entry fails
 *     the gate, forcing periodic re-review so exceptions cannot live forever.
 *   - Allowlist entries matching no current finding are reported as unused
 *     (non-fatal) so the baseline can be pruned as upstream ships fixes.
 *
 * This module is vscode-free and dependency-free so it can be unit-tested with
 * Vitest and imported by the standalone `scripts/audit-gate.ts` runner.
 */

export type Severity = 'low' | 'moderate' | 'high' | 'critical';

export const SEVERITY_ORDER: Record<Severity, number> = {
  low: 0,
  moderate: 1,
  high: 2,
  critical: 3,
};

/** One advisory as emitted inside `bun audit --json`. */
export interface RawAdvisory {
  id?: number;
  url?: string;
  title?: string;
  severity?: string;
  vulnerable_versions?: string;
}

/** `bun audit --json` shape: a map of package name -> advisories. */
export type BunAuditJson = Record<string, RawAdvisory[]>;

/** A single, flattened advisory keyed by a stable identity. */
export interface Finding {
  package: string;
  /** GHSA slug (e.g. `GHSA-xxxx-yyyy-zzzz`) or `id:<n>` fallback. */
  ghsa: string;
  id: number | null;
  url: string;
  title: string;
  severity: Severity;
}

/** A reviewed, time-bounded exception. */
export interface AllowlistEntry {
  /** GHSA slug (or `id:<n>`) that this exception covers. */
  ghsa: string;
  /** Optional package name, for documentation/validation. */
  package?: string;
  /** Why this advisory is accepted (reachability, dev-only, etc.). */
  reason: string;
  /** Exception expiry, `YYYY-MM-DD`. Past this date the gate re-fails. */
  expires: string;
}

export interface Allowlist {
  /** Fail the gate on any non-allowlisted finding at/above this severity. */
  threshold: Severity;
  entries: AllowlistEntry[];
}

export interface GateResult {
  ok: boolean;
  findings: Finding[];
  /** >= threshold and not allowlisted — these fail the gate. */
  unreviewed: Finding[];
  /** < threshold and not allowlisted — reported only, not fatal. */
  belowThreshold: Finding[];
  /** Findings covered by a live allowlist entry. */
  allowlisted: Finding[];
  /** Allowlist entries past their expiry — these fail the gate. */
  expired: AllowlistEntry[];
  /** Allowlist entries that match no current finding — non-fatal warning. */
  unusedAllowlist: AllowlistEntry[];
  reasons: string[];
}

const GHSA_RE = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i;

export function ghsaFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = GHSA_RE.exec(url);
  return m ? m[0] : null;
}

export function normalizeSeverity(severity: string | undefined): Severity {
  const s = (severity ?? '').toLowerCase();
  if (s === 'low' || s === 'moderate' || s === 'high' || s === 'critical') {
    return s;
  }
  return 'moderate';
}

/**
 * Parse the raw text emitted by `bun audit --json`. Bun prints a version banner
 * before the JSON, so we slice from the first `{`. Empty / no-vuln output maps
 * to an empty audit.
 */
export function parseBunAuditJson(text: string): BunAuditJson {
  if (!text) return {};
  const start = text.indexOf('{');
  if (start < 0) return {};
  const json = text.slice(start);
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as BunAuditJson;
    }
  } catch {
    // fall through to empty
  }
  return {};
}

/** Flatten the package->advisories map into a de-duplicated Finding[]. */
export function parseAudit(audit: BunAuditJson): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const [pkg, advisories] of Object.entries(audit ?? {})) {
    for (const adv of advisories ?? []) {
      const ghsa = ghsaFromUrl(adv.url) ?? `id:${adv.id ?? 'unknown'}`;
      const key = `${pkg}::${ghsa}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        package: pkg,
        ghsa,
        id: typeof adv.id === 'number' ? adv.id : null,
        url: adv.url ?? '',
        title: adv.title ?? '',
        severity: normalizeSeverity(adv.severity),
      });
    }
  }
  return findings;
}

function isExpired(expires: string, now: Date): boolean {
  // Date-only comparison: an entry expires at the END of its expires day.
  const end = new Date(`${expires}T23:59:59.999Z`);
  if (Number.isNaN(end.getTime())) return true; // malformed -> treat as expired
  return now.getTime() > end.getTime();
}

export function evaluateGate(findings: Finding[], allowlist: Allowlist, now: Date): GateResult {
  const threshold = SEVERITY_ORDER[allowlist.threshold];
  const entriesByGhsa = new Map<string, AllowlistEntry>();
  for (const entry of allowlist.entries) {
    entriesByGhsa.set(entry.ghsa, entry);
  }

  const unreviewed: Finding[] = [];
  const belowThreshold: Finding[] = [];
  const allowlisted: Finding[] = [];
  const matchedGhsa = new Set<string>();

  for (const f of findings) {
    const entry = entriesByGhsa.get(f.ghsa);
    if (entry) {
      matchedGhsa.add(f.ghsa);
      allowlisted.push(f);
      continue;
    }
    if (SEVERITY_ORDER[f.severity] >= threshold) {
      unreviewed.push(f);
    } else {
      belowThreshold.push(f);
    }
  }

  const expired = allowlist.entries.filter((e) => isExpired(e.expires, now));
  const unusedAllowlist = allowlist.entries.filter((e) => !matchedGhsa.has(e.ghsa));

  const reasons: string[] = [];
  for (const f of unreviewed) {
    reasons.push(
      `Unreviewed ${f.severity} advisory ${f.ghsa} in ${f.package} (>= ${allowlist.threshold}). ` +
        `Remediate it, or add a reviewed, time-bounded entry to the audit allowlist.`
    );
  }
  for (const e of expired) {
    reasons.push(
      `Allowlist exception ${e.ghsa} expired on ${e.expires}. Re-review: remediate or renew.`
    );
  }

  return {
    ok: unreviewed.length === 0 && expired.length === 0,
    findings,
    unreviewed,
    belowThreshold,
    allowlisted,
    expired,
    unusedAllowlist,
    reasons,
  };
}

/** Count findings by severity — used by the runner's report. */
export function severityCounts(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { low: 0, moderate: 0, high: 0, critical: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}
