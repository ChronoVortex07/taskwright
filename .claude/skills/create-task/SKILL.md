---
name: create-task
description: Turn a vague brief into a set of detailed, dependency-linked Taskwright tasks slotted into the right tech-tree lanes and milestones, committed as draft proposals the human reviews and promotes on the board. Use when the user says /create-task, asks to "plan out", "break down", "decompose", or "add tasks for" a feature/idea, or hands you a rough brief to turn into board work. Reads the tree first (categories, milestones, board, search), then proposes PR-sized tasks as drafts.
allowed-tools: mcp__taskwright__list_categories, mcp__taskwright__list_milestones, mcp__taskwright__get_board, mcp__taskwright__search_tasks, mcp__taskwright__create_category, mcp__taskwright__create_task, mcp__taskwright__create_subtask, mcp__taskwright__attach_plan, mcp__taskwright__promote_drafts, Skill(superpowers:brainstorming), Skill(superpowers:writing-plans)
---

# Create task (Taskwright AI authoring)

Turn a brief into a well-formed **set** of tech-tree tasks: read the existing tree, decompose
the brief into PR-sized tasks linked by dependencies, slot each into the right lane
(category) and milestone, and commit the proposal as **draft nodes** the human reviews and
promotes on the canvas. Parity: every tool here is one a human can drive by hand via the P3
board gestures — you are automating authoring, not bypassing review.

## When to use

- The user invokes `/create-task`, or asks you to plan / break down / decompose / add tasks
  for a feature, idea, or rough brief.
- Not for a single obvious one-line task the user could type into the board's quick-capture —
  just tell them to use the `+` on the board. Use this when there is scope to decompose.

## Subscription safety

This skill runs inside the user's Claude session. It **never** spawns `claude -p` or any
headless agent. It only reads and writes through the `taskwright` MCP tools and (when a spec
or plan is warranted) drafts files via `superpowers:writing-plans`.

## The loop

1. **Understand.** If the brief is ambiguous (unclear scope, unstated constraints, multiple
   plausible interpretations), invoke `superpowers:brainstorming` to clarify intent before
   decomposing. If it is already clear, continue.

2. **Read the tree.** Before proposing anything:
   - `list_categories` — the existing lanes (with counts + which are reserved: Misc/Bugs).
   - `list_milestones` — the milestone bands in board order (with counts; Backburner = no
     milestone).
   - `get_board` — the compact board (active tasks + existing drafts). Filter by
     `category` / `milestone` / `status` on a large board to keep it bounded.
   - `search_tasks` — on the brief's key terms, to find related or overlapping work.

3. **Decompose.** Break the brief into **PR-sized tasks** (AGENTS.md: "1 PR = 1 task").
   Express ordering as **dependencies**, not as one mega-task. Reserve `create_subtask` for a
   genuine breakdown of a single PR's internal work — not for sequencing separate PRs.
   - **Slot the lane** by sideways traversal of the existing categories (reuse one). Only
     when the work is a genuinely new area, propose a new lane with `create_category` — and
     surface that to the user for approval first.
   - **Slot the milestone** by where the work lands in the flow; default to Backburner
     (omit `milestone`) when unknown.
   - **Infer dependencies** from required order. Every proposed edge must not create a cycle
     (the tools reject cycles; design the graph so it never comes up).
   - **Overlap → link, don't duplicate.** If `search_tasks` / `get_board` surfaces existing
     work that overlaps, depend on or extend it instead of creating a near-duplicate.

4. **Propose as drafts.** Commit the proposal so nothing hits the active board until the
   human promotes:
   - `create_category` first for any approved-new lane.
   - `create_task` with `draft: true` for each task, setting `category`, `priority`,
     `milestone`, and `dependencies` in the one call (drafts carry all of these). Use
     `type: "bug"` + `causedBy` for a bug node. `create_subtask` for within-task breakdowns.
   - Drafts render as **proposed nodes** on the tree canvas.

5. **Plans (optional).** When a task genuinely warrants a spec/plan (large or ambiguous
   scope), or the user asks, draft it with `superpowers:writing-plans` and link it with
   `attach_plan`. Do not over-plan small tasks.

6. **Hand off to review.** Tell the user the proposal is on the tree as draft nodes. They
   edit / reslot / connect / disconnect with the P3 board gestures and **promote** when
   satisfied — single (per-node Promote) or all at once ("Promote all proposed", which runs
   `promote_drafts` and rewires the dependency edges). Do **not** promote for them; the
   review-and-promote step is the human's.

## Rules of thumb

- One task = one shippable PR; sequence with dependencies.
- Reuse a lane before creating one; a new lane is a decision to surface, not assume.
- Default milestone Backburner when the flow position is unknown.
- Link to existing work over duplicating it.
- Drafts only — you propose, the human promotes.
