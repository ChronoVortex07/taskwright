---
id: TASK-22
title: Tech-tree P4 — /create-task skill & tree-traversal MCP tools
status: Done
assignee: []
created_date: '2026-07-03 08:06'
updated_date: '2026-07-03 10:51'
labels:
  - tech-tree
  - phase-4
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
AI authoring counterpart to P3: from a brief, Claude reads the tree and proposes dependency-linked draft tasks on-canvas. New MCP reads (list_categories, list_milestones, get_board, search_tasks), writes (create_category, promote_drafts), the .claude/skills/create-task/ skill, and three gap closures: draft visibility on the canvas (drafts union into the tree universe), draft-create field completeness (priority/milestone/labels/assignee), and bulk promote with dependency/caused_by id-remap (shared core; canvas Promote-all posts one promoteDrafts message).

Spec: docs/superpowers/specs/2026-07-02-tech-tree-p4-create-task-skill-design.md
Plan: docs/superpowers/plans/2026-07-03-tech-tree-p4-create-task-skill.md (8 tasks; adversarial review BUILD-READY, fix wave folded, focused re-review LAND-THE-PLAN)
Directives: .superpowers/tech-tree-run/p4-architecture-directives.md
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
P4 landed on main at 6a93c17 (ff-merge, 10 commits, 25 files +3887/−31). Delivered: (1) /create-task skill (.claude/skills/create-task/SKILL.md) — brief → PR-sized dependency-linked draft proposals reviewed/promoted on canvas; (2) four MCP reads — list_categories, list_milestones, get_board, search_tasks (canvas-parity via loadTreeBoardFromParser; pure core src/core/searchTasks.ts); (3) two MCP writes — create_category (surgical config.yml single-line edit, src/core/categoriesConfig.ts, multi-line/flow/comment guard + full YAML escaping) and promote_drafts (bulk, src/core/promoteDrafts.ts — dep-first topo + inbound dependencies/caused_by remap); (4) three gap closures making the draft-review loop live: drafts render on the canvas (treeDerived + tree-tab union), draft-create carries priority/milestone/labels/assignee (one updateTask; draft+status → error), promote keeps edges (single/bulk/canvas Promote-all all route through the remapping core; button posts one promoteDrafts message). Gates at 6a93c17: unit 1432/1; lint 0-warn; typecheck clean; Playwright 360 (tree glob 79); CDP 18/18 across 5 files (new tree-promote on port 9344 asserts disk state); visual proof verified. Every task adversarially reviewed; 2 fix loops (Task 6 multi-line config corruption — Medium, falsification-proven; branch fix wave — esc backslash Major + limit clamp + quoted-entry parse + 3 trivials). Follow-up bug filed: switch-to-tree doesn't refresh, hiding pre-existing drafts.
<!-- SECTION:FINAL_SUMMARY:END -->
