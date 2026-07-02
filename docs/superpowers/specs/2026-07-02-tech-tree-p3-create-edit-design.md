# Design: Tech-tree P3 — frictionless create & edit

**Date:** 2026-07-02
**Status:** Approved (brainstorm) — pending implementation plan
**Umbrella:** `docs/superpowers/specs/2026-07-01-tech-tree-overhaul-vision.md`
**Builds on:** P1 model (`…2026-07-01-tech-tree-p1-model-and-gating-design.md`) + P2 canvas (`…2026-07-02-tech-tree-p2-canvas-design.md`).

P3 is how a **human** authors the tree directly on the canvas: create tasks with every field up
front, wire dependencies by dragging, capture bugs/one-offs without ceremony, and re-slot nodes by
dragging. (The **AI** counterpart — `/create-task` generating and splitting tasks — is P4.)

## 1. Problem & goal

Today creating a task takes four steps (create → save → re-open → set priority), and the create
panel only collects title/description/milestone (`TaskCreatePanel`). Dependencies, categories, and
bug links have no authoring UI at all. P3 makes authoring **fast and spatial**: fields at creation,
drag to connect, drag to re-home, quick bug/one-off capture.

## 2. Decisions locked during brainstorming

- **One unified create form**, two triggers (click-in-place + quick-add); it always includes
  Description (no stripped inline editor).
- **All fields at creation:** Title, Category, **Priority** (configurable levels), Milestone,
  Description — plus a **Task | Bug** toggle.
- **Click-in-place infers** category (lane) + milestone (age) from the click position; both editable.
- **Directional connect handles:** right = "unlocks" (source→prereq), left = "needs"
  (target→prereq); edges flow left→right; cycles/dupes refused; drop-on-empty creates a linked node.
- **Drag-to-reslot edits fields, not coordinates:** vertical → category, horizontal → milestone,
  in-cell → ordinal; the hovered age band **expands** as a drop target; prereq inversion is **allowed
  with a soft warning**.
- **Bug/one-off:** Bug mode adds severity (= priority) + `caused_by`; "Report bug" from a node
  pre-fills `caused_by`; quick capture drops a one-off into **Misc / Backburner**.

## 3. Unified create form

One Svelte form component, two entry points:

- **Click-in-place** — clicking empty canvas opens the form anchored there, with **Category** and
  **Milestone** pre-filled from the lane/band clicked (editable). Bug lane / Backburner are valid
  click targets.
- **Quick-add** — a command (`⌘/Ctrl-N`, `backlog.createTask`) opens the same form with defaults
  (Category = Misc, Milestone = Backburner) for not-yet-placed capture.

**Fields:** Title · **Task | Bug** toggle · Category · **Priority** (from config `priorities`) ·
Milestone · Description. Submit = **Create** (`↵`) or **Create & open** (`⇧↵`), producing a **To Do**,
unclaimed node written via the surgical writers (P1 fields + Backlog.md body).

## 4. Bug & one-off intake

- **Bug mode** (form toggle): Category is fixed to the **Bug lane** (`type: bug`), Milestone hidden
  (bugs sort by severity on the Bug lane, not by age). Adds **Severity** (= `priority`), **Caused by**
  (task search; may be left *untraced*), and steps/notes. `caused_by` is optional at capture but
  **required before the bug can be completed** (P1 §6).
- **Report bug from a node** — a node/popover action opens the form in Bug mode with `caused_by`
  pre-filled to that task.
- **One-off quick capture** — `⌘⇧N` (`backlog.quickCapture`): a single title line → a **Task** in
  **Misc** lane, **Backburner** age, To Do. Drag it into its real home later (§6).

## 5. Drag-to-connect dependencies

- Each node exposes two connect handles on hover: **left = "needs"**, **right = "unlocks"**.
- **Direction follows the handle:** dragging from the **right** handle to node B makes the source a
  **prerequisite** of B; dragging from the **left** handle to node A makes A the source's
  **prerequisite**. The resulting edge always renders left→right.
- **Live feedback:** a dashed line follows the cursor; a valid target **glows green**; a drop that
  would create a **cycle** or a duplicate is **refused** (red), backed by P1's `wouldCreateCycle`.
- **Drop on empty canvas** → opens the create form for a **new node pre-linked** in the dragged
  direction.
- **Removing** a dependency: hover the edge → **✕**, or delete it from the popover's Prereqs list.

## 6. Drag-to-reslot

Because layout is derived from fields (P1/P2), dragging a node **edits those fields**:

- **Vertical** (to another lane) → sets `category`. **Horizontal** (to another band) → sets
  `milestone`. **Within a cell** → sets `ordinal` (reorder). The layout then re-flows.
- **Band expand-on-hover:** while dragging, the age band under the cursor temporarily **expands** into
  a roomy highlighted drop target (and collapses when you leave), so any milestone — even a narrow or
  crowded one — is easy to hit. A drop cell + preview ghost show the landing spot.
- **Prereq inversion:** dropping a task into an age **earlier** than one of its prerequisites is
  **allowed**, with an amber "before its prerequisite" warning on the edge/age (matches P1's
  cross-band soft warning). Not blocked.
- Bugs stay on the Bug lane (dragging reorders by severity, not lane/age). One-offs drag out of Misc.

## 7. Editing model

All P3 gestures resolve to **field edits through the existing surgical writers** — never stored
coordinates: create (P1 fields + body), `category`/`milestone` (frontmatterEdit), `dependencies`
(with cycle guard), `ordinal` (fractional indexing, existing `ordinalUtils`), `type`/`caused_by` for
bugs. Quick edits (status/priority/labels) continue to run through the P2 popover. This keeps every
authoring action reversible, Backlog.md-compatible, and identical to what the MCP write tools do
(human/agent parity).

## 8. Architecture, messages & testing

- **Components:** a `CreateTaskForm.svelte` (shared by both triggers), connect-handle + drag-layer
  behavior on the P2 `TechTreeCanvas`, and re-slot drop handling on lanes/bands.
- **Messages (webview→ext):** extend the existing bus — `createTask` (full field set),
  `addDependency`/`removeDependency` (with `from`/`to` + cycle result), `createLinkedTask`
  (drop-on-empty), `reslotTask` (`category`/`milestone`), and the existing `reorderTasks` (ordinal).
- **Testing:** **Playwright** for the drag interactions (connect, reslot, band-expand) — HTML5 drag
  can't be unit-tested (repo convention); **unit tests** for cycle rejection and field-edit writers
  (with P1); **CDP** for create→node-appears and reslot→file-written cross-view; `visual-proof` for
  PR artifacts.

## 9. Scope boundary & dependencies

**In P3:** the unified create form, bug/one-off intake, drag-to-connect, drag-to-reslot, and the
field-edit plumbing behind them.

**Depends on:** P1 (model, `wouldCreateCycle`, config `categories`/`priorities`) and P2 (canvas,
nodes, popover, layout).

**Deferred:** `/create-task` (AI generating/splitting tasks, populating specs/plans) and
tree-traversal MCP tools (**P4**); `/execute-task` (**P5**); codebase indexing (**P6**). P3 is the
human authoring surface; P4 is its automated counterpart and reuses the same writers and cycle guard.
