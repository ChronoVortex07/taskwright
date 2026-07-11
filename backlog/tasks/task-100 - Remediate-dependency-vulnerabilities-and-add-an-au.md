---
id: TASK-100
title: Remediate dependency vulnerabilities and add an audit gate
type: bug
status: In Progress
assignee: []
created_date: '2026-07-11 02:35'
updated_date: '2026-07-11 08:16'
labels: []
dependencies: []
priority: high
category: Misc
claimed_by: '@agent/main'
worktree: main
claimed_at: '2026-07-11 15:55'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Triage the dependency vulnerabilities reported by the package audit, upgrade or replace affected direct dependencies without breaking the extension toolchain, document any accepted transitive risk, and add a reproducible CI policy that prevents meaningful regressions.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Every reported vulnerability is mapped to its direct dependency, runtime reachability, severity, and remediation decision
- [x] #2 Affected dependencies are upgraded, replaced, or explicitly documented with a time-bounded exception
- [x] #3 Build, unit, webview, extension e2e, and packaging behavior remain intact after dependency changes
- [x] #4 CI enforces a documented vulnerability threshold without being vulnerable to unreviewed advisory churn
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Triaged all 46 `bun audit` rows (45 unique advisories: 1 critical, 16 high, 20 moderate, 8 low; bun 1.3.14).

Key finding: the published VSIX bundles only esbuild `dist/` and excludes `node_modules/**` (.vscodeignore), confirmed by `bun run package` (106 files, no node_modules, no security/**). So every advisory is a transitive dep of dev/build/test tooling (vscode-extension-tester, release-it, generate-license-file, oxipng-bin, depcheck, eslint, jsdom, vite) that never ships. The only runtime-reachable ones — dompurify/uuid via mermaid, js-yaml 3.x via gray-matter — process the user's OWN board content inside a CSP-sandboxed webview. The SDK's qs/ip-address/cross-spawn/fast-uri are in the tree but unreachable (stdio transport, no HTTP/spawn path).

Remediation decisions: evaluated compatible `bun update` (reduced vuln count by ZERO — advisories pinned in dev-tool transitive ranges) and reverted it to keep the toolchain/lockfile stable; force-overriding transitive versions rejected as riskier than the (dev-only/own-content) exposure with no shipped benefit. All 45 advisories recorded as reviewed, categorized, time-bounded exceptions (expire 2026-10-11) in security/audit-allowlist.json, with full rationale in security/dependency-audit.md.

Audit gate (AC#4): pure core src/core/auditGate.ts (15 unit tests) + scripts/audit-gate.ts runner + security/audit-allowlist.json (documented threshold: high). Fails CI on any non-allowlisted advisory >= threshold OR any expired exception; below-threshold and allowlisted findings are reported-only. Resilient to unreviewed advisory churn because the green baseline is the curated allowlist, not the raw `bun audit` count — a new high/critical forces a human triage, and exceptions expire. Wired into .github/workflows/ci.yml ("Dependency audit gate") and the `ci`/`audit`/`audit:gate` npm scripts.

Verification: typecheck, lint, prettier --check, depcheck, full unit suite (1966 tests, 136 files), `bun run build`, and `bun run package` (VSIX) all pass. Gate PASS proven at exit 0 on the reviewed baseline; FAIL proven at exit 1 when a critical entry is removed (churn simulation) and on expired entries (unit-tested). No package.json dependency-version or bun.lock changes, so webview/e2e/cdp toolchains are unaffected by construction.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added a reviewed-baseline dependency-audit gate and full vulnerability triage. Every one of the 46 `bun audit` findings is mapped to its direct dependency, reachability, severity, and decision in security/dependency-audit.md; all 45 unique advisories are recorded as reviewed, time-bounded exceptions in security/audit-allowlist.json (all dev-only/not-shipped or own-content/sandboxed — the VSIX ships no node_modules). The gate (src/core/auditGate.ts + scripts/audit-gate.ts, 15 unit tests) fails CI on any non-allowlisted advisory at/above a documented "high" threshold or any expired exception — deterministic against unreviewed advisory churn — and is wired into ci.yml and the `ci` script. No dependency versions changed; typecheck/lint/prettier/depcheck/1966 unit tests/build/package all pass.
<!-- SECTION:FINAL_SUMMARY:END -->
