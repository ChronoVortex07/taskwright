---
id: TASK-131
title: >-
  Milestone completion — collapse a finished milestone's section on the board,
  reversibly
status: In Progress
assignee: []
created_date: '2026-07-14 05:26'
updated_date: '2026-07-15 00:42'
labels:
  - friction
  - ux
milestone: Workflow Friction Hardening
dependencies: []
references:
  - .taskwright/docs/friction-report-2026-07-14.md
priority: medium
category: Core Board
claimed_by: '@agent/.worktrees/task-131-milestone-completion-collapse-a-finished-milestone-s-section-on-the-board-reversibly'
worktree: .worktrees/task-131-milestone-completion-collapse-a-finished-milestone-s-section-on-the-board-reversibly
claimed_at: '2026-07-15 08:31'
plan: docs/superpowers/specs/2026-07-15-milestone-completion-collapse-design.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Supersedes the original framing of this task (a per-task "Completed" action with an undo path). Per-task archival is the wrong unit and is now dewired (TASK-133): moving a single task into `backlog/completed/` takes it out of the board's records, which is a footgun with no upside — `request_merge` already marks tasks **Done** and leaves them visible.

The real need is **space**, not archival. A finished milestone's band keeps consuming canvas and screen long after it stops being interesting. So:

**Completed is a milestone-scoped state, not a task-scoped one.** A milestone becomes eligible to be marked complete only once *every* task in it is Done. Marking it complete is an explicit human action, and its effect is to **collapse that milestone's section** — the band folds down so it stops taking up space, and the dependency edges into and out of it are hidden along with it. It must be expandable again on demand, at any time.

**Load-bearing design constraint — this is a VIEW state, not a file move.** Completing a milestone must NOT relocate task files, must NOT move anything into `backlog/completed/`, and must NOT change any task's status. The whole reason per-task complete was dewired is that it destroyed board records; milestone completion must not reintroduce that. Tasks stay in `backlog/tasks/`, stay parseable, stay resolvable as dependency targets. Collapsing is a rendering decision layered over intact data — which is exactly what makes re-expanding it trivial and safe.

**Open questions to settle while implementing** (decide, then record the decision in the task notes):
- Where the completed flag lives: milestone frontmatter (`backlog/milestones/m-N.md`) is the natural home, but confirm it stays byte-compatible with how Taskwright already serializes milestone files.
- Whether the collapse state is *shared* (committed, so every collaborator sees the milestone folded) or *local* (a per-user view preference). The "mark the milestone as complete" phrasing suggests shared and deliberate, with expand/collapse as the local override on top.
- Whether a per-task `Completed` **status** should exist at all. It probably should not — the milestone carries the flag, tasks just stay Done. If that holds, say so explicitly, because it retires the concept for good.

**Watch the Backburner invariant.** The tree canvas keys bands by name and Backburner must appear exactly once and last in `bandOrder`; a duplicate band key is a Svelte `each_key_duplicate` that blanks the whole canvas (TASK-124). Any change to band construction for collapse must preserve that.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A milestone can be marked complete ONLY when every task in it is Done. The action is unavailable (and refuses, if invoked programmatically) while any task in the milestone is not Done.
- [ ] #2 Marking a milestone complete collapses its section on the tree canvas: the band folds to a compact strip instead of a full-height lane, and the dependency edges into/out of its nodes are hidden.
- [ ] #3 A completed milestone can be expanded again at any time and renders exactly as it did before — collapse is fully reversible, and un-completing the milestone is available too.
- [ ] #4 NOTHING moves on disk: no task file leaves `backlog/tasks/`, nothing is written to `backlog/completed/`, and no task's status changes. Pin this with a test that fingerprints the board files before and after a complete/expand cycle.
- [ ] #5 A completed milestone's tasks remain fully readable via the board and MCP tools, and remain valid dependency targets for tasks in other milestones — collapsing the view never dangles a reference.
- [ ] #6 The Backburner invariant survives: Backburner still appears exactly once and last in `bandOrder`, and no collapse path can introduce a duplicate band key (which would blank the canvas).
- [ ] #7 The completed/collapsed state persists across a window reload rather than resetting to expanded.
- [ ] #8 Full gate green in the worktree: `bun run test && bun run lint && bun run typecheck`.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 The decisions on the three open questions (flag location, shared vs local collapse, whether a per-task Completed status exists) are recorded in the task's implementation notes.
- [ ] #2 Visual proof captured via the `visual-proof` skill — this is a visible canvas change (collapsed band, hidden edges, re-expand).
<!-- DOD:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Design decisions (DoD item 1 — the three open questions), full detail in the attached plan docs/superpowers/specs/2026-07-15-milestone-completion-collapse-design.md:

1. Flag location: a boolean `completed: true` in milestone frontmatter (backlog/milestones/m-N.md). Added to Milestone type + RawMilestoneFrontmatter + parseMilestoneFile; serialized via the same matter.stringify path with `completed` slotted after `title` in FRONTMATTER_FIELD_ORDER and OMITTED when false/unset (omit rule extended to treat boolean false as empty), so existing milestone files stay byte-identical and only `completed: true` is ever written.

2. Shared vs local: the `completed` flag is SHARED/committed (frontmatter, in git) — the deliberate "milestone finished" statement that collapses the band by default for everyone. Expand/collapse is a LOCAL per-user override persisted in extension globalState (backlog.expandedMilestones), mirroring the kanban collapsedMilestones precedent. Effective collapse = completedMilestones \ locallyExpanded. Un-complete (shared) permanently expands. Marking complete clears any stale local expand entry.

3. Per-task Completed status: NO — retired for good. Milestone carries the flag; tasks stay Done. No new task status, no per-task complete action (dewired in TASK-133, stays dewired).

Implementation is phased A–E (data layer / MCP guard / geometry / webview wiring / acceptance+proof), TDD, commit per phase — see attached plan.
<!-- SECTION:NOTES:END -->
