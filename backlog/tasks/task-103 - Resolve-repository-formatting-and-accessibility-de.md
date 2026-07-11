---
id: TASK-103
title: Resolve repository formatting and accessibility debt
status: In Progress
assignee: []
created_date: '2026-07-11 02:35'
updated_date: '2026-07-11 10:51'
labels: []
dependencies: []
priority: medium
category: Polish
claimed_by: '@agent/main'
worktree: main
claimed_at: '2026-07-11 18:13'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Bring committed source and documentation back under the format check, then address the webview accessibility oversights found by static review: semantic controls, keyboard/focus behavior, accessible names, and appropriate automated coverage without changing intended visuals.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 bun run format:check passes on the committed repository
- [x] #2 Clickable webview controls use appropriate semantic elements and accessible names
- [x] #3 Keyboard navigation, visible focus, dialogs, menus, and drag/drop alternatives meet documented accessibility expectations
- [x] #4 Automated accessibility and interaction coverage protects the corrected behavior
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Formatting (AC#1): ran `prettier --write .`; 68 pre-existing debt files (docs/specs/plans, tests, core, README, scripts) now conform. `bun run format:check` passes. `.prettierrc` uses `endOfLine: auto` so no CRLF/LF churn.

Accessibility — approach: the two Svelte-compiler a11y warnings (ConfigEditor bare label; TechTreeCanvas non-interactive div) were the concrete "static review" findings; a subagent survey mapped the rest. Fixes made without changing intended visuals (indicators only appear on keyboard focus):
- AC#3 visible focus: added a global `:focus-visible` outline for button/[role=button]/[role=menuitem]/[role=tab]/[role=application] in src/webview/styles.css (restores focus ring for the many `all: unset` controls; component-scoped :focus-visible rules keep higher specificity). Added :focus-visible replacements where `outline:none` had none (ConfigEditor select/number, MarkdownEditor container).
- AC#2 accessible names: aria-labels on title-only icon buttons (TabBar create/refresh + overflow menu label, Tasks gear, AgentSetupBanner dismiss, InFlightPanel toggle+aria-expanded, DetailPopover expand/close, MilestonePopover close, TechTreeCanvas 3 zoom buttons, Checklist toggle/delete) and on placeholder-only form controls (ConfigEditor inputs, ListView search+4 filters, TreeNavigator/Docs/Decisions search, CreateTaskForm title, TaskHeader title/status/priority, MetaSection add-inputs/milestone/remove-chips, Checklist inputs). ConfigEditor bare `<label>Definition of Done</label>` -> role=group + aria-labelledby span (styled identically). Dead label-section-header (role=button, no handler) demoted to plain header.
- AC#3 dialogs/menus: ConfigEditor modal -> role=dialog + aria-modal + aria-labelledby + focus-on-open. MilestonePopover gained an Escape handler. ContextMenu moves focus to its first item on open, and its backdrop's mis-scoped aria-hidden="true" (which removed the whole menu from the a11y tree) was removed. TabBar overflow menu got aria-label.
- AC#3 keyboard nav: TaskCard role=button now activates on Enter (open) as well as Space (select); KanbanColumn header now activates on Space as well as Enter (+aria-expanded). Canvas viewport keeps role=application+aria-label; keydown nav bubbles from focusable .tree-node children, so a justified svelte-ignore documents the intentional interactive application region (0 compiler a11y warnings). Drag-only mutations retain keyboard equivalents (status/priority selects; prereq removal via DetailPopover chip).

AC#4: new e2e/accessibility.spec.ts (9 Playwright tests via getByRole/name) covers toolbar/tab button names, canvas application role, the focus-visible rule, DetailPopover dialog+Escape, ContextMenu menu+focus+Escape, ConfigEditor modal+named controls+Escape, ListView filter names, and task-detail control names. Full Playwright suite green (418), unit 2038, lint, typecheck all pass; webview build emits 0 a11y warnings.
<!-- SECTION:NOTES:END -->
