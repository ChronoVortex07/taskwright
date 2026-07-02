# Design: Tech-tree P4 — `/create-task` skill & tree-traversal tools

**Date:** 2026-07-02
**Status:** Approved (brainstorm) — pending implementation plan
**Umbrella:** `docs/superpowers/specs/2026-07-01-tech-tree-overhaul-vision.md`
**Builds on:** P1 (model, `wouldCreateCycle`, config lists), P2 (canvas + a draft-node amendment, §7), P3 (authoring gestures reused for review).

P4 is the **AI authoring** counterpart to P3: from a vague brief, Claude produces a set of detailed,
dependency-linked tasks slotted into the right lanes/ages — reading the tree first, creating
categories when needed, and drafting specs/plans when warranted. It adds a skill plus a few
read/traversal MCP tools, and commits its proposal as **draft nodes** you review on the canvas.

## 1. Problem & goal

Turning an idea into a well-formed set of tree tasks by hand (P3) is powerful but manual: you must
know the existing lanes, pick dependencies, and split scope yourself. P4 automates that authoring —
Claude reads the tree, decomposes the brief into PR-sized tasks with dependencies, and proposes them
on-canvas for approval — while staying subscription-safe and using the exact same writers a human
does (parity).

## 2. Decisions locked during brainstorming

- **Adaptive brainstorm:** clarify via `superpowers:brainstorming` only when the brief is vague;
  decompose directly when it's clear.
- **PR-sized tasks linked by dependencies** (AGENTS.md "1 PR = 1 task"); `create_subtask` only for
  genuine within-task breakdowns.
- **Apply as draft nodes** on the tree; the user reviews visually and **promotes** (single/bulk).
- **Specs/plans only when warranted / asked** (via `writing-plans` + `attach_plan`).
- **Tool set:** `list_categories`, `list_milestones`, `get_board`, **`search_tasks`**,
  `create_category`, extended `create_task`, plus existing `create_subtask` / `attach_plan` /
  `promote_draft` (+ bulk promote).
- **Parity:** every tool reuses P1's surgical writers + `wouldCreateCycle`; nothing the skill does is
  unavailable to a human via P3.

## 3. The `/create-task` skill

A `.claude/skills/create-task/SKILL.md` (name, description, `allowed-tools`: the taskwright MCP
tools + `superpowers:brainstorming` + `superpowers:writing-plans`). Its loop:

1. **Understand** — if the brief is ambiguous, invoke `superpowers:brainstorming` to clarify intent;
   otherwise continue.
2. **Read the tree** — `list_categories` + `list_milestones` + `get_board`, and `search_tasks` on key
   terms to find related/overlapping work.
3. **Decompose** — into PR-sized tasks; express ordering as **dependencies**; infer each task's lane
   (traverse sideways over existing categories) and milestone; mark where a **new category** is
   genuinely needed. Flag overlaps and **link** rather than duplicate.
4. **Propose as drafts** — `create_category` (if approved-new) then `create_task` (Draft) for each,
   with category/priority/milestone/dependencies set; `create_subtask` for within-task breakdowns.
5. **Plans (optional)** — when warranted or asked, draft via `writing-plans` and `attach_plan`.
6. **Hand off to review** — the drafts appear as **proposed nodes** on the canvas; the user edits /
   reslots / connects them with P3 gestures and **promotes** when satisfied.

## 4. New MCP tools

**Reads** (align with human/agent parity — agents can now see the board):

- `list_categories` → `[{ category, count }]`, incl. reserved Bugs/Misc.
- `list_milestones` → `[{ id, name, order, taskCount, doneCount }]`, incl. Backburner.
- `get_board` → compact task summaries `{ id, title, category, milestone, status, priority,
  dependencies, blockedBy, locked, type, caused_by }`, with optional filters (category / milestone /
  status) so output stays bounded on large boards.
- `search_tasks` → keyword search over title / description / labels / category, ranked, returning the
  same compact summaries. *Baseline is keyword; semantic/embedding search is a flagged later
  enhancement — no embeddings dependency is taken on now.*

**Writes** (all reuse P1 surgical writers; cycle-guarded):

- `create_category` → append to config `categories`.
- `create_task` **extended** to accept the full field set in one call: `category`, `priority`,
  `milestone`, `dependencies` (rejected on cycle), `type`, `caused_by`, and a `draft` flag.
- Existing `create_subtask`, `attach_plan`, `promote_draft`; add **`promote_drafts`** (bulk) to
  promote a set of reviewed proposals at once.

## 5. Decomposition & slotting rules

- **Granularity:** one task = one shippable PR. Sequence with dependencies; reserve subtasks for
  genuine decomposition of a single PR's work.
- **Slotting:** category by sideways traversal of existing lanes (create a new one only for a
  genuinely new area, surfaced for approval); milestone by where the work lands in the flow
  (default Backburner when unknown).
- **Dependencies:** inferred from required order; every proposed edge is checked with
  `wouldCreateCycle` before it's written.
- **Overlap:** `search_tasks`/`get_board` results are used to link to or extend existing tasks
  instead of creating near-duplicates.

## 6. Draft-review apply model

- The proposal is written as **Draft-status nodes** (`create_task` with `draft: true`), so nothing is
  committed to the active board until you promote.
- Draft nodes render distinctly on the canvas (P2 amendment, §7), are **fully editable via P3
  gestures** (rename, reslot, connect/disconnect, change priority), and can be discarded.
- **Promote** (single via `promote_draft`, or **all proposed** via `promote_drafts`) turns them into
  real `To Do` tasks. This reuses the existing draft → task promotion (new `TASK-N` ids).

## 7. Amendment folded into P2

P4 requires a small P2 addition (recorded in the P2 spec):

- **Draft/proposed node rendering** — Draft-status nodes get a distinct "proposed" style (e.g.,
  dashed/ghosted) on the canvas, and participate in layout, filtering, and P3 gestures.
- **Promote action** — a per-node **Promote** and a canvas-level **Promote all proposed**, backed by
  `promote_draft` / `promote_drafts`.

## 8. Architecture, parity & testing

- **Subscription-safe:** the skill runs inside the user's Claude session; it never spawns `claude -p`.
  It only reads/writes via MCP tools and drafts specs/plans as files.
- **Parity:** identical writers to P3; any decomposition the skill makes, a human could make by hand,
  and vice versa.
- **Testing:** unit tests for the new read tools (shape, filters, ranking) and `create_category` /
  extended `create_task` / `promote_drafts` (with cycle rejection); the skill's behavior is validated
  by scenario walkthroughs (brief → drafts on tree) plus the P2 draft-render/promote UI tests.

## 9. Scope boundary & dependencies

**In P4:** the `/create-task` skill, the read/traversal + write MCP tools, and the draft-review apply
flow (with the P2 draft-node amendment).

**Depends on:** P1 (model, `wouldCreateCycle`, config `categories`/`priorities`), P2 (canvas + draft
rendering + promote), P3 (gestures reused for reviewing drafts).

**Deferred:** `/execute-task` — worktree-enforced dispatch that *works* these tasks (**P5**); codebase
indexing that bootstraps an initial tree on an existing project (**P6**), which will reuse P4's
create/traversal tools.
