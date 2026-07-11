---
id: TASK-27
title: >-
  Tech-tree P6 — /index-codebase skill, create_milestone & status-carrying
  drafts
status: Done
assignee: []
created_date: '2026-07-03 17:58'
updated_date: '2026-07-04 00:43'
labels: []
milestone: Tech-Tree P5-P6 — Execute & Indexing
dependencies:
  - TASK-22
priority: high
category: Tree
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Tech-tree P6 (final phase, completes P1–P6): a /index-codebase skill that reconstructs an existing project's built foundation onto the board via git forensics — subsystems/features/decisions become Done `baseline` draft nodes in the milestone-age they were built, mined TODO/FIXME gaps become To-Do draft nodes, all deduped against the live board and left for the human to review/promote (parity + subscription-safe, no `claude -p`). Adds one new MCP tool `create_milestone` (wraps the existing BacklogWriter.createMilestone; idempotent like create_category; band order = creation order; no `order` param; reserved-guard Backburner only). 

Also lands a foundation fix mandated during design: **status-carrying drafts** — a draft is a provisional/discardable state ORTHOGONAL to completion status (a draft can be Done). createDraft/createTaskCore write the real status, getDrafts reflects it, and promoteDraft PRESERVES it (Done draft → Done task), so a Done baseline can travel through the draft-review flow. Demote aligned to preserve status too.

Spec: docs/superpowers/specs/2026-07-02-tech-tree-p6-codebase-indexing-design.md
Directives: .superpowers/tech-tree-run/p6-architecture-directives.md
Plan: docs/superpowers/plans/2026-07-04-tech-tree-p6-codebase-indexing-skill.md
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Landed on main at 55af8a3 (ff-merge from tech-tree-p6, user-authorized). Delivered three workstreams: (1) status-carrying drafts — a draft is now a provisional/discardable state ORTHOGONAL to completion status (provisional marker = folder==='drafts', not a synthetic 'Draft' status), so a Done baseline can be a draft that promotes to a Done task; createDraft/createTaskCore accept+write the real status (default config.default_status ?? 'To Do'), getDrafts/getTask reflect it with legacy on-disk 'Draft' migrate-on-read, and promoteDraft/demoteTask PRESERVE status. (2) create_milestone MCP tool — wraps BacklogWriter.createMilestone, idempotent on name like create_category, Backburner-only reserved guard, no 'order' param (band order = creation order), invalidateMilestoneCache after the file write. (3) /index-codebase skill — git-forensics bootstrap that reconstructs the built foundation as Done baseline drafts and mines TODO/FIXME gaps as To-Do drafts, confirm-before-write, deduped, oldest-first ages, never promotes (parity + subscription-safe). Build: 4 SDD tasks (Opus for the cross-cutting draft-model slice + reviews; DeepSeek workers via ch worker for the create_milestone tool + SKILL.md transcription, each per-slice HARD-read-only Opus reviewed). Whole-branch adversarial review (Workflow, 4 lenses + adversarial refutation): 11 raw findings → 4 MINOR/NIT survivors (all test-quality/doc — no correctness bug) → one fix wave (55af8a3) → focused re-review LGTM. Close gate: unit 1479/1skip/0fail, typecheck+lint clean, full Playwright 363, full CDP 18/18. Completes the tech-tree overhaul P1–P6. Design: docs/superpowers/specs/2026-07-02-tech-tree-p6-codebase-indexing-design.md; plan: docs/superpowers/plans/2026-07-04-tech-tree-p6-codebase-indexing-skill.md.
<!-- SECTION:FINAL_SUMMARY:END -->
