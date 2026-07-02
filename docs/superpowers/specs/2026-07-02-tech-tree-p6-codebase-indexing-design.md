# Design: Tech-tree P6 — codebase indexing / git forensics

**Date:** 2026-07-02
**Status:** Approved (brainstorm) — pending implementation plan
**Umbrella:** `docs/superpowers/specs/2026-07-01-tech-tree-overhaul-vision.md`
**Builds on:** P1 (model, cycle guard, config), P2 (canvas + draft rendering + promote), P4
(create/traversal tools + draft-review flow).

P6 bootstraps an initial tree when Taskwright is mounted on an **existing** project. An
`/index-codebase` skill reads git history and the codebase — "forensics" — to reconstruct the
already-built foundation as Done nodes, mine visible gaps as open tasks, and apply the result as
draft nodes for review. It is the last sub-project; it reuses P4 almost entirely.

## 1. Problem & goal

On a fresh install over an existing repo the tree is empty, so there is nothing for new tasks to
attach to. P6 reconstructs the **major** structure and decisions (not every detail) — subsystems,
features, releases, and dependencies — so the board reflects reality and new work slots onto the
existing foundation with correct lanes, ages, and prerequisites.

## 2. Decisions locked during brainstorming

- **Baseline = Done tasks.** Each major subsystem/feature/decision becomes a **Done** task tagged
  `baseline`, in the milestone age it was built. Reuses gating/dependencies; nothing new to render.
- **Claude forensics.** Claude reads git log/tags, the module structure, manifests, and docs and
  judges the major structure (adapts to any project), rather than rigid rules.
- **Also mine gaps.** TODO/FIXME comments and obvious gaps become **open To-Do tasks**, attached to
  the relevant baseline module.
- **Apply as drafts** (P4 flow); re-runnable with dedupe. Nothing lands without review.
- **One new tool:** `create_milestone`; otherwise P4's tools + P1 writers/cycle guard.

## 3. The `/index-codebase` skill

A `.claude/skills/index-codebase/SKILL.md` (name, description, `allowed-tools`: shell/Read/Grep/Glob
for analysis + the taskwright MCP write/traversal tools). Its loop:

1. **Survey** — `list_categories` / `list_milestones` / `get_board` to see what (if anything) already
   exists, so the bootstrap is additive.
2. **Forensics** — inspect:
   - **git** — tags/releases, commit clusters, file churn, dates/authors (chronology & phases);
   - **structure** — top-level modules/dirs, package manifests, entry points, the dependency graph;
   - **docs** — README, CHANGELOG, `backlog/decisions`/ADRs, architecture notes.
3. **Reconstruct (coarse):**
   - top-level modules/dirs → **lanes** (`create_category` for new ones);
   - git tags/releases (or inferred phases when untagged) → **milestone ages** (`create_milestone`),
     ordered oldest→newest on the left;
   - major subsystems/features/decisions → **Done `baseline` tasks** in the age they were built;
   - module dependency graph + build chronology → **dependencies** (each checked with
     `wouldCreateCycle`).
4. **Mine gaps** — scan `TODO`/`FIXME`/`XXX` markers and obvious gaps → **open To-Do tasks** attached
   (as dependents) to the relevant baseline module, in the current age (or Backburner). FIXMEs are
   flagged as candidate **bugs** but default to tasks unless clearly a defect.
5. **Propose as drafts** — write everything with `create_task` `draft: true` (+ `create_category` /
   `create_milestone` as needed); the proposal appears as **draft nodes** on the canvas.
6. **Review & promote** — the user edits/reslots/connects (P3 gestures) and promotes
   (`promote_draft` / `promote_drafts`). Discarded drafts leave no trace.

Granularity is deliberately coarse — tens of nodes for a typical project, capturing major decisions
and structure, not per-file detail.

## 4. New tool: `create_milestone`

- `create_milestone` → `{ name, description?, order? }`, wrapping the existing `BacklogWriter`
  milestone create (files under `backlog/milestones/`), returning the milestone id. This is the only
  new MCP tool P6 needs; `list_milestones` (P4) already reads them.

## 5. Apply model — drafts, re-runnable, dedupe

- All reconstructed/mined nodes are **drafts** until promoted, so an imperfect forensic pass never
  pollutes the live board.
- The skill is **re-runnable** (e.g., after more history accrues): it first surveys the board and uses
  `search_tasks`/`get_board` to **dedupe**, extending or linking to existing nodes rather than
  duplicating already-tracked work.

## 6. Parity, subscription-safety & testing

- **Parity:** identical writers to P3/P4 — the skill just derives its proposal from the repo instead
  of a brief or manual gestures.
- **Subscription-safe:** runs inside the session; uses shell/Read/Grep/Glob for analysis and MCP tools
  for writes; never spawns `claude -p`.
- **Testing:** unit tests for `create_milestone` and for the dedupe/attach logic where it's pure;
  scenario coverage on a sample repo (git history + dirs + TODOs → expected coarse tree of Done
  baseline + open mined tasks, as drafts).

## 7. Scope boundary & dependencies

**In P6:** the `/index-codebase` skill, the `create_milestone` tool, and the draft-review bootstrap.

**Depends on:** P1 (model, `wouldCreateCycle`, config `categories`/`priorities`), P2 (canvas + draft
rendering + promote), P4 (create/traversal tools + draft flow). Executing the resulting tasks is P5's
job.

**Completes the tech-tree spec set (P1–P6).** Implementation order remains P1 → P2 → P3 → P4 →
(P5, P6), each with its own plan → build cycle.
