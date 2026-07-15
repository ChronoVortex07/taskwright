---
id: TASK-131
title: >-
  Milestone completion — collapse a finished milestone's section on the board,
  reversibly
status: In Progress
assignee: []
created_date: '2026-07-14 05:26'
updated_date: '2026-07-15 00:58'
labels:
  - friction
  - ux
milestone: Workflow Friction Hardening
dependencies: []
references:
  - .taskwright/docs/friction-report-2026-07-14.md
priority: medium
category: Core Board
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
Design decisions (DoD item 1) — full detail in attached plan docs/superpowers/specs/2026-07-15-milestone-completion-collapse-design.md:
1. Flag = committed `completed: true` in milestone frontmatter; serialized after `title`, omitted when false/unset (existing milestone files stay byte-identical).
2. `completed` is shared/committed (collapses band by default for everyone); expand/collapse is a LOCAL per-user override in globalState (backlog.expandedMilestones). Effective collapse = completedMilestones \ locallyExpanded. Un-complete permanently expands.
3. No per-task Completed status — retired for good; tasks stay Done, milestone carries the flag.

PROGRESS (phased, TDD, commit per phase; worktree branch task-131-...):
- Phase A DONE (commit 8f270ce): Milestone.completed + parser read + BacklogWriter.setMilestoneCompleted + byte-compat serialization. Tests green (BacklogWriter.otherEntities, BacklogParser.aggregation).
- Phase B DONE (commit 634c161): set_milestone_complete MCP tool + all-Done guard (AC1) + list_milestones surfaces `completed` + server registration. Tests green (mcpWriteHandlers).
- Phase C DONE (commit 8d02e73): deriveGeometry collapsedBands param + COLLAPSED_BAND_WIDTH strip + BandRange.collapsed + omit collapsed-band boxes (edges drop) + reclaim lane rows; Backburner never collapsed; empty set is a no-op. Tests green (treeGeometry, 28).

REMAINING (specified in the plan):
- Phase D — webview wiring: types.ts WebviewMessage setMilestoneComplete/setMilestoneBandExpanded + ExtensionMessage milestoneBandExpandedChanged (+ completed rides milestonesUpdated); TasksController globalState backlog.expandedMilestones load/save + 2 message handlers (complete reuses the core all-Done guard) + push completed/expanded to webview; TechTreeCanvas derive collapsedBands (completed \ expanded), pass to deriveGeometry, fold collapsed-band nodes into the PRIMITIVE hiddenIds (acyclicity), render a .tree-band-collapsed strip, post messages; AgeBandHeader/MilestonePopover controls (complete disabled unless all Done). Run the Svelte MCP autofixer on changed components.
- Phase E — AC4 fingerprint test (task files unchanged across complete/expand/uncomplete), AC6 Backburner-invariant regression with a collapsed band, full gate (bun run test && lint && typecheck), visual-proof skill, then request_merge { taskId: TASK-131, worktree }.

Resume: cd into the worktree, `bun install` if needed, continue at Phase D. NOT yet merged — ACs 2/3/7 + DoD2 unmet until D+E land.
<!-- SECTION:NOTES:END -->
