# Tech-tree P3a — Create Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a **human** a frictionless way to author tasks directly from the board: one **unified create form** (full / quick / bug modes) opened by keyboard, the TabBar `+`, the command palette, or a "Report bug" node action — every path landing on the **same** `CreateTaskForm.svelte` and posting one locked `createTask` message. Behind it, extract the MCP `createTaskHandler`'s writer sequence into a **vscode-free shared core** (`createTaskWithTreeFields`) so the human form and the agent MCP tool go through **one writer path** (parity), and implement the `linkTo` post-create dependency wiring now so P3b's drop-on-empty just reuses it. Retire the legacy `TaskCreatePanel`. No canvas drag lands here.

**Scope boundary (P3a).** This plan implements the P3 directives §P3a items **1–5** (shared create core, `CreateTaskForm`, triggers/keybindings, `createTask` handler + retire `TaskCreatePanel`, bug & one-off intake) plus the P3a slice of testing directive **12** (unit `createTaskCore` + `TasksController` `createTask` case; Playwright `tree-authoring.spec.ts`; CDP `tree-authoring.test.ts`) and doc directive **13** (CLAUDE.md doc-sync incl. the two P2b wording nits). It does **not** implement drag-to-connect, drag-to-reslot, edge removal, geometry-inverse hit-testing, the navigator minimap drag-to-pan, or any new MCP tool — those are **P3b** and **P4**. The `createTask` message's `linkTo` field and the `TechTreeCanvas` `onCreateInPlace` prop pathway are **built** here (so P3b consumes them unchanged) but the form itself **never sets `linkTo`** in P3a, and there is **no empty-canvas click trigger** yet (P3b adds it via the geometry inverse).

**Architecture:** The MCP `createTaskHandler` (`src/mcp/handlers.ts`) is the create-parity target. Its writer orchestration — `BacklogWriter.createTask` → `updateTask({type,dependencies})` → `TreeFieldService.setCategory/setCausedBy` — is extracted verbatim into `src/core/createTaskCore.ts` `createTaskWithTreeFields(deps, args)` (`deps = {parser, writer, backlogPath, treeFieldService}`), which also owns the `linkTo` post-create dependency append. The MCP handler keeps its own validation (status/priority/dependency-existence) and calls the core; the new `TasksController` `createTask` case calls the **same** core, then `refresh()`s and optionally opens the new task. On the webview side, `Tasks.svelte` **hosts** the new `CreateTaskForm.svelte` at its root (so it works from any tab), opened by (a) the in-webview keydown handler (`Ctrl/Cmd-N` & bare `n` → full, `Ctrl/Cmd-Shift-N` → quick), (b) the TabBar `+`, (c) an outbound `openCreateForm` message posted by the repointed `taskwright.createTask` command / new `taskwright.quickCapture` command (with `contributes.keybindings`), and (d) a `reportBug` `DetailPopover` action routed through the canvas's new `onCreateInPlace` prop. The legacy `TaskCreatePanel` webview panel is deleted.

**Tech Stack:** TypeScript, Svelte 5 (runes), Vitest (pure core + host-agnostic controller), Playwright (form interactions on the Vite fixture), CDP (create → node-appears + file-on-disk cross-view), esbuild (extension host) + Vite (webview bundles), VS Code webview CSP (same-origin, no inline scripts).

## Where this fits (the P3 decomposition)

P3 was split by the orchestrator (adjudication Q0, `.superpowers/tech-tree-run/p3-plan-adjudications.md`) into two independently-shippable plans, mirroring the P2 a/b precedent:

1. **P3a — create surface (this plan):** the unified create form, bug/one-off intake, the shared create core (+ `linkTo` wiring), triggers/keybindings, and retiring `TaskCreatePanel`. Worktree `.worktrees/tech-tree-p3a`, branch `tech-tree-p3a`, base main `b95826c`.
2. **P3b — drag surface (a later plan, drafted against landed P3a reality):** geometry-inverse hit-testing, gesture disambiguation (pointer events), drag-to-connect, drag-to-reslot, edge removal, and the P2b carry-in debt. P3b's **only** P3a dependency is drop-on-empty, which reuses this plan's `createTask` + `linkTo` + `onCreateInPlace` — all delivered here.

**Locked message names (exact strings, from the P3 directives — do not rename).**
Inbound (webview→ext): **`createTask`** with the full field set
`{title, description?, status?, priority?, category?, milestone?, taskType?:'bug', causedBy?, dependencies?, linkTo?:{taskId, direction:'needs'|'unlocks'}, openAfter?}` (this plan **repurposes** the existing unhandled `{ type:'createTask'; task: Partial<Task> }` variant to this schema and handles it). Outbound (ext→webview): **`openCreateForm`** `{mode:'full'|'quick', bugMode?, causedBy?, category?, milestone?}`. Commands: **`taskwright.createTask`** (repointed) and **`taskwright.quickCapture`** (new). The names **`reslotTask` / `addDependency` / `removeDependency` / `navigatorMinimapPan`** are reserved for **P3b — do NOT implement them here and do NOT define conflicting variants.** Non-locked helper names this plan introduces (`CreateTaskPayload`, `createTaskWithTreeFields`, `onCreateInPlace`) may keep the names given here. `linkTo.direction` semantics are **defined by P3a** (Task 1) so P3b maps its connect handles onto them 1:1: `linkTo.taskId` is the drag-origin node, `direction` is the origin's handle — `'unlocks'` (right handle) ⇒ **new task depends on origin** (`new.dependencies += origin`); `'needs'` (left handle) ⇒ **origin depends on new task** (`origin.dependencies += new`). Both match `addDependency{taskId,dependsOn}` = `task[taskId].dependencies += dependsOn`.

> **Blessed deviation (Q1, orchestrator-adjudicated — do NOT "fix" back):** the directives' locked
> schema named the task-type wire field `type?`, but a TypeScript discriminated-union message cannot
> carry a payload property named `type` (TS2300 duplicate identifier against the `type: 'createTask'`
> envelope discriminant), and a `{ type:'createTask', ...payload }` spread with `payload.type` would
> clobber the discriminant at runtime (bug-mode submits would silently post `{type:'bug'}` and be
> ignored). Per `.superpowers/tech-tree-run/p3-plan-adjudications.md` **Q1**, the **wire** field is
> renamed **`taskType?: 'bug'`** — in the `WebviewMessage` member (Task 2) and `CreateTaskPayload`
> (Task 3) — and mapped explicitly in `handleCreateSubmit` (Task 4) and the controller case
> (`type: message.taskType`, Task 2). The vscode-free **core arg stays `type`** so MCP parity is
> untouched. P3b must use `taskType` on the wire too (e.g. drop-on-empty `createTask` with `linkTo`).

## Global Constraints

_Every task's requirements implicitly include this section._

- **Worktree:** work in `.worktrees/tech-tree-p3a` on branch `tech-tree-p3a`. Run all git/file/test commands inside the worktree. A fresh worktree has no `node_modules` (git-ignored) — run `bun install` there **once** before the first build/test. Never commit/merge from the repo root; stage only the files each task names; commit with `--no-verify` (the repo's lint-staged pre-commit hook flips the whole tree CRLF→LF on Windows — see the memory note).
- **Runtime:** Node **≥ 22**; build/test via **Bun** (`bun run test`, `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test:playwright`, `bun run test:cdp`).
- **Baselines at branch base (`b95826c`):** unit **1385 passed / 1 skipped**; Playwright **333 passed**; CDP **15/15**; lint zero-warning; typecheck clean. Windows shows ~22 known upstream POSIX-path unit failures — unrelated, do not "fix". Confirm no previously-green test regresses; each task states what it adds.
- **Parity (mandatory):** the MCP `createTaskHandler` and the `TasksController` `createTask` case must **both** call `createTaskWithTreeFields` — one writer sequence for human and agent. The MCP handler refactor must **not change its observable behavior**: `src/test/unit/mcpWriteHandlers.test.ts`'s `createTaskHandler` describe keeps passing unchanged (or is updated only minimally with justification). Every field a gesture sets resolves through the same writers the MCP tools use (`BacklogWriter.createTask/updateTask`, `TreeFieldService.setCategory/setCausedBy`); no create business logic is re-implemented in the webview.
- **TDD where a pure core or controller message exists** (`createTaskCore`, the `TasksController` `createTask` case): write the failing Vitest first, run red, implement, run green. Svelte components are UI — cover behavior with **Playwright** (REQUIRED for click/keyboard/DOM-order); cover cross-view create with **CDP**. Document the house UI-only exception in the commit for pure-markup steps.
- **Rendering discipline:** Lucide **inline SVG** only (no emojis); every color/border via `--vscode-*` tokens so all themes work. Reactive `style="…"` and Svelte `on*`/`bind:` handlers are CSP-safe; **no** inline `<script>`, no string-built handlers. The form lives inside the existing same-origin `tasks.js` bundle (CSP `default-src 'none'; style-src/script-src ${cspSource}`) — no new webview bundle entry.
- **Svelte 5 runes** (`$state`/`$derived`/`$props`/`$effect`/`{#snippet}`); follow existing component patterns; run the `svelte` MCP `svelte-autofixer` over each new/edited component until it reports no issues **before** committing.
- **Do not break** the kanban/list/dashboard/drafts/archived/docs/decisions tabs, the tree popover / milestone popover / in-flight panel / navigator (P2b), the detail panel, or their tests. The tech-tree canvas drag surface stays untouched (P3b).
- **Commit trailer:** end each commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (workers substitute their own model line per `AGENTS.md`). **The orchestrator lands this branch (ff-merge) — the close task (Task 8) ends at "worktree clean, all gates green, ledger updated", NOT `request_merge`.**

---

## File Structure

**Create:**

- `src/core/createTaskCore.ts` — vscode-free shared create core: `createTaskWithTreeFields(deps, args)` (the extracted MCP writer sequence) + the moved `normalizeType` + `linkTo` post-create dependency wiring.
- `src/test/unit/createTaskCore.test.ts` — its unit tests (mocked parser/writer/treeFieldService: call-sequence + `linkTo` + validation).
- `src/webview/components/tree/CreateTaskForm.svelte` — the unified create form (full / quick / bug modes), hosted at `Tasks.svelte` root.
- `e2e/tree-authoring.spec.ts` — Playwright: open-via-`+`, full-mode fields + prefill, quick-add, bug mode (severity/caused-by/category-locked), Enter/Shift+Enter (`openAfter`), `openCreateForm` injection, `reportBug` popover action.
- `src/test/cdp/tree-authoring.test.ts` — CDP cross-view: create in the form → node appears + task file written to disk.

**Modify:**

- `src/mcp/handlers.ts` — `createTaskHandler` calls `createTaskWithTreeFields`; delete the local `normalizeType` and import it from the core (`editTaskHandler` re-uses the imported one).
- `src/core/types.ts` — repurpose the `WebviewMessage` `createTask` variant to the locked full schema; add the `openCreateForm` `ExtensionMessage` variant.
- `src/providers/TasksController.ts` — add a `TreeFieldService` instance + a `createTask` inbound case (calls the core, `refresh()`, optional `openAfter` → open detail).
- `src/webview/components/tasks/Tasks.svelte` — host `CreateTaskForm` at root; keydown triggers (`Ctrl/Cmd-N`, bare `n`, `Ctrl/Cmd-Shift-N`); `openCreateForm` message case; repoint the TabBar `+`; pass `onCreateInPlace` into the canvas; post `createTask` on submit.
- `src/webview/components/tree/TechTreeCanvas.svelte` — add the `onCreateInPlace` prop (pathway only) and route the popover `reportBug` action to it.
- `src/webview/components/tree/DetailPopover.svelte` — add the `'reportBug'` `PopoverActionKind` + a persistent "Report bug" action button.
- `src/extension.ts` — remove the `TaskCreatePanel` import; repoint `taskwright.createTask` to `reveal()` + broadcast `openCreateForm{mode:'full'}`; register `taskwright.quickCapture` (broadcast `openCreateForm{mode:'quick'}`).
- `package.json` — add the `taskwright.quickCapture` command + a new `contributes.keybindings` block.
- Existing tests: `src/test/unit/TasksController.test.ts` (new `createTask` case), `e2e/keyboard-shortcuts.spec.ts` (B2: `n` now opens the form, not `requestCreateTask`), `src/test/unit/mcpWriteHandlers.test.ts` (only if a minimal update is justified).
- `CLAUDE.md` — doc-sync (Task 8): P3a additions bullet + the two P2b wording nits.

**Delete (Task 4):**

- `src/providers/TaskCreatePanel.ts` — the legacy create panel (its fields are a strict subset of `CreateTaskForm`).
- `src/test/unit/TaskCreatePanel.test.ts` — its tests.

---

## Recommended execution order

Leaves-first so the bundle builds green at every commit:

`1 → 2 → 3 → 4 → 5 → 6 → 7 → 8`

- **1** (`createTaskCore` + MCP parity refactor) is the pure leaf every other task's create path resolves to — do it first; it changes no observable MCP behavior.
- **2** (message repurpose + controller `createTask` case) depends on the core existing; it makes the inbound `createTask` handled so the webview can post it.
- **3** (`CreateTaskForm.svelte`) is a self-contained new component; **4** hosts it, so **3** precedes **4**.
- **4** (triggers + retire panel) wires the form into `Tasks.svelte`/commands/keybindings and establishes the `onCreateInPlace` prop pathway; **5** (reportBug) needs both **3**'s bug mode and **4**'s pathway.
- **6** (Playwright) exercises **3/4/5**; **7** (CDP) needs the create path (**2/4**) landed. **8** runs the full gate + doc-sync + visual proof + close.

> **Anchor caveat (read before transcribing):** every edit hunk quotes the exact existing lines to match — **match the quoted text, not the cited line number**. Tasks 4/5 grow `Tasks.svelte`/`TechTreeCanvas.svelte`/`DetailPopover.svelte`, so absolute line numbers cited for those files drift under earlier insertions; the quoted before/after snippets are unique and authoritative.

Each task's model tier is noted in its heading: **[haiku-transcription]** = fully-specified single-surface, safe to transcribe verbatim; **[opus-integration]** = cross-file wiring/judgment.

---

## Task 1: Shared create core `createTaskWithTreeFields` + MCP parity refactor [opus-integration]

**Files:**

- Create: `src/core/createTaskCore.ts`
- Create test: `src/test/unit/createTaskCore.test.ts`
- Modify: `src/mcp/handlers.ts`

**Why (directive 1):** the human form and the agent MCP tool must create through **one** writer sequence. Extract the orchestration from `createTaskHandler` into a vscode-free core; the handler keeps its own validation and calls the core. Implement the `linkTo` post-create wiring **now** (directive 1) so P3b's drop-on-empty reuses it; the P3a form never sets `linkTo`.

**Interfaces:** `createTaskWithTreeFields(deps: CreateTaskCoreDeps, args: CreateTaskCoreArgs): Promise<{ id: string }>`, where `deps = { parser, writer, backlogPath, treeFieldService }`.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/createTaskCore.test.ts`. The writer/treeFieldService/parser are mocked so the test asserts the **call sequence** (mirrors how `mcpWriteHandlers.test.ts` exercises the handlers, but with pure mocks):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTaskWithTreeFields, normalizeType } from '../../core/createTaskCore';

// Minimal fakes: only the methods the core touches. `universe` feeds the four list
// getters applyLinkTo walks for its wouldCreateCycle guard — the default has NO
// back-edge, so the happy-path linkTo tests pass the guard; the cycle test overrides it.
function makeDeps(overrides?: {
  createTaskId?: string;
  getTask?: (id: string) => Promise<{ id: string; dependencies: string[] } | undefined>;
  universe?: Array<{ id: string; dependencies: string[] }>;
}) {
  const createTask = vi
    .fn()
    .mockResolvedValue({ id: overrides?.createTaskId ?? 'TASK-9', filePath: '/b/tasks/task-9.md' });
  const createDraft = vi
    .fn()
    .mockResolvedValue({ id: 'DRAFT-1', filePath: '/b/drafts/draft-1.md' });
  const updateTask = vi.fn().mockResolvedValue(undefined);
  const setCategory = vi.fn().mockResolvedValue('');
  const setCausedBy = vi.fn().mockResolvedValue('');
  const getTask =
    overrides?.getTask ?? vi.fn(async (id: string) => ({ id, dependencies: [] as string[] }));
  const universe = overrides?.universe ?? [
    { id: 'TASK-1', dependencies: [] as string[] },
    { id: 'TASK-9', dependencies: [] as string[] },
  ];
  const getTasks = vi.fn().mockResolvedValue(universe);
  const getDrafts = vi.fn().mockResolvedValue([]);
  const getCompletedTasks = vi.fn().mockResolvedValue([]);
  const getArchivedTasks = vi.fn().mockResolvedValue([]);
  const deps = {
    parser: { getTask, getTasks, getDrafts, getCompletedTasks, getArchivedTasks } as never,
    writer: { createTask, createDraft, updateTask } as never,
    backlogPath: '/b',
    treeFieldService: { setCategory, setCausedBy } as never,
  };
  return { deps, createTask, createDraft, updateTask, setCategory, setCausedBy, getTask };
}

describe('createTaskWithTreeFields — writer sequence', () => {
  it('quick create (title only): createTask, no updateTask/category/causedBy', async () => {
    const m = makeDeps();
    const res = await createTaskWithTreeFields(m.deps, { title: '  Ship it  ' });
    expect(res).toEqual({ id: 'TASK-9' });
    expect(m.createTask).toHaveBeenCalledWith(
      '/b',
      {
        title: 'Ship it',
        description: undefined,
        status: undefined,
        priority: undefined,
        labels: undefined,
        assignee: undefined,
        milestone: undefined,
      },
      m.deps.parser
    );
    expect(m.updateTask).not.toHaveBeenCalled();
    expect(m.setCategory).not.toHaveBeenCalled();
    expect(m.setCausedBy).not.toHaveBeenCalled();
  });

  it('full create: passes priority/milestone/description to createTask and sets category surgically', async () => {
    const m = makeDeps();
    await createTaskWithTreeFields(m.deps, {
      title: 'Add login',
      description: 'desc',
      status: 'To Do',
      priority: 'high',
      milestone: 'v1',
      category: 'Features',
    });
    expect(m.createTask).toHaveBeenCalledWith(
      '/b',
      expect.objectContaining({
        title: 'Add login',
        priority: 'high',
        milestone: 'v1',
        description: 'desc',
        status: 'To Do',
      }),
      m.deps.parser
    );
    expect(m.setCategory).toHaveBeenCalledWith('TASK-9', 'Features', m.deps.parser);
  });

  it('category "" / whitespace is not written (Misc = no category)', async () => {
    const m = makeDeps();
    await createTaskWithTreeFields(m.deps, { title: 'x', category: '   ' });
    expect(m.setCategory).not.toHaveBeenCalled();
  });

  it('bug create: updateTask({type:"bug"}) then setCausedBy', async () => {
    const m = makeDeps();
    await createTaskWithTreeFields(m.deps, { title: 'Crash', type: 'bug', causedBy: 'TASK-1' });
    expect(m.updateTask).toHaveBeenCalledWith('TASK-9', { type: 'bug' }, m.deps.parser);
    expect(m.setCausedBy).toHaveBeenCalledWith('TASK-9', 'TASK-1', m.deps.parser);
  });

  it('dependencies go through updateTask', async () => {
    const m = makeDeps();
    await createTaskWithTreeFields(m.deps, { title: 'x', dependencies: ['TASK-1', 'TASK-2'] });
    expect(m.updateTask).toHaveBeenCalledWith(
      'TASK-9',
      { dependencies: ['TASK-1', 'TASK-2'] },
      m.deps.parser
    );
  });

  it('draft create routes to createDraft with title/description', async () => {
    const m = makeDeps();
    const res = await createTaskWithTreeFields(m.deps, {
      title: 'Spike',
      description: 'd',
      draft: true,
    });
    expect(res).toEqual({ id: 'DRAFT-1' });
    expect(m.createDraft).toHaveBeenCalledWith('/b', m.deps.parser, {
      title: 'Spike',
      description: 'd',
    });
    expect(m.createTask).not.toHaveBeenCalled();
  });

  it('validates: empty title throws; caused_by without bug throws; invalid type throws', async () => {
    const m = makeDeps();
    await expect(createTaskWithTreeFields(m.deps, { title: '   ' })).rejects.toThrow(
      'A task title is required.'
    );
    await expect(
      createTaskWithTreeFields(m.deps, { title: 'x', causedBy: 'TASK-1' })
    ).rejects.toThrow('caused_by can only be set on a bug');
    await expect(createTaskWithTreeFields(m.deps, { title: 'x', type: 'nope' })).rejects.toThrow(
      'Invalid type'
    );
  });
});

describe('createTaskWithTreeFields — linkTo post-create wiring', () => {
  it("direction 'unlocks': new task depends on the origin (new.dependencies += origin)", async () => {
    const m = makeDeps({
      getTask: vi.fn(async (id: string) => ({ id, dependencies: [] as string[] })),
    });
    await createTaskWithTreeFields(m.deps, {
      title: 'B',
      linkTo: { taskId: 'TASK-1', direction: 'unlocks' },
    });
    expect(m.updateTask).toHaveBeenCalledWith(
      'TASK-9',
      { dependencies: ['TASK-1'] },
      m.deps.parser
    );
  });

  it("direction 'needs': origin depends on the new task (origin.dependencies += new)", async () => {
    const m = makeDeps({
      getTask: vi.fn(async (id: string) => ({
        id,
        dependencies: id === 'TASK-1' ? ['TASK-0'] : [],
      })),
    });
    await createTaskWithTreeFields(m.deps, {
      title: 'A',
      linkTo: { taskId: 'TASK-1', direction: 'needs' },
    });
    expect(m.updateTask).toHaveBeenCalledWith(
      'TASK-1',
      { dependencies: ['TASK-0', 'TASK-9'] },
      m.deps.parser
    );
  });

  it('linkTo that would cycle is refused', async () => {
    // Back-edge universe: the new TASK-9 already depends on TASK-1 (via the dependencies
    // arg), so 'needs' (TASK-1.dependencies += TASK-9) would close TASK-1 → TASK-9 → TASK-1.
    const m = makeDeps({
      universe: [
        { id: 'TASK-1', dependencies: [] },
        { id: 'TASK-9', dependencies: ['TASK-1'] },
      ],
    });
    await expect(
      createTaskWithTreeFields(m.deps, {
        title: 'A',
        dependencies: ['TASK-1'],
        linkTo: { taskId: 'TASK-1', direction: 'needs' },
      })
    ).rejects.toThrow('cycle');
  });
});

describe('normalizeType', () => {
  it('accepts bug, blanks to undefined, rejects others', () => {
    expect(normalizeType('bug')).toBe('bug');
    expect(normalizeType('  ')).toBeUndefined();
    expect(normalizeType(undefined)).toBeUndefined();
    expect(() => normalizeType('feature')).toThrow('Invalid type');
  });
});
```

> **Universe note:** `applyLinkTo` loads the post-create task universe from `parser.getTasks()/getDrafts()/getCompletedTasks()/getArchivedTasks()` before running `wouldCreateCycle`, so `makeDeps` stubs all four (drafts/completed/archived return `[]`). The default `universe` has **no back-edge**, so the happy-path `linkTo` tests pass the guard; only the cycle test overrides `universe` with the `TASK-9 → TASK-1` back-edge graph.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- createTaskCore`
Expected: FAIL — module `../../core/createTaskCore` does not exist.

- [ ] **Step 3: Write the core**

Create `src/core/createTaskCore.ts`. This lifts the writer sequence out of `createTaskHandler` (`src/mcp/handlers.ts:588-643`) verbatim, adds `linkTo`, and owns `normalizeType`:

```ts
/**
 * Shared create core (P3a). The single writer sequence behind both the human
 * create form (TasksController) and the agent MCP tool (createTaskHandler) —
 * human/agent parity. vscode-free: it only touches the injected parser/writer/
 * treeFieldService. Callers layer their own validation on top (the MCP handler
 * validates status/priority/dependency-existence before calling this).
 */
import type { BacklogParser } from './BacklogParser';
import type { BacklogWriter } from './BacklogWriter';
import type { TreeFieldService } from './TreeFieldService';
import type { Task } from './types';
import { wouldCreateCycle } from './treeGate';

export interface CreateTaskCoreDeps {
  parser: BacklogParser;
  writer: BacklogWriter;
  /** Path to the `backlog/` directory (parent of `tasks/`). */
  backlogPath: string;
  treeFieldService: TreeFieldService;
}

export interface CreateTaskLink {
  /** The existing task the drag started from. */
  taskId: string;
  /**
   * The origin node's connect handle (P3b maps its handles onto these):
   *  - 'unlocks' (right handle): origin unlocks the new task ⇒ new.dependencies += origin.
   *  - 'needs'   (left handle):  origin needs the new task   ⇒ origin.dependencies += new.
   */
  direction: 'needs' | 'unlocks';
}

export interface CreateTaskCoreArgs {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  labels?: string[];
  assignee?: string[];
  milestone?: string;
  category?: string;
  type?: string;
  causedBy?: string;
  dependencies?: string[];
  draft?: boolean;
  /** Post-create dependency wiring for drop-on-empty (built now for P3b; the P3a form never sets it). */
  linkTo?: CreateTaskLink;
}

/** Validate the `type` value: only 'bug' or absent is allowed. Returns the trimmed value or undefined. */
export function normalizeType(type: string | undefined): string | undefined {
  if (type === undefined) return undefined;
  const t = type.trim();
  if (t === '') return undefined;
  if (t !== 'bug') {
    throw new Error(`Invalid type "${type}". Only "bug" (or none) is allowed.`);
  }
  return 'bug';
}

/** Append `depId` to `current` without duplicates (case-insensitive), preserving order. */
function appendDep(current: string[], depId: string): string[] {
  const key = depId.trim().toUpperCase();
  if (current.some((d) => d.trim().toUpperCase() === key)) return current;
  return [...current, depId];
}

/**
 * The one create writer sequence: BacklogWriter.createTask/createDraft →
 * updateTask({type,dependencies}) → TreeFieldService.setCategory/setCausedBy →
 * optional linkTo dependency wiring. Returns the new id.
 */
export async function createTaskWithTreeFields(
  deps: CreateTaskCoreDeps,
  args: CreateTaskCoreArgs
): Promise<{ id: string }> {
  const title = args.title?.trim();
  if (!title) throw new Error('A task title is required.');
  const type = normalizeType(args.type);
  const causedBy = args.causedBy?.trim();
  if (causedBy && type !== 'bug') {
    throw new Error('caused_by can only be set on a bug (type: bug).');
  }
  const dependencies = args.dependencies ?? [];

  let id: string;
  if (args.draft) {
    ({ id } = await deps.writer.createDraft(deps.backlogPath, deps.parser, {
      title,
      description: args.description,
    }));
  } else {
    ({ id } = await deps.writer.createTask(
      deps.backlogPath,
      {
        title,
        description: args.description,
        status: args.status,
        priority: args.priority,
        labels: args.labels,
        assignee: args.assignee,
        milestone: args.milestone,
      },
      deps.parser
    ));
  }

  // type / dependencies go through BacklogWriter (both serialized there).
  const canonical: Partial<Task> = {};
  if (type !== undefined) canonical.type = type;
  if (dependencies.length > 0) canonical.dependencies = dependencies;
  if (Object.keys(canonical).length > 0) {
    await deps.writer.updateTask(id, canonical, deps.parser);
  }

  // category / caused_by are Taskwright-only: written surgically after create.
  if (args.category !== undefined && args.category.trim() !== '') {
    await deps.treeFieldService.setCategory(id, args.category, deps.parser);
  }
  if (causedBy) {
    await deps.treeFieldService.setCausedBy(id, causedBy, deps.parser);
  }

  if (args.linkTo) {
    await applyLinkTo(deps, id, args.linkTo);
  }

  return { id };
}

/**
 * Wire the drop-on-empty dependency edge, defended against cycles (belt-and-
 * suspenders; P3b also re-validates extension-side before it ever passes linkTo).
 */
async function applyLinkTo(
  deps: CreateTaskCoreDeps,
  newId: string,
  link: CreateTaskLink
): Promise<void> {
  const [tasks, drafts, completed, archived] = await Promise.all([
    deps.parser.getTasks(),
    deps.parser.getDrafts(),
    deps.parser.getCompletedTasks(),
    deps.parser.getArchivedTasks(),
  ]);
  const all = [...tasks, ...drafts, ...completed, ...archived];

  if (link.direction === 'unlocks') {
    // origin unlocks new ⇒ new depends on origin.
    if (wouldCreateCycle(all, newId, link.taskId)) {
      throw new Error(`Linking ${newId} to ${link.taskId} would create a dependency cycle.`);
    }
    const newTask = await deps.parser.getTask(newId);
    const next = appendDep(newTask?.dependencies ?? [], link.taskId);
    await deps.writer.updateTask(newId, { dependencies: next }, deps.parser);
  } else {
    // origin needs new ⇒ origin depends on new.
    if (wouldCreateCycle(all, link.taskId, newId)) {
      throw new Error(`Linking ${link.taskId} to ${newId} would create a dependency cycle.`);
    }
    const origin = await deps.parser.getTask(link.taskId);
    if (!origin) throw new Error(`linkTo target ${link.taskId} does not exist.`);
    const next = appendDep(origin.dependencies ?? [], newId);
    await deps.writer.updateTask(link.taskId, { dependencies: next }, deps.parser);
  }
}
```

- [ ] **Step 4: Refactor `createTaskHandler` to call the core (preserve behavior)**

In `src/mcp/handlers.ts`:

First, **delete the local `normalizeType`** (`handlers.ts:561-570`) and import the one from the core. Add to the imports near the top (after the `wouldCreateCycle` import at `handlers.ts:10`):

```ts
import { createTaskWithTreeFields, normalizeType } from '../core/createTaskCore';
```

Then remove the local function block:

```ts
/** Validate the type value: only 'bug' or absent is allowed. Returns the trimmed value or undefined. */
function normalizeType(type: string | undefined): string | undefined {
  if (type === undefined) return undefined;
  const t = type.trim();
  if (t === '') return undefined;
  if (t !== 'bug') {
    throw new Error(`Invalid type "${type}". Only "bug" (or none) is allowed.`);
  }
  return 'bug';
}
```

(`editTaskHandler` still calls `normalizeType(...)` — it now resolves to the imported one; no other change there.)

Replace the body of `createTaskHandler` (`handlers.ts:588-643`) — keep the validation, delegate the writer sequence to the core:

```ts
/** Create a task (or draft) and return its summary. */
export async function createTaskHandler(
  deps: McpHandlerDeps,
  args: CreateTaskArgs
): Promise<TaskSummary> {
  const config = await deps.parser.getConfig();
  if (args.status !== undefined) assertValidStatus(args.status, config.statuses ?? []);
  if (args.priority !== undefined) assertValidPriority(args.priority, resolvePriorities(config));
  await assertDependenciesValid(deps, args.dependencies ?? []); // no targetId: new task cannot form a cycle

  const { id } = await createTaskWithTreeFields(deps, args);
  return requireSummary(deps, id);
}
```

(`McpHandlerDeps` structurally satisfies `CreateTaskCoreDeps` — it has `parser`, `writer`, `backlogPath`, `treeFieldService`; `CreateTaskArgs` is assignable to `CreateTaskCoreArgs` since the latter's extra fields are optional. `CreateTaskArgs` need **not** gain `linkTo` — the MCP tool does not expose it.)

> **Behavior note:** the title/`normalizeType`/`caused_by`-requires-bug checks now live in the core (thrown with identical messages), so they fire _after_ the handler's status/priority/dependency checks instead of before. All existing `mcpWriteHandlers.test.ts` create cases pass valid titles, so ordering is observationally identical; do not "fix" the tests.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun run test -- createTaskCore mcpWriteHandlers` → PASS (new core suite green; the `createTaskHandler`/`editTaskHandler` describes in `mcpWriteHandlers.test.ts` unchanged and green). Then `bun run typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/createTaskCore.ts src/test/unit/createTaskCore.test.ts src/mcp/handlers.ts
git commit --no-verify -m "feat(tree P3a): shared createTaskWithTreeFields core + MCP parity refactor

- extract createTaskHandler's writer sequence (createTask -> updateTask({type,
  dependencies}) -> setCategory/setCausedBy) into vscode-free src/core/createTaskCore.ts
- move normalizeType to the core; handlers.ts imports it (edit_task reuses)
- implement linkTo post-create dependency wiring now (P3b drop-on-empty reuses it),
  cycle-guarded via wouldCreateCycle
- createTaskHandler keeps status/priority/dependency-existence validation, then
  delegates to the core; observable MCP behavior unchanged

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `createTask` / `openCreateForm` messages + controller `createTask` case [opus-integration]

**Files:**

- Modify: `src/core/types.ts`, `src/providers/TasksController.ts`
- Test: `src/test/unit/TasksController.test.ts`

**Why (directive 4):** repurpose the existing unhandled inbound `createTask` variant to the locked full field set and handle it in `TasksController`, calling the same `createTaskWithTreeFields` core (parity), then `refresh()`; if `openAfter`, open the new id's detail. Add the outbound `openCreateForm` variant the command path posts (consumed by `Tasks.svelte` in Task 4).

- [ ] **Step 1: Write the failing tests**

Append to `src/test/unit/TasksController.test.ts` (inside the top-level `describe`, near the other `handleMessage` assertions). These spy on `BacklogWriter.prototype.createTask` (the core's writer call) to prove the case routes through the shared core end-to-end, plus assert `refresh()` re-emits and `openAfter` opens the detail:

```ts
describe('TasksController — P3a create case', () => {
  it('createTask routes through the shared writer sequence, then refreshes', async () => {
    const createSpy = vi
      .spyOn(BacklogWriter.prototype, 'createTask')
      .mockResolvedValue({ id: 'TASK-9', filePath: '/fake/backlog/tasks/task-9.md' });
    (mockParser.getBacklogPath as ReturnType<typeof vi.fn>).mockReturnValue('/fake/backlog');
    const controller = new TasksController(host, mockParser, mockContext);
    await controller.handleMessage({
      type: 'createTask',
      title: 'Brand new task',
      priority: 'high',
    });
    expect(createSpy).toHaveBeenCalledWith(
      '/fake/backlog',
      expect.objectContaining({ title: 'Brand new task', priority: 'high' }),
      mockParser
    );
    // refresh() re-emitted the board:
    expect(posted.some((m) => m.type === 'tasksUpdated')).toBe(true);
  });

  it('createTask with openAfter opens the new task detail', async () => {
    vi.spyOn(BacklogWriter.prototype, 'createTask').mockResolvedValue({
      id: 'TASK-9',
      filePath: '/fake/backlog/tasks/task-9.md',
    });
    (mockParser.getBacklogPath as ReturnType<typeof vi.fn>).mockReturnValue('/fake/backlog');
    const execSpy = vscode.commands.executeCommand as ReturnType<typeof vi.fn>;
    execSpy.mockClear();
    const controller = new TasksController(host, mockParser, mockContext);
    await controller.handleMessage({ type: 'createTask', title: 'Open me', openAfter: true });
    expect(execSpy).toHaveBeenCalledWith('taskwright.openTaskDetail', { taskId: 'TASK-9' });
  });
});
```

> **Harness note:** `BacklogWriter`, `posted`, `host`, `mockParser`, `mockContext`, and the `vscode` mock are the existing `TasksController.test.ts` fixtures (the P2b tasks added `BacklogWriter` + `posted` usage). If `mockParser.getBacklogPath`/`getConfig`/`getTasks`/… aren't already stubbed to resolve, reuse the file's existing `beforeEach` mock setup so `refresh()` completes without throwing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- TasksController`
Expected: FAIL — no `createTask` case, so `createTask` is a no-op (no `createTask` writer call, no `openTaskDetail`).

- [ ] **Step 3: Repurpose the inbound `createTask` message**

In `src/core/types.ts`, replace the placeholder `createTask` variant (`types.ts:254`):

```ts
  | { type: 'createTask'; task: Partial<Task> }
```

with the locked full schema:

```ts
  | {
      type: 'createTask';
      title: string;
      description?: string;
      status?: string;
      priority?: string;
      category?: string;
      milestone?: string;
      /** Q1 blessed deviation: the task-type wire field is `taskType`, NOT `type` —
       * `type` is the union discriminant (TS2300 otherwise). The core arg stays `type`. */
      taskType?: 'bug';
      causedBy?: string;
      dependencies?: string[];
      linkTo?: { taskId: string; direction: 'needs' | 'unlocks' };
      openAfter?: boolean;
    }
```

> The old `{ task: Partial<Task> }` form was **never handled** in `TasksController.handleMessage` and is not posted anywhere in the webview (the legacy panel used its own private message channel, retired in Task 4). Grep to confirm before deleting: `rg "type: 'createTask'" src/webview src/providers` should show only the new usages you add.

- [ ] **Step 4: Add the outbound `openCreateForm` message**

In `src/core/types.ts`, add to the `ExtensionMessage` union, immediately after the `prioritiesUpdated` variant (`types.ts:342`):

```ts
  | {
      type: 'openCreateForm';
      mode: 'full' | 'quick';
      bugMode?: boolean;
      causedBy?: string;
      category?: string;
      milestone?: string;
    }
```

- [ ] **Step 5: Add a `TreeFieldService` to the controller**

In `src/providers/TasksController.ts`, import the service (after the existing `BacklogWriter` import at `TasksController.ts:16`):

```ts
import { TreeFieldService } from '../core/TreeFieldService';
import { createTaskWithTreeFields } from '../core/createTaskCore';
```

Add the instance field alongside `private readonly writer = new BacklogWriter();` (`TasksController.ts:85`):

```ts
  private readonly treeFieldService = new TreeFieldService();
```

- [ ] **Step 6: Handle the `createTask` case**

In `handleMessage`, add a new case (place it next to the other create-adjacent cases — e.g. right after `case 'requestCreateTask'` at `TasksController.ts:922-925`):

```ts
      case 'createTask': {
        if (!this.parser) break;
        try {
          const { id } = await createTaskWithTreeFields(
            {
              parser: this.parser,
              writer: this.writer,
              backlogPath: this.parser.getBacklogPath(),
              treeFieldService: this.treeFieldService,
            },
            {
              title: message.title,
              description: message.description,
              status: message.status,
              priority: message.priority,
              category: message.category,
              milestone: message.milestone,
              // Q1: the wire field is `taskType` (message.type is the envelope discriminant);
              // the core arg keeps the canonical name `type` (MCP parity).
              type: message.taskType,
              causedBy: message.causedBy,
              dependencies: message.dependencies,
              // linkTo is built for P3b; the P3a form never sets it. When P3b feeds it,
              // re-validate with wouldCreateCycle extension-side before this call.
              linkTo: message.linkTo,
            }
          );
          await this.refresh();
          if (message.openAfter) {
            vscode.commands.executeCommand('taskwright.openTaskDetail', { taskId: id });
          }
        } catch (error) {
          console.error('[Taskwright] createTask failed:', error);
          vscode.window.showErrorMessage(
            `Failed to create task: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        break;
      }
```

- [ ] **Step 7: Run tests + typecheck**

Run: `bun run test -- TasksController` → PASS (baseline + 2 new). Then `bun run typecheck` → PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/types.ts src/providers/TasksController.ts src/test/unit/TasksController.test.ts
git commit --no-verify -m "feat(tree P3a): handle inbound createTask via the shared core + add openCreateForm

- repurpose the unhandled createTask WebviewMessage to the locked full schema
  (title/description/status/priority/category/milestone/taskType/causedBy/dependencies/
  linkTo/openAfter); add openCreateForm ExtensionMessage
- TasksController.createTask calls createTaskWithTreeFields (parity with MCP),
  refreshes, and opens the new task when openAfter is set

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `CreateTaskForm.svelte` — full / quick / bug modes [haiku-transcription]

**Files:**

- Create: `src/webview/components/tree/CreateTaskForm.svelte`

**Behavior (directives 2 & 5, spec §3-4):** one form, three shapes. **Full** shows Title · **Task|Bug** toggle · Category · Priority · Milestone · Description; **Create** (`Enter`) / **Create & open** (`Shift+Enter` → `openAfter`). **Quick** shows Title only, `Enter` = create. **Bug** (toggle or `bugMode` prefill): category hidden (a bug's lane is derived from `type:'bug'`, so no category is sent), milestone hidden, "Severity" relabels Priority, and a **Caused by** task-search (optional). The category picker drops the `Bugs` lane and treats `Misc` as "no category" (empty on submit); the milestone picker's `Backburner` means "no milestone". The form is a self-contained overlay hosted by `Tasks.svelte` (Task 4); it emits a built `CreateTaskPayload` via `onSubmit` and never posts messages itself. UI-only component — behavior covered by Playwright (Task 6); document the house exception in the commit.

- [ ] **Step 1: Create the component**

Create `src/webview/components/tree/CreateTaskForm.svelte`:

```svelte
<script lang="ts" module>
  export interface CreateTaskPayload {
    title: string;
    description?: string;
    priority?: string;
    category?: string;
    milestone?: string;
    /** Q1 blessed deviation: `taskType` on the wire — never name this `type` (it would
     * collide with the createTask message envelope discriminant when posted). */
    taskType?: 'bug';
    causedBy?: string;
    openAfter?: boolean;
  }
</script>

<script lang="ts">
  import type { Task, Milestone } from '../../lib/types';

  interface Props {
    mode: 'full' | 'quick';
    bugMode?: boolean;
    prefill?: { category?: string; milestone?: string; causedBy?: string };
    /** Lane vocabulary (the category picker drops `Bugs`; `Misc` = no category). */
    laneOrder: string[];
    /** Config milestones for the milestone picker (`Backburner` = no milestone). */
    milestones: Milestone[];
    priorities: string[];
    /** In-webview tasks for the caused_by search datalist. */
    tasks: Array<Pick<Task, 'id' | 'title'>>;
    onSubmit: (payload: CreateTaskPayload) => void;
    onClose: () => void;
  }
  let {
    mode,
    bugMode = false,
    prefill,
    laneOrder,
    milestones,
    priorities,
    tasks,
    onSubmit,
    onClose,
  }: Props = $props();

  const MISC = 'Misc';
  const BACKBURNER = 'Backburner';

  // Bug is a mode of the form: type:'bug', no category/milestone, priority relabeled "Severity".
  let isBug = $state(bugMode);
  let title = $state('');
  let description = $state('');
  let priority = $state('');
  let category = $state(prefill?.category ?? MISC);
  let milestone = $state(prefill?.milestone ?? BACKBURNER);
  let causedBy = $state(prefill?.causedBy ?? '');

  // Category options: keep Misc first, drop the Bugs lane, de-dupe Misc from laneOrder.
  const categoryOptions = $derived([MISC, ...laneOrder.filter((l) => l !== 'Bugs' && l !== MISC)]);
  const priorityLabel = $derived(isBug ? 'Severity' : 'Priority');

  let titleEl: HTMLInputElement | undefined = $state();
  $effect(() => {
    titleEl?.focus();
  });

  function buildPayload(openAfter: boolean): CreateTaskPayload | null {
    const t = title.trim();
    if (!t) {
      titleEl?.focus();
      return null;
    }
    if (mode === 'quick') return { title: t, openAfter };
    if (isBug) {
      const p: CreateTaskPayload = { title: t, taskType: 'bug', openAfter };
      if (description.trim()) p.description = description.trim();
      if (priority) p.priority = priority;
      if (causedBy.trim()) p.causedBy = causedBy.trim();
      return p;
    }
    const p: CreateTaskPayload = { title: t, openAfter };
    if (description.trim()) p.description = description.trim();
    if (priority) p.priority = priority;
    if (category && category !== MISC) p.category = category;
    if (milestone && milestone !== BACKBURNER) p.milestone = milestone;
    return p;
  }

  function submit(openAfter: boolean) {
    const payload = buildPayload(openAfter);
    if (payload) onSubmit(payload);
  }

  function onTitleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit(e.shiftKey); // Shift+Enter = Create & open
    }
  }

  function onRootKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onRootKeydown} />

<div class="cf-backdrop" data-testid="create-form-backdrop" onpointerdown={onClose} role="presentation"></div>

<div class="cf-panel" data-testid="create-form" role="dialog" aria-label="Create task" aria-modal="true">
  <div class="cf-head">
    <span class="cf-head-label">
      {mode === 'quick' ? 'Quick capture' : isBug ? 'Report bug' : 'New task'}
    </span>
    <button class="cf-icon" data-testid="cf-close" title="Close" onclick={onClose} aria-label="Close">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
    </button>
  </div>

  <input
    class="cf-input"
    data-testid="cf-title"
    bind:this={titleEl}
    bind:value={title}
    placeholder="Task title"
    onkeydown={onTitleKeydown}
  />

  {#if mode === 'full'}
    <div class="cf-toggle-row" data-testid="cf-type-toggle">
      <button class="cf-toggle" class:active={!isBug} data-testid="cf-toggle-task" onclick={() => (isBug = false)}>Task</button>
      <button class="cf-toggle" class:active={isBug} data-testid="cf-toggle-bug" onclick={() => (isBug = true)}>Bug</button>
    </div>

    {#if !isBug}
      <label class="cf-field">
        <span>Category</span>
        <select class="cf-select" data-testid="cf-category" bind:value={category}>
          {#each categoryOptions as c (c)}<option value={c}>{c}</option>{/each}
        </select>
      </label>
    {/if}

    <label class="cf-field">
      <span>{priorityLabel}</span>
      <select class="cf-select" data-testid="cf-priority" bind:value={priority}>
        <option value="">—</option>
        {#each priorities as p (p)}<option value={p}>{p}</option>{/each}
      </select>
    </label>

    {#if !isBug}
      <label class="cf-field">
        <span>Milestone</span>
        <!-- Submitting m.id (not m.name) is canonical: BacklogParser.resolveMilestoneValue
             normalizes stored milestones to their id, so the board round-trips ids (N3). -->
        <select class="cf-select" data-testid="cf-milestone" bind:value={milestone}>
          <option value={BACKBURNER}>{BACKBURNER}</option>
          {#each milestones as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
        </select>
      </label>
    {/if}

    {#if isBug}
      <label class="cf-field">
        <span>Caused by</span>
        <input
          class="cf-input"
          data-testid="cf-causedby"
          list="cf-causedby-list"
          bind:value={causedBy}
          placeholder="Task ID (optional)"
        />
        <datalist id="cf-causedby-list">
          {#each tasks as t (t.id)}<option value={t.id}>{t.title}</option>{/each}
        </datalist>
      </label>
    {/if}

    <label class="cf-field">
      <span>Description</span>
      <textarea class="cf-textarea" data-testid="cf-description" bind:value={description} placeholder="Optional description (Markdown)"></textarea>
    </label>
  {/if}

  <div class="cf-actions">
    <button class="cf-btn primary" data-testid="cf-submit" onclick={() => submit(false)}>Create</button>
    <button class="cf-btn" data-testid="cf-submit-open" onclick={() => submit(true)}>Create &amp; open</button>
  </div>
</div>

<style>
  .cf-backdrop {
    position: absolute;
    inset: 0;
    z-index: 40;
    background: rgba(0, 0, 0, 0.35);
  }
  .cf-panel {
    position: absolute;
    z-index: 41;
    top: 48px;
    left: 50%;
    transform: translateX(-50%);
    width: 340px;
    max-width: calc(100% - 24px);
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444));
    border-radius: 8px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    color: var(--vscode-foreground);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
  }
  .cf-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .cf-head-label {
    font-size: 13px;
    font-weight: 600;
  }
  .cf-icon {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    padding: 3px;
    border-radius: 4px;
    color: var(--vscode-foreground);
    opacity: 0.8;
  }
  .cf-icon:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  }
  .cf-input,
  .cf-textarea,
  .cf-select {
    width: 100%;
    box-sizing: border-box;
    font-size: 13px;
    padding: 6px 8px;
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    background: var(--vscode-input-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #444));
    border-radius: 4px;
  }
  .cf-input:focus,
  .cf-textarea:focus,
  .cf-select:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
  }
  .cf-textarea {
    min-height: 72px;
    resize: vertical;
    font-family: inherit;
  }
  .cf-field {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
  }
  .cf-toggle-row {
    display: flex;
    gap: 4px;
  }
  .cf-toggle {
    all: unset;
    cursor: pointer;
    flex: 1;
    text-align: center;
    font-size: 12px;
    padding: 4px 0;
    border-radius: 4px;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #444));
    color: var(--vscode-foreground);
    opacity: 0.75;
  }
  .cf-toggle.active {
    opacity: 1;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    border-color: var(--vscode-focusBorder, transparent);
  }
  .cf-actions {
    display: flex;
    gap: 8px;
    margin-top: 2px;
  }
  .cf-btn {
    all: unset;
    cursor: pointer;
    font-size: 12px;
    padding: 5px 12px;
    border-radius: 4px;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #fff);
  }
  .cf-btn.primary {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
  }
  .cf-btn:hover {
    background: var(--vscode-button-hoverBackground, #1177bb);
  }
</style>
```

- [ ] **Step 2: svelte-autofixer**

Run the `svelte` MCP `svelte-autofixer` on `CreateTaskForm.svelte` and keep applying its fixes until it reports no issues. Likely adjustments: an a11y hint on the `role="presentation"` backdrop (it has no keyboard handler by design — the window-level `Escape` and the `cf-close` button are the keyboard paths; suppress with the pattern the repo already uses, or add `onkeydown` that no-ops). Do **not** change the `data-testid`s, the payload shape, or the message contract.

- [ ] **Step 3: Build**

Run: `bun run build && bun run typecheck` → PASS (component compiles into `tasks.js`; not yet mounted — Task 4 wires it).

- [ ] **Step 4: Commit**

```bash
git add src/webview/components/tree/CreateTaskForm.svelte
git commit --no-verify -m "feat(tree P3a): CreateTaskForm (full/quick/bug modes)

- one form: full (title/task-bug toggle/category/priority/milestone/description),
  quick (title only), bug (severity relabel, optional caused_by search, no lane/age)
- Create (Enter) / Create & open (Shift+Enter -> openAfter); emits a built
  CreateTaskPayload via onSubmit; posts no messages itself
- Misc = no category, Backburner = no milestone; category picker drops the Bugs lane

House UI exception: presentation component; behavior covered by e2e/tree-authoring.spec.ts (Task 6).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Triggers, command repoint, keybindings + retire `TaskCreatePanel` [opus-integration]

**Files:**

- Modify: `src/webview/components/tasks/Tasks.svelte`, `src/webview/components/tree/TechTreeCanvas.svelte`, `src/extension.ts`, `package.json`, `e2e/keyboard-shortcuts.spec.ts` (B2: the `n`-key baseline assertion)
- Delete: `src/providers/TaskCreatePanel.ts`, `src/test/unit/TaskCreatePanel.test.ts`

**Behavior (directives 3 & 4):** host `CreateTaskForm` at `Tasks.svelte` root; open it from the in-webview keydown handler (`Ctrl/Cmd-N` & bare `n` → full, `Ctrl/Cmd-Shift-N` → quick), the TabBar `+`, and the outbound `openCreateForm` message; add the `onCreateInPlace` prop pathway on the canvas (used by Task 5). Repoint `taskwright.createTask` to reveal the board + broadcast `openCreateForm{mode:'full'}`; add `taskwright.quickCapture` (broadcast `openCreateForm{mode:'quick'}`) + `contributes.keybindings`. Delete the legacy `TaskCreatePanel`.

- [ ] **Step 1: Import + host state in `Tasks.svelte`**

In `src/webview/components/tasks/Tasks.svelte`, add the import (after the `TechTreeCanvas` import at `Tasks.svelte:9`):

```ts
import CreateTaskForm, { type CreateTaskPayload } from '../tree/CreateTaskForm.svelte';
```

Add the form state (near the tree vocab state at `Tasks.svelte:37-52`):

```ts
// Unified create form (hosted at root so it works from any tab).
let createForm = $state<{
  mode: 'full' | 'quick';
  bugMode: boolean;
  prefill?: { category?: string; milestone?: string; causedBy?: string };
} | null>(null);

function openCreateForm(
  mode: 'full' | 'quick',
  opts?: {
    bugMode?: boolean;
    prefill?: { category?: string; milestone?: string; causedBy?: string };
  }
) {
  createForm = { mode, bugMode: opts?.bugMode ?? false, prefill: opts?.prefill };
}

function handleCreateSubmit(payload: CreateTaskPayload) {
  // Q1: map fields explicitly — never spread a payload into the message envelope
  // (a spread carrying a `type` key would clobber the discriminant).
  vscode.postMessage({
    type: 'createTask',
    title: payload.title,
    description: payload.description,
    priority: payload.priority,
    category: payload.category,
    milestone: payload.milestone,
    taskType: payload.taskType,
    causedBy: payload.causedBy,
    openAfter: payload.openAfter,
  });
  createForm = null;
}
```

- [ ] **Step 2: Handle `openCreateForm` inbound**

Add a case to the `onMessage` switch (after the `prioritiesUpdated` case at `Tasks.svelte:117-119`):

```ts
      case 'openCreateForm':
        openCreateForm(message.mode, {
          bugMode: message.bugMode,
          prefill: { category: message.category, milestone: message.milestone, causedBy: message.causedBy },
        });
        break;
```

- [ ] **Step 3: Keyboard triggers**

In `handleGlobalKeydown` (`Tasks.svelte:294-348`), add a modifier-combo block **before** the single-key `switch` (right after the `Enter` handling block that ends at `Tasks.svelte:320`):

```ts
// Create-form shortcuts (Ctrl/Cmd-N = full, Ctrl/Cmd-Shift-N = quick). Handled
// before the single-key switch so bare `n` below doesn't also fire.
if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) {
  e.preventDefault();
  openCreateForm(e.shiftKey ? 'quick' : 'full');
  return;
}
```

Repoint bare `n` from the round-trip message to the immediate local open. Change the `case 'n'` line (`Tasks.svelte:339`):

```ts
        case 'n': vscode.postMessage({ type: 'requestCreateTask' }); break;
```

to:

```ts
        case 'n': openCreateForm('full'); break;
```

- [ ] **Step 3b: Update the baseline `n`-key Playwright assertion (B2)**

The repoint above breaks a baseline spec: `e2e/keyboard-shortcuts.spec.ts` asserts `n` posts `requestCreateTask`, which is never sent anymore (the form opens locally, no round-trip). Update the test — replace (`keyboard-shortcuts.spec.ts:193-200`):

```ts
test('n key sends requestCreateTask message', async ({ page }) => {
  await clearPostedMessages(page);
  await page.keyboard.press('n');
  await page.waitForTimeout(50);

  const messages = await getPostedMessages(page);
  expect(messages).toContainEqual({ type: 'requestCreateTask' });
});
```

with:

```ts
test('n key opens the create form locally (P3a)', async ({ page }) => {
  await clearPostedMessages(page);
  await page.keyboard.press('n');

  await expect(page.locator('[data-testid="create-form"]')).toBeVisible();
  // No round-trip message: the form opens in-webview and posts createTask only on submit.
  const messages = await getPostedMessages(page);
  expect(messages).not.toContainEqual({ type: 'requestCreateTask' });
});
```

(The sibling test "action shortcuts do not fire when popup is open" at `keyboard-shortcuts.spec.ts:287-301` still passes — the `showShortcuts` early-return at `Tasks.svelte:311` precedes the new modifier block and the `n` case.)

- [ ] **Step 4: TabBar `+` opens the form locally**

Repoint the TabBar create action. Change the `onCreateTask` prop (`Tasks.svelte:499`):

```svelte
  onCreateTask={() => vscode.postMessage({ type: 'requestCreateTask' })}
```

to:

```svelte
  onCreateTask={() => openCreateForm('full')}
```

- [ ] **Step 5: Pass `onCreateInPlace` into the canvas + render the form**

Add the `onCreateInPlace` prop to the `TechTreeCanvas` render (the tree branch at `Tasks.svelte:537-556`), after `onSelectTask={handleSelectTask}`:

```svelte
      onSelectTask={handleSelectTask}
      onCreateInPlace={(opts) =>
        openCreateForm(opts.mode ?? 'full', {
          bugMode: opts.bugMode,
          prefill: { causedBy: opts.causedBy, category: opts.category, milestone: opts.milestone },
        })}
```

Render the form at root (after the `Toast` block at `Tasks.svelte:662-664`):

```svelte
{#if createForm}
  <CreateTaskForm
    mode={createForm.mode}
    bugMode={createForm.bugMode}
    prefill={createForm.prefill}
    {laneOrder}
    milestones={configMilestones}
    {priorities}
    {tasks}
    onSubmit={handleCreateSubmit}
    onClose={() => (createForm = null)}
  />
{/if}
```

- [ ] **Step 6: Add the `onCreateInPlace` prop to `TechTreeCanvas` (pathway only)**

In `src/webview/components/tree/TechTreeCanvas.svelte`, extend `Props` (after `onSelectTask` at `TechTreeCanvas.svelte:42`):

```ts
    onSelectTask: (taskId: string, meta?: Pick<Task, 'filePath' | 'source' | 'branch'>) => void;
    /** Open the unified create form (P3a: reportBug; P3b: drop-on-empty click-in-place). */
    onCreateInPlace?: (opts: {
      mode?: 'full' | 'quick';
      bugMode?: boolean;
      causedBy?: string;
      category?: string;
      milestone?: string;
    }) => void;
```

Do **NOT** add `onCreateInPlace` to the `$props()` destructure yet (N2): an unused destructured
binding risks tripping the zero-warning lint gate. Declaring it only on `Props` keeps typecheck happy
— `Tasks.svelte` may pass the prop; undestructured props are simply ignored. Task 5 adds the
destructure in the same commit that consumes it.

- [ ] **Step 7: Run the `svelte-autofixer`**

Run the `svelte` MCP `svelte-autofixer` on `Tasks.svelte` and `TechTreeCanvas.svelte` until clean.

- [ ] **Step 8: Repoint the `taskwright.createTask` command + add `taskwright.quickCapture`**

In `src/extension.ts`, remove the legacy panel import (near the other provider imports at the top of the file):

```ts
import { TaskCreatePanel } from './providers/TaskCreatePanel';
```

Replace the create-task command registration (`extension.ts:1001-1014`):

```ts
context.subscriptions.push(
  vscode.commands.registerCommand('taskwright.createTask', () => {
    const activeBacklogPath = manager.getActiveRoot()?.backlogPath;
    if (!activeBacklogPath || !parser) {
      vscode.window.showErrorMessage('No backlog folder found in workspace');
      return;
    }

    TaskCreatePanel.show(context.extensionUri, writer, parser, activeBacklogPath, {
      tasksProvider,
      taskDetailProvider,
    });
  })
);
```

with the reveal + broadcast form open (the in-webview keydown/TabBar paths open the form immediately; this command is the command-palette / external-focus path):

```ts
// Create task: reveal the board and open the unified create form in it.
// (relayNavigator is the generic "post this ExtensionMessage to the board" relay.)
context.subscriptions.push(
  vscode.commands.registerCommand('taskwright.createTask', () => {
    tasksPanelProvider.reveal();
    tasksHosts.forEach((host) => host.relayNavigator({ type: 'openCreateForm', mode: 'full' }));
  })
);

// Quick capture: same form in quick (title-only) mode.
context.subscriptions.push(
  vscode.commands.registerCommand('taskwright.quickCapture', () => {
    tasksPanelProvider.reveal();
    tasksHosts.forEach((host) => host.relayNavigator({ type: 'openCreateForm', mode: 'quick' }));
  })
);
```

> `tasksPanelProvider` (`extension.ts:365`), `tasksHosts` (`:370`), and `relayNavigator` (on `TasksBoardSurface`, used at `:457`) are all already in scope here. The keydown/keybinding double-path is intentional and **idempotent** (`openCreateForm` replaces `createForm` with a fresh full/quick form; opening an already-open form re-opens the same empty form). **N4 (reviewed, accepted):** the broadcast reaches **both** hosts (sidebar + editor board), so one `Ctrl+N` can open the form in two surfaces while the in-webview keydown also opens it locally — harmless (only the focused surface is visible/interacted with; each open resets to a fresh empty form), just slightly noisy; do not "fix" by narrowing the broadcast. `writer`/`parser`/`taskDetailProvider` remain used elsewhere in `extension.ts` — do not remove them.

- [ ] **Step 9: `package.json` — `quickCapture` command + keybindings**

In `contributes.commands`, add the `quickCapture` entry immediately after the `taskwright.createTask` entry (`package.json:196-200`):

```json
      {
        "command": "taskwright.createTask",
        "title": "Taskwright: Create Task",
        "icon": "$(add)"
      },
      {
        "command": "taskwright.quickCapture",
        "title": "Taskwright: Quick Capture Task",
        "icon": "$(add)"
      },
```

Add a new `contributes.keybindings` array. Insert it immediately before the `"menus": {` key (`package.json:314`), so it sits between `commands` and `menus`:

```json
    "keybindings": [
      {
        "command": "taskwright.createTask",
        "key": "ctrl+n",
        "mac": "cmd+n",
        "when": "activeWebviewPanelId == 'taskwright.tasksEditor' || focusedView == 'taskwright.kanban'"
      },
      {
        "command": "taskwright.quickCapture",
        "key": "ctrl+shift+n",
        "mac": "cmd+shift+n",
        "when": "activeWebviewPanelId == 'taskwright.tasksEditor' || focusedView == 'taskwright.kanban'"
      }
    ],
    "menus": {
```

> The `when` clause scopes off VS Code's global New-File / New-Window. `taskwright.tasksEditor` is the editor panel's real `viewType` (`src/providers/TasksPanelProvider.ts:92`); `taskwright.kanban` is the sidebar view id (`package.json` `contributes.views`). Both verified in code.

- [ ] **Step 10: Delete the legacy panel + its test**

```bash
git rm src/providers/TaskCreatePanel.ts src/test/unit/TaskCreatePanel.test.ts
```

Confirm no dangling references remain: `rg "TaskCreatePanel" src` should return **nothing** (the only `src` references were the import + `.show` call you removed in Step 8, plus the deleted files).

- [ ] **Step 11: Build + typecheck + regression**

Run: `bun run build && bun run typecheck && bun run lint`
Expected: PASS. Unit suite drops the `TaskCreatePanel.test.ts` cases (that count is subtracted from the baseline — note the new total in the commit). Then `bun run test` → PASS (no other suite referenced `TaskCreatePanel`). Then `bun run test:playwright -- keyboard-shortcuts` → PASS with the Step 3b delta (`n` opens the form; no `requestCreateTask`). This is the only baseline Playwright spec the repoint touches — no e2e spec references `action-create` (verified by review).

- [ ] **Step 12: Commit**

```bash
git add src/webview/components/tasks/Tasks.svelte src/webview/components/tree/TechTreeCanvas.svelte \
  src/extension.ts package.json e2e/keyboard-shortcuts.spec.ts
git commit --no-verify -m "feat(tree P3a): create-form triggers + keybindings; retire TaskCreatePanel

- Tasks.svelte hosts CreateTaskForm at root; opens via Ctrl/Cmd-N & bare n (full),
  Ctrl/Cmd-Shift-N (quick), TabBar +, and the openCreateForm message; posts createTask
- repoint taskwright.createTask to reveal + broadcast openCreateForm{full}; add
  taskwright.quickCapture (quick) + contributes.keybindings (scoped to the board)
- TechTreeCanvas gains the onCreateInPlace prop declaration (destructured+used in the next task)
- keyboard-shortcuts.spec.ts: n now opens the form locally (no requestCreateTask round-trip)
- delete TaskCreatePanel.ts + TaskCreatePanel.test.ts (fields are a subset of the new form)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: "Report bug" popover action → bug intake [opus-integration]

**Files:**

- Modify: `src/webview/components/tree/DetailPopover.svelte`, `src/webview/components/tree/TechTreeCanvas.svelte`

**Behavior (directive 5, spec §4):** add a `'reportBug'` action to the node popover. Clicking it opens the unified form in **bug mode** with `caused_by` pre-filled to that task (`onCreateInPlace({ bugMode: true, causedBy: task.id })`). "Report bug" is available in every popover state (you can trace a bug to any task), so it renders as a persistent row below the state-aware actions.

- [ ] **Step 1: Add `'reportBug'` to `PopoverActionKind` + a persistent action button**

In `src/webview/components/tree/DetailPopover.svelte`, extend the exported union (`DetailPopover.svelte:10-18`):

```ts
export type PopoverActionKind =
  | 'claim'
  | 'dispatch'
  | 'forceClaim'
  | 'release'
  | 'markDone'
  | 'cancelDispatch'
  | 'approve'
  | 'sendBack'
  | 'reportBug';
```

Add a persistent "Report bug" row. Replace the state-aware actions block (`DetailPopover.svelte:189-197`):

```svelte
  {#if actions.length > 0}
    <div class="tp-actions" data-testid="tp-actions">
      {#each actions as a (a.key)}
        <button class="tp-btn" class:primary={a.primary} data-testid="tp-action-{a.kind}" onclick={() => onAction(a.kind, task.id)}>
          {a.label}
        </button>
      {/each}
    </div>
  {/if}
```

with (the state-aware row stays, plus a persistent report-bug row):

```svelte
  {#if actions.length > 0}
    <div class="tp-actions" data-testid="tp-actions">
      {#each actions as a (a.key)}
        <button class="tp-btn" class:primary={a.primary} data-testid="tp-action-{a.kind}" onclick={() => onAction(a.kind, task.id)}>
          {a.label}
        </button>
      {/each}
    </div>
  {/if}

  <div class="tp-actions tp-actions-secondary" data-testid="tp-actions-secondary">
    <button class="tp-btn tp-btn-quiet" data-testid="tp-action-reportBug" onclick={() => onAction('reportBug', task.id)}>
      Report bug
    </button>
  </div>
```

Add the quiet-button style inside the `<style>` block (after the `.tp-btn:hover` rule at `DetailPopover.svelte:345-347`):

```css
.tp-actions-secondary {
  margin-top: 2px;
}
.tp-btn-quiet {
  font-size: 11px;
  opacity: 0.85;
  background: transparent;
  border-color: var(--vscode-panel-border, #444);
}
.tp-btn-quiet:hover {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
}
```

- [ ] **Step 2: Route `reportBug` through the canvas to `onCreateInPlace`**

In `src/webview/components/tree/TechTreeCanvas.svelte`, first add `onCreateInPlace` to the `$props()` destructure (deferred from Task 4 per N2 — this commit consumes it, so no unused-binding lint risk). Change (after `onSelectTask,` at `TechTreeCanvas.svelte:59`):

```ts
    onSelectTask,
```

to:

```ts
    onSelectTask,
    onCreateInPlace,
```

Then add a `reportBug` case to `onPopoverAction` (`TechTreeCanvas.svelte:332-359`) — place it before the `markDone` case:

```ts
      case 'reportBug':
        closePopover();
        onCreateInPlace?.({ bugMode: true, causedBy: id });
        break;
```

- [ ] **Step 3: svelte-autofixer**

Run the `svelte` MCP `svelte-autofixer` on `DetailPopover.svelte` and `TechTreeCanvas.svelte` until clean.

- [ ] **Step 4: Build + typecheck**

Run: `bun run build && bun run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/webview/components/tree/DetailPopover.svelte src/webview/components/tree/TechTreeCanvas.svelte
git commit --no-verify -m "feat(tree P3a): Report-bug popover action -> bug-mode create form

- DetailPopover gains a persistent 'Report bug' action (reportBug PopoverActionKind)
- TechTreeCanvas routes it to onCreateInPlace({bugMode:true, causedBy:task.id}),
  opening CreateTaskForm in bug mode with caused_by pre-filled

House UI exception: presentation/interaction; behavior covered by e2e/tree-authoring.spec.ts (Task 6).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Playwright `e2e/tree-authoring.spec.ts` [opus-integration]

**Files:**

- Create: `e2e/tree-authoring.spec.ts`

**Behavior (directive 12):** drive the form on the Vite fixture (`/tasks.html`, `tasks.js`): open via the TabBar `+`, full-mode fields + Category/Milestone, quick-add, bug mode (severity relabel + caused_by + no category/milestone), `Enter` = create / `Shift+Enter` = `openAfter`, the `openCreateForm` inbound message, and the `reportBug` popover action. Assert the outbound `createTask` message shapes. Mirrors the house pattern in `e2e/tree-popover.spec.ts` exactly (imports, `setup`, `data-testid` selectors, `getLastPostedMessage`/`toMatchObject`).

- [ ] **Step 1: Write the spec**

Create `e2e/tree-authoring.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import {
  installVsCodeMock,
  postMessageToWebview,
  getLastPostedMessage,
  getPostedMessages,
  clearPostedMessages,
} from './fixtures/vscode-mock';
import type { Task } from '../src/webview/lib/types';

const laneOrder = ['Features', 'Misc', 'Bugs'];
const bandOrder = ['v1', 'Backburner'];

function tasks(): Task[] {
  const base = (over: Partial<Task> & { id: string }): Task =>
    ({
      title: over.id,
      status: 'To Do',
      labels: [],
      assignee: [],
      dependencies: [],
      acceptanceCriteria: [],
      definitionOfDone: [],
      filePath: `/b/tasks/${over.id}.md`,
      ...over,
    }) as Task;
  return [
    base({
      id: 'TASK-1',
      title: 'Root feature',
      status: 'To Do',
      category: 'Features',
      milestone: 'v1',
      layout: { lane: 'Features', band: 'v1', depth: 0, subRow: 0 },
    }),
  ];
}

async function setup(page: Parameters<typeof installVsCodeMock>[0]) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installVsCodeMock(page);
  await page.goto('/tasks.html');
  await page.waitForTimeout(100);
  await postMessageToWebview(page, {
    type: 'statusesUpdated',
    statuses: ['To Do', 'In Progress', 'Done'],
  });
  await postMessageToWebview(page, {
    type: 'prioritiesUpdated',
    priorities: ['high', 'medium', 'low'],
  });
  await postMessageToWebview(page, {
    type: 'milestonesUpdated',
    milestones: [{ id: 'v1', name: 'v1' }],
  });
  await postMessageToWebview(page, { type: 'tasksUpdated', tasks: tasks() });
  await postMessageToWebview(page, {
    type: 'treeLayoutUpdated',
    laneOrder,
    bandOrder,
    warnings: [],
  });
  await postMessageToWebview(page, { type: 'activeTabChanged', tab: 'tree' });
  await page.waitForTimeout(150);
  await expect(page.locator('[data-testid="tree-canvas"]')).toBeVisible();
}

test.describe('Tree authoring — create form', () => {
  test.beforeEach(async ({ page }) => setup(page));

  test('TabBar + opens the full form and creates a task on Enter', async ({ page }) => {
    await page.locator('[data-testid="action-create"]').click();
    await expect(page.locator('[data-testid="create-form"]')).toBeVisible();
    await clearPostedMessages(page);
    const title = page.locator('[data-testid="cf-title"]');
    await title.fill('Write the docs');
    await title.press('Enter');
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'createTask',
      title: 'Write the docs',
      openAfter: false,
    });
    await expect(page.locator('[data-testid="create-form"]')).toHaveCount(0);
  });

  test('Shift+Enter sets openAfter', async ({ page }) => {
    await page.locator('[data-testid="action-create"]').click();
    await clearPostedMessages(page);
    const title = page.locator('[data-testid="cf-title"]');
    await title.fill('Open me after');
    await title.press('Shift+Enter');
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'createTask',
      title: 'Open me after',
      openAfter: true,
    });
  });

  test('full form sends category (non-Misc) and milestone (non-Backburner)', async ({ page }) => {
    await page.locator('[data-testid="action-create"]').click();
    await page.locator('[data-testid="cf-title"]').fill('Feature X');
    await page.locator('[data-testid="cf-category"]').selectOption('Features');
    await page.locator('[data-testid="cf-priority"]').selectOption('high');
    await page.locator('[data-testid="cf-milestone"]').selectOption('v1');
    await clearPostedMessages(page);
    await page.locator('[data-testid="cf-submit"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'createTask',
      title: 'Feature X',
      category: 'Features',
      priority: 'high',
      milestone: 'v1',
    });
  });

  test('Misc category is omitted (no category)', async ({ page }) => {
    await page.locator('[data-testid="action-create"]').click();
    await page.locator('[data-testid="cf-title"]').fill('Uncategorized');
    // category defaults to Misc
    await clearPostedMessages(page);
    await page.locator('[data-testid="cf-submit"]').click();
    const msg = await getLastPostedMessage(page);
    expect(msg).toMatchObject({ type: 'createTask', title: 'Uncategorized' });
    expect((msg as Record<string, unknown>).category).toBeUndefined();
    expect((msg as Record<string, unknown>).milestone).toBeUndefined();
  });

  test('quick capture (openCreateForm quick) is title-only', async ({ page }) => {
    await postMessageToWebview(page, { type: 'openCreateForm', mode: 'quick' });
    await page.waitForTimeout(60);
    await expect(page.locator('[data-testid="create-form"]')).toBeVisible();
    await expect(page.locator('[data-testid="cf-category"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="cf-description"]')).toHaveCount(0);
    const title = page.locator('[data-testid="cf-title"]');
    await title.fill('Just a title');
    await clearPostedMessages(page);
    await title.press('Enter');
    const msg = await getLastPostedMessage(page);
    expect(msg).toMatchObject({ type: 'createTask', title: 'Just a title' });
    expect((msg as Record<string, unknown>).category).toBeUndefined();
  });

  test('bug mode relabels priority to Severity and sends taskType:bug + causedBy', async ({
    page,
  }) => {
    await postMessageToWebview(page, {
      type: 'openCreateForm',
      mode: 'full',
      bugMode: true,
      causedBy: 'TASK-1',
    });
    await page.waitForTimeout(60);
    await expect(page.locator('[data-testid="create-form"]')).toBeVisible();
    // caused_by pre-filled; category/milestone hidden; priority relabeled in bug mode.
    await expect(page.locator('[data-testid="cf-causedby"]')).toHaveValue('TASK-1');
    await expect(page.locator('[data-testid="cf-category"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="cf-milestone"]')).toHaveCount(0);
    // N1: hard assertion — the relabel renders in the priority label's <span> ({priorityLabel}),
    // so assert on the form container, not the Task|Bug toggle row.
    await expect(page.locator('[data-testid="create-form"]')).toContainText('Severity');
    await page.locator('[data-testid="cf-title"]').fill('It crashes');
    await page.locator('[data-testid="cf-priority"]').selectOption('high');
    await clearPostedMessages(page);
    await page.locator('[data-testid="cf-submit"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'createTask',
      title: 'It crashes',
      taskType: 'bug',
      causedBy: 'TASK-1',
      priority: 'high',
    });
  });

  test('Report bug from a node opens the form in bug mode with caused_by prefilled', async ({
    page,
  }) => {
    await page.locator('[data-testid="tree-node-TASK-1"]').click();
    await expect(page.locator('[data-testid="tree-popover"]')).toBeVisible();
    await page.locator('[data-testid="tp-action-reportBug"]').click();
    await expect(page.locator('[data-testid="create-form"]')).toBeVisible();
    await expect(page.locator('[data-testid="cf-causedby"]')).toHaveValue('TASK-1');
    await page.locator('[data-testid="cf-title"]').fill('Regression from TASK-1');
    await clearPostedMessages(page);
    await page.locator('[data-testid="cf-submit"]').click();
    expect(await getLastPostedMessage(page)).toMatchObject({
      type: 'createTask',
      title: 'Regression from TASK-1',
      taskType: 'bug',
      causedBy: 'TASK-1',
    });
  });

  test('Escape closes the form without posting', async ({ page }) => {
    await page.locator('[data-testid="action-create"]').click();
    await expect(page.locator('[data-testid="create-form"]')).toBeVisible();
    await clearPostedMessages(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="create-form"]')).toHaveCount(0);
    expect((await getPostedMessages(page)).some((m) => m.type === 'createTask')).toBe(false);
  });
});
```

> **Wire-field note (Q1):** the bug matchers assert **`taskType: 'bug'`** — the blessed wire rename (see the locked-names paragraph). Do not "restore" a `type: 'bug'` object key: a duplicate `type` key in the matcher literal would silently collapse onto the envelope discriminant and pass against a broken message.

- [ ] **Step 2: Run Playwright**

Run: `bun run build && bun run test:playwright -- tree-authoring`
Expected: PASS (all new cases). Then run the full webview suite `bun run test:playwright` to confirm the baseline **333** still holds with exactly one intentional delta: the `keyboard-shortcuts.spec.ts` `n`-key test, already updated in **Task 4 Step 3b** (B2). No other baseline spec is affected — review verified no e2e spec references `action-create`, and the create-form host is otherwise additive.

- [ ] **Step 3: Commit**

```bash
git add e2e/tree-authoring.spec.ts
git commit --no-verify -m "test(tree P3a): Playwright tree-authoring — form open/create/quick/bug/reportBug

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: CDP cross-view test — create in the form ⇒ node appears + file written [opus-integration]

**Files:**

- Create: `src/test/cdp/tree-authoring.test.ts`

**Behavior (directive 12):** in a real VS Code instance, opening the create form (TabBar `+`), typing a title, and clicking **Create** writes a new task file to `backlog/tasks/` and the new node appears on the tree. Reuses the CDP library (`src/test/cdp/lib/`) and the same harness scaffold as `tree-popover.test.ts`.

> **CDP notes:** runs via `bun run test:cdp` (build + `vitest run --config vitest.cdp.config.ts`, xvfb on headless Linux). Use a fresh CDP port (`9342` — `9340`/`9341` are taken by `cross-view`/`tree-popover`). The create form is driven entirely by clicking `[data-testid="action-create"]` then the form's own controls, so **no new `taskwright.*` command keybinding** is needed in `cdp-helpers.ts`'s `COMMAND_KEYBINDINGS` (avoid adding one). The fixture workspace seeds `TASK-1..TASK-8`; the created task is the next id. `resetTestWorkspace` restores `backlog/tasks` between tests. See `docs/cdp-testing-notes.md`.

- [ ] **Step 1: Write the CDP spec**

Create `src/test/cdp/tree-authoring.test.ts`:

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
  typeInWebviewInput,
  elementExistsInWebview,
  clearWebviewSessionCache,
} from './lib/webview-helpers';
import { dismissNotifications, resetEditorState, executeCommand, sleep } from './lib/cdp-helpers';

const CDP_PORT = 9342;

function tasksDir(workspacePath: string): string {
  return path.join(workspacePath, 'backlog', 'tasks');
}

/** Poll the tasks dir for a file whose content contains `needle`; returns its parsed TASK-id. */
async function waitForTaskContaining(
  workspacePath: string,
  needle: string,
  timeoutMs = 15_000
): Promise<string> {
  const dir = tasksDir(workspacePath);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!f.endsWith('.md')) continue;
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      if (content.includes(needle)) {
        const idMatch = content.match(/^id:\s*(TASK-[0-9.]+)/m);
        if (idMatch) return idMatch[1];
      }
    }
    await sleep(250);
  }
  throw new Error(`No task file containing "${needle}" within ${timeoutMs}ms`);
}

async function waitForTreeNode(
  instance: VsCodeInstance,
  taskId: string,
  timeoutMs = 10_000
): Promise<void> {
  const selector = `[data-testid="tree-node-${taskId}"]`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await elementExistsInWebview(instance.cdp, 'tasks', selector)) return;
    await sleep(200);
  }
  throw new Error(`Tree node "${selector}" not found within ${timeoutMs}ms`);
}

describe('Tree authoring cross-view (CDP)', () => {
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
    await resetEditorState(instance.cdp);
    await dismissNotifications(instance.cdp);
    await executeCommand(instance.cdp, 'taskwright.refresh');
    await waitForWebviewContent(instance.cdp, 'tasks', 'TASK-', { timeoutMs: 10_000 });
  }, 30_000);

  it('creating a task in the form writes the file and adds a tree node', async () => {
    // Open the form via the TabBar + (always visible, any tab).
    const opened = await clickInWebview(instance.cdp, 'tasks', '[data-testid="action-create"]');
    expect(opened).toBe(true);
    const formShown = await elementExistsInWebview(
      instance.cdp,
      'tasks',
      '[data-testid="create-form"]'
    );
    expect(formShown).toBe(true);

    const typed = await typeInWebviewInput(
      instance.cdp,
      'tasks',
      '[data-testid="cf-title"]',
      'CDP authoring task',
      { clearFirst: true }
    );
    expect(typed).toBe(true);
    const created = await clickInWebview(instance.cdp, 'tasks', '[data-testid="cf-submit"]');
    expect(created).toBe(true);

    // File written to disk (the parity core ran through BacklogWriter.createTask).
    const newId = await waitForTaskContaining(workspacePath, 'CDP authoring task');
    expect(newId).toMatch(/^TASK-\d+$/);

    // Node appears on the tree (board refreshed cross-view).
    await clickInWebview(instance.cdp, 'tasks', '[data-testid="tab-tree"]');
    await waitForTreeNode(instance, newId);
  }, 60_000);
});
```

- [ ] **Step 2: Run the CDP suite**

Run: `bun run test:cdp` (or, faster during iteration after a build: `vitest run --config vitest.cdp.config.ts src/test/cdp/tree-authoring.test.ts`).
Expected: PASS alongside the existing CDP suites (baseline **15/15** + this file). If `typeInWebviewInput` needs the title focused first, the helper clears+focuses via the inner frame; if a click misses because the form overlay animates in, add a short `await sleep(150)` after opening. Do **not** weaken the disk assertion — a failure there is a real create-path regression.

- [ ] **Step 3: Commit**

```bash
git add src/test/cdp/tree-authoring.test.ts
git commit --no-verify -m "test(tree P3a): CDP cross-view — create form writes the task file + adds a tree node

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Full gate + CLAUDE.md doc-sync + visual proof + close [opus-integration]

**Files:** `CLAUDE.md` (doc-sync) + verification/proof (no other code).

- [ ] **Step 1: Full regression gate**

Run, in the worktree:

```bash
bun run test && bun run lint && bun run typecheck && bun run test:playwright
```

Expected: PASS. Unit: baseline **1385 passed / 1 skipped** minus the deleted `TaskCreatePanel.test.ts` cases, plus the new `createTaskCore` suite and the two `TasksController` create-case tests — record the exact new total. Playwright: baseline **333** + the new `tree-authoring` cases, with the one intentional baseline delta from Task 4 Step 3b (`keyboard-shortcuts.spec.ts`: `n` opens the form instead of posting `requestCreateTask`). Lint zero-warning; typecheck clean. (Windows: the ~22 known upstream POSIX-path unit failures are pre-existing and unrelated — do not "fix".)

- [ ] **Step 2: CDP proof**

Run: `bun run test:cdp` (headless Linux uses xvfb). Expected: the new `tree-authoring` CDP test passes alongside the existing **15/15**.

- [ ] **Step 3: CLAUDE.md doc-sync**

In `CLAUDE.md`, **amend the P2b bullet** to fix the two wording nits (directive 13). Replace (`CLAUDE.md:105-107`):

```md
- **Tech-tree interaction shell (P2b)** ✅: node-centric actions replace the old detail-panel banners.
  `DetailPopover.svelte` surfaces state-aware claim / set-active / dispatch / promote actions on a tree
  node and drives an ephemeral active task (`popoverActiveChanged` message); `src/core/cancelDispatch.ts`
```

with:

```md
- **Tech-tree interaction shell (P2b)** ✅: node-centric actions replace the old detail-panel banners.
  `DetailPopover.svelte` surfaces state-aware claim / dispatch actions on a tree node and drives an
  **ephemeral** active task via popover open/close (`popoverActiveChanged` message) — there is no
  "Set active" control (the `backlog.setActiveTask` / `backlog.clearActiveTask` commands remain).
  **Promote** lives on draft `TreeNode`s and the canvas "Promote all proposed" button, **not** the
  popover. `src/core/cancelDispatch.ts`
```

Then **add the P3a additions bullet** immediately after the P2b bullet closes (`CLAUDE.md:112`):

```md
- **Tech-tree create surface (P3a)** ✅: a **human** authors tasks from the board via one unified
  `CreateTaskForm.svelte` (full / quick / bug modes), hosted at the `Tasks.svelte` root so it works from
  any tab. Triggers: in-webview `Ctrl/Cmd-N` & bare `n` (full), `Ctrl/Cmd-Shift-N` (quick), the TabBar
  `+`, the repointed `taskwright.createTask` / new `taskwright.quickCapture` commands (`contributes.keybindings`,
  scoped to the board via `activeWebviewPanelId`/`focusedView`), and a **Report bug** popover action
  (`onCreateInPlace({bugMode,causedBy})`). Every path posts one locked `createTask` message. The MCP
  `createTaskHandler` and the `TasksController` `createTask` case both call the shared vscode-free core
  `src/core/createTaskCore.ts` (`createTaskWithTreeFields`) — one writer sequence for human and agent
  (parity). `linkTo` post-create dependency wiring is built here (P3b's drop-on-empty reuses it). The
  legacy `TaskCreatePanel` is retired. Coverage: `src/test/unit/createTaskCore.test.ts`,
  `e2e/tree-authoring.spec.ts`, `src/test/cdp/tree-authoring.test.ts`. Design:
  `docs/superpowers/specs/2026-07-02-tech-tree-p3-create-edit-design.md`; plan:
  `docs/superpowers/plans/2026-07-03-tech-tree-p3a-create-surface.md`.
```

Also update the P2b coverage line if it still reads as if create actions are unproven — leave `e2e/tree-popover.spec.ts` references intact (they remain valid).

- [ ] **Step 4: Visual proof**

Invoke the **`visual-proof`** skill (`.claude/skills/visual-proof/`) to produce a showboat doc capturing: the create form in **full** mode (Task|Bug toggle, Category/Priority/Milestone/Description); **quick** capture (title-only); **bug** mode (Severity relabel + Caused-by search); the **Report bug** popover action opening the bug form pre-filled; and (CDP path) a create → the new node appearing on the tree with its task file written. Prefer the CDP (real-VS-Code) path for the create→node/file flow since it spans views; the Vite-fixture path is fine for the isolated form visuals. Save under the skill's output location (git-ignored screenshots).

- [ ] **Step 5: Commit the doc-sync**

```bash
git add CLAUDE.md
git commit --no-verify -m "docs(tree P3a): CLAUDE.md doc-sync — P3a create-surface bullet + P2b wording nits

- add the P3a create-surface bullet (unified form, triggers, shared create core, retire panel)
- P2b nits: drop the non-existent 'Set active' control (active is ephemeral via popover
  open/close); state Promote lives on draft nodes + the canvas button, not the popover

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Hand back to the orchestrator**

Confirm the worktree is clean (`git status` shows nothing uncommitted), all gates are green (unit + Playwright + CDP + lint + typecheck), and update the run ledger. **Do NOT run `request_merge`** — in this run the orchestrator lands the branch (ff-merge). Stop at "worktree clean, all gates green, ledger updated".

---

## Self-Review

**1. Directive → task mapping (P3a slice):**

- **Dir 1 (shared create core + parity + `linkTo`)** → Task 1 (`createTaskCore.ts`, MCP `createTaskHandler` refactor, moved `normalizeType`, cycle-guarded `linkTo`).
- **Dir 2 (`CreateTaskForm.svelte` full/quick/bug + vocab)** → Task 3.
- **Dir 3 (triggers & keybinding delivery)** → Task 4 (keydown `Ctrl/Cmd-N`/`n`/`Ctrl/Cmd-Shift-N`, TabBar `+`, command repoint, `taskwright.quickCapture`, `contributes.keybindings`).
- **Dir 4 (`createTask` handler + retire panel)** → Task 2 (message repurpose + controller case) + Task 4 (delete `TaskCreatePanel` + its test; all entry points land on `CreateTaskForm`).
- **Dir 5 (bug & one-off intake)** → Task 5 (`reportBug` popover action → `onCreateInPlace({bugMode,causedBy})`) + Task 3 (bug mode: severity relabel, caused_by search, no lane/age; quick capture = title-only → Misc/Backburner/To Do).
- **Dir 12 (testing)** → Task 1 (`createTaskCore.test.ts`) + Task 2 (`TasksController` create case) + Task 6 (Playwright `tree-authoring.spec.ts`) + Task 7 (CDP `tree-authoring.test.ts`).
- **Dir 13 (doc-sync)** → Task 8 (P3a bullet + P2b nits).

**2. Locked-message compliance:** `createTask` (full locked schema incl. `linkTo?`/`openAfter?`) and `openCreateForm` are used verbatim, with **one orchestrator-blessed deviation (Q1)**: the task-type wire field is `taskType?: 'bug'` instead of the literal `type?` (which is unsatisfiable in a discriminated union — TS2300 + discriminant clobber); the core arg stays `type` so MCP parity is untouched, and P3b must use `taskType` on the wire. Commands `taskwright.createTask` (repointed) / `taskwright.quickCapture` (new) match. `reslotTask`/`addDependency`/`removeDependency`/`navigatorMinimapPan` are **not** implemented and **not** referenced (P3b). `linkTo.direction` semantics are defined in Task 1 (`'unlocks'` ⇒ new depends on origin; `'needs'` ⇒ origin depends on new) and match `addDependency{taskId,dependsOn}` so P3b maps handles 1:1.

**3. Parity:** the MCP `createTaskHandler` and the controller `createTask` case both call `createTaskWithTreeFields`; the handler keeps status/priority/dependency-existence validation and delegates the writer sequence, so `mcpWriteHandlers.test.ts` stays green. No create business logic in the webview.

**4. Scope discipline:** no canvas drag, no geometry inverse, no empty-canvas click trigger, no new MCP tool. The `onCreateInPlace` prop + `linkTo` are pathway-only for P3b (linkTo cycle-guarded but never set by the P3a form). Kanban/list/dashboard and the P2b popover/panel/navigator are untouched.

**5. Leaves-first build integrity:** each task ends green (`bun run build` + relevant tests). Task 3 (component) lands before Task 4 (host); Task 4 declares the `onCreateInPlace` prop on `Props` only, and Task 5 destructures + consumes it in one commit (N2 — no unused-binding lint window); the message + controller case (Task 2) precede the webview posting it (Task 4). The one baseline-test delta (B2, `keyboard-shortcuts.spec.ts` `n`-key) is updated in the **same commit** as the repoint (Task 4 Step 3b), so the Playwright suite is green at every commit.

**6. Verify commands are per-task and concrete** (`bun run test -- createTaskCore`, `… -- TasksController`, `bun run test:playwright -- tree-authoring`, `bun run test:cdp`, plus the full gate in Task 8). Commits stage only named files and use `--no-verify` (Windows CRLF hook).
