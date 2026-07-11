---
id: TASK-20
title: >-
  Tech-tree P3a — create surface (unified create form, bug/one-off intake,
  shared create core)
status: Done
assignee: []
created_date: '2026-07-02 22:28'
updated_date: '2026-07-04 00:42'
labels:
  - tech-tree
milestone: Tech-Tree P3 — Create & Drag Surfaces
dependencies:
  - TASK-19
priority: high
category: Tree
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create-surface half of tech-tree P3 (spec: docs/superpowers/specs/2026-07-02-tech-tree-p3-create-edit-design.md §3–4; directives: .superpowers/tech-tree-run/p3-architecture-directives.md §P3a; plan: docs/superpowers/plans/2026-07-03-tech-tree-p3a-create-surface.md, 8 tasks).

Ships: shared vscode-free create core src/core/createTaskCore.ts (createTaskWithTreeFields — MCP createTaskHandler and the controller createTask case call the SAME writer sequence, incl. linkTo wiring ready for P3b); locked createTask/openCreateForm messages (wire field taskType per adjudication Q1); CreateTaskForm.svelte (full/quick/bug modes — Title, Task|Bug toggle, Category, Priority/Severity, Milestone, Description; Enter=Create, Shift+Enter=Create & open); triggers (in-webview Ctrl/Cmd-N + n + Ctrl/Cmd-Shift-N quick capture, TabBar +, repointed taskwright.createTask, new taskwright.quickCapture, first contributes.keybindings); TaskCreatePanel retired; Report-bug popover action pre-filling caused_by; Playwright e2e/tree-authoring.spec.ts; CDP create→node-appears + file-written proof; CLAUDE.md doc-sync (incl. the two P2b wording nits).

P3b (drag-to-connect/reslot, edge removal, P2b carry-in debt) is a separate follow-up plan. Being implemented autonomously in worktree tech-tree-p3a (orchestrated run, 2026-07-03).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
P3a (tech-tree create surface) landed on main at 5fb53cf — 11 commits fast-forwarded from .worktrees/tech-tree-p3a. Deliverables: shared vscode-free create core src/core/createTaskCore.ts (createTaskWithTreeFields + normalizeType + cycle-guarded linkTo wiring, ready for P3b) with the MCP createTaskHandler refactored onto it (behavior-preserving; human/agent parity — one writer sequence); locked createTask/openCreateForm messages (wire field taskType per adjudication Q1) + TasksController createTask case; CreateTaskForm.svelte (full/quick/bug modes — Task|Bug toggle, Severity relabel, caused_by search, category picker drops Bugs/Misc="no category", Enter=Create, Shift+Enter=Create & open); triggers: in-webview Ctrl/Cmd-N, bare n, Ctrl/Cmd-Shift-N quick capture, TabBar +, repointed taskwright.createTask, new taskwright.quickCapture, first contributes.keybindings (board-scoped when clauses); TaskCreatePanel retired (−1221 lines incl. 30 tests); Report-bug popover action pre-filling caused_by; modal suppresses single-key shortcuts. Tests: Playwright e2e/tree-authoring.spec.ts (9 tests incl. falsification-verified shortcut-suppression guard), CDP tree-authoring (create→file-on-disk + tree-node-appears in real VS Code). Gates at 5fb53cf: unit 1368 passed/1 skipped (1385 base +13 new −30 retired); Playwright 342; CDP 16/16; lint zero-warning; typecheck clean; visual proof (5 screenshots) verified. Full pipeline: adversarially reviewed plan (2 blockers fixed pre-build), 8 SDD tasks each reviewed (1 fix loop: CreateTaskForm init-once state), whole-branch review READY WITH FIXES → 2-fix wave 5fb53cf → focused re-review verdict LAND. Accepted debt: dead requestCreateTask webview path, onboarding blurb wording (both trivial, ride to P3b+).
<!-- SECTION:FINAL_SUMMARY:END -->
