---
id: TASK-100
title: Remediate dependency vulnerabilities and add an audit gate
type: bug
status: In Progress
assignee: []
created_date: '2026-07-11 02:35'
updated_date: '2026-07-11 02:36'
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
- [ ] #1 Every reported vulnerability is mapped to its direct dependency, runtime reachability, severity, and remediation decision
- [ ] #2 Affected dependencies are upgraded, replaced, or explicitly documented with a time-bounded exception
- [ ] #3 Build, unit, webview, extension e2e, and packaging behavior remain intact after dependency changes
- [ ] #4 CI enforces a documented vulnerability threshold without being vulnerable to unreviewed advisory churn
<!-- AC:END -->
