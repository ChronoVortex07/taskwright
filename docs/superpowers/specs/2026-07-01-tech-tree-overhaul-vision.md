# Vision: Tech-tree overhaul (board presentation, dependency gating, agent authoring)

**Date:** 2026-07-01
**Status:** Approved (brainstorm) — umbrella vision; each sub-project has its own spec → plan → build

This is the **north-star** document for a multi-sub-project overhaul. It records the shared
metaphor, the model decisions every piece inherits, and the decomposition into buildable
sub-projects. It does not contain implementation detail — that lives in the per-sub-project
design specs it points to.

## 1. Motivation

The current board is a status-columned kanban with a vertical task list. Three problems:

1. **Too many clicks.** Creating a task takes: `+` → fill title/description → create → *then* open
   the task and edit to set priority. Fields that belong at creation (priority, category) are
   buried behind a second edit step (`TaskCreatePanel` only collects title/description/milestone).
2. **Doesn't scale.** A large project stacks every task in one vertical column per status with no
   way to group or read structure at a glance. Categories exist only as filterable labels.
3. **No sense of flow or readiness.** Some work can't start until other work is done, but
   `dependencies` are display-only (a gray "blocked by" badge) — nothing prevents claiming a task
   whose prerequisites are unfinished. There is no visual of what belongs to which part of the
   project, what "age"/milestone it's in, or what is unlocked to work on now.

## 2. The metaphor: a tech tree

Model the board on a game tech tree (Dyson Sphere Program as the reference). A task is a **tech
node**. This gives, for free, the exact affordances the board is missing:

- **Categories are parallel branches** (power, factory, logistics) → each task lives in one **lane**.
- **Dependencies lock techs behind others** → a task can't be claimed until its prerequisites are Done.
- **Status is read at a glance** from the node itself (done / active / pending / locked).
- **Milestones are "ages"/matrices** → coarse bands the tree flows through.
- The whole thing is a **pannable, zoomable canvas** you author and read spatially.

## 3. Model decisions locked during brainstorming

These are shared by all sub-projects and must not be re-litigated per-piece:

- **View:** the tech tree becomes the **new default view**; the existing kanban + list remain as
  alternate tabs on the same data bus (`Tasks.svelte` `TabBar`). Nothing is thrown away.
- **Category = a new single-value field.** A Taskwright-only `category` string, one per task,
  written surgically like `claimed_by`/`plan` (Backlog.md frontmatter round-trips untouched).
  Labels stay as free, multi-valued cross-cutting tags. One lane per task, like a tech branch.
- **Layout is derived, never hand-placed.** A node's position is a pure function of its fields
  (lane = category, band = milestone, depth = dependencies, tie-break = ordinal). This is what lets
  Claude "slot" a task by setting fields rather than pixels; optional manual nudging is a later polish.
- **Flow axis = milestone bands + dependency depth.** Milestones are the visible age bands
  left→right; within/across them, dependency chains push nodes rightward. No-milestone tasks fall to
  a **Backburner** band pinned rightmost.
- **Gating is a hard block with a human-only override.** Unmet dependencies refuse claim/dispatch;
  a human can "Force claim" in the UI, but the MCP `claim_task` stays strict so agents can't self-unlock.
- **Bugs are first-class nodes** on a reserved **Bug lane**, tracing back to the task that
  introduced them (`caused_by`), required before a bug can be closed; one-offs live in a **Misc** lane.

## 4. Decomposition into sub-projects

Each is independently specifiable, buildable, and testable. Order reflects dependencies.

| # | Sub-project | Absorbs | Depends on |
|---|-------------|---------|-----------|
| **P1** | **Tree model & dependency gating** — `category`, gating, milestone bands, bug model, derived layout state | Task 9 | — (foundation) |
| **P2** | **Tech-tree canvas** — pan/zoom board, nodes, dependency edges, lanes, age bands, side panel, detail popup, focus = active | Task 6, Task 12 | P1 |
| **P3** | **Frictionless create/edit** — full-field creation (priority/category at creation), quick-edit, draw-edge-to-add-dependency, bug/one-off intake | — | P1, P2 |
| **P4** | **`/create-task` skill + tree-traversal MCP tools** — vague → detailed tasks with dependency splitting, spec/plan population, walk-deps / walk-categories / create-category tools | — | P1 |
| **P5** | **`/execute-task` skill** — worktree-enforced dispatch using executing-plans / subagent-driven-development | — | mostly independent |
| **P6** | **Codebase indexing / git forensics** — bootstrap the initial tree on an existing project | — | P1, P4 |

**Absorbed board tasks:** Task 6 (group-by-label swimlanes) is superseded by category lanes in P2;
Task 9 (prerequisite gating) is delivered by P1; Task 12 (focused task = active task) is delivered
by P2's detail popup.

**Recommended sequence:** P1 → P2 → P3 → P4 → (P5, P6). P5 can be built any time (it evolves the
existing subscription-safe dispatch); P6 comes last (it needs the P1 model and the P4 create tools).

## 5. Non-goals

- Not a rewrite of task storage — everything stays Backlog.md-compatible Markdown in git.
- Not replacing the merge queue, worktree isolation, or synced-board substrate — those stay as-is
  and the tree sits on top of them.
- Not manual/pixel-based graph authoring — layout is semantic (see §3).
- No new external services. The canvas is a webview like the existing boards.

## 6. Where to read next

- **P1 (foundation):** `docs/superpowers/specs/2026-07-01-tech-tree-p1-model-and-gating-design.md`
- P2–P6: to be written as each sub-project is brainstormed, following the same spec → plan → build cycle.
