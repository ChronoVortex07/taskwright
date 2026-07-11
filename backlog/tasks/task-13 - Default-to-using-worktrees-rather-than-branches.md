---
id: TASK-13
title: Default to using worktrees rather than branches
status: Done
assignee: []
created_date: '2026-06-30 13:02'
updated_date: '2026-07-04 00:51'
labels: []
milestone: 'Worktree Safety, Merge Queue & Synced Board'
dependencies: []
priority: high
category: 'Worktrees & Merge'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The main point of having this board is that it facilitates multiple claude session working at once, which branches do not help with. Thus, the default action should be to use git worktrees when implementing tasks.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Worktree machinery already existed behind `dispatchCreateWorktree` (which defaulted to false). Core change: flip that default to true in BOTH package.json and the readSettings() code fallback in src/providers/dispatchActions.ts (they must match), guarded by a new src/test/unit/configDefaults.test.ts that reads the manifest.

Added an opt-in `taskwright.dispatchTerminalCommand` (default empty). When dispatchOpenTerminal is on and the command is non-empty, the rendered command runs in the worktree terminal. It is templated on a new `{{handoffFile}}` placeholder (added to DispatchContext). Subscription-safe: new pure cores in src/core/dispatchPrompt.ts — `commandUsesClaudePrintMode` (segments the command on &&/||/;/| and flags `claude -p`/`--print`) and `resolveTerminalLaunch` (empty=noop, -p/--print=refuse+warn, else render+run). dispatchActions builds the dispatch context once and reuses it for both the prompt render and the terminal command. Empty default = byte-identical behavior to before for the terminal path.

Key decisions:
- Chose a freeform command setting over a turnkey boolean: a single hardcoded invocation cannot seed a multi-line prompt robustly across bash and PowerShell (their command-substitution + newline handling differ). The command references the handoff file (already persisted) to avoid shell-quoting a multi-line string; the `-p` guard enforces "interactive chat, not headless/metered".
- e2e/dispatch.spec.ts is a webview component test (no real git / extension host), so worktree + terminal behavior is verified via the unit-tested resolveTerminalLaunch core rather than e2e.

Docs: README + CLAUDE.md reworded (worktrees are the default; new setting documented); CHANGELOG Unreleased updated. Executed subagent-driven (5 TDD tasks, per-task review, opus final review = ready-to-merge, one batched polish pass). Spec: docs/superpowers/specs/2026-06-30-default-worktrees-dispatch-design.md; plan: docs/superpowers/plans/2026-06-30-default-worktrees-dispatch.md.</implementationNotes>
<parameter name="finalSummary">Per-task git worktrees are now the default on dispatch (taskwright.dispatchCreateWorktree defaults to true; set false to opt out; still falls back to the workspace root when not a git repo), so the board's multi-session value works out of the box. Added an opt-in taskwright.dispatchTerminalCommand that runs a command (templated on {{handoffFile}}) in the dispatch worktree terminal; it is subscription-safe — commands using claude -p/--print are refused with a warning, steering users to an interactive Claude Code chat. Verified: typecheck clean, lint clean, tests 1055 passed / 21 pre-existing Windows POSIX-path failures (unchanged), all new tests pass.
<!-- SECTION:NOTES:END -->
