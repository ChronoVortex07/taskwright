#!/usr/bin/env bun
/**
 * Dependency-audit gate (TASK-100).
 *
 * Runs `bun audit --json`, then evaluates the findings against the reviewed,
 * time-bounded allowlist in `security/audit-allowlist.json` using the pure core
 * in `src/core/auditGate.ts`. Exits non-zero when the gate fails so CI blocks:
 *
 *   - a NOT-allowlisted advisory at/above the allowlist `threshold` severity
 *     (a newly published advisory a human must triage), or
 *   - an EXPIRED allowlist exception (forces periodic re-review).
 *
 * Findings below the threshold and allowlisted findings are reported but do not
 * fail the build. This makes the gate resilient to unreviewed advisory churn:
 * the green baseline is the curated allowlist, not the raw `bun audit` count.
 *
 * Usage:
 *   bun run audit:gate          # evaluate; non-zero exit on failure (CI mode)
 *   bun run audit:gate --report # print the report, always exit 0
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  parseBunAuditJson,
  parseAudit,
  evaluateGate,
  severityCounts,
  type Allowlist,
} from '../src/core/auditGate';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const allowlistPath = resolve(repoRoot, 'security/audit-allowlist.json');

const reportOnly = process.argv.includes('--report');

function runBunAudit(): string {
  try {
    // bun audit exits non-zero when vulnerabilities exist — capture stdout anyway.
    return execFileSync('bun', ['audit', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string | Buffer };
    if (e && e.stdout != null) return e.stdout.toString();
    throw err;
  }
}

function loadAllowlist(): Allowlist {
  const raw = JSON.parse(readFileSync(allowlistPath, 'utf8')) as Partial<Allowlist>;
  return {
    threshold: raw.threshold ?? 'high',
    entries: raw.entries ?? [],
  };
}

function main(): void {
  const auditText = runBunAudit();
  const findings = parseAudit(parseBunAuditJson(auditText));
  const allowlist = loadAllowlist();
  const result = evaluateGate(findings, allowlist, new Date());

  const counts = severityCounts(findings);
  console.log('Dependency audit gate');
  console.log('─'.repeat(60));
  console.log(
    `Findings: ${findings.length} ` +
      `(critical ${counts.critical}, high ${counts.high}, moderate ${counts.moderate}, low ${counts.low})`
  );
  console.log(`Threshold: fail on non-allowlisted advisories >= "${allowlist.threshold}"`);
  console.log(
    `Allowlisted: ${result.allowlisted.length} · below threshold (reported): ${result.belowThreshold.length}`
  );

  if (result.unusedAllowlist.length > 0) {
    console.log('');
    console.log(
      `Note: ${result.unusedAllowlist.length} allowlist entr(y/ies) match no current finding (prunable):`
    );
    for (const e of result.unusedAllowlist) {
      console.log(`  - ${e.ghsa} (${e.package ?? 'unknown'})`);
    }
  }

  if (result.ok) {
    console.log('');
    console.log('PASS — no unreviewed advisories at/above threshold, no expired exceptions.');
    process.exit(0);
  }

  console.log('');
  console.log('FAIL:');
  for (const reason of result.reasons) {
    console.log(`  ✗ ${reason}`);
  }
  console.log('');
  console.log('Fix by remediating the dependency, or add a reviewed, time-bounded entry to');
  console.log('security/audit-allowlist.json (see security/dependency-audit.md).');

  if (reportOnly) {
    console.log('');
    console.log('(--report: exiting 0 despite failures)');
    process.exit(0);
  }
  process.exit(1);
}

main();
