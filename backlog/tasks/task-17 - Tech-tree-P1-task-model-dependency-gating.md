---
id: TASK-17
title: Tech-tree P1 — task model & dependency gating
status: Done
assignee: []
created_date: '2026-07-02 08:33'
updated_date: '2026-07-02 10:17'
labels:
  - tech-tree
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Foundation of the tech-tree overhaul (spec: docs/superpowers/specs/2026-07-01-tech-tree-p1-model-and-gating-design.md, incl. §10 amendments; plan: docs/superpowers/plans/2026-07-02-tech-tree-p1-model-and-gating.md).

Ships: `category`/`caused_by` frontmatter fields + surgical writers; config `categories`/`priorities` (priority relaxed to config-defined list); pure gating core (locked/blockedBy, wouldCreateCycle); pure tree layout derivation (lane/band/depth/subRow + Backburner/Bugs/Misc); bug lifecycle rule (complete refuses untraced bugs); MCP enforcement (claim gate, cycle-guarded deps, extended summaries); dispatch refusal + taskwright.forceClaimTask human override.

Being implemented autonomously in worktree tech-tree-p1 (orchestrated run, 2026-07-02).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Landed on main at 9b34012 (13 commits, ff-merge; suite 1339 passed / 1 skipped, lint+typecheck clean). Shipped: config-driven priorities (priorityOrder.ts; TaskPriority relaxed to string, parsePriority exact-match so custom priorities are never mangled); category/caused_by fields parsed + surgically written (TreeFieldService, byte-for-byte Backlog.md round-trip, CRLF preserved); getCategories + config categories; pure gating core treeGate.ts (resolveDoneStatus/computeBlockedBy/isLocked/wouldCreateCycle with cycle-safe traversal); pure treeLayout.ts (Bugs/Misc lanes, Backburner band, same-band depth, deterministic sub-row packing with ordinal→config-priority→id tie-break, bug-lane severity/open/recency sort, cross-band soft warnings); treeDerived.ts composing per-task {locked, blockedBy, bugs, activeBugIds, layout} (map keyed by normalized id) + TasksController enrichment; MCP surface: summaries carry all tree fields, create/edit accept + validate category/type/caused_by/dependencies (existence + cycle guard, exact error strings), claim_task hard gate before the sync fork ({claimed:false,locked,blockedBy}, NO force parameter — agents cannot self-unlock), complete_task refuses untraced bugs; UI: dispatch refuses locked tasks, claim offers human-only Force claim modal, taskwright.forceClaimTask command, detail panel priorities from config. 10 plan tasks + adversarial per-task reviews + whole-branch final review (1 Important finding fixed: normalized derived-map keying).
<!-- SECTION:FINAL_SUMMARY:END -->
