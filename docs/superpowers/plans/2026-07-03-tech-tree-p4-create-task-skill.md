# Tech-tree P4 — `/create-task` Skill & Tree-Traversal Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Claude an **AI authoring** counterpart to P3's human create/drag surfaces: a `/create-task` skill that reads the tech-tree, decomposes a vague brief into PR-sized dependency-linked tasks slotted into the right lanes/ages, and commits the proposal as **draft nodes** the human reviews and promotes on the canvas. Behind the skill are a handful of read/traversal MCP tools (`list_categories`, `list_milestones`, `get_board`, `search_tasks`), one config-write tool (`create_category`), and a **bulk promote** tool (`promote_drafts`) — every one reusing P1's surgical writers + `wouldCreateCycle` (parity: nothing the skill does is unavailable to a human via P3). Along the way P4 **closes three latent gaps** that make the draft-proposal route actually work end-to-end: drafts must render on the canvas (GAP-1), draft-create must carry all fields (GAP-2), and promotion must not shatter dependency edges (GAP-3).

**Scope boundary (P4).** This plan implements the P4 architecture directives (`.superpowers/tech-tree-run/p4-architecture-directives.md`) in full: GAP-1/2/3 (Tasks 1–3), the read tools (Tasks 4–5), `create_category` (Task 6), the skill + tool-description polish + doc-sync (Task 7), and the CDP + Playwright proof pass (Task 8), plus the two cheap accepted-debt folds (dead `requestCreateTask` webview path → Task 1; the CLAUDE.md onboarding blurb → Task 7). It does **not** implement `/execute-task` (worktree-enforced dispatch — **P5**) or codebase-indexing tree bootstrap (**P6**). No new webview drag gestures, no stored coordinates, no embeddings/semantic search (baseline keyword only).

**Architecture.** The MCP server (`src/mcp/server.ts` + `src/mcp/handlers.ts`) is a separate vscode-free stdio process reusing `src/core`. P4 adds:

- **Reads** (`jsonContent` wrapper): `list_categories`/`list_milestones`/`get_board`/`search_tasks` — all built on the existing shared board derivation `loadTreeBoardFromParser` (`src/core/treeDerived.ts:92`) + `parser.getTasks()`/`getDrafts()`, so agent output matches the canvas exactly. `search_tasks` gets a pure core `src/core/searchTasks.ts`.
- **Writes** (`runTool` wrapper): `create_category` (surgical single-line `config.yml` edit via new `src/core/categoriesConfig.ts`, mirroring `src/core/mergeStatusConfig.ts`) and `promote_drafts` (bulk, via new `src/core/promoteDrafts.ts` — validate → topo-order → per-draft `writer.promoteDraft` → remap inbound `dependencies`/`caused_by` across the board).
- **Three gap closures** so the draft-review loop is live: (1) `loadTreeBoardFromParser` unions `getDrafts()` into the derivation universe **and** `TasksController` unions drafts into the **tree-tab** `tasksUpdated` payload, so draft files render as proposed nodes (the existing `isDraft` styling in `TreeNode.svelte:38` — `status === 'Draft' || folder === 'drafts'` — engages with zero webview changes); (2) `createTaskWithTreeFields`'s draft path applies `priority`/`milestone`/`labels`/`assignee` through the same `updateTask` call that already writes `type`/`dependencies`, and rejects `draft:true` + explicit `status`; (3) `promoteDrafts` re-ids each draft and rewrites every inbound `dependencies` reference (and bug `caused_by`) so a linked proposal set keeps its edges on promote. Both single (`promote_draft`) and bulk (`promote_drafts`) MCP promotes, and the canvas "Promote all proposed" button (now one `promoteDrafts` webview message), route through this core (parity + remap for free).

**Tech Stack:** TypeScript, Svelte 5 (runes), Vitest (pure cores + temp-dir `scaffold()` MCP handler tests + host-agnostic controller cases), Playwright (canvas draft-render + one-message promote-all), CDP-over-WebSocket (drafts-from-disk → promote-all → files land with rewired deps), esbuild (extension + MCP bundles) + Vite (webview bundles). MCP tools run as a **separate stdio process** reusing only `src/core`; `console.log` is routed to stderr (stdout is the JSON-RPC channel).

## Where this fits (the tech-tree overhaul)

- **Umbrella vision:** `docs/superpowers/specs/2026-07-01-tech-tree-overhaul-vision.md`.
- **Spec (approved):** `docs/superpowers/specs/2026-07-02-tech-tree-p4-create-task-skill-design.md`.
- **Directives (orchestrator-locked, binding):** `.superpowers/tech-tree-run/p4-architecture-directives.md` (Q1–Q12, GAP-1/2/3, Scope & sizing). Every directive is honored below; none are relitigated.
- **Base:** main `0b00e9f`. Worktree `.worktrees/tech-tree-p4`, branch `tech-tree-p4`.
- **Builds on landed reality:** P1 (model, `wouldCreateCycle`, config `categories`/`priorities`, `deriveTreeLayout`), P2 (canvas + draft-node styling), P3a (`createTaskWithTreeFields` shared create core + extended `create_task`), P3b (drag surface, geometry inverse). `create_task` is **already extended** with `category`/`type`/`causedBy`/`dependencies`/`draft` (`src/mcp/handlers.ts:562-589`) — the spec's "extended create_task" is landed; P4 only fixes its **draft path** (GAP-2).

## Locked names & wire conventions (from the directives — do not rename)

**New MCP tools (camelCase args/results, house style per `CreateTaskArgs`/`EditTaskArgs`):**

- Reads → `jsonContent`: `list_categories` (no args) · `list_milestones` (no args) · `get_board` `{category?, milestone?, status?}` · `search_tasks` `{query, limit?}`.
- Writes → `runTool`: `create_category` `{category}` · `promote_drafts` `{taskIds}`.
- Field names stay camelCase in tool I/O (`causedBy`, not `caused_by` — the latter is the frontmatter spelling only, written surgically by `TreeFieldService.setCausedBy`).

**New webview→ext message (Q1 wire rule):** **`promoteDrafts`** `{ type:'promoteDrafts'; taskIds: string[] }`. The envelope discriminant is `type`; this is not a create message so there is no `taskType`. The P3-blessed rule still binds any **future** create-shaped webview message: task-type travels as `taskType`, never `type`. P4 adds no create-shaped webview message.

**Reused unchanged:** `promoteDraft` (`{type:'promoteDraft'; taskId}`, `types.ts:290`) stays for the per-node promote; its controller case is **rerouted through the bulk core** (Task 3) so a single per-node promote also remaps edges. The extended `create_task` MCP tool and `createTaskWithTreeFields` core keep their signatures; only the draft branch changes (Task 2).

## Global Constraints

_Every task's requirements implicitly include this section._

- **Worktree:** work in `.worktrees/tech-tree-p4` on branch `tech-tree-p4`. Run all git/file/test commands inside the worktree. A fresh worktree has no `node_modules` (git-ignored) — run `bun install` there **once** before the first build/test. Never commit/merge from the repo root; stage only the files each task names; commit with `--no-verify` (the repo's lint-staged pre-commit hook flips the whole tree CRLF→LF on Windows — see the memory note "Pre-commit hook autocrlf corruption").
- **Runtime:** Node **≥ 22**; build/test via **Bun** (`bun run test`, `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test:playwright`, `bun run test:cdp`).
- **Baselines at branch base (`0b00e9f`):** capture them **before** starting — run `bun run test`, `bun run test:playwright`, `bun run test:cdp` once and record the pass counts (P3b closed at roughly unit ~1400 / Playwright ~350 / CDP 17; the P3b-polish commits since may nudge these — **record the actual numbers, do not hardcode these**). Windows shows ~22 known upstream POSIX-path unit failures — unrelated, do not "fix". Confirm no previously-green test regresses; each task states what it adds.
- **MCP primary-build live-caveat (directive Q12):** the `taskwright` MCP server in a worktree runs the **primary** checkout's `dist/mcp/server.js` (via `scripts/taskwright-mcp.cjs`). New tools you add here are **NOT live** in the worktree until this branch is merged and the primary rebuilt. Exercise them via **unit tests** (temp-dir `scaffold()` pattern) — never by calling the tool live from the worktree. A post-land smoke is the orchestrator's job, not a task gate.
- **Parity (mandatory):** every new write reuses P1's surgical writers — `create_category` mirrors `mergeStatusConfig.ts`; `promote_drafts`/`promote_draft` route through `writer.promoteDraft` + `writer.updateTask` + `TreeFieldService.setCausedBy`; the draft-create fix folds into the **same** `updateTask` call. Nothing the skill does is unavailable to a human via P3. No dependency write bypasses `wouldCreateCycle` (`src/core/treeGate.ts:56`).
- **TDD where a pure core or handler/controller message exists** (directive Q12): write the failing Vitest first, run **red**, implement, run **green** (falsification proof on every test). Pure cores (`searchTasks`, `categoriesConfig`, `promoteDrafts` topo/remap) get direct unit tests; read/write handlers get the temp-dir `scaffold()` pattern (`src/test/unit/mcpWriteHandlers.test.ts` house style — **avoid `vi.mock('fs')` for anything near queue/config paths**); the `loadTreeBoardFromParser` draft-union and `TasksController` tree-mode-union / `promoteDrafts`-message get their own cases. Svelte components + canvas messages are UI — cover with **Playwright**; cover cross-view promote with **CDP**. Document the house UI-only exception in the commit for pure-markup steps.
- **Every task's verify gate runs the FULL `e2e/tree-*` Playwright set** (`bun run test:playwright -- tree-` — matches `tree-authoring`/`tree-canvas`/`tree-drag`/`tree-navigator`/`tree-popover`) **plus** `bun run test`, `bun run lint`, `bun run typecheck` as appropriate (P3 lesson — no narrow spec nets). The **CDP suite** runs at least once mid-build (bound to **Task 3**) and once at the close (**Task 8**, which also authors the new CDP test on port **9344**).
- **Rendering discipline (webview):** Lucide **inline SVG** only (no emojis); every color/border via `--vscode-*` tokens. The only webview change in P4 is one line in `TechTreeCanvas.svelte` (`promoteAll`) — no new component, no CSP surface change.
- **Svelte 5 runes** for the one canvas edit; run the `svelte` MCP `svelte-autofixer` over it until clean before committing. **House precedent:** a `state_referenced_locally` warning on an init-once `$state` read in an `{#if}`-mounted component is a **FALSE POSITIVE** → suppress with `<!-- svelte-ignore state_referenced_locally -->`, do not restructure.
- **Root check-and-heal before/after every dispatch** (incl. the untracked `TaskCreatePanel` resurrection check): the shared root tree can accumulate autocrlf noise; heal per the memory notes before staging.
- **Commit trailer:** end each commit with `Co-Authored-By: <implementing model> <noreply@anthropic.com>` (opus tasks: `Claude Opus 4.8 (1M context)`; the haiku task: `Claude Haiku 4.5`; workers substitute their own model line per `AGENTS.md`). **The orchestrator lands this branch (ff-merge) — the close task (Task 8) ends at "worktree clean, all gates green, ledger updated", NOT `request_merge`.**

## Shape of the phase (the ~8 tasks)

Following the directives' Scope & sizing (`§Scope & sizing`, recommended ~8 tasks) **exactly** — no split/merge was warranted:

1. **GAP-1 — draft visibility** [opus]. `loadTreeBoardFromParser` unions `getDrafts()` into the derivation universe; `TasksController` unions drafts into the **tree-tab-only** `tasksUpdated` payload. Fold: delete the dead `requestCreateTask` webview path.
2. **GAP-2 — draft field completeness** [opus]. `createTaskWithTreeFields` applies `priority`/`milestone`/`labels`/`assignee` on the draft path via the same `updateTask` call; `draft:true` + `status` → error.
3. **GAP-3 — bulk promote with id-remap** [opus]. New `src/core/promoteDrafts.ts`; MCP `promote_drafts` + rerouted `promote_draft`; webview `promoteDrafts` message + rerouted controller `promoteDraft` case; canvas "Promote all proposed" posts ONE message. Playwright draft-render + one-message assertions. **Mid-build full-CDP checkpoint.**
4. **Read tools — `list_categories` + `list_milestones`** [opus]. Board-parity vocabulary + counts.
5. **Read tools — `get_board` + `search_tasks`** [opus]. Compact summaries + filters; pure `src/core/searchTasks.ts`.
6. **Write tool — `create_category`** [opus]. Surgical `config.yml` edit via `src/core/categoriesConfig.ts`; idempotent dupe, reserved-name rejection.
7. **Skill + tool-description polish + doc-sync** [haiku]. `.claude/skills/create-task/SKILL.md`; CLAUDE.md P4 bullet + onboarding-blurb fold.
8. **CDP + Playwright proof pass + close** [opus]. New CDP `src/test/cdp/tree-promote.test.ts` (port 9344); full gate; visual proof; handback.

**Recommended execution order (leaves-first, green at every commit):** `1 → 2 → 3 → 4 → 5 → 6 → 7 → 8`.

- **1** makes drafts visible — the substrate every other P4 deliverable renders/reads over. **2** makes draft-create carry fields (the skill's proposal payload). **3** makes promote non-destructive (the review loop's exit). **4/5/6** add the read/write tools the skill leans on (each additive to `handlers.ts`/`server.ts`, green in isolation). **7** writes the skill (needs the tools registered) + doc-sync. **8** proves the whole loop cross-view + visual proof.

> **Anchor caveat (read before transcribing):** every edit hunk quotes the exact existing lines to match — **match the quoted text, not the cited line number**. `handlers.ts`/`server.ts` grow across Tasks 3–6, so absolute line numbers cited for them drift under earlier insertions; the quoted before/after snippets are unique and authoritative. All line numbers here are verified against the working tree at `0b00e9f`.

---

## File Structure

**Create:**

- `src/core/promoteDrafts.ts` — vscode-free bulk-promote core: `promoteDrafts(deps, taskIds)` (validate → topo-order → per-draft `writer.promoteDraft` → remap inbound `dependencies`/`caused_by`); `PromoteDraftsError` carrying the partial mapping.
- `src/core/searchTasks.ts` — pure keyword ranker: `searchTasks(tasks, query, {limit})`.
- `src/core/categoriesConfig.ts` — surgical `config.yml` `categories:` single-line editor (mirrors `mergeStatusConfig.ts`): `parseCategoriesLine`, `isReservedCategory`, `addCategoryLine`.
- `src/test/unit/promoteDrafts.test.ts` — topo-order + remap + partial-failure unit tests (temp-dir scaffold).
- `src/test/unit/searchTasks.test.ts` — ranking / all-tokens / tie-break / empty-query unit tests (pure).
- `src/test/unit/categoriesConfig.test.ts` — line parse/insert/EOL/reserved/dupe unit tests (pure).
- `src/test/unit/mcpReadHandlers.test.ts` — `list_categories`/`list_milestones`/`get_board`/`search_tasks` handler tests (temp-dir `scaffold()`).
- `.claude/skills/create-task/SKILL.md` — the `/create-task` skill.
- `src/test/cdp/tree-promote.test.ts` — CDP cross-view: drafts on disk → promote-all → files land in `tasks/` with rewired deps (port **9344**).

**Modify:**

- `src/core/treeDerived.ts` — `loadTreeBoardFromParser` unions `parser.getDrafts()` into the derivation universe (GAP-1a).
- `src/providers/TasksController.ts` — tree-tab-only draft union into the `tasksUpdated` payload (GAP-1b); `promoteDrafts` inbound case + reroute the `promoteDraft` case through the bulk core (GAP-3); delete the dead `requestCreateTask` case.
- `src/core/createTaskCore.ts` — draft path applies `priority`/`milestone`/`labels`/`assignee` via the same `updateTask`; `draft:true` + explicit `status` → error (GAP-2).
- `src/core/types.ts` — add `promoteDrafts` to `WebviewMessage`; delete the dead `requestCreateTask` variant.
- `src/mcp/handlers.ts` — new handlers `listCategoriesHandler`, `listMilestonesHandler`, `getBoardHandler`, `searchTasksHandler`, `createCategoryHandler`, `promoteDraftsHandler`; reroute `promoteDraftHandler` through `promoteDrafts`; shared `toBoardSummary` helper + `resolveConfigPath` helper; new imports (`loadTreeBoardFromParser`, `laneOf`/`MISC_LANE`/`BUGS_LANE`/`BACKBURNER_BAND`, `searchTasks`, `addCategoryLine`/`isReservedCategory`, `detectCRLF`/`normalizeToLF`/`restoreLineEndings`, `fs`).
- `src/mcp/server.ts` — register the six new tools (imports + `registerTool` blocks with skill-quality descriptions).
- `src/webview/components/tree/TechTreeCanvas.svelte` — `promoteAll()` posts ONE `promoteDrafts` message (replaces the N-message loop).
- `CLAUDE.md` — doc-sync (Task 7): P4 bullet after the P3b bullet + the onboarding-blurb fold.
- Existing tests: `e2e/tree-canvas.spec.ts` (11b — promote-all now posts ONE `promoteDrafts` message; new draft-render assertion), `src/test/unit/treeDerived.test.ts` (draft-union case), `src/test/unit/TasksController.test.ts` (tree-mode union + `promoteDrafts` case), `src/test/unit/mcpWriteHandlers.test.ts` (`create_category` + `promote_drafts` + the draft-fields create case; confirm `promoteDraftHandler` reroute stays green).

**Delete (Task 1 fold):**

- The `requestCreateTask` `WebviewMessage` variant (`src/core/types.ts:304`) and its controller case (`src/providers/TasksController.ts:1010-1013`) — **dead**: verified the only two references in `src/` are those two lines (grep at `0b00e9f`); no webview posts it anymore (P3a repointed bare `n` / TabBar `+` / command to `openCreateForm`).

---

## Task 1: GAP-1 — draft visibility (derivation universe + tree-tab payload) + retire dead `requestCreateTask` [opus]

**Files:**

- Modify: `src/core/treeDerived.ts`, `src/providers/TasksController.ts`, `src/core/types.ts`
- Test: `src/test/unit/treeDerived.test.ts`, `src/test/unit/TasksController.test.ts`

**Why (GAP-1, directive Q2):** `create_task {draft:true}` (the skill's proposal route) writes `DRAFT-N` files, but nothing renders them: tree-mode `taskLoader` is `getTasks()` (tasks/ only, `TasksController.ts:235-244`) and `loadTreeBoardFromParser` unions tasks+completed+archived — never `getDrafts()` (`treeDerived.ts:93-101`). The proposed-styling in `TreeNode.svelte:38` is `task.status === 'Draft' || task.folder === 'drafts'` — the `folder` arm is unexercised today (P2's fixtures trigger it via `status:'Draft'` tasks); real drafts from `getDrafts()` carry BOTH (`BacklogParser.ts:242,:284`), so this task lights the data path up with **zero webview changes** (do NOT "fix" the styling condition — it is correct as-is): (a) drafts enter the derivation universe so they gate like any unmet dependency (a dep on a draft is unsatisfied ⇒ dependents locked; draft nodes get lanes/bands from their own category/milestone); (b) `TasksController` unions `getDrafts()` into the `tasksUpdated` payload **for the tree tab only** (kanban/list/drafts/archived unchanged; cross-branch unchanged — tree derivation is already skipped there). Also folds the dead `requestCreateTask` path (accepted-debt).

**Ripple to acknowledge (GAP-1a):** `loadTreeBoardFromParser` is shared by the MCP handlers (`loadTreeStateFromParser` → claim gate / `get_active_task` / `toSummary`) and the controller. NOTE the union does **not** flip any task's lock state: a dependency on a draft is ALREADY blocking pre-change, because `computeBlockedBy` treats a missing dep as unsatisfied (`dependencySatisfied(undefined, …) === false`, `treeGate.ts:21,:37`). The real (intended, safe) ripples are: (1) draft nodes now appear in `states` with a `layout`; (2) draft categories/milestones now contribute discovered lanes/bands to `laneOrder`/`bandOrder`. Existing MCP/unit fixtures create no task-depends-on-draft graph, so no green test flips; confirm by running the mcp suites in the gate.

- [ ] **Step 1: Write the failing tests**

**1a — `treeDerived.test.ts` (draft-union of `loadTreeBoardFromParser`).** Append a new `describe`. `loadTreeBoardFromParser` reads via a `BacklogParser`; stub a minimal parser object exposing only the getters it calls (`getTasks`/`getCompletedTasks`/`getArchivedTasks`/`getConfig`/`getMilestones`/`getCategories` + the new `getDrafts`). Assert a draft appears in `board.states` and that a task depending on that draft is `locked`:

```ts
import { loadTreeBoardFromParser } from '../../core/treeDerived';

describe('loadTreeBoardFromParser — draft union (GAP-1a)', () => {
  function stubParser(over: { tasks?: Task[]; drafts?: Task[] }) {
    return {
      getTasks: async () => over.tasks ?? [],
      getDrafts: async () => over.drafts ?? [],
      getCompletedTasks: async () => [],
      getArchivedTasks: async () => [],
      getConfig: async () => ({ statuses: ['To Do', 'In Progress', 'Done'] }),
      getMilestones: async () => [],
      getCategories: async () => [],
    } as unknown as import('../../core/BacklogParser').BacklogParser;
  }

  it('includes drafts in the derivation universe (draft node gets a state/layout)', async () => {
    const parser = stubParser({
      tasks: [task({ id: 'TASK-1', dependencies: ['DRAFT-1'] })],
      drafts: [task({ id: 'DRAFT-1', status: 'Draft', folder: 'drafts' })],
    });
    const board = await loadTreeBoardFromParser(parser);
    expect(board.states.has('DRAFT-1')).toBe(true);
    expect(board.states.get('DRAFT-1')!.layout.lane).toBeDefined();
  });

  // Stable-regression companion, NOT the red gate: a dep on a missing id is ALREADY
  // blocking pre-change (treeGate.ts:21,:37), so this passes before AND after the union.
  // It pins the post-union semantics (draft-as-dep stays blocking). The red gate is the
  // test above (DRAFT-1 present in states).
  it('a task depending on an unpromoted draft is locked (draft is unsatisfied)', async () => {
    const parser = stubParser({
      tasks: [task({ id: 'TASK-1', dependencies: ['DRAFT-1'] })],
      drafts: [task({ id: 'DRAFT-1', status: 'Draft', folder: 'drafts' })],
    });
    const board = await loadTreeBoardFromParser(parser);
    expect(board.states.get('TASK-1')!.locked).toBe(true);
    expect(board.states.get('TASK-1')!.blockedBy).toEqual(['DRAFT-1']);
  });
});
```

> Reuse the file's existing `task()` factory (`treeDerived.test.ts:5-18`) — it defaults `folder`/`status`/etc. The stub returns `Draft` status + `folder:'drafts'` so `dependencySatisfied` (`treeGate.ts:17-24`) counts the draft as blocking.

**1b — `TasksController.test.ts` (tree-mode-only union).** Add two cases proving the `tasksUpdated` payload includes drafts **only** in tree mode. Use the file's existing `host`/`mockParser`/`mockContext`/`posted` fixtures; stub `mockParser.getDrafts` to resolve a draft:

```ts
describe('TasksController — GAP-1b tree-mode draft union', () => {
  it('tree tab unions drafts into the tasksUpdated payload', async () => {
    (mockParser.getDrafts as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'DRAFT-1',
        title: 'Proposed',
        status: 'Draft',
        folder: 'drafts',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/b/drafts/draft-1.md',
      },
    ]);
    const controller = new TasksController(host, mockParser, mockContext);
    controller.setViewMode('tree'); // or the file's existing helper to select the tree tab
    await controller.refresh();
    const tasksMsg = posted.find((m) => m.type === 'tasksUpdated');
    expect((tasksMsg!.tasks as Task[]).some((t) => t.id === 'DRAFT-1')).toBe(true);
  });

  it('kanban tab does NOT union drafts into the payload', async () => {
    (mockParser.getDrafts as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'DRAFT-1',
        title: 'Proposed',
        status: 'Draft',
        folder: 'drafts',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/b/drafts/draft-1.md',
      },
    ]);
    const controller = new TasksController(host, mockParser, mockContext);
    controller.setViewMode('kanban');
    await controller.refresh();
    const tasksMsg = posted.find((m) => m.type === 'tasksUpdated');
    expect((tasksMsg!.tasks as Task[]).some((t) => t.id === 'DRAFT-1')).toBe(false);
  });
});
```

> **Harness note:** match the file's existing view-mode-selection and refresh idioms (grep `viewMode` / `setViewMode` / how other `describe`s drive a refresh — the P2/P3 tree tests already exercise `viewMode==='tree'`). Ensure `mockParser` stubs `getDrafts`, `getCategories`, `getMilestones`, `getConfig`, `getTasks`, `getCompletedTasks`, `getArchivedTasks`, `getStatuses`, `getBacklogPath` to resolve so `refresh()` completes. **Do not assert cross-branch behavior here** — these tests use the default (non-cross-branch) `dataSourceMode`. **Precondition:** the mock `getConfig()` must NOT set `check_active_branches` — `refresh()` flips `dataSourceMode = 'cross-branch'` when it is truthy (`TasksController.ts:231-233`), which silently disables the union and fails the tree-mode test for the wrong reason (the default `'local-only'` at `TasksController.ts:83` is what these tests rely on).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- treeDerived TasksController`
Expected: FAIL — the red gates are test 1a's first case (`board.states.has('DRAFT-1')` — drafts absent from the universe pre-change) and 1b's tree-tab case (payload has no `DRAFT-1`). The "dependent locked" companion in 1a passes pre-change too (missing dep already blocks; it is a pinned-semantics regression test, not a red gate) — do not be surprised by it.

- [ ] **Step 3: Union drafts into `loadTreeBoardFromParser` (GAP-1a)**

In `src/core/treeDerived.ts`, replace the universe-gather in `loadTreeBoardFromParser` (`treeDerived.ts:92-107`). Add `parser.getDrafts()` to the `Promise.all` and spread it into the `deriveTreeBoard` universe:

```ts
export async function loadTreeBoardFromParser(parser: BacklogParser): Promise<TreeBoard> {
  const [tasks, drafts, completed, archived, config, milestones, categories] = await Promise.all([
    parser.getTasks(),
    parser.getDrafts(),
    parser.getCompletedTasks(),
    parser.getArchivedTasks(),
    parser.getConfig(),
    parser.getMilestones(),
    parser.getCategories(),
  ]);
  return deriveTreeBoard([...tasks, ...drafts, ...completed, ...archived], {
    doneStatus: resolveDoneStatus(config.statuses),
    milestoneOrder: milestones.map((m) => m.name),
    priorities: resolvePriorities(config),
    categories,
  });
}
```

> `getDrafts()` (`BacklogParser.ts:282`) forces `status:'Draft'` and sets `folder:'drafts'` on each — so `dependencySatisfied` treats them as blocking and `laneOf` slots them by their own `category`. No change to `deriveTreeBoard` itself.

- [ ] **Step 4: Union drafts into the tree-tab payload (GAP-1b)**

In `src/providers/TasksController.ts`, immediately after the `Promise.all` destructure that produces `tasks` (`TasksController.ts:246-256`) and **before** `computeSubtasks(tasks)` (`:259`), append drafts to `tasks` for the tree tab only:

```ts
// GAP-1(b): the tree canvas must show draft proposals as nodes (they gate deps
// and carry their own lane/band). Union drafts into the payload for the TREE tab
// ONLY — kanban/list/drafts/archived tabs are unchanged, and cross-branch mode
// skips tree derivation (treeBoard stays undefined) so there is nothing to render.
if (this.viewMode === 'tree' && this.dataSourceMode !== 'cross-branch') {
  const treeDrafts = await this.parser.getDrafts();
  tasks.push(...treeDrafts);
}
```

> `tasks` is a `const` array binding — `.push` mutates in place (allowed). The parser mtime-caches folder reads, so this second `getDrafts()` (the first feeds `draftCountFromFolder` at `:251-253`) is cheap. Downstream is automatic: `computeSubtasks(tasks)` (`:259`), the reverse-dep/`taskById` maps (`:281-293`), and the `tasksWithBlocks` enrichment map (`:325-381`) all iterate `tasks`, and the enrichment reads `treeBoard?.states.get(...)` (`:355`) — which now (Step 3) carries draft states/layout. The draft badge count is unaffected: `draftCount` uses `draftCountFromFolder` in tree mode (`:418`, `viewMode !== 'drafts'`). Draft nodes arrive with `folder:'drafts'` set, so `TreeNode.svelte:38` `isDraft` styling engages with no webview change. Popover claim/dispatch on a draft: `DetailPopover`'s existing `isDraft` branch already restricts drafts to Promote/edit (directive Q2 — verify the branch during the Task 8 visual proof; no code change expected here).

- [ ] **Step 5: Retire the dead `requestCreateTask` path (accepted-debt fold)**

First **confirm it is dead:** `rg "requestCreateTask" src` must show exactly two hits — `src/core/types.ts:304` and `src/providers/TasksController.ts:1010`. (If any webview file posts it, STOP and leave it — but at `0b00e9f` it is dead.)

Delete the `WebviewMessage` variant in `src/core/types.ts` (`:304`):

```ts
  | { type: 'requestCreateTask' }
```

Delete the controller case in `src/providers/TasksController.ts` (`:1010-1013`):

```ts
      case 'requestCreateTask': {
        vscode.commands.executeCommand('taskwright.createTask');
        break;
      }
```

> Removing the union member makes the deleted `case` a compile error if left — delete both together. `taskwright.createTask` remains registered (command palette / keybinding path); only the round-trip webview message is retired.

- [ ] **Step 6: Run tests + typecheck + mcp regression**

Run: `bun run test -- treeDerived TasksController` → PASS (new cases green). Then `bun run test -- mcp` → PASS (the GAP-1a ripple does not flip any mcp handler test — confirm; if a fixture genuinely asserts a now-locked task is claimable, that is a real behavior change, update it minimally with the directive Q2a justification in the commit). Then `bun run typecheck` → PASS.

- [ ] **Step 7: Full task gate**

Run: `bun run test && bun run lint && bun run typecheck && bun run test:playwright -- tree-` → PASS. (No webview change here, so the tree Playwright set is a regression check only.)

- [ ] **Step 8: Commit**

```bash
git add src/core/treeDerived.ts src/providers/TasksController.ts src/core/types.ts \
  src/test/unit/treeDerived.test.ts src/test/unit/TasksController.test.ts
git commit --no-verify -m "feat(tree P4): draft visibility — union drafts into board derivation + tree payload (GAP-1)

- loadTreeBoardFromParser unions parser.getDrafts() into the derivation universe:
  draft nodes get lanes/bands, and a dep on an unpromoted draft is unsatisfied (locked)
- TasksController unions drafts into the tasksUpdated payload for the TREE tab only
  (kanban/list/drafts/archived + cross-branch unchanged); TreeNode's folder==='drafts'
  proposed styling lights up with zero webview changes
- retire the dead requestCreateTask webview path (WebviewMessage variant + controller
  case; P3a repointed all posters)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: GAP-2 — draft-create field completeness + status guard [opus]

**Files:**

- Modify: `src/core/createTaskCore.ts`
- Test: `src/test/unit/createTaskCore.test.ts`, `src/test/unit/mcpWriteHandlers.test.ts`

**Why (GAP-2, directive Q3):** `createTaskWithTreeFields` passes only `title`/`description` to `createDraft` (`createTaskCore.ts:87-91`); `priority`/`milestone`/`labels`/`assignee` are silently dropped on the draft path (`category`/`type`/`causedBy`/`dependencies` ARE applied post-create). The spec (§3 step 4) requires drafts carry `category`/`priority`/`milestone`/`dependencies` so the skill's proposal is complete before review. Fix: after `createDraft`, apply the missing canonical fields through the **same** `writer.updateTask(id, …)` call that already writes `type`/`dependencies` (one write, not two). And `draft:true` + explicit `status` → error (`'drafts always have status Draft'`) so both the human form (never sends it) and the MCP agree.

- [ ] **Step 1: Write the failing tests**

Append to `src/test/unit/createTaskCore.test.ts` (the file's `makeDeps()` fake already stubs `createDraft`/`createTask`/`updateTask`/parser getters — reuse it):

```ts
describe('createTaskWithTreeFields — draft field completeness (GAP-2)', () => {
  it('draft create folds priority/milestone/labels/assignee into the same updateTask', async () => {
    const m = makeDeps();
    await createTaskWithTreeFields(m.deps, {
      title: 'Spike caching',
      draft: true,
      priority: 'high',
      milestone: 'v1',
      labels: ['spike'],
      assignee: ['@alice'],
    });
    expect(m.createDraft).toHaveBeenCalledWith('/b', m.deps.parser, {
      title: 'Spike caching',
      description: undefined,
    });
    expect(m.createTask).not.toHaveBeenCalled();
    // ONE updateTask carrying the draft-only canonical fields:
    expect(m.updateTask).toHaveBeenCalledWith(
      'DRAFT-1',
      expect.objectContaining({
        priority: 'high',
        milestone: 'v1',
        labels: ['spike'],
        assignee: ['@alice'],
      }),
      m.deps.parser
    );
  });

  it('draft create still applies type/dependencies through the SAME updateTask (one write)', async () => {
    const m = makeDeps();
    await createTaskWithTreeFields(m.deps, {
      title: 'Bug spike',
      draft: true,
      type: 'bug',
      causedBy: 'TASK-1',
      dependencies: ['TASK-2'],
      priority: 'medium',
    });
    // exactly one updateTask, carrying type + dependencies + priority together:
    expect(m.updateTask).toHaveBeenCalledTimes(1);
    expect(m.updateTask).toHaveBeenCalledWith(
      'DRAFT-1',
      expect.objectContaining({ type: 'bug', dependencies: ['TASK-2'], priority: 'medium' }),
      m.deps.parser
    );
    expect(m.setCausedBy).toHaveBeenCalledWith('DRAFT-1', 'TASK-1', m.deps.parser);
  });

  it('draft create with an explicit status throws (drafts are always Draft)', async () => {
    const m = makeDeps();
    await expect(
      createTaskWithTreeFields(m.deps, { title: 'x', draft: true, status: 'To Do' })
    ).rejects.toThrow('drafts always have status Draft');
    expect(m.createDraft).not.toHaveBeenCalled();
  });

  it('non-draft create is unchanged: fields go to createTask, not a second updateTask', async () => {
    const m = makeDeps();
    await createTaskWithTreeFields(m.deps, {
      title: 'y',
      priority: 'high',
      milestone: 'v1',
      labels: ['f'],
    });
    expect(m.createTask).toHaveBeenCalledWith(
      '/b',
      expect.objectContaining({ priority: 'high', milestone: 'v1', labels: ['f'] }),
      m.deps.parser
    );
    expect(m.updateTask).not.toHaveBeenCalled(); // no type/deps → no canonical updateTask
  });
});
```

Also add one temp-dir integration case to `src/test/unit/mcpWriteHandlers.test.ts` (the `createTaskHandler` describe) proving a **real** draft file carries the fields on disk:

```ts
it('draft create writes priority + milestone into the DRAFT file (GAP-2)', async () => {
  const d = deps();
  // seed a milestone-less config; priority is validated against config priorities
  const summary = await createTaskHandler(d, {
    title: 'Proposed feature',
    draft: true,
    priority: 'high',
    milestone: 'v1',
    category: 'Features',
  });
  expect(summary.id).toBe('DRAFT-1');
  const file = fs.readFileSync(
    path.join(backlogPath, 'drafts', 'draft-1 - Proposed-feature.md'),
    'utf-8'
  );
  expect(file).toMatch(/^priority:\s*high/m);
  expect(file).toMatch(/^milestone:\s*v1/m);
  expect(file).toMatch(/^category:\s*Features/m);
  expect(file).toMatch(/^status:\s*Draft/m); // never rewritten to a board status
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- createTaskCore mcpWriteHandlers`
Expected: FAIL — draft `updateTask` is never called with `priority`/`milestone`/`labels`/`assignee`; no status guard; the draft file lacks `priority:`/`milestone:`.

- [ ] **Step 3: Implement the draft-field fix**

In `src/core/createTaskWithTreeFields` (`createTaskCore.ts:73-129`), add the status guard near the top validation (after the `causedBy`-requires-bug check at `:81-83`) and fold the draft-only canonical fields into the existing `canonical` block.

Add the guard right after the `dependencies` line (`:84`):

```ts
const dependencies = args.dependencies ?? [];
if (args.draft && args.status !== undefined) {
  throw new Error('drafts always have status Draft; do not set status on a draft.');
}
```

Then replace the canonical block (`createTaskCore.ts:108-114`):

```ts
// type / dependencies go through BacklogWriter (both serialized there).
const canonical: Partial<Task> = {};
if (type !== undefined) canonical.type = type;
if (dependencies.length > 0) canonical.dependencies = dependencies;
if (Object.keys(canonical).length > 0) {
  await deps.writer.updateTask(id, canonical, deps.parser);
}
```

with (drafts fold their canonical fields into the SAME updateTask; non-draft path unchanged — those fields already went to `createTask`):

```ts
// type / dependencies go through BacklogWriter (both serialized there). On the DRAFT
// path, createDraft accepts only title/description, so priority/milestone/labels/
// assignee are folded into the SAME updateTask (GAP-2 — one write, not two).
const canonical: Partial<Task> = {};
if (type !== undefined) canonical.type = type;
if (dependencies.length > 0) canonical.dependencies = dependencies;
if (args.draft) {
  if (args.priority !== undefined) canonical.priority = args.priority;
  if (args.milestone !== undefined) canonical.milestone = args.milestone;
  if (args.labels !== undefined) canonical.labels = args.labels;
  if (args.assignee !== undefined) canonical.assignee = args.assignee;
}
if (Object.keys(canonical).length > 0) {
  await deps.writer.updateTask(id, canonical, deps.parser);
}
```

> `BacklogWriter.updateTask` (`BacklogWriter.ts:554`) serializes `priority`/`milestone`/`labels`/`assignee`/`dependencies`/`type` from a `Partial<Task>` (`:581-609`) — no writer change needed. `category`/`causedBy` remain surgical post-create for both paths (`createTaskCore.ts:116-122`), so they already reach drafts (the pre-existing behavior GAP-2 does not touch). The non-draft path is untouched: those fields still flow through `createTask` (`:93-105`) and the `if (args.draft)` block never runs, so the existing `createTaskCore.test.ts` non-draft cases stay green.

- [ ] **Step 4: Run tests + typecheck**

Run: `bun run test -- createTaskCore mcpWriteHandlers` → PASS (new + existing). Then `bun run typecheck` → PASS.

- [ ] **Step 5: Full task gate**

Run: `bun run test && bun run lint && bun run typecheck && bun run test:playwright -- tree-` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/createTaskCore.ts src/test/unit/createTaskCore.test.ts src/test/unit/mcpWriteHandlers.test.ts
git commit --no-verify -m "feat(tree P4): draft-create carries all fields + status guard (GAP-2)

- createTaskWithTreeFields draft path folds priority/milestone/labels/assignee into the
  same updateTask that already writes type/dependencies (one write); category/caused_by
  stay surgical post-create (unchanged)
- draft:true + explicit status now errors ('drafts always have status Draft'), so the
  human form (never sends it) and the MCP agree
- non-draft path unchanged (fields still flow through createTask)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: GAP-3 — bulk promote with id-remap (`promoteDrafts` core + MCP + webview) [opus]

**Files:**

- Create: `src/core/promoteDrafts.ts`, `src/test/unit/promoteDrafts.test.ts`
- Modify: `src/mcp/handlers.ts`, `src/mcp/server.ts`, `src/core/types.ts`, `src/providers/TasksController.ts`, `src/webview/components/tree/TechTreeCanvas.svelte`
- Test: `src/test/unit/mcpWriteHandlers.test.ts`, `src/test/unit/TasksController.test.ts`, `e2e/tree-canvas.spec.ts`

**Why (GAP-3, directive Q4):** `promoteDraft` (`BacklogWriter.ts:357`) re-ids `DRAFT-N → TASK-N` and rewrites only the moved file's frontmatter — nothing rewrites **inbound** references, so any task/draft whose `dependencies` (or bug `caused_by`) points at the old `DRAFT` id is left dangling. The canvas "Promote all proposed" fires N independent `promoteDraft` messages (`TechTreeCanvas.svelte:145-149`), so a linked proposal set (the skill's core output) shatters its edges on promote. Fix: a vscode-free core `promoteDrafts(deps, taskIds)` that validates, topo-orders (deps first), promotes each, and remaps every inbound `dependencies`/`caused_by` across the board. Consumers (parity): MCP `promote_drafts` (bulk) AND the single MCP `promote_draft` (routes through the core with one id — gains remap for free, contract unchanged) AND a new `promoteDrafts` webview message the canvas button posts **once** (replacing its N-message loop) AND the per-node `promoteDraft` webview case (rerouted through the core too, so a single on-canvas promote also remaps).

- [ ] **Step 1: Write the failing tests**

**3a — `promoteDrafts.test.ts` (topo/remap/partial-failure).** Temp-dir scaffold (mirror `mcpWriteHandlers.test.ts:28-52` — a real `BacklogParser`/`BacklogWriter`/`TreeFieldService` over `fs.mkdtempSync`). Write real draft + task files, promote, assert files land + inbound refs rewired:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';
import { TreeFieldService } from '../../core/TreeFieldService';
import { promoteDrafts, PromoteDraftsError } from '../../core/promoteDrafts';

let root: string, backlogPath: string;
function scaffold(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-promote-'));
  backlogPath = path.join(root, 'backlog');
  fs.mkdirSync(path.join(backlogPath, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(backlogPath, 'drafts'), { recursive: true });
  fs.writeFileSync(
    path.join(backlogPath, 'config.yml'),
    'project_name: "t"\nstatuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: "task"\n',
    'utf-8'
  );
}
function deps() {
  return {
    parser: new BacklogParser(backlogPath),
    writer: new BacklogWriter(),
    treeFieldService: new TreeFieldService(),
  };
}
function writeDraft(id: string, title: string, deps_: string[] = []): void {
  const depBlock = deps_.length
    ? `dependencies:\n${deps_.map((d) => `  - ${d}`).join('\n')}\n`
    : 'dependencies: []\n';
  fs.writeFileSync(
    path.join(backlogPath, 'drafts', `${id.toLowerCase()} - ${title}.md`),
    `---\nid: ${id}\ntitle: ${title}\nstatus: Draft\nassignee: []\n${depBlock}---\n\n## Description\n<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->\n`,
    'utf-8'
  );
}
function writeTask(id: string, title: string, deps_: string[] = [], extra = ''): void {
  const depBlock = deps_.length
    ? `dependencies:\n${deps_.map((d) => `  - ${d}`).join('\n')}\n`
    : 'dependencies: []\n';
  fs.writeFileSync(
    path.join(backlogPath, 'tasks', `${id.toLowerCase()} - ${title}.md`),
    `---\nid: ${id}\ntitle: ${title}\nstatus: To Do\nassignee: []\n${depBlock}${extra}---\n\n## Description\n<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->\n`,
    'utf-8'
  );
}
function read(id: string): string {
  for (const dir of ['tasks', 'drafts']) {
    const p = path.join(backlogPath, dir);
    for (const f of fs.existsSync(p) ? fs.readdirSync(p) : []) {
      const c = fs.readFileSync(path.join(p, f), 'utf-8');
      if (new RegExp(`^id:\\s*${id}\\b`, 'm').test(c)) return c;
    }
  }
  throw new Error(`no file for ${id}`);
}
beforeEach(scaffold);
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('promoteDrafts', () => {
  it('promotes a single draft and returns its {from,to} mapping', async () => {
    writeDraft('DRAFT-1', 'Solo');
    const res = await promoteDrafts(deps(), ['DRAFT-1']);
    expect(res.promoted).toEqual([{ from: 'DRAFT-1', to: 'TASK-1' }]);
    expect(read('TASK-1')).toMatch(/^status:\s*To Do/m);
    expect(fs.existsSync(path.join(backlogPath, 'drafts', 'draft-1 - Solo.md'))).toBe(false);
  });

  it('rewrites an inbound task dependency that pointed at the promoted draft', async () => {
    writeDraft('DRAFT-1', 'Dep');
    writeTask('TASK-9', 'Dependent', ['DRAFT-1']);
    const res = await promoteDrafts(deps(), ['DRAFT-1']);
    const to = res.promoted[0].to; // TASK-10 (getNextTaskId is fs-based; tasks/ already holds task-9)
    expect(read('TASK-9')).toMatch(new RegExp(`- ${to}\\b`));
    expect(read('TASK-9')).not.toMatch(/DRAFT-1/);
    expect(res.remapped).toContain('TASK-9');
  });

  it('bulk promote of a linked pair rewires the intra-set edge (topo: dep first)', async () => {
    writeDraft('DRAFT-1', 'Base');
    writeDraft('DRAFT-2', 'Uses-base', ['DRAFT-1']); // DRAFT-2 depends on DRAFT-1
    const res = await promoteDrafts(deps(), ['DRAFT-2', 'DRAFT-1']); // request out of order
    const map = new Map(res.promoted.map((p) => [p.from, p.to]));
    // DRAFT-1 promoted first (dep-first topo) → lower id:
    expect(map.get('DRAFT-1')).toBe('TASK-1');
    expect(map.get('DRAFT-2')).toBe('TASK-2');
    // the promoted TASK-2 file now depends on TASK-1, not DRAFT-1:
    expect(read('TASK-2')).toMatch(/- TASK-1\b/);
    expect(read('TASK-2')).not.toMatch(/DRAFT-1/);
  });

  it('re-points a bug caused_by that referenced a promoted draft', async () => {
    writeDraft('DRAFT-1', 'Cause');
    writeTask('TASK-9', 'Regression', [], 'type: bug\ncaused_by: DRAFT-1\n');
    const res = await promoteDrafts(deps(), ['DRAFT-1']);
    const to = res.promoted[0].to;
    expect(read('TASK-9')).toMatch(new RegExp(`^caused_by:\\s*${to}\\b`, 'm'));
    expect(res.remapped).toContain('TASK-9');
  });

  it('rejects a non-draft id before writing anything', async () => {
    writeTask('TASK-9', 'Real');
    await expect(promoteDrafts(deps(), ['TASK-9'])).rejects.toThrow(/not a draft/);
  });

  it('on mid-set failure throws PromoteDraftsError carrying the partial mapping', async () => {
    writeDraft('DRAFT-1', 'Ok');
    // Simulate a mid-set failure by stubbing writer.promoteDraft to throw on the 2nd call
    // (the 1st call runs the real implementation).
    writeDraft('DRAFT-2', 'Boom');
    const d = deps();
    const spy = vi.spyOn(d.writer, 'promoteDraft');
    spy
      .mockImplementationOnce(async (id, parser) =>
        BacklogWriter.prototype.promoteDraft.call(d.writer, id, parser)
      )
      .mockImplementationOnce(async () => {
        throw new Error('disk full');
      });
    // ONE call only: capture the error and assert it carries the partial mapping.
    // (Do NOT call promoteDrafts a second time — DRAFT-1 is already promoted, so a
    // second call fails up-front validation with a plain Error, proving nothing.)
    const e = await promoteDrafts(d, ['DRAFT-1', 'DRAFT-2']).catch((x) => x);
    expect(e).toBeInstanceOf(PromoteDraftsError);
    expect(e.promoted).toEqual([{ from: 'DRAFT-1', to: 'TASK-1' }]);
  });
});
```

> The partial-failure test uses `vi.spyOn(instance.writer, 'promoteDraft')` — add `import { vi } from 'vitest';`. Keep it simple: the essential assertion is that a `PromoteDraftsError` is thrown after the first promote succeeded (its `.promoted` holds `[{from:'DRAFT-1',to:'TASK-1'}]`). Adjust the spy plumbing to the file's conventions if cleaner.

**3b — `TasksController.test.ts` (`promoteDrafts` message case).** Add a case proving the controller routes the message through the core:

```ts
describe('TasksController — promoteDrafts message (GAP-3)', () => {
  it('promoteDrafts routes taskIds through the bulk core then refreshes', async () => {
    const spy = vi.spyOn(BacklogWriter.prototype, 'promoteDraft').mockResolvedValue('TASK-9');
    // parser.getDrafts must return the requested ids as drafts for validation to pass:
    (mockParser.getDrafts as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'DRAFT-1',
        title: 'a',
        status: 'Draft',
        folder: 'drafts',
        labels: [],
        assignee: [],
        dependencies: [],
        acceptanceCriteria: [],
        definitionOfDone: [],
        filePath: '/b/drafts/draft-1.md',
      },
    ]);
    (mockParser.getTasks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const controller = new TasksController(host, mockParser, mockContext);
    await controller.handleMessage({ type: 'promoteDrafts', taskIds: ['DRAFT-1'] });
    expect(spy).toHaveBeenCalledWith('DRAFT-1', mockParser);
    expect(posted.some((m) => m.type === 'tasksUpdated')).toBe(true); // refresh re-emitted
  });
});
```

**3c — `mcpWriteHandlers.test.ts` (`promote_drafts` handler + `promote_draft` reroute).** Add temp-dir cases:

```ts
describe('promoteDraftsHandler', () => {
  it('bulk-promotes and rewires an inbound dependency', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'Base', draft: true }); // DRAFT-1
    await createTaskHandler(d, { title: 'Uses', draft: true, dependencies: ['DRAFT-1'] }); // DRAFT-2 → dep DRAFT-1
    const res = await promoteDraftsHandler(d, { taskIds: ['DRAFT-1', 'DRAFT-2'] });
    expect(res.promoted).toHaveLength(2);
    const uses = fs.readFileSync(
      path.join(
        backlogPath,
        'tasks',
        fs.readdirSync(path.join(backlogPath, 'tasks')).find((f) => f.includes('Uses'))!
      ),
      'utf-8'
    );
    expect(uses).toMatch(/- TASK-1\b/);
    expect(uses).not.toMatch(/DRAFT/);
  });
});

describe('promoteDraftHandler (single, rerouted through the bulk core)', () => {
  it('still returns the promoted task summary (contract unchanged)', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'Solo', draft: true }); // DRAFT-1
    const summary = await promoteDraftHandler(d, { taskId: 'DRAFT-1' });
    expect(summary.id).toBe('TASK-1');
    expect(summary.status).toBe('To Do');
  });
});
```

> Import `promoteDraftsHandler` in the test's handler import block. The existing `promoteDraftHandler` describe (if any) must stay green after the reroute — same observable contract.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- promoteDrafts TasksController mcpWriteHandlers`
Expected: FAIL — `src/core/promoteDrafts` does not exist; no `promoteDrafts` controller case; no `promoteDraftsHandler`.

- [ ] **Step 3: Write the core `src/core/promoteDrafts.ts`**

```ts
/**
 * Bulk draft promotion with dependency-edge remap (P4, GAP-3). vscode-free.
 *
 * `writer.promoteDraft` re-ids DRAFT-N → TASK-N but rewrites only the moved file's
 * frontmatter — inbound `dependencies` / bug `caused_by` references to the old DRAFT id
 * are left dangling. This core promotes a set in dependency order (deps first, so
 * prerequisites get lower ids), then rewrites EVERY inbound reference across the live
 * board (tasks + remaining drafts, incl. the just-promoted tasks' own edges).
 *
 * Consumers (parity): MCP `promote_drafts` (bulk), MCP `promote_draft` (single id →
 * gains remap for free), and the canvas "Promote all proposed" webview message.
 */
import type { BacklogParser } from './BacklogParser';
import type { BacklogWriter } from './BacklogWriter';
import type { TreeFieldService } from './TreeFieldService';

export interface PromoteDraftsDeps {
  parser: BacklogParser;
  writer: BacklogWriter;
  treeFieldService: TreeFieldService;
}

export interface PromoteMapping {
  from: string;
  to: string;
}

export interface PromoteDraftsResult {
  /** Old→new id pairs, in promotion (dep-first) order. */
  promoted: PromoteMapping[];
  /** Ids of tasks/drafts whose dependencies or caused_by were rewired. */
  remapped: string[];
}

/** Thrown when a draft fails to promote mid-set; carries the drafts already moved. */
export class PromoteDraftsError extends Error {
  constructor(
    message: string,
    readonly promoted: PromoteMapping[]
  ) {
    super(message);
    this.name = 'PromoteDraftsError';
  }
}

/** Order the requested drafts so a draft's in-set dependencies precede it (deps → dependents). */
function topoOrder(ids: string[], draftByUpper: Map<string, { dependencies: string[] }>): string[] {
  const inSet = new Set(ids.map((i) => i.trim().toUpperCase()));
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visit = (upper: string) => {
    if (visited.has(upper)) return;
    visited.add(upper);
    for (const dep of draftByUpper.get(upper)?.dependencies ?? []) {
      const d = dep.trim().toUpperCase();
      if (inSet.has(d)) visit(d);
    }
    ordered.push(upper);
  };
  for (const i of ids) visit(i.trim().toUpperCase());
  return ordered; // uppercased, deps-first
}

export async function promoteDrafts(
  deps: PromoteDraftsDeps,
  taskIds: string[]
): Promise<PromoteDraftsResult> {
  if (taskIds.length === 0) return { promoted: [], remapped: [] };

  const drafts = await deps.parser.getDrafts();
  const draftByUpper = new Map(drafts.map((d) => [d.id.trim().toUpperCase(), d]));

  // Validate up front: every requested id must be an existing draft (no partial writes yet).
  for (const id of taskIds) {
    if (!draftByUpper.has(id.trim().toUpperCase())) {
      throw new Error(`Cannot promote ${id}: it is not a draft in backlog/drafts/.`);
    }
  }

  const orderUpper = topoOrder(taskIds, draftByUpper as Map<string, { dependencies: string[] }>);
  const promoted: PromoteMapping[] = [];
  for (const upper of orderUpper) {
    const from = draftByUpper.get(upper)!.id;
    try {
      const to = await deps.writer.promoteDraft(from, deps.parser);
      promoted.push({ from, to });
    } catch (err) {
      const done = promoted.map((p) => `${p.from}→${p.to}`).join(', ') || '(none)';
      throw new PromoteDraftsError(
        `Promoted ${promoted.length} of ${orderUpper.length} drafts (${done}) before failing on ${from}: ${err instanceof Error ? err.message : String(err)}. Dependency references were NOT remapped; rerun promote_drafts on the remaining drafts.`,
        promoted
      );
    }
  }

  // Remap inbound references across the live board. Reload AFTER promotion so promoted
  // files (now in tasks/) and any remaining drafts are seen with current content.
  const oldToNew = new Map(promoted.map((p) => [p.from.trim().toUpperCase(), p.to]));
  const [tasks, remainingDrafts] = await Promise.all([
    deps.parser.getTasks(),
    deps.parser.getDrafts(),
  ]);
  const remapped: string[] = [];
  for (const t of [...tasks, ...remainingDrafts]) {
    let changed = false;
    const nextDeps = t.dependencies.map((d) => {
      const to = oldToNew.get(d.trim().toUpperCase());
      if (to) {
        changed = true;
        return to;
      }
      return d;
    });
    if (changed) {
      await deps.writer.updateTask(t.id, { dependencies: nextDeps }, deps.parser);
      remapped.push(t.id);
    }
    if (t.type === 'bug' && t.causedBy) {
      const to = oldToNew.get(t.causedBy.trim().toUpperCase());
      if (to) {
        await deps.treeFieldService.setCausedBy(t.id, to, deps.parser);
        if (!changed) remapped.push(t.id);
      }
    }
  }

  return { promoted, remapped };
}
```

> **Design notes (review-confirmed):** (a) **Sequential promote is collision-safe** — `writer.promoteDraft` scans `tasks/` for the next id and `renameSync`s the file in + invalidates the cache, so the next iteration's scan sees the freshly-added `TASK-N` (no `crossBranchIds` needed). (b) **Topo-order is dep-first** so prerequisites get lower ids; remap is order-independent (it scans the whole board), so correctness does not depend on it — the order is cosmetic/consistency per directive Q4. (c) **Partial failure: stop, no rollback** — `PromoteDraftsError.promoted` files the exact drafts already moved; remap is skipped (state is partial), matching directive Q4 "return/throw with the partial mapping in the message — file remainder precisely." (d) **Scope of remap = tasks + drafts** ("every task/draft on the board", directive Q4); completed/archived are not rewritten (a done task depending on a fresh draft is not a real graph). (e) `updateTask`/`setCausedBy` work on both DRAFT and TASK ids (`parser.getTask` searches all folders, `BacklogParser.ts:307`).

- [ ] **Step 4: MCP `promote_drafts` handler + reroute `promote_draft`**

In `src/mcp/handlers.ts`, add the import (after the `createTaskWithTreeFields` import at `handlers.ts:11`):

```ts
import { promoteDrafts, type PromoteDraftsResult } from '../core/promoteDrafts';
```

Replace `promoteDraftHandler` (`handlers.ts:658-665`) to route through the core and keep its contract; add `promoteDraftsHandler` right after it:

```ts
/** Promote a draft (DRAFT-N) to a task (new TASK-N id). Routes through the bulk core so
 *  inbound dependency/caused_by references are remapped (contract unchanged: returns the
 *  promoted task summary). */
export async function promoteDraftHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<TaskSummary> {
  const { promoted } = await promoteDrafts(deps, [args.taskId]);
  const to = promoted[0]?.to;
  if (!to) throw new Error(`Draft ${args.taskId} could not be promoted.`);
  return requireSummary(deps, to);
}

/** Promote a set of drafts at once, remapping inbound dependency/caused_by edges so a
 *  linked proposal set keeps its structure. Returns { promoted:[{from,to}], remapped:[] }. */
export async function promoteDraftsHandler(
  deps: McpHandlerDeps,
  args: { taskIds: string[] }
): Promise<PromoteDraftsResult> {
  return promoteDrafts(deps, args.taskIds ?? []);
}
```

> `McpHandlerDeps` structurally satisfies `PromoteDraftsDeps` (it has `parser`/`writer`/`treeFieldService`, `handlers.ts:63-67`). On a `PromoteDraftsError`, `runTool` (registered in Step 5) serializes `error.message` — which already carries the partial mapping. The single-promote reroute leaves the observable contract identical (still returns a `TaskSummary`) but a set of one still runs the remap pass.

- [ ] **Step 5: Register `promote_drafts` in `server.ts`**

In `src/mcp/server.ts`, add `promoteDraftsHandler` to the `./handlers` import block (`server.ts:23-38`, near `promoteDraftHandler`). Then register the tool immediately after the `promote_draft` block (`server.ts:232-240`):

```ts
server.registerTool(
  'promote_drafts',
  {
    title: 'Promote drafts (bulk)',
    description:
      'Promote a SET of reviewed draft proposals (DRAFT-N) into real tasks at once, remapping every inbound dependency and bug caused_by reference so a linked proposal set keeps its structure. Use after the human has reviewed the drafts on the board. Returns { promoted: [{from,to}], remapped: [...] }.',
    inputSchema: {
      taskIds: z
        .array(z.string())
        .describe('Draft IDs to promote together, e.g. ["DRAFT-1","DRAFT-2"].'),
    },
  },
  async (args) => runTool(() => promoteDraftsHandler(deps, args))
);
```

> Bare object-of-zod-validators (house convention, directive Q11). `runTool` because it can throw (`PromoteDraftsError` / validation). No sync-mode fork — promotion touches no claim/status ref (create_task precedent, directive Q11).

- [ ] **Step 6: Add the `promoteDrafts` webview message + controller cases**

In `src/core/types.ts`, add the message to `WebviewMessage` immediately after the `promoteDraft` variant (`types.ts:290`):

```ts
  | { type: 'promoteDraft'; taskId: string }
  | { type: 'promoteDrafts'; taskIds: string[] }
```

In `src/providers/TasksController.ts`, import the core (near the `createTaskCore` import P3a added — grep `from '../core/createTaskCore'`):

```ts
import { promoteDrafts } from '../core/promoteDrafts';
```

Reroute the existing `promoteDraft` case (`TasksController.ts:837-853`) through the core (keeps the read-only guard; gains remap for the single per-node promote), and add the bulk `promoteDrafts` case right after it:

```ts
      case 'promoteDraft': {
        if (!this.parser || !message.taskId) break;
        const draft = await this.parser.getTask(message.taskId);
        if (draft && isReadOnlyTask(draft)) {
          vscode.window.showErrorMessage(
            `Cannot promote draft: ${draft.id} is read-only from ${getReadOnlyTaskContext(draft)}.`
          );
          break;
        }
        try {
          await promoteDrafts(
            { parser: this.parser, writer: this.writer, treeFieldService: this.treeFieldService },
            [message.taskId]
          );
          await this.refresh();
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to promote draft: ${error}`);
        }
        break;
      }

      case 'promoteDrafts': {
        if (!this.parser) break;
        const ids = message.taskIds ?? [];
        if (ids.length === 0) break;
        try {
          await promoteDrafts(
            { parser: this.parser, writer: this.writer, treeFieldService: this.treeFieldService },
            ids
          );
          await this.refresh();
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to promote drafts: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        break;
      }
```

> `this.treeFieldService` was added to the controller by P3a (grep `private readonly treeFieldService`); `this.writer` and `isReadOnlyTask`/`getReadOnlyTaskContext` are existing. The bulk case has no per-id read-only guard: promoting a set the human assembled on-canvas is human-initiated, and the core validates each id is a draft (read-only cross-branch drafts aren't in `getDrafts()` for the local board).

- [ ] **Step 7: Canvas — post ONE `promoteDrafts` message**

In `src/webview/components/tree/TechTreeCanvas.svelte`, replace `promoteAll` (`TechTreeCanvas.svelte:145-149`):

```ts
function promoteAll() {
  for (const t of promotableDrafts) {
    vscode.postMessage({ type: 'promoteDraft', taskId: t.id });
  }
}
```

with a single bulk post (preserves the filter-aware `promotableDrafts` — directive Q4, P2b carry-in already landed):

```ts
function promoteAll() {
  vscode.postMessage({ type: 'promoteDrafts', taskIds: promotableDrafts.map((t) => t.id) });
}
```

> The per-node promote (`onPromote={(pid) => vscode.postMessage({ type: 'promoteDraft', taskId: pid })}`, `TechTreeCanvas.svelte:831`) is **unchanged** — its controller case (Step 6) now remaps too. `promotableDrafts` (`:144`) already filters to non-faded drafts, so the button count and payload stay filter-aware. Run the `svelte` MCP `svelte-autofixer` on `TechTreeCanvas.svelte` until clean (a one-line change; no new `$state`).

- [ ] **Step 8: Update the 11b Playwright test + add a draft-render assertion**

In `e2e/tree-canvas.spec.ts`, extend the **11b** test (`tree-canvas.spec.ts:348-372`) so it clicks Promote-all and asserts **one** `promoteDrafts` message carrying only the filtered-visible id. (Precision note: today's 11b only asserts the button count `(1)` — it does NOT assert the old N `promoteDraft` messages; the appended click+assert below is what creates the genuine red→green for the canvas rewire, in the SAME commit.) Append to the existing 11b body after the `(1)` count assertion:

```ts
// Promote-all now posts ONE promoteDrafts message with only the visible (filtered) draft.
await page.locator('[data-testid="tree-promote-all"]').click();
const msgs = await getPostedMessages(page);
const bulk = msgs.filter((m) => m.type === 'promoteDrafts');
expect(bulk).toHaveLength(1);
expect(bulk[0]).toMatchObject({ type: 'promoteDrafts', taskIds: ['TASK-D1'] });
// No per-node promoteDraft messages from the bulk button:
expect(msgs.some((m) => m.type === 'promoteDraft')).toBe(false);
```

Add a new sibling test asserting a `folder:'drafts'` node renders as proposed (the fixture's `treeTasks()` already carries a `status:'Draft'` node `TASK-4`, `tree-canvas.spec.ts:61-68`):

```ts
test('a draft node renders as a proposed tree node (GAP-1 visible)', async ({ page }) => {
  // treeTasks() includes TASK-4 (status 'Draft'); the tree tab shows it as a proposed node.
  await expect(page.locator('[data-testid="tree-node-TASK-4"]')).toBeVisible();
  await expect(page.locator('[data-testid="tree-node-TASK-4"]')).toHaveClass(/draft|proposed/);
});
```

> Confirm the exact proposed-style class on `TreeNode.svelte` (grep the draft branch — it applies a class like `is-draft`/`proposed`/`draft`; match the real one in the `toHaveClass` regex). The fixture already posts `TASK-4` via `treeTasks()` in the describe's `beforeEach` setup — reuse it; do not re-post tasks.

- [ ] **Step 9: Build + run tests + typecheck**

Run: `bun run build && bun run test -- promoteDrafts TasksController mcpWriteHandlers && bun run typecheck` → PASS.

- [ ] **Step 10: Full task gate + MID-BUILD CDP checkpoint**

Run the full unit + lint + typecheck + full tree Playwright set:

```bash
bun run test && bun run lint && bun run typecheck && bun run test:playwright -- tree-
```

Then the **mid-build full-CDP checkpoint** (directive Q12 — the canvas message change + controller reroute is the highest cross-view-regression-risk edit in P4, so run the existing CDP suite now):

```bash
bun run test:cdp
```

Expected: PASS — the existing CDP suites (`cross-view`, `tree-popover`, `tree-authoring`, `tree-reslot`) stay green; the promote-all rewire does not break node selection / popover / reslot cross-view. (The new promote CDP test is authored in Task 8.)

- [ ] **Step 11: Commit**

```bash
git add src/core/promoteDrafts.ts src/test/unit/promoteDrafts.test.ts src/mcp/handlers.ts \
  src/mcp/server.ts src/core/types.ts src/providers/TasksController.ts \
  src/webview/components/tree/TechTreeCanvas.svelte src/test/unit/TasksController.test.ts \
  src/test/unit/mcpWriteHandlers.test.ts e2e/tree-canvas.spec.ts
git commit --no-verify -m "feat(tree P4): bulk promote with dependency-edge remap (GAP-3)

- src/core/promoteDrafts.ts: validate -> dep-first topo order -> per-draft promoteDraft
  -> remap inbound dependencies + bug caused_by across tasks/drafts; PromoteDraftsError
  carries the partial mapping on mid-set failure (no rollback)
- MCP promote_drafts (bulk) + promote_draft rerouted through the core (single id gains
  remap for free; contract unchanged)
- webview promoteDrafts message + controller case; per-node promoteDraft case rerouted
  through the core; canvas 'Promote all proposed' posts ONE promoteDrafts message
- 11b Playwright asserts one promoteDrafts message; new draft-node-renders assertion

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Read tools — `list_categories` + `list_milestones` [opus]

**Files:**

- Modify: `src/mcp/handlers.ts`, `src/mcp/server.ts`
- Create test: `src/test/unit/mcpReadHandlers.test.ts`

**Why (directive Q6, Q7):** the skill "reads the tree" before decomposing — it needs the lane vocabulary and the milestone bands with counts, matching the canvas exactly (parity). Both are built on the shared `loadTreeBoardFromParser` so the agent sees the same `laneOrder`/`bandOrder` the canvas renders.

**Shapes (verbatim from the directives):**

- `list_categories` → `[{ category, count, reserved }]`. Vocabulary = `TreeBoard.laneOrder` (config order + discovered + Misc + Bugs — canvas parity, reserved included). `count` = tasks in the Q5 universe (tasks + drafts) whose lane resolves there via `laneOf`. `reserved` = `Misc | Bugs`.
- `list_milestones` → `[{ id?, name, order, taskCount, doneCount }]`. Order = `TreeBoard.bandOrder` (declared → discovered → Backburner). `id` from milestone files (`getMilestones()`) when one exists; omitted for discovered/Backburner. Counts over the Q5 universe; `done` = `status === resolveDoneStatus(config.statuses)`. Backburner counts tasks with no/unknown milestone (band semantics, `treeLayout.ts:77-83`).

- [ ] **Step 1: Write the failing tests**

Create `src/test/unit/mcpReadHandlers.test.ts` using the temp-dir `scaffold()`/`deps()` pattern (copy `mcpWriteHandlers.test.ts:1-52`). Seed tasks/drafts via `createTaskHandler` and a `categories`-bearing config, then assert shapes:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';
import { ClaimService } from '../../core/ClaimService';
import { PlanService } from '../../core/PlanService';
import { TreeFieldService } from '../../core/TreeFieldService';
import {
  createTaskHandler,
  editTaskHandler,
  listCategoriesHandler,
  listMilestonesHandler,
} from '../../mcp/handlers';
import type { McpHandlerDeps } from '../../mcp/handlers';

let root: string, backlogPath: string;
function scaffold(configExtra = ''): void {
  // Tests that need configExtra call scaffold(...) again inside the test body —
  // remove the beforeEach tmpdir first so it doesn't leak (afterEach only removes
  // the latest root).
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-read-'));
  backlogPath = path.join(root, 'backlog');
  fs.mkdirSync(path.join(backlogPath, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(backlogPath, 'drafts'), { recursive: true });
  fs.writeFileSync(
    path.join(backlogPath, 'config.yml'),
    `project_name: "t"\nstatuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: "task"\n${configExtra}`,
    'utf-8'
  );
}
function deps(): McpHandlerDeps {
  return {
    root,
    backlogPath,
    parser: new BacklogParser(backlogPath),
    writer: new BacklogWriter(),
    claimService: new ClaimService(),
    planService: new PlanService(),
    treeFieldService: new TreeFieldService(),
  };
}
beforeEach(() => scaffold());
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('listCategoriesHandler', () => {
  it('returns laneOrder vocabulary with counts and reserved flags', async () => {
    scaffold('categories: ["Features", "Platform"]\n');
    const d = deps();
    await createTaskHandler(d, { title: 'A', category: 'Features' });
    await createTaskHandler(d, { title: 'B', category: 'Features' });
    await createTaskHandler(d, { title: 'C' }); // Misc
    await createTaskHandler(d, { title: 'Bug', type: 'bug', causedBy: undefined }); // Bugs lane
    const cats = await listCategoriesHandler(d);
    const byName = new Map(cats.map((c) => [c.category, c]));
    expect(byName.get('Features')!.count).toBe(2);
    expect(byName.get('Features')!.reserved).toBe(false);
    expect(byName.get('Platform')!.count).toBe(0); // declared, unused
    expect(byName.get('Misc')!.reserved).toBe(true);
    expect(byName.get('Bugs')!.reserved).toBe(true);
    expect(byName.get('Bugs')!.count).toBe(1);
    // reserved lanes are last, declared order preserved:
    expect(cats.map((c) => c.category).slice(0, 2)).toEqual(['Features', 'Platform']);
    expect(cats.map((c) => c.category).slice(-2)).toEqual(['Misc', 'Bugs']);
  });

  it('counts drafts in the universe (canvas parity)', async () => {
    scaffold('categories: ["Features"]\n');
    const d = deps();
    await createTaskHandler(d, { title: 'D', draft: true, category: 'Features' });
    const cats = await listCategoriesHandler(d);
    expect(cats.find((c) => c.category === 'Features')!.count).toBe(1);
  });
});

describe('listMilestonesHandler', () => {
  it('orders by bandOrder and counts task/done per band; Backburner absorbs unset', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'A', milestone: 'v1' });
    await createTaskHandler(d, { title: 'B', milestone: 'v1' });
    await editTaskHandler(d, { taskId: 'TASK-2', status: 'Done' });
    await createTaskHandler(d, { title: 'C' }); // no milestone → Backburner
    const ms = await listMilestonesHandler(d);
    const byName = new Map(ms.map((m) => [m.name, m]));
    expect(byName.get('v1')!.taskCount).toBe(2);
    expect(byName.get('v1')!.doneCount).toBe(1);
    expect(byName.get('Backburner')!.taskCount).toBe(1);
    expect(byName.get('Backburner')!.id).toBeUndefined();
    expect(ms[ms.length - 1].name).toBe('Backburner'); // always last
    // order is 0-based, ascending, matching bandOrder:
    expect(ms.map((m) => m.order)).toEqual(ms.map((_m, i) => i));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- mcpReadHandlers`
Expected: FAIL — `listCategoriesHandler`/`listMilestonesHandler` are not exported.

- [ ] **Step 3: Add imports + handlers to `handlers.ts`**

Extend the tree imports in `src/mcp/handlers.ts`. Change (`handlers.ts:22`):

```ts
import { loadTreeStateFromParser, type TreeDerivedState } from '../core/treeDerived';
```

to:

```ts
import {
  loadTreeStateFromParser,
  loadTreeBoardFromParser,
  type TreeDerivedState,
} from '../core/treeDerived';
import { laneOf, MISC_LANE, BUGS_LANE, BACKBURNER_BAND } from '../core/treeLayout';
import { resolveDoneStatus } from '../core/treeGate';
import type { Milestone } from '../core/types';
```

> `resolveDoneStatus` is only imported here if not already present — grep first (`treeGate` is imported for `wouldCreateCycle` at `handlers.ts:10`; extend that import rather than duplicating): `import { wouldCreateCycle, resolveDoneStatus } from '../core/treeGate';`.

Add the handlers (place near the other read handlers, after `attachPlanHandler` at `handlers.ts:516`):

```ts
export interface CategorySummary {
  category: string;
  count: number;
  reserved: boolean;
}

/** The tech-tree lane vocabulary (canvas parity: config order + discovered + Misc + Bugs)
 *  with a task count per lane over the tasks+drafts universe. */
export async function listCategoriesHandler(deps: McpHandlerDeps): Promise<CategorySummary[]> {
  const [board, tasks, drafts] = await Promise.all([
    loadTreeBoardFromParser(deps.parser),
    deps.parser.getTasks(),
    deps.parser.getDrafts(),
  ]);
  const counts = new Map<string, number>();
  for (const t of [...tasks, ...drafts]) {
    const lane = laneOf(t);
    counts.set(lane, (counts.get(lane) ?? 0) + 1);
  }
  const reserved = new Set([MISC_LANE, BUGS_LANE]);
  return board.laneOrder.map((category) => ({
    category,
    count: counts.get(category) ?? 0,
    reserved: reserved.has(category),
  }));
}

export interface MilestoneSummary {
  id?: string;
  name: string;
  order: number;
  taskCount: number;
  doneCount: number;
}

/** The milestone band order (canvas parity: declared -> discovered -> Backburner) with
 *  task/done counts per band over the tasks+drafts universe. Backburner absorbs
 *  tasks with no/unknown milestone (band semantics). */
export async function listMilestonesHandler(deps: McpHandlerDeps): Promise<MilestoneSummary[]> {
  const [board, tasks, drafts, milestones, config] = await Promise.all([
    loadTreeBoardFromParser(deps.parser),
    deps.parser.getTasks(),
    deps.parser.getDrafts(),
    deps.parser.getMilestones(),
    deps.parser.getConfig(),
  ]);
  const doneStatus = resolveDoneStatus(config.statuses);
  const idByName = new Map(milestones.map((m: Milestone) => [m.name.toLowerCase(), m.id]));
  const bandByLower = new Map(board.bandOrder.map((b) => [b.toLowerCase(), b]));
  const resolveBand = (t: Task): string => {
    const m = t.milestone?.trim();
    if (!m) return BACKBURNER_BAND;
    return bandByLower.get(m.toLowerCase()) ?? BACKBURNER_BAND;
  };
  const totals = new Map<string, { taskCount: number; doneCount: number }>();
  for (const t of [...tasks, ...drafts]) {
    const band = resolveBand(t);
    const agg = totals.get(band) ?? { taskCount: 0, doneCount: 0 };
    agg.taskCount++;
    if (t.status === doneStatus) agg.doneCount++;
    totals.set(band, agg);
  }
  return board.bandOrder.map((name, order) => {
    const agg = totals.get(name) ?? { taskCount: 0, doneCount: 0 };
    const id = name === BACKBURNER_BAND ? undefined : idByName.get(name.toLowerCase());
    return {
      ...(id ? { id } : {}),
      name,
      order,
      taskCount: agg.taskCount,
      doneCount: agg.doneCount,
    };
  });
}
```

> `laneOf` (`treeLayout.ts:36`) returns `Bugs` for `type:'bug'`, else `category` or `Misc` — so counts match the lane a node actually renders in. `resolveBand` mirrors `treeLayout`'s `bandOf` (`treeLayout.ts:77-83`): a milestone in `bandOrder` maps to that band, else Backburner. Drafts (`status:'Draft'`) never count as done. `Task` is already imported (`handlers.ts:14`).

- [ ] **Step 4: Register both in `server.ts`**

Add `listCategoriesHandler`, `listMilestonesHandler` to the `./handlers` import block (`server.ts:23-38`). Register them after `attach_plan` (`server.ts:122-136`), before `create_task`, both `jsonContent` (infallible reads, directive Q11):

```ts
server.registerTool(
  'list_categories',
  {
    title: 'List categories',
    description:
      'List the tech-tree lane vocabulary (categories) with a task count each, including the reserved Misc and Bugs lanes. Read this before deciding a new task’s lane: reuse an existing category by sideways traversal; only create a new one (create_category) for a genuinely new area.',
  },
  async () => jsonContent(await listCategoriesHandler(deps))
);

server.registerTool(
  'list_milestones',
  {
    title: 'List milestones',
    description:
      'List milestone bands in board order (declared → discovered → Backburner) with task/done counts each. Read this to slot a task into the milestone where the work lands in the flow; default to Backburner when unknown.',
  },
  async () => jsonContent(await listMilestonesHandler(deps))
);
```

- [ ] **Step 5: Build + tests + typecheck**

Run: `bun run test -- mcpReadHandlers && bun run typecheck` → PASS. Then `bun run build` (rebuild the MCP bundle so the tools compile) → PASS.

- [ ] **Step 6: Full task gate**

Run: `bun run test && bun run lint && bun run typecheck && bun run test:playwright -- tree-` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/handlers.ts src/mcp/server.ts src/test/unit/mcpReadHandlers.test.ts
git commit --no-verify -m "feat(tree P4): list_categories + list_milestones read tools

- list_categories: laneOrder vocabulary (config + discovered + Misc + Bugs) with per-lane
  counts (tasks+drafts universe, laneOf semantics) and reserved flags
- list_milestones: bandOrder (declared -> discovered -> Backburner) with task/done counts;
  id from milestone files when present, omitted for discovered/Backburner
- both built on loadTreeBoardFromParser (canvas parity), jsonContent wrapper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Read tools — `get_board` + `search_tasks` (+ `searchTasks` core) [opus]

**Files:**

- Create: `src/core/searchTasks.ts`, `src/test/unit/searchTasks.test.ts`
- Modify: `src/mcp/handlers.ts`, `src/mcp/server.ts`
- Test: `src/test/unit/mcpReadHandlers.test.ts`

**Why (directive Q5, Q8):** the skill reads the board (compact, filterable so output stays bounded) and searches for related/overlapping work to link rather than duplicate. `get_board` yields compact per-task summaries; `search_tasks` ranks the same universe by a pure keyword scorer.

**Shapes (verbatim from the directives):**

- `get_board` → universe = tasks + drafts (completed/archived participate in gating only, never output). Compact: `{ id, title, status, priority?, category?, milestone?, type?, causedBy?, dependencies, blockedBy, locked, draft }` (`draft` = `folder==='drafts'`; `milestone` omitted ⇒ Backburner, `category` omitted ⇒ Misc — do NOT synthesize lane/band names into the fields). Optional filters `category` (laneOf semantics: `Bugs`/`Misc` match), `milestone` (`Backburner` matches unset), `status`. Built on `loadTreeBoardFromParser` + `getDrafts` + `getTasks`; `blockedBy`/`locked` from `states`.
- `search_tasks` → pure core `searchTasks(tasks, query, {limit=20})`, case-insensitive tokenized query, ALL tokens must match somewhere; score per token: title 3 / labels+category 2 / description 1, sum, tie-break stable by id. Empty/blank query → error (that's `get_board`'s job). Handler composes the Q5 compact summaries over the same universe.

- [ ] **Step 1: Write the failing tests**

**5a — `searchTasks.test.ts` (pure).**

```ts
import { describe, it, expect } from 'vitest';
import { searchTasks, type SearchableTask } from '../../core/searchTasks';

const T = (over: Partial<SearchableTask> & { id: string; title: string }): SearchableTask => ({
  description: '',
  labels: [],
  category: '',
  ...over,
});

describe('searchTasks', () => {
  const tasks = [
    T({
      id: 'TASK-1',
      title: 'Login flow',
      description: 'auth via oauth',
      labels: ['auth'],
      category: 'Features',
    }),
    T({
      id: 'TASK-2',
      title: 'Dashboard',
      description: 'charts and login widget',
      category: 'Features',
    }),
    T({ id: 'TASK-3', title: 'Docs', description: 'unrelated' }),
  ];

  it('ranks a title hit above a description hit', () => {
    const res = searchTasks(tasks, 'login');
    expect(res.map((t) => t.id)).toEqual(['TASK-1', 'TASK-2']); // TASK-1 title(3) > TASK-2 desc(1)
  });

  it('requires ALL tokens to match somewhere', () => {
    expect(searchTasks(tasks, 'login oauth').map((t) => t.id)).toEqual(['TASK-1']); // only TASK-1 has both
    expect(searchTasks(tasks, 'login docs')).toEqual([]); // no single task has both
  });

  it('sums field weights per token (title+desc beats title-only)', () => {
    const two = [
      T({ id: 'TASK-A', title: 'alpha', description: 'alpha' }), // 3 + 1 = 4
      T({ id: 'TASK-B', title: 'alpha', description: 'beta' }), // 3
    ];
    expect(searchTasks(two, 'alpha').map((t) => t.id)).toEqual(['TASK-A', 'TASK-B']);
  });

  it('tie-breaks stably by id ascending', () => {
    const two = [T({ id: 'TASK-2', title: 'same' }), T({ id: 'TASK-1', title: 'same' })];
    expect(searchTasks(two, 'same').map((t) => t.id)).toEqual(['TASK-1', 'TASK-2']);
  });

  it('respects the limit (default 20)', () => {
    const many = Array.from({ length: 30 }, (_v, i) => T({ id: `TASK-${i}`, title: 'match' }));
    expect(searchTasks(many, 'match')).toHaveLength(20);
    expect(searchTasks(many, 'match', { limit: 5 })).toHaveLength(5);
  });

  it('throws on an empty/blank query', () => {
    expect(() => searchTasks(tasks, '')).toThrow(/query/i);
    expect(() => searchTasks(tasks, '   ')).toThrow(/query/i);
  });
});
```

**5b — `mcpReadHandlers.test.ts` (`get_board` + `search_tasks`).** Append:

```ts
import { getBoardHandler, searchTasksHandler } from '../../mcp/handlers';

describe('getBoardHandler', () => {
  it('returns compact summaries over tasks+drafts; drafts flagged; unset lane/band omitted', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'Feature X', category: 'Features', milestone: 'v1' });
    await createTaskHandler(d, { title: 'Loose' }); // Misc + Backburner (omitted)
    await createTaskHandler(d, { title: 'Idea', draft: true });
    const board = await getBoardHandler(d, {});
    const byId = new Map(board.map((b) => [b.id, b]));
    expect(byId.get('TASK-1')!.category).toBe('Features');
    expect(byId.get('TASK-2')!.category).toBeUndefined(); // Misc not synthesized
    expect(byId.get('TASK-2')!.milestone).toBeUndefined(); // Backburner not synthesized
    expect(byId.get('DRAFT-1')!.draft).toBe(true);
    expect(byId.get('TASK-1')!.draft).toBe(false);
  });

  it('filters by category (Misc/Bugs match), milestone (Backburner matches unset), status', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'A', category: 'Features', milestone: 'v1' });
    await createTaskHandler(d, { title: 'B' }); // Misc + Backburner
    expect((await getBoardHandler(d, { category: 'Features' })).map((b) => b.id)).toEqual([
      'TASK-1',
    ]);
    expect((await getBoardHandler(d, { category: 'Misc' })).map((b) => b.id)).toEqual(['TASK-2']);
    expect((await getBoardHandler(d, { milestone: 'Backburner' })).map((b) => b.id)).toEqual([
      'TASK-2',
    ]);
    expect((await getBoardHandler(d, { status: 'To Do' })).map((b) => b.id).sort()).toEqual([
      'TASK-1',
      'TASK-2',
    ]);
  });

  it('reports locked/blockedBy from the derivation', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'Base' }); // TASK-1
    await createTaskHandler(d, { title: 'Dep', dependencies: ['TASK-1'] }); // TASK-2 blocked by TASK-1
    const board = await getBoardHandler(d, {});
    const t2 = board.find((b) => b.id === 'TASK-2')!;
    expect(t2.locked).toBe(true);
    expect(t2.blockedBy).toEqual(['TASK-1']);
  });
});

describe('searchTasksHandler', () => {
  it('ranks compact summaries over the tasks+drafts universe', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'Login flow' });
    await createTaskHandler(d, { title: 'Dashboard', description: 'login widget' });
    const res = await searchTasksHandler(d, { query: 'login' });
    expect(res.map((r) => r.id)).toEqual(['TASK-1', 'TASK-2']);
    expect(res[0]).toHaveProperty('locked'); // compact summary shape (same as get_board)
  });

  it('errors on a blank query', async () => {
    await expect(searchTasksHandler(deps(), { query: '  ' })).rejects.toThrow(/query/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- searchTasks mcpReadHandlers`
Expected: FAIL — `src/core/searchTasks` and the two handlers don't exist.

- [ ] **Step 3: Write `src/core/searchTasks.ts`**

```ts
/**
 * Pure keyword ranker for the tech-tree `search_tasks` MCP tool (P4). Baseline is
 * substring keyword matching (no embeddings — semantic search is a flagged later
 * enhancement). Case-insensitive; a task is included only when EVERY query token
 * matches at least one field. Per-token score sums the weights of the fields it
 * appears in (title 3, labels/category 2, description 1); the task score is the sum
 * over tokens. Ties break stably by id ascending.
 */
export interface SearchableTask {
  id: string;
  title: string;
  description?: string;
  labels?: string[];
  category?: string;
}

export function searchTasks<T extends SearchableTask>(
  tasks: T[],
  query: string,
  opts: { limit?: number } = {}
): T[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error(
      'A non-empty search query is required (use get_board to list the whole board).'
    );
  }
  const limit = opts.limit ?? 20;
  const scored: Array<{ task: T; score: number }> = [];
  for (const t of tasks) {
    const title = t.title.toLowerCase();
    const labelsCat = [...(t.labels ?? []), t.category ?? ''].join(' ').toLowerCase();
    const desc = (t.description ?? '').toLowerCase();
    let total = 0;
    let allMatch = true;
    for (const tok of tokens) {
      let s = 0;
      if (title.includes(tok)) s += 3;
      if (labelsCat.includes(tok)) s += 2;
      if (desc.includes(tok)) s += 1;
      if (s === 0) {
        allMatch = false;
        break;
      }
      total += s;
    }
    if (allMatch) scored.push({ task: t, score: total });
  }
  scored.sort((a, b) => b.score - a.score || a.task.id.localeCompare(b.task.id));
  return scored.slice(0, limit).map((s) => s.task);
}
```

- [ ] **Step 4: Add `get_board`/`search_tasks` handlers + shared `toBoardSummary`**

In `src/mcp/handlers.ts`, add the import (near the other core imports):

```ts
import { searchTasks } from '../core/searchTasks';
```

Add the summary shape, a shared mapper, and both handlers (after `listMilestonesHandler` from Task 4):

```ts
export interface BoardTaskSummary {
  id: string;
  title: string;
  status: string;
  priority?: string;
  category?: string;
  milestone?: string;
  type?: string;
  causedBy?: string;
  dependencies: string[];
  blockedBy: string[];
  locked: boolean;
  draft: boolean;
}

/** Shape one task into the compact board summary. Unset category/milestone are OMITTED
 *  (callers read reserved lane/band names from list_categories/list_milestones — the
 *  fields themselves are never synthesized to Misc/Backburner). */
function toBoardSummary(
  task: Task,
  board: Awaited<ReturnType<typeof loadTreeBoardFromParser>>
): BoardTaskSummary {
  const st = board.states.get(task.id.trim().toUpperCase());
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    category: task.category?.trim() || undefined,
    milestone: task.milestone?.trim() || undefined,
    type: task.type,
    causedBy: task.causedBy,
    dependencies: task.dependencies,
    blockedBy: st?.blockedBy ?? [],
    locked: st?.locked ?? false,
    draft: task.folder === 'drafts',
  };
}

export interface GetBoardArgs {
  category?: string;
  milestone?: string;
  status?: string;
}

/** Compact, filterable board view over the tasks+drafts universe (completed/archived
 *  gate only, never appear). Filters use laneOf/band semantics so 'Bugs'/'Misc'/
 *  'Backburner' work. */
export async function getBoardHandler(
  deps: McpHandlerDeps,
  args: GetBoardArgs = {}
): Promise<BoardTaskSummary[]> {
  const [board, tasks, drafts] = await Promise.all([
    loadTreeBoardFromParser(deps.parser),
    deps.parser.getTasks(),
    deps.parser.getDrafts(),
  ]);
  const bandByLower = new Map(board.bandOrder.map((b) => [b.toLowerCase(), b]));
  const resolveBand = (t: Task): string => {
    const m = t.milestone?.trim();
    if (!m) return BACKBURNER_BAND;
    return bandByLower.get(m.toLowerCase()) ?? BACKBURNER_BAND;
  };
  const catF = args.category?.trim().toLowerCase();
  const mileF = args.milestone?.trim().toLowerCase();
  const statF = args.status?.trim().toLowerCase();
  const out: BoardTaskSummary[] = [];
  for (const t of [...tasks, ...drafts]) {
    if (catF && laneOf(t).toLowerCase() !== catF) continue;
    if (mileF && resolveBand(t).toLowerCase() !== mileF) continue;
    if (statF && t.status.toLowerCase() !== statF) continue;
    out.push(toBoardSummary(t, board));
  }
  return out;
}

/** Ranked keyword search over the tasks+drafts universe; returns the same compact
 *  summaries as get_board. Empty query throws (use get_board for the whole board). */
export async function searchTasksHandler(
  deps: McpHandlerDeps,
  args: { query: string; limit?: number }
): Promise<BoardTaskSummary[]> {
  const [board, tasks, drafts] = await Promise.all([
    loadTreeBoardFromParser(deps.parser),
    deps.parser.getTasks(),
    deps.parser.getDrafts(),
  ]);
  const ranked = searchTasks([...tasks, ...drafts], args.query, { limit: args.limit });
  return ranked.map((t) => toBoardSummary(t, board));
}
```

> `searchTasks` receives the raw `Task[]` (which carries `title`/`description`/`labels`/`category`/`id` — a `Task` structurally satisfies `SearchableTask`), ranks, then the handler maps the winners through the SAME `toBoardSummary` `get_board` uses — one summary shape. The blank-query throw lives in the core, so `search_tasks`'s `runTool`… wait — reads use `jsonContent` (no try/catch). See the Step 5 note.

- [ ] **Step 5: Register both in `server.ts`**

Add `getBoardHandler`, `searchTasksHandler` to the `./handlers` import block. Register after `list_milestones` (Task 4), both `jsonContent`:

```ts
server.registerTool(
  'get_board',
  {
    title: 'Get board',
    description:
      'Get a compact, filterable view of the board (active tasks + draft proposals) for tree traversal: each row is { id, title, status, priority?, category?, milestone?, type?, causedBy?, dependencies, blockedBy, locked, draft }. Filter by category / milestone / status to keep output bounded on large boards. Unset category means the Misc lane; unset milestone means Backburner.',
    inputSchema: {
      category: z.string().optional().describe('Lane filter (incl. reserved "Bugs"/"Misc").'),
      milestone: z.string().optional().describe('Band filter ("Backburner" matches unset).'),
      status: z.string().optional().describe('Status filter.'),
    },
  },
  async (args) => jsonContent(await getBoardHandler(deps, args))
);

server.registerTool(
  'search_tasks',
  {
    title: 'Search tasks',
    description:
      'Keyword-search the board (active tasks + drafts) by title / description / labels / category, ranked, returning the same compact summaries as get_board. Use this to find related or overlapping work so you LINK to or extend an existing task instead of creating a near-duplicate. All query tokens must match; a blank query is an error (use get_board to list everything).',
    inputSchema: {
      query: z.string().describe('Space-separated keywords; all must match somewhere.'),
      limit: z.number().optional().describe('Max results (default 20).'),
    },
  },
  async (args) => jsonContent(await searchTasksHandler(deps, args))
);
```

> **Wrapper note (directive Q11):** reads use `jsonContent`, which has **no** try/catch — a thrown error propagates to the SDK and surfaces as a tool error to the client. `searchTasksHandler`'s blank-query throw is therefore surfaced correctly under `jsonContent` (the SDK reports the error); this matches the read-tool contract. Do **not** switch `search_tasks` to `runTool` — it is a read, and the throw is the intended empty-query signal. The unit test asserts the handler rejects (Step 1 5b), which covers the surfaced-error path.

- [ ] **Step 6: Build + tests + typecheck**

Run: `bun run test -- searchTasks mcpReadHandlers && bun run typecheck && bun run build` → PASS.

- [ ] **Step 7: Full task gate**

Run: `bun run test && bun run lint && bun run typecheck && bun run test:playwright -- tree-` → PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/searchTasks.ts src/test/unit/searchTasks.test.ts src/mcp/handlers.ts \
  src/mcp/server.ts src/test/unit/mcpReadHandlers.test.ts
git commit --no-verify -m "feat(tree P4): get_board + search_tasks read tools (+ searchTasks core)

- src/core/searchTasks.ts: pure keyword ranker (all-tokens-match; title 3 / labels+
  category 2 / description 1; stable id tie-break; default limit 20; blank query throws)
- get_board: compact filterable summaries over tasks+drafts (Bugs/Misc/Backburner filter
  semantics; unset lane/band omitted; blockedBy/locked from the derivation)
- search_tasks: ranks the same universe into the same compact summaries
- shared toBoardSummary mapper; both jsonContent reads

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Write tool — `create_category` (+ `categoriesConfig` core) [opus]

**Files:**

- Create: `src/core/categoriesConfig.ts`, `src/test/unit/categoriesConfig.test.ts`
- Modify: `src/mcp/handlers.ts`, `src/mcp/server.ts`
- Test: `src/test/unit/mcpWriteHandlers.test.ts`

**Why (directive Q9):** when the skill finds a genuinely new area (surfaced for approval), it creates a lane. `create_category` appends to the config `categories:` list via a **surgical single-line edit** mirroring `mergeStatusConfig.ts` exactly (regex the `categories:` line, preserve EOL + all other lines). Idempotent on a case-insensitive dupe (against config ∪ discovered ∪ reserved → `{created:false, category}`, not an error — skill-friendly); rejects blank and reserved names (Bugs/Misc/Backburner). Multi-line YAML `categories:` arrays are out of scope (same documented limitation as `mergeStatusConfig`).

- [ ] **Step 1: Write the failing tests**

**6a — `categoriesConfig.test.ts` (pure).**

```ts
import { describe, it, expect } from 'vitest';
import {
  parseCategoriesLine,
  isReservedCategory,
  addCategoryLine,
} from '../../core/categoriesConfig';

const CONFIG =
  'project_name: "t"\nstatuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: "task"\n';

describe('parseCategoriesLine', () => {
  it('parses a single-line categories array', () => {
    expect(parseCategoriesLine('categories: ["Features", "Platform"]\n')).toEqual([
      'Features',
      'Platform',
    ]);
  });
  it('returns [] when absent', () => {
    expect(parseCategoriesLine(CONFIG)).toEqual([]);
  });
});

describe('isReservedCategory', () => {
  it('rejects the reserved lane names case-insensitively', () => {
    for (const r of ['Bugs', 'misc', 'BACKBURNER']) expect(isReservedCategory(r)).toBe(true);
    expect(isReservedCategory('Features')).toBe(false);
  });
});

describe('addCategoryLine', () => {
  it('appends to an existing categories line, preserving other lines + EOL', () => {
    const src = 'statuses: ["To Do"]\ncategories: ["Features"]\ntask_prefix: "task"\n';
    const out = addCategoryLine(src, 'Platform');
    expect(parseCategoriesLine(out)).toEqual(['Features', 'Platform']);
    expect(out).toContain('task_prefix: "task"');
  });
  it('inserts a categories line after statuses when absent', () => {
    const out = addCategoryLine(CONFIG, 'Features');
    const lines = out.split('\n');
    const sIdx = lines.findIndex((l) => l.startsWith('statuses:'));
    expect(lines[sIdx + 1]).toBe('categories: ["Features"]');
    expect(out).toContain('default_status: "To Do"'); // untouched
  });
  it('preserves CRLF', () => {
    const crlf = CONFIG.replace(/\n/g, '\r\n');
    const out = addCategoryLine(crlf, 'Features');
    expect(out).toContain('\r\n');
    expect(out).not.toMatch(/[^\r]\n/); // no bare LF introduced
  });
  it('appends at EOF when there is no statuses line', () => {
    const src = 'project_name: "t"\n';
    const out = addCategoryLine(src, 'Features');
    expect(parseCategoriesLine(out)).toEqual(['Features']);
  });
});
```

**6b — `mcpWriteHandlers.test.ts` (`create_category` handler).** Append:

```ts
import { createCategoryHandler } from '../../mcp/handlers';

describe('createCategoryHandler', () => {
  it('adds a new category to config.yml and reports created:true', async () => {
    const d = deps();
    const res = await createCategoryHandler(d, { category: 'Platform' });
    expect(res).toEqual({ created: true, category: 'Platform' });
    const cfg = fs.readFileSync(path.join(backlogPath, 'config.yml'), 'utf-8');
    expect(cfg).toMatch(/^categories:\s*\["Platform"\]/m);
  });

  it('is idempotent on a case-insensitive dupe (created:false, no error)', async () => {
    const d = deps();
    await createCategoryHandler(d, { category: 'Platform' });
    const res = await createCategoryHandler(d, { category: 'platform' });
    expect(res.created).toBe(false);
    expect(res.category).toBe('Platform'); // returns the existing canonical value
    const cfg = fs.readFileSync(path.join(backlogPath, 'config.yml'), 'utf-8');
    expect((cfg.match(/Platform/g) ?? []).length).toBe(1); // not duplicated
  });

  it('rejects reserved names and blanks', async () => {
    const d = deps();
    await expect(createCategoryHandler(d, { category: 'Bugs' })).rejects.toThrow(/reserved/);
    await expect(createCategoryHandler(d, { category: '  ' })).rejects.toThrow(/required/);
  });

  it('treats a discovered (task-only) category as an existing dupe', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'A', category: 'Data' }); // discovered, not in config
    const res = await createCategoryHandler(d, { category: 'data' });
    expect(res.created).toBe(false);
    expect(res.category).toBe('Data');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- categoriesConfig mcpWriteHandlers`
Expected: FAIL — `src/core/categoriesConfig` and `createCategoryHandler` don't exist.

- [ ] **Step 3: Write `src/core/categoriesConfig.ts`**

```ts
/**
 * Surgical single-line editing of the `categories:` line in config.yml (P4). Mirrors
 * mergeStatusConfig.ts exactly: only a SINGLE-LINE `categories: [...]` array is
 * recognized (Taskwright's own writer always emits single-line) — multi-line YAML
 * arrays are out of scope. All other lines and the file's EOL are preserved.
 */

/** Reserved lane names owned by the layout module; never user categories. */
export const RESERVED_CATEGORIES = ['Bugs', 'Misc', 'Backburner'];

/** Parse the `categories: ["A", "B"]` line; [] when absent. */
export function parseCategoriesLine(configText: string): string[] {
  const m = configText.match(/^categories:\s*\[(.*)\]\s*$/m);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/** True when `name` is a reserved lane (case-insensitive). */
export function isReservedCategory(name: string): boolean {
  return RESERVED_CATEGORIES.some((r) => r.toLowerCase() === name.trim().toLowerCase());
}

/**
 * Append `category` to the single-line `categories:` list, preserving EOL and all other
 * lines. If the line is absent, insert `categories: ["X"]` immediately after the
 * `statuses:` line (house configs always have one); if that too is absent, append at EOF.
 * Rendering matches mergeStatusConfig.rewriteStatusesLine (double-quoted entries), which
 * is what config.yml already uses for statuses.
 */
export function addCategoryLine(configText: string, category: string): string {
  const eol = configText.includes('\r\n') ? '\r\n' : '\n';
  const esc = (s: string) => s.replace(/"/g, '\\"');
  const next = [...parseCategoriesLine(configText), category];
  const rendered = `categories: [${next.map((c) => `"${esc(c)}"`).join(', ')}]`;
  const lines = configText.split(/\r?\n/);

  const idx = lines.findIndex((l) => /^categories:\s*\[/.test(l));
  if (idx !== -1) {
    lines[idx] = rendered;
    return lines.join(eol);
  }
  const statusIdx = lines.findIndex((l) => /^statuses:\s*\[/.test(l));
  if (statusIdx !== -1) {
    lines.splice(statusIdx + 1, 0, rendered);
    return lines.join(eol);
  }
  const body = lines.join(eol);
  return body.endsWith(eol) ? `${body}${rendered}${eol}` : `${body}${eol}${rendered}`;
}
```

> **Rendering choice (double-quote entries):** the directive's illustrative `categories: ['X']` uses single quotes, but "mirroring `mergeStatusConfig.ts` exactly" (which emits `"..."`, `mergeStatusConfig.ts:58-60`) and the existing `config.yml` `statuses: ["To Do", ...]` line both use double quotes — so this uses double quotes for consistency. YAML accepts both; not an open question.

- [ ] **Step 4: Add `createCategoryHandler` to `handlers.ts`**

Add the imports (near the top of `src/mcp/handlers.ts`):

```ts
import * as fs from 'fs';
import { addCategoryLine, isReservedCategory } from '../core/categoriesConfig';
import { detectCRLF, normalizeToLF, restoreLineEndings } from '../core/BacklogWriter';
```

> `path` is already imported (`handlers.ts:3`); `fs` is **not** — add it. `detectCRLF`/`normalizeToLF`/`restoreLineEndings` are the CRLF-preserving idiom exported from `BacklogWriter.ts` (used by `TreeFieldService`/`ClaimService`).

Add a config-path resolver + the handler (near the other write handlers):

```ts
/** Resolve the board config file (config.yml preferred, then config.yaml). */
function resolveConfigPath(backlogPath: string): string | undefined {
  const yml = path.join(backlogPath, 'config.yml');
  if (fs.existsSync(yml)) return yml;
  const yaml = path.join(backlogPath, 'config.yaml');
  if (fs.existsSync(yaml)) return yaml;
  return undefined;
}

export interface CreateCategoryResult {
  created: boolean;
  category: string;
}

/** Add a tech-tree lane (category) to config.yml. Idempotent on a case-insensitive dupe
 *  (against config ∪ discovered ∪ reserved). Rejects blank and reserved names. */
export async function createCategoryHandler(
  deps: McpHandlerDeps,
  args: { category: string }
): Promise<CreateCategoryResult> {
  const category = args.category?.trim();
  if (!category) throw new Error('A category name is required.');
  if (isReservedCategory(category)) {
    throw new Error(
      `"${category}" is a reserved lane (Bugs/Misc/Backburner) and cannot be created as a category.`
    );
  }
  // getCategories() = config ∪ discovered (reserved excluded, sorted). Dupe → idempotent.
  const existing = await deps.parser.getCategories();
  const match = existing.find((c) => c.toLowerCase() === category.toLowerCase());
  if (match) return { created: false, category: match };

  const configPath = resolveConfigPath(deps.backlogPath);
  if (!configPath) throw new Error('No backlog config.yml was found to add the category to.');
  const raw = fs.readFileSync(configPath, 'utf-8');
  const hasCRLF = detectCRLF(raw);
  const updated = addCategoryLine(normalizeToLF(raw), category);
  fs.writeFileSync(configPath, restoreLineEndings(updated, hasCRLF), 'utf-8');
  deps.parser.invalidateConfigCache();
  return { created: true, category };
}
```

> `parser.getCategories()` (`BacklogParser.ts:435`) already returns config-order ∪ discovered with reserved excluded; reserved names are rejected up front, so the dupe check covers config ∪ discovered ∪ reserved. `invalidateConfigCache()` (`BacklogParser.ts:170`, public) forces the next `getConfig()`/`getCategories()` to re-read. CRLF-preserving read/normalize/write mirrors `TreeFieldService.rewrite` (`TreeFieldService.ts:55-65`).

- [ ] **Step 5: Register `create_category` in `server.ts`**

Add `createCategoryHandler` to the `./handlers` import block. Register after `create_task` (`server.ts:138-166`), `runTool` (it can throw):

```ts
server.registerTool(
  'create_category',
  {
    title: 'Create category',
    description:
      'Add a new tech-tree lane (category) to the board config. Idempotent: an existing category (case-insensitive, including discovered ones) returns { created:false, category } rather than erroring. Reserved lane names (Bugs/Misc/Backburner) are refused. Create a category ONLY for a genuinely new area of work, surfaced for the user’s approval — prefer reusing an existing lane (see list_categories).',
    inputSchema: {
      category: z.string().describe('The new lane name, e.g. "Platform".'),
    },
  },
  async (args) => runTool(() => createCategoryHandler(deps, args))
);
```

- [ ] **Step 6: Build + tests + typecheck**

Run: `bun run test -- categoriesConfig mcpWriteHandlers && bun run typecheck && bun run build` → PASS.

- [ ] **Step 7: Full task gate**

Run: `bun run test && bun run lint && bun run typecheck && bun run test:playwright -- tree-` → PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/categoriesConfig.ts src/test/unit/categoriesConfig.test.ts src/mcp/handlers.ts \
  src/mcp/server.ts src/test/unit/mcpWriteHandlers.test.ts
git commit --no-verify -m "feat(tree P4): create_category tool (+ categoriesConfig surgical core)

- src/core/categoriesConfig.ts: single-line categories: [...] editor mirroring
  mergeStatusConfig (regex the line, preserve EOL + other lines; insert after statuses:
  when absent, else append at EOF); reserved-name guard; parse helper
- create_category handler: idempotent case-insensitive dupe (config ∪ discovered ∪
  reserved) -> {created:false}; blank/reserved rejected; CRLF-preserving config write +
  invalidateConfigCache; runTool wrapper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: The `/create-task` skill + tool-description polish + doc-sync [haiku]

**Files:**

- Create: `.claude/skills/create-task/SKILL.md`
- Modify: `CLAUDE.md`
- Review only: `src/mcp/server.ts` (confirm the new tool descriptions read skill-quality — they were authored inline in Tasks 3–6; polish wording if any reads terse), `AGENTS.md` (no change expected — see note)

**Why (directive Q10, Q11, Q13):** the skill is P4's user-facing deliverable — it encodes the spec's six-step authoring loop and the decomposition/slotting/dependency/overlap rules, referencing the tools by exact name, and states the parity rule (drafts only, human promotes on canvas) + subscription-safety (no `claude -p`). It is validated by the reviewer + a scenario walkthrough (directive Q10), not by a unit test. This task also folds the CLAUDE.md P4 bullet and the onboarding-blurb fix (accepted-debt). **[haiku-transcription]** — the SKILL.md body is provided verbatim below and the doc edits are anchored diffs; no cross-file judgment.

- [ ] **Step 1: Create the skill**

Create `.claude/skills/create-task/SKILL.md` with the exact content below (frontmatter format matches `.claude/skills/visual-proof/SKILL.md:1-5` — YAML fence with `name` / `description` / `allowed-tools`):

```markdown
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
```

- [ ] **Step 2: CLAUDE.md — add the P4 bullet**

In `CLAUDE.md`, add the P4 bullet immediately after the P3b bullet closes (`CLAUDE.md:149`, before the blank line preceding `## Conventions` at `:151`):

```markdown
- **Tech-tree AI authoring (P4)** ✅: a `/create-task` **skill** (`.claude/skills/create-task/SKILL.md`)
  turns a brief into a set of PR-sized, dependency-linked tasks slotted into lanes/milestones and
  commits them as **draft proposals** the human reviews and promotes on the canvas (parity: every
  tool is one a human can drive via P3; subscription-safe — no `claude -p`). New read MCP tools
  `list_categories` / `list_milestones` / `get_board` / `search_tasks` (built on
  `loadTreeBoardFromParser` for canvas parity; `search_tasks` core `src/core/searchTasks.ts`) and write
  tools `create_category` (surgical `config.yml` edit, `src/core/categoriesConfig.ts` mirroring
  `mergeStatusConfig.ts`) + `promote_drafts` (bulk, `src/core/promoteDrafts.ts` — validate → dep-first
  topo → per-draft `promoteDraft` → **remap** inbound `dependencies`/`caused_by`). Closes three gaps that
  made the draft-review loop live: **drafts render on the canvas** (`loadTreeBoardFromParser` +
  `TasksController` tree-tab union drafts; `TreeNode` `folder==='drafts'` styling), **draft-create carries
  all fields** (`createTaskWithTreeFields` folds priority/milestone/labels/assignee into the same
  `updateTask`; `draft`+`status` → error), and **promote keeps edges** (single `promote_draft` + bulk
  `promote_drafts` + the canvas "Promote all proposed" button all route through the remapping core; the
  button posts one `promoteDrafts` message). Coverage: `src/test/unit/{promoteDrafts,searchTasks,categoriesConfig,mcpReadHandlers}.test.ts`,
  `src/test/cdp/tree-promote.test.ts`. Design:
  `docs/superpowers/specs/2026-07-02-tech-tree-p4-create-task-skill-design.md`; plan:
  `docs/superpowers/plans/2026-07-03-tech-tree-p4-create-task-skill.md`.
```

- [ ] **Step 3: CLAUDE.md — fix the onboarding blurb (accepted-debt fold)**

Replace the onboarding blurb line (`CLAUDE.md:168`):

```markdown
The active task is chosen on the Taskwright board ("Set active") or set by a dispatch. If `get_active_task` reports none is set, ask which task to work on rather than assuming.
```

with (drop the non-existent "Set active" control — active is ephemeral via the tree-node popover open/close, per the P2b nit already applied at `CLAUDE.md:41`/`:109`):

```markdown
The active task is set ephemerally by opening a tree-node popover on the Taskwright board, or by a dispatch. If `get_active_task` reports none is set, ask which task to work on rather than assuming.
```

- [ ] **Step 4: AGENTS.md — no change needed (verify)**

`AGENTS.md` documents the task workflow (get_active_task → claim → work → request_merge); the create-task skill is auto-discovered from `.claude/skills/` and adds no step to that workflow. Confirm no stale statement contradicts P4 (e.g. a claim that agents can't see the board — grep `AGENTS.md` for "board"); if a genuinely misleading line exists, note it, but the default is **no AGENTS.md edit**.

- [ ] **Step 5: Tool-description review**

Re-read the six new `registerTool` descriptions in `src/mcp/server.ts` (added in Tasks 3–6). Confirm each reads skill-quality (the skill leans on them): a one-line what + when-to-use hint. Fix any that read terse; if all are fine, no change. (No test — descriptions are prose.)

- [ ] **Step 6: Build + typecheck + full gate**

Run: `bun run build && bun run test && bun run lint && bun run typecheck && bun run test:playwright -- tree-` → PASS. (Doc/skill-only + optional description wording; the gate is a regression check.)

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/create-task/SKILL.md CLAUDE.md src/mcp/server.ts
git commit --no-verify -m "docs(tree P4): /create-task skill + CLAUDE.md P4 bullet + onboarding-blurb fix

- add .claude/skills/create-task/SKILL.md (six-step authoring loop, decomposition/slotting/
  dependency/overlap rules, parity + subscription-safety, exact tool names)
- CLAUDE.md: P4 AI-authoring bullet; fix onboarding blurb ('Set active' control does not
  exist — active is ephemeral via the tree-node popover)
- tool-description wording polish (if any)

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Task 8: CDP proof pass + full gate + visual proof + close [opus]

**Files:**

- Create: `src/test/cdp/tree-promote.test.ts` (port **9344**)
- Verification/proof only (no other code)

**Why (directive Q12, Q13):** prove the whole draft-review loop cross-view in a real VS Code instance — drafts on the canvas from disk → promote-all → files land in `tasks/` with rewired deps → tree updates — and produce the visual proof. Then run the full gate and hand back.

> **CDP notes:** runs via `bun run test:cdp` (build + `vitest run --config vitest.cdp.config.ts`, xvfb on headless Linux). Use CDP port **9344** — `9340`/`9341`/`9342`/`9343` are taken by `cross-view`/`tree-popover`/`tree-authoring`/`tree-reslot`. Mirror the harness scaffold + the inner-frame drive pattern of `src/test/cdp/tree-reslot.test.ts` (which seeds frontmatter into the per-run tmpdir, forces kanban for the readiness signal, then switches to the tree tab). Draft files must be seeded on disk (the fixture ships tasks only); write `backlog/drafts/*.md` into the tmpdir copy in the test. See `docs/cdp-testing-notes.md`.

- [ ] **Step 1: Write the CDP spec**

Create `src/test/cdp/tree-promote.test.ts`. Seed two **linked** drafts on disk (DRAFT-2 depends on DRAFT-1), open the tree, click "Promote all proposed", then assert both draft files are gone from `drafts/`, two `TASK-*` files exist in `tasks/`, and the dependent's dependency was rewired to the promoted id (no `DRAFT` left):

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { launchVsCode, closeVsCode, type VsCodeInstance } from './lib/vscode-launcher';
import {
  createTestWorkspace,
  resetTestWorkspace,
  cleanupTestWorkspace,
} from './lib/test-workspace';
import { waitForExtensionReady, waitForWebviewContent } from './lib/wait-helpers';
import {
  clickInWebview,
  elementExistsInWebview,
  clearWebviewSessionCache,
} from './lib/webview-helpers';
import { dismissNotifications, resetEditorState, executeCommand, sleep } from './lib/cdp-helpers';

const CDP_PORT = 9344;

function draftsDir(w: string): string {
  return path.join(w, 'backlog', 'drafts');
}
function tasksDir(w: string): string {
  return path.join(w, 'backlog', 'tasks');
}

/** Seed two linked drafts (DRAFT-2 depends on DRAFT-1) into the per-run tmpdir copy. */
function seedLinkedDrafts(w: string): void {
  fs.mkdirSync(draftsDir(w), { recursive: true });
  fs.writeFileSync(
    path.join(draftsDir(w), 'draft-1 - Base-proposal.md'),
    `---\nid: DRAFT-1\ntitle: Base proposal\nstatus: Draft\nassignee: []\ndependencies: []\ncategory: Features\n---\n\n## Description\n<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->\n`,
    'utf-8'
  );
  fs.writeFileSync(
    path.join(draftsDir(w), 'draft-2 - Uses-base.md'),
    `---\nid: DRAFT-2\ntitle: Uses base\nstatus: Draft\nassignee: []\ndependencies:\n  - DRAFT-1\ncategory: Features\n---\n\n## Description\n<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->\n`,
    'utf-8'
  );
}

function readById(dir: string, id: string): string | undefined {
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.md')) continue;
    const c = fs.readFileSync(path.join(dir, f), 'utf-8');
    if (new RegExp(`^id:\\s*${id}\\b`, 'm').test(c)) return c;
  }
  return undefined;
}

async function waitFor(fn: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(250);
  }
  return false;
}

describe('Tree promote-all cross-view (CDP)', () => {
  let instance: VsCodeInstance;
  let workspacePath: string;

  beforeAll(async () => {
    workspacePath = createTestWorkspace();
    instance = await launchVsCode({ workspacePath, cdpPort: CDP_PORT });
    await waitForExtensionReady(instance.cdp);
    await dismissNotifications(instance.cdp);
  }, 90_000);

  afterAll(async () => {
    if (instance) closeVsCode(instance);
    if (workspacePath) cleanupTestWorkspace(workspacePath);
  }, 15_000);

  beforeEach(async () => {
    clearWebviewSessionCache();
    resetTestWorkspace(workspacePath);
    fs.rmSync(path.join(workspacePath, '.taskwright'), { recursive: true, force: true });
    fs.rmSync(draftsDir(workspacePath), { recursive: true, force: true }); // clean drafts each run
    await resetEditorState(instance.cdp);
    await dismissNotifications(instance.cdp);
    await executeCommand(instance.cdp, 'taskwright.refresh');
    await executeCommand(instance.cdp, 'taskwright.showKanbanView'); // readiness signal
    await waitForWebviewContent(instance.cdp, 'tasks', 'TASK-', { timeoutMs: 10_000 });
  }, 30_000);

  it('promote-all lands linked drafts in tasks/ with rewired dependencies', async () => {
    seedLinkedDrafts(workspacePath);
    await executeCommand(instance.cdp, 'taskwright.refresh');
    await sleep(500);

    // Switch to the tree; the seeded drafts render as proposed nodes.
    await clickInWebview(instance.cdp, 'tasks', '[data-testid="tab-tree"]');
    await sleep(500);
    expect(
      await elementExistsInWebview(instance.cdp, 'tasks', '[data-testid="tree-node-DRAFT-1"]')
    ).toBe(true);
    expect(
      await elementExistsInWebview(instance.cdp, 'tasks', '[data-testid="tree-node-DRAFT-2"]')
    ).toBe(true);

    // Promote all proposed → ONE promoteDrafts message → the bulk core runs cross-view.
    const clicked = await clickInWebview(instance.cdp, 'tasks', '[data-testid="tree-promote-all"]');
    expect(clicked).toBe(true);

    // Both drafts left drafts/ and landed in tasks/, with the intra-set edge rewired.
    const landed = await waitFor(() => {
      const d1 = readById(draftsDir(workspacePath), 'DRAFT-1');
      const d2 = readById(draftsDir(workspacePath), 'DRAFT-2');
      const usesBase = readById(tasksDir(workspacePath), 'TASK-'); // any promoted task
      return !d1 && !d2 && !!usesBase;
    }, 20_000);
    expect(landed).toBe(true);

    // The dependent's dependency was remapped to the promoted TASK id (no DRAFT left).
    const usesBaseFile = fs
      .readdirSync(tasksDir(workspacePath))
      .map((f) => fs.readFileSync(path.join(tasksDir(workspacePath), f), 'utf-8'))
      .find((c) => /title:\s*Uses base/.test(c));
    expect(usesBaseFile).toBeDefined();
    expect(usesBaseFile!).toMatch(/- TASK-\d+/);
    expect(usesBaseFile!).not.toMatch(/DRAFT-/);
  }, 60_000);
});
```

> Confirm the CDP fixture renders the tree (its config must not be cross-branch — the sibling `tree-reslot`/`tree-authoring` suites render nodes, so it does). If the seeded drafts don't appear, verify the GAP-1 union (Task 1) landed and the fixture's `taskwright.refresh` re-derives. Keep the disk assertions strict — a failure there is a real GAP-3 regression. Draft node `data-testid` is `tree-node-DRAFT-1` (same `tree-node-<id>` pattern as tasks).

- [ ] **Step 2: Run the new CDP test + the full CDP suite (close checkpoint)**

Run: `bun run test:cdp` → PASS (the new `tree-promote` test plus the existing suites; record the new CDP total = mid-build baseline + 1). If the promote-all click races the overlay, add a short `await sleep(150)` after the tree-tab switch.

- [ ] **Step 3: Full regression gate**

Run, in the worktree:

```bash
bun run test && bun run lint && bun run typecheck && bun run test:playwright
```

Expected: PASS. Record the exact new totals against the branch-base baselines captured at the start:

- **Unit:** baseline + new suites (`promoteDrafts`, `searchTasks`, `categoriesConfig`, `mcpReadHandlers`) + the added cases in `treeDerived`/`TasksController`/`mcpWriteHandlers`.
- **Playwright:** baseline + the new `tree-canvas` draft-render test, with the 11b delta (promote-all now posts one `promoteDrafts` message).
- **CDP:** baseline + `tree-promote` (port 9344).
- Lint zero-warning; typecheck clean. (Windows: the ~22 known upstream POSIX-path unit failures are pre-existing and unrelated — do not "fix".)

- [ ] **Step 4: Visual proof**

Invoke the **`visual-proof`** skill (`.claude/skills/visual-proof/`) to produce a showboat doc capturing: (a) **draft proposals on the tree** — draft nodes rendered as proposed (GAP-1), ideally via the Vite fixture (fast) using the `tree-canvas.spec.ts` `treeTasks()` draft fixture; (b) the **"Promote all proposed"** button; (c) the CDP path — seed linked drafts → promote-all → the new nodes appear as `To Do` tasks on the tree with their dependency edge intact and the files rewired on disk (`showboat exec` on the before/after frontmatter is ideal for the remap). Prefer the CDP (real-VS-Code) path for the promote→files-land→edges-rewired flow since it spans views + disk; the Vite-fixture path is fine for the isolated proposed-node visual. Save under the skill's output location (git-ignored screenshots). Also capture, via `showboat exec`, an MCP-tool transcript is **not** possible live from the worktree (primary-build caveat) — instead show a unit-test run of `mcpReadHandlers`/`promoteDrafts` as the tool-behavior evidence.

- [ ] **Step 5: Hand back to the orchestrator**

Confirm the worktree is clean (`git status` shows nothing uncommitted), all gates are green (unit + Playwright + CDP + lint + typecheck), and update the run ledger (`.superpowers/tech-tree-run/`). **Do NOT run `request_merge`** — in this run the orchestrator lands the branch (ff-merge). Stop at "worktree clean, all gates green, ledger updated". (The CDP proof commit below is the last commit.)

- [ ] **Step 6: Commit the CDP test**

```bash
git add src/test/cdp/tree-promote.test.ts
git commit --no-verify -m "test(tree P4): CDP cross-view — promote-all lands linked drafts with rewired deps

- seeds two linked drafts on disk (DRAFT-2 -> DRAFT-1), promotes all on the tree, asserts
  both land in tasks/ and the dependent's edge is remapped to the promoted TASK id (no
  DRAFT left) — end-to-end proof of GAP-1 (render) + GAP-3 (bulk promote + remap)
- port 9344

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Directive → task mapping (P4):**

- **GAP-1 (draft visibility, Q2)** → Task 1 (`loadTreeBoardFromParser` union + `TasksController` tree-tab union + retire dead `requestCreateTask`).
- **GAP-2 (draft field completeness, Q3)** → Task 2 (`createTaskWithTreeFields` draft-path fold + `draft`+`status` guard).
- **GAP-3 (bulk promote + remap, Q4)** → Task 3 (`promoteDrafts.ts` + MCP `promote_drafts`/rerouted `promote_draft` + webview `promoteDrafts` message + rerouted per-node case + canvas one-message button + 11b Playwright).
- **Q5 (`get_board`)** → Task 5. **Q6 (`list_categories`)/Q7 (`list_milestones`)** → Task 4. **Q8 (`search_tasks` + core)** → Task 5.
- **Q9 (`create_category` + `categoriesConfig`)** → Task 6.
- **Q10 (the skill)** → Task 7. **Q11 (registration conventions)** → Tasks 3–6 (jsonContent reads / runTool writes; bare object-of-zod; no sync fork). **Q12 (tests/gates)** → every task (unit cores + temp-dir handler tests + full tree Playwright gate; CDP mid-build Task 3 + close Task 8 port 9344). **Q13 (doc-sync)** → Task 7.
- **Accepted-debt folds** → dead `requestCreateTask` (Task 1), CLAUDE.md onboarding blurb (Task 7).

**2. Locked-name compliance:** new MCP tools `list_categories`/`list_milestones`/`get_board`/`search_tasks`/`create_category`/`promote_drafts` with camelCase I/O (`causedBy`, `taskIds`); the one new webview message is `promoteDrafts {taskIds}` (envelope discriminant `type`; no create-shaped payload, so the Q1 `taskType` rule is not triggered but remains binding for any future create message). `promoteDraft` (per-node) and the extended `create_task` keep their names/contracts.

**3. Parity:** `create_category` mirrors `mergeStatusConfig.ts`; `promote_drafts`/`promote_draft`/canvas-button all route through `promoteDrafts` (one remapping core); the draft-field fix folds into the same `updateTask`; reads share `loadTreeBoardFromParser` + `toBoardSummary`. Nothing the skill does is unavailable to a human via P3.

**4. Scope discipline:** no `/execute-task` (P5), no codebase-index bootstrap (P6), no embeddings (keyword only), no new drag gesture, no stored coordinates, no new webview component. The only webview change is one line in `promoteAll`.

**5. Leaves-first build integrity:** each task ends green (`bun run build` where a bundle changed + relevant tests + full tree Playwright). Task 1 (draft visibility) is the substrate; Task 2 (draft fields) and Task 3 (promote remap) complete the review loop; Tasks 4–6 add tools additively to `handlers.ts`/`server.ts`; Task 7 writes the skill over the registered tools; Task 8 proves cross-view. The 11b Playwright delta lands in the **same commit** as the canvas rewire (Task 3), so Playwright is green at every commit. Mid-build full-CDP is bound to Task 3 (highest cross-view risk); the new CDP test + full CDP close-checkpoint is Task 8.

**6. Verify commands are per-task and concrete** (`bun run test -- <suite>`, `bun run test:playwright -- tree-`, `bun run test:cdp`, plus the full gate in Task 8). Commits stage only named files and use `--no-verify` (Windows CRLF hook). Model tiers: Tasks 1–6, 8 opus (integration/design/ripple); Task 7 haiku (fully-provided SKILL.md + anchored doc diffs — genuine transcription).

## Open questions

None; the directives adjudicate all known forks. Two deliberate, code-anchored choices are recorded inline rather than raised as questions: (a) `create_category` renders `"double-quoted"` entries to mirror `mergeStatusConfig.ts` + the existing `config.yml` `statuses:` line (the directive's `['X']` is illustrative; YAML accepts both); (b) `promoteDrafts` scopes the reference remap to tasks + drafts (matching directive Q4's "every task/draft on the board"), leaving completed/archived untouched.
