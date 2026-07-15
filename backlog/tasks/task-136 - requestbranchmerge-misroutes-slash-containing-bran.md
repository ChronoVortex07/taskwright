---
id: TASK-136
title: >-
  request_branch_merge misroutes slash-containing branch names as paths
  (TASK-134 audit)
type: bug
status: To Do
assignee: []
created_date: '2026-07-15 01:20'
updated_date: '2026-07-15 01:32'
labels: []
milestone: Workflow Friction Hardening
dependencies: []
references:
  - docs/audits/2026-07-15-workflow-friction-hardening-audit.md
priority: medium
category: Worktrees & Merge
caused_by: TASK-127
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Independent audit TASK-134 (reviewer: codex-terra / GPT-5.6), grounding-confirmed against the code.

`resolveWorktreeTarget` in src/mcp/handlers.ts:434-437 branches on whether the `worktree` arg contains a slash: `arg.includes('/') || arg.includes('\\') ? path.resolve(primaryRoot, arg) : worktreePathFor(primaryRoot, arg)`. The intent is "a `.worktrees/<branch>` path resolves as a path; a bare branch name maps to `.worktrees/<name>`." But git branch names very commonly contain `/` (e.g. `feature/tech-tree/p5`). Such a name is misrouted through `path.resolve(primaryRoot, 'feature/tech-tree/p5')` → `<root>/feature/tech-tree/p5`, which then fails the containment gate (not under `<root>/.worktrees/`) at handlers.ts:439-445.

Failure scenario: a primary-rooted caller follows the documented branch-name form — `request_branch_merge { worktree: "feature/tech-tree/p5" }` — and it is refused as "does not resolve under .worktrees/", even though `.worktrees/feature/tech-tree/p5` exists. The task-less close (and, via the same helper, request_merge's worktree target) is therefore unavailable for slash-containing branch names unless the caller knows the undocumented workaround of passing the full `.worktrees/<branch>` path.

Fix: disambiguate branch-name vs path robustly (e.g. try the bare-branch mapping when the arg is not already a `.worktrees/`-relative path, or check both candidates for containment/existence) so a slash-containing branch name resolves to `<root>/.worktrees/<branch>`. Add a regression test with a slash branch name via the bare form.

Reference: docs/audits/2026-07-15-workflow-friction-hardening-audit.md
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A slash-containing branch name passed in the documented bare-branch form (e.g. worktree: "feature/x/y") resolves to <root>/.worktrees/feature/x/y and is accepted, not refused by the containment gate.
- [ ] #2 The `.worktrees/<branch>` explicit-path form still works, and paths genuinely outside .worktrees/ are still refused (containment not weakened).
- [ ] #3 Regression test covers a slash-containing branch name via the bare form for both request_branch_merge and request_merge worktree targeting.
<!-- AC:END -->
