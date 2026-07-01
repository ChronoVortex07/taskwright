# Design: Tech-tree P1 — task model & dependency gating

**Date:** 2026-07-01
**Status:** Approved (brainstorm) — pending implementation plan
**Umbrella:** `docs/superpowers/specs/2026-07-01-tech-tree-overhaul-vision.md`

P1 is the foundation the tech-tree overhaul is built on. It ships the **data model, dependency
gating, and validation** — everything the canvas (P2), creation UX (P3), and agent tools (P4/P6)
inherit. It is testable headlessly, with no canvas.

## 1. Problem

The task model has the raw material for a tech tree but none of the semantics:

- **Dependencies are display-only.** `Task.dependencies: string[]` exists, and
  `TasksController` already computes `blockingDependencyIds` (deps not yet Done) and `blocksTaskIds`
  (reverse deps), but only to render a gray "blocked by" badge. A locked task can still be claimed,
  dispatched, and worked — there is no gate (Task 9).
- **No category concept.** "Categories" are just labels today (`labels: string[]`), so a task has no
  single deterministic home lane (Task 6 wanted this as a board axis).
- **Bugs and one-offs are unmodeled.** There is no bug node type, no link from a bug to the task
  that caused it, and no notion of an off-tree "Backburner"/"Misc" home for un-slotted work.
- **Position is not derivable.** Nothing maps a task to a lane/band/depth, so neither the canvas nor
  an agent can place a task from its fields.

## 2. Goal & decisions locked

Give tasks the fields and rules that make them tree nodes, and turn dependencies into a real gate —
without breaking Backlog.md frontmatter compatibility.

Decisions locked during brainstorming:

- **`category` is a new single-value Taskwright field**, written surgically (Backlog.md round-trips
  byte-for-byte). Labels stay as free multi-valued tags.
- **Layout is derived** from fields; P1 stores no coordinates.
- **Flow axis = milestone band + dependency depth**; no-milestone tasks fall to **Backburner** (rightmost).
- **Gating is a hard block with a human-only override** (UI "Force claim"; MCP `claim_task` stays strict).
- **Bugs are `type: bug` nodes** on a reserved **Bug lane**, traced by `caused_by`, required before close.
  **Severity reuses the existing `priority` field** (relabeled "Severity" in bug UI) — no new field.
- **Reserved lanes:** `Bugs` (all `type: bug`) and `Misc` (default lane for uncategorized non-bugs).

## 3. Data model

### 3.1 New / repurposed frontmatter fields

All optional; all Taskwright-only; all written via the surgical `frontmatterEdit.ts` path so
canonical Backlog.md fields are untouched.

| Field | Type | On | Semantics |
|-------|------|-----|-----------|
| `category` | `string` | tasks | The lane. Free-form single value. Absent/empty ⇒ **Misc** lane. |
| `type` | `'bug'` | bugs | Marks a bug node → **Bug lane** regardless of `category`. (Field already exists in `Task`.) |
| `caused_by` | `string` | bugs | Task ID that introduced the bug. Optional at filing; **required to complete** (§5.2). |

`dependencies: string[]` (existing) remains the **gating** relation. `caused_by` is a **reference**
relation, never a gate. `priority: 'high' | 'medium' | 'low'` (existing) doubles as bug **severity**.

### 3.2 Config additions (`backlog/config.yml`)

- `categories: string[]` — predeclared lanes, mirroring the existing `labels` list. Drives lane
  rendering (empty lanes still show), autocomplete, and the create form's category picker. The union
  of config categories + categories seen on tasks is the lane set (as `getUniqueLabels` does for labels).
- Reserved lane names `Bugs` and `Misc`, and the virtual band name `Backburner`, are **constants** in
  P1 (not user-configurable yet). Milestone **band order** = order of the existing config `milestones`
  list (files still take precedence for existence/metadata); `Backburner` is always appended last.

### 3.3 Derived (computed at load, never stored)

Computed in the parser/controller layer alongside today's reverse-dep pass, and surfaced on the task
data object + MCP responses:

- `locked: boolean` and `blockedBy: string[]` — from `blockingDependencyIds` (a dependency counts as
  satisfied when its status is the configured Done status, or it is completed/archived; a **missing**
  dependency counts as blocking).
- `bugs: string[]` and `activeBugIds: string[]` — every `type: bug` task whose `caused_by === this.id`
  (active = not Done). Single source of truth is the bug's `caused_by`; the task-side list is derived
  so it can never drift. `activeBugIds.length > 0` is the "has an active bug" flag P2 will highlight.
- `layout: { lane: string; band: string; depth: number }` — `lane` from `type`/`category`, `band`
  from `milestone` (or `Backburner`), `depth` = longest chain of prerequisites in the same band.
  Ordinal remains the in-cell tie-break. Pure function, unit-testable without a canvas.

## 4. Layout derivation rules

A pure module (e.g. `src/core/treeLayout.ts`) maps `Task[]` → placement, with no rendering:

1. **Lane (row):** `type === 'bug'` ⇒ `Bugs`; else `category` if set; else `Misc`. Lane render order:
   declared `categories` first (config order), then discovered categories (sorted), then `Misc`, then
   `Bugs` pinned last. (Exact pin order is a P2 presentation detail; the model just tags the lane.)
2. **Band (age):** `milestone` resolved to its canonical id/name, ordered by config `milestones`;
   no milestone ⇒ `Backburner` (always rightmost).
3. **Depth within a band:** longest path of Done-gating `dependencies` among nodes in the same band
   (prereqs push right). Cross-band dependencies are allowed; a dependency pointing to a *later* band
   is a **soft warning** (surfaced, not blocked) since you cannot logically require a future age.
4. **In-cell order:** existing `ordinal` (fractional index), then `priority`, then id — reusing
   `ordinalUtils.compareByOrdinal`.
5. **Bug lane** ignores bands: bugs sort by `priority` (severity) then completion state (open before
   done) then recency.

## 5. Dependency gating (Task 9)

### 5.1 The gate

- **Locked** ⇔ `blockedBy.length > 0`.
- `claim_task` (MCP) **refuses** a locked task, returning `{ claimed: false, locked: true, blockedBy }`.
- Dispatch (`dispatchActions`) **refuses** to dispatch a locked task with the same reason.
- The UI renders locked nodes distinctly and disables Claim/Dispatch (P2), offering **Force claim**.

### 5.2 Override & integrity

- **Force claim is human-only.** Implemented as a UI action / `backlog.forceClaimTask` command that
  bypasses the gate. The MCP `claim_task` gains **no** `force` parameter — a dispatched agent can never
  self-unlock. To put an agent on locked work, a human force-claims then dispatches.
- **DAG invariant.** Adding a dependency that would introduce a cycle is rejected in `edit_task` and
  in the future edge-drawing UI. A pure `wouldCreateCycle(tasks, from, to)` helper backs both.

## 6. Bug lifecycle

- **File:** create a task with `type: bug`; `caused_by` may be empty ("cause unknown, triage later").
- **Close:** `complete_task` on a `type: bug` **refuses** unless `caused_by` is set and resolves to an
  existing task — "trace it back before closing." Returns a clear error otherwise.
- **Backlink & highlight:** the caused task exposes `bugs`/`activeBugIds` (§3.3); "has active bug" is
  a derived flag for P2 to surface on the origin node.

## 7. MCP & command surface (P1 scope)

P1 exposes the fields and enforces the rules; the *rich* traversal tools are P4.

- `create_task` / `edit_task`: accept and validate `category`, `type: 'bug'`, `caused_by`; reject
  cycles on dependency edits.
- `claim_task`: enforce the gate (§5.1); response gains `locked`/`blockedBy`.
- `complete_task`: enforce the bug-completion rule (§6).
- `get_active_task` and task summaries: include `category`, `locked`, `blockedBy`, `bugs`/
  `activeBugIds`, and `layout` hints.
- New human command `backlog.forceClaimTask` (UI Force claim).

## 8. Testing (TDD, Vitest)

Pure cores get failing tests first:

- Gate predicate: locked/unlocked across Done/missing/cross-branch dependency states.
- `wouldCreateCycle`: direct, transitive, self, and no-cycle cases.
- Layout derivation: lane selection (bug/category/misc), band ordering incl. `Backburner`, depth from
  chains, bug-lane severity+completion sort.
- Bug-completion validation: refuse without `caused_by`, refuse on dangling ref, accept on valid ref.
- Surgical writes: `category`/`caused_by` round-trip leaves canonical Backlog.md frontmatter
  byte-for-byte, CRLF preserved (mirrors the `claims.ts` tests).

Windows note: assert with `path.*`, not literal POSIX separators (per repo convention).

## 9. Scope boundary

**In P1:** fields, config, derived state, layout module, gating + override, bug lifecycle, MCP/command
enforcement, tests.

**Deferred:** the pannable canvas, node/edge rendering, and active-bug highlighting (P2); the
streamlined create form, drag-to-connect, and bug/one-off intake UX (P3); `/create-task`,
`/execute-task`, tree-traversal tools, and codebase indexing (P4–P6). The `dependencies`-as-gate work
here is what those later pieces stand on.
