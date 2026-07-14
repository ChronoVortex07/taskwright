# Tech-tree P1 — task model & dependency gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every code block is complete and runnable — do not summarize, do not defer.

**Goal:** Ship the foundation of the tech-tree overhaul: the **data model**, **dependency gating**, and **validation**. Give tasks the fields that make them tree nodes (`category`, `type: bug`, `caused_by`), turn `dependencies` into a real gate (locked tasks refuse claim/dispatch, human-only force override), enforce the bug-completion rule, derive lane/band/depth/subRow layout as a pure function, and surface all of it through the MCP read/write tools. No canvas — everything is testable headlessly.

**Architecture:** Four new **vscode-free pure cores** in `src/core/` (`priorityOrder.ts`, `treeGate.ts`, `treeLayout.ts`, `treeDerived.ts`) plus one file-backed surgical writer (`TreeFieldService.ts`) cloned from `PlanService`. `category`/`caused_by` are **Taskwright-only fields written surgically** through `frontmatterEdit.ts` (byte-for-byte Backlog.md round-trip, CRLF preserved) — never through `BacklogWriter`'s canonical serializer (see Task 8 for the investigation that locks this). Derived state (`locked`, `blockedBy`, `bugs`, `activeBugIds`, `layout`) is computed at load in `TasksController` and in the MCP handlers via one shared derive pass, never stored. The MCP surface enforces the gate and the bug rule; the UI adds a human-only `taskwright.forceClaimTask` override.

**Tech Stack:** TypeScript, Vitest (`src/test/unit/`), Bun (`bun run test` / `lint` / `typecheck`). Pure cores use no I/O; file-backed services and MCP write handlers use the repo's established test patterns (fs-mock for `TreeFieldService`, real temp dirs for MCP write handlers).

## Where this fits

This is the sole plan for **P1** of the tech-tree overhaul (`docs/superpowers/specs/2026-07-01-tech-tree-overhaul-vision.md`), planning `docs/superpowers/specs/2026-07-01-tech-tree-p1-model-and-gating-design.md` (including its authoritative §10 Amendments). P2 (canvas), P3 (create UX), and P4–P6 (agent tools, indexing) inherit this model and gate. Do not build any canvas/rendering here.

---

## Global Constraints

_Every task's requirements implicitly include this section._

- **Runtime:** Node **≥ 22**; build/test via **Bun** (`bun run test`, `bun run lint`, `bun run typecheck`).
- **Worktree isolation:** all work happens in the worktree `.worktrees/tech-tree-p1` on branch `tech-tree-p1`. `cd` into it first; run every git/file/test command there. **Never `git checkout`/`commit`/`merge` at the repo root** — it is shared. A fresh worktree has no `node_modules`; run `bun install` there once before building or testing.
- **Core purity:** `priorityOrder.ts`, `treeGate.ts`, `treeLayout.ts` are **pure** (no `fs`, no `child_process`, no `vscode`). `treeDerived.ts` is pure except the single documented convenience `loadTreeStateFromParser(parser)` (reads via `BacklogParser`, still vscode-free). `TreeFieldService.ts` is file-backed but vscode-free.
- **CRLF-preserving write idiom:** every disk write to a task file goes through the `ClaimService`/`PlanService` `rewrite` idiom — `raw = readFileSync` → `hasCRLF = detectCRLF(raw)` → `transform(normalizeToLF(raw))` → `writeFileSync(restoreLineEndings(updated, hasCRLF))` → `parser.invalidateTaskCache(filePath)`. Never call a pure `frontmatterEdit` helper on raw file bytes directly.
- **LF line endings for source:** repo git config is `autocrlf=false`, `eol=lf`; committed blobs are LF.
- **Byte-for-byte Backlog.md compatibility:** `category`/`caused_by` are surgical Taskwright-only fields; canonical Backlog.md frontmatter must round-trip untouched (mirror the `claims.ts`/`PlanService.ts` tests).
- **Windows path convention:** assert with `path.*` helpers, not literal POSIX separators. (~22 upstream unit tests assert POSIX paths and fail on Windows **by design** — do not "fix" the code to match them; confirm only that your new suites and previously-green suites pass.)
- **Baseline is green** at HEAD (1284 passed / 1 skipped). Any red test after your change is yours.
- **TDD:** write the failing test first; run it red; implement minimally; run it green; then commit. UI-only/wiring changes (Task 10's provider/command edits) follow the house exception (document why) but still ship behind unit-tested cores.
- **Before every commit:** `bun run test`, `bun run lint`, `bun run typecheck` (all green for your suites). Commit after each task with a conventional message referencing "tech-tree P1".
- **Commit trailer:** end each commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (workers substitute their own model line per `AGENTS.md`, e.g. `Claude Haiku 4.5`).
- **Sync mode is ON (`github`) in this repo:** `backlog/tasks` is materialized and git-ignored-by-machinery (shows untracked at root — never `git add` it). Claim/release route through the sync engine; the MCP claim gate you add runs **before** that fork so it applies in every mode.

---

## File Structure

**Create (core):**

- `src/core/priorityOrder.ts` — config-driven priority ordering (Task 1).
- `src/core/TreeFieldService.ts` — surgical `category`/`caused_by` writers (Task 3).
- `src/core/treeGate.ts` — pure gating + cycle detection + done-status helper (Task 4).
- `src/core/treeLayout.ts` — pure lane/band/depth/subRow derivation (Task 5).
- `src/core/treeDerived.ts` — pure `deriveTreeState` + `loadTreeStateFromParser` convenience (Task 6).

**Create (tests):**

- `src/test/unit/priorityOrder.test.ts` (Task 1)
- `src/test/unit/TreeFieldService.test.ts` (Task 3)
- `src/test/unit/treeGate.test.ts` (Tasks 4, 10)
- `src/test/unit/treeLayout.test.ts` (Task 5)
- `src/test/unit/treeDerived.test.ts` (Task 6)

**Modify:**

- `src/core/types.ts` — relax `TaskPriority`; add `category`/`causedBy` + derived fields to `Task`; add `categories` to `BacklogConfig` (Tasks 1, 2, 6).
- `src/core/ordinalUtils.ts` — relax `CardData.priority` to `string` (Task 1).
- `src/core/BacklogParser.ts` — `RawFrontmatter` + `applyFrontmatter` for `category`/`caused_by`; relax `parsePriority`; add `getCategories()` (Tasks 1, 2).
- `src/providers/TasksController.ts` — enrich payload with derived tree state (Task 6).
- `src/mcp/handlers.ts` — `TaskSummary`/`toSummary`/`requireSummary`/`getActiveTask` derive pass; `create_task`/`edit_task` fields + validation + TreeFieldService; `claim_task` gate; `complete_task` bug rule (Tasks 7, 8, 9).
- `src/mcp/server.ts` — instantiate `TreeFieldService`; extend `create_task`/`edit_task` schemas (Task 8).
- `src/mcp/taskWriteHelpers.ts` — `assertValidPriority(priority, allowed)` (Task 8).
- `src/test/unit/taskWriteHelpers.test.ts` — update for new signature (Task 8).
- `src/test/unit/mcpWriteHandlers.test.ts` — new create/edit/complete/claim coverage (Tasks 7, 8, 9).
- `src/providers/dispatchActions.ts` — refuse dispatch of a locked task (Task 10).
- `src/providers/claimActions.ts` — `force` param + lock modal (Task 10).
- `src/providers/TaskDetailProvider.ts` — config-driven `priorities` in `TaskDetailData` (Task 10).
- `src/test/unit/TaskDetailProvider.test.ts` — config priorities assertion + `getConfig` mock (Task 10).
- `src/extension.ts` — register `taskwright.forceClaimTask` (Task 10).
- `package.json` — contribute `taskwright.forceClaimTask` command (Task 10).

---

## Task 1: `priorityOrder.ts` + relax `TaskPriority`

**Files:**

- Create: `src/core/priorityOrder.ts`
- Test: `src/test/unit/priorityOrder.test.ts`
- Modify: `src/core/types.ts`, `src/core/ordinalUtils.ts`, `src/core/BacklogParser.ts`

**Interfaces:**

- Consumes: `BacklogConfig` (only `.priorities?: string[]`).
- Produces:
  - `export const DEFAULT_PRIORITIES: readonly string[]` = `['high', 'medium', 'low']`
  - `export function resolvePriorities(config: { priorities?: string[] }): string[]`
  - `export function priorityRank(value: string | undefined, priorities: string[]): number` — case-insensitive index; unknown/absent → `priorities.length` (sorts last).
  - `export function comparePriority(a: string | undefined, b: string | undefined, priorities: string[]): number`
- Type ripple (enumerated from `grep TaskPriority`): the single source `TaskPriority` in `src/core/types.ts:13` is re-exported by `src/webview/lib/types.ts` and consumed by `BacklogParser.ts` (`:7` import, `:984` `parsePriority`), `ordinalUtils.ts` (`CardData.priority`), and four `.svelte` files (`TaskHeader`, `TaskPreviewView`, `CompactTaskDetails`, `PriorityIcon`). `bun run typecheck` is `tsc --noEmit` (does **not** compile `.svelte`), so the only `.ts` edits needed for a green typecheck are: relax `TaskPriority` to `string` (types.ts), relax `CardData.priority?: string` (ordinalUtils.ts), and the `parsePriority` body (BacklogParser.ts). The `.svelte` files keep working because they use `string | undefined` and their `Record<TaskPriority, string>` literals stay assignable to `Record<string, string>`; config-driven priority plumbing into `TaskHeader`/detail is Task 10.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/priorityOrder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PRIORITIES,
  resolvePriorities,
  priorityRank,
  comparePriority,
} from '../../core/priorityOrder';
import { BacklogParser } from '../../core/BacklogParser';

describe('priorityOrder', () => {
  describe('resolvePriorities', () => {
    it('returns the default high/medium/low when config has none', () => {
      expect(resolvePriorities({})).toEqual(['high', 'medium', 'low']);
      expect(resolvePriorities({ priorities: [] })).toEqual(['high', 'medium', 'low']);
      expect([...DEFAULT_PRIORITIES]).toEqual(['high', 'medium', 'low']);
    });

    it('uses the config list (order preserved) when present, trimming blanks', () => {
      expect(resolvePriorities({ priorities: [' Critical ', 'Normal', '', 'Low'] })).toEqual([
        'Critical',
        'Normal',
        'Low',
      ]);
    });
  });

  describe('priorityRank', () => {
    const order = ['high', 'medium', 'low'];
    it('is the case-insensitive index in the order', () => {
      expect(priorityRank('high', order)).toBe(0);
      expect(priorityRank('MEDIUM', order)).toBe(1);
      expect(priorityRank('low', order)).toBe(2);
    });
    it('sorts unknown/absent last', () => {
      expect(priorityRank('nope', order)).toBe(3);
      expect(priorityRank(undefined, order)).toBe(3);
    });
  });

  describe('comparePriority', () => {
    const order = ['Critical', 'Normal', 'Low'];
    it('orders by config rank, unknown/absent last', () => {
      const sorted = ['Low', undefined, 'Critical', 'Normal'].sort((a, b) =>
        comparePriority(a, b, order)
      );
      expect(sorted).toEqual(['Critical', 'Normal', 'Low', undefined]);
    });
  });
});

describe('BacklogParser.parsePriority (exact-match, verbatim passthrough)', () => {
  const parser = new BacklogParser('/fake/path');
  const parse = (priority: string): string | undefined =>
    parser.parseTaskContent(
      `---\nid: TASK-1\ntitle: T\nstatus: To Do\nassignee: []\ndependencies: []\npriority: ${priority}\n---\n\n## Description\n\nBody.\n`,
      '/fake/path/tasks/task-1 - T.md'
    )?.priority;

  it('normalizes case for the legacy high/medium/low tokens', () => {
    expect(parse('High')).toBe('high');
  });
  it('passes custom priorities through verbatim (never substring-collapsed)', () => {
    expect(parse('critical')).toBe('critical');
    expect(parse('Highest')).toBe('Highest'); // NOT collapsed to 'high'
    expect(parse('Follow-up')).toBe('Follow-up'); // NOT collapsed to 'low'
  });
  it('treats empty / whitespace-only as undefined', () => {
    expect(parse('')).toBeUndefined();
    expect(parse('   ')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- priorityOrder`
Expected: FAIL — cannot resolve `../../core/priorityOrder`.

- [ ] **Step 3: Implement**

Create `src/core/priorityOrder.ts`:

```ts
/**
 * Config-driven priority ordering for the tech tree (P1 §10 amendment). Priority
 * is a user-defined, highest-first ordered list sourced from config `priorities`
 * (falling back to the legacy high/medium/low). Bug severity reuses this list.
 * All comparisons are case-insensitive; an unknown or absent priority sorts last.
 */
export const DEFAULT_PRIORITIES: readonly string[] = ['high', 'medium', 'low'];

/** The effective, highest-first priority list: config `priorities` (trimmed, blanks dropped) or the default. */
export function resolvePriorities(config: { priorities?: string[] }): string[] {
  const configured = (config.priorities ?? []).map((p) => String(p).trim()).filter(Boolean);
  return configured.length > 0 ? configured : [...DEFAULT_PRIORITIES];
}

/** Case-insensitive index of `value` in `priorities`; `priorities.length` (sorts last) when unknown/absent. */
export function priorityRank(value: string | undefined, priorities: string[]): number {
  if (!value) return priorities.length;
  const lower = value.trim().toLowerCase();
  const idx = priorities.findIndex((p) => p.toLowerCase() === lower);
  return idx === -1 ? priorities.length : idx;
}

/** Comparator: lower rank (higher priority) first; unknown/absent last; ties equal. */
export function comparePriority(
  a: string | undefined,
  b: string | undefined,
  priorities: string[]
): number {
  return priorityRank(a, priorities) - priorityRank(b, priorities);
}
```

Edit `src/core/types.ts` — relax the union to a string alias (keep the doc comment):

```ts
/**
 * Task priority. P1 §10 relaxed this from a fixed high|medium|low enum to a
 * user-defined ordered list sourced from config `priorities` (see priorityOrder.ts).
 */
export type TaskPriority = string;
```

Edit `src/core/ordinalUtils.ts` — relax `CardData.priority` (line ~9) so `Task.priority: string` assigns cleanly:

```ts
export interface CardData {
  taskId: string;
  ordinal: number | undefined;
  priority?: string;
}
```

(Leave `PRIORITY_ORDER`/`compareByOrdinal` unchanged — its fixed high/medium/low tiebreak stays as the drag-drop default; the tree uses `comparePriority` separately in Task 5.)

Edit `src/core/BacklogParser.ts` `parsePriority` (line ~984) to normalize the legacy `high`/`medium`/`low` tokens by **exact** (case-insensitive) match and pass every other non-empty trimmed value through **verbatim** — never collapse by substring. A user's custom config priority like `Highest` must not be mangled into `high` (nor `Follow-up` into `low`); no existing test depends on the old substring behavior:

```ts
  private parsePriority(value: string): TaskPriority | undefined {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const lower = trimmed.toLowerCase();
    if (lower === 'high' || lower === 'medium' || lower === 'low') {
      return lower as TaskPriority;
    }
    return trimmed;
  }
```

- [ ] **Step 4: Run tests to verify green**

Run: `bun run test -- priorityOrder`
Expected: PASS.
Run: `bun run test && bun run lint && bun run typecheck`
Expected: PASS (baseline suites still green; known Windows POSIX-path failures unrelated).

- [ ] **Step 5: Commit**

```bash
git add src/core/priorityOrder.ts src/test/unit/priorityOrder.test.ts src/core/types.ts src/core/ordinalUtils.ts src/core/BacklogParser.ts
git commit -m "feat(tech-tree P1): config-driven priority ordering; relax TaskPriority to string

- priorityOrder.ts: DEFAULT_PRIORITIES, resolvePriorities, priorityRank, comparePriority
- TaskPriority is now a string alias; parsePriority passes through custom values
- CardData.priority relaxed to string (no ripple to typecheck)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Model plumbing for `category` / `caused_by`

**Files:**

- Modify: `src/core/types.ts`, `src/core/BacklogParser.ts`
- Test: `src/test/unit/BacklogParser.test.ts` (append)

**Interfaces:**

- Consumes: existing `Task`, `RawFrontmatter`, `applyFrontmatter`, `getTasks`, `getConfig`.
- Produces:
  - `Task.category?: string`, `Task.causedBy?: string` (parsed from frontmatter `category` / `caused_by`; `Task.type?: string` already exists).
  - `BacklogConfig.categories?: string[]`.
  - `RawFrontmatter.category?: string`, `RawFrontmatter.caused_by?: string`.
  - `BacklogParser.getCategories(): Promise<string[]>` — config `categories` (order preserved) then categories seen on **non-bug** tasks (sorted, deduped, case-insensitive dedupe / case-preserving output). Reserved lanes `Bugs`/`Misc` are NOT included here.

- [ ] **Step 1: Write the failing test**

Append to `src/test/unit/BacklogParser.test.ts` (it already `import`s `describe/it/expect` and constructs `new BacklogParser('/fake/path')` driving `parseTaskContent`; reuse that style):

```ts
describe('category / caused_by parsing (tech-tree P1)', () => {
  it('parses category and caused_by from frontmatter', () => {
    const parser = new BacklogParser('/fake/path');
    const md = `---
id: TASK-1
title: A task
status: To Do
assignee: []
dependencies: []
category: Backend
type: bug
caused_by: TASK-9
---

## Description

Body.
`;
    const task = parser.parseTaskContent(md, '/fake/path/tasks/task-1 - A-task.md');
    expect(task?.category).toBe('Backend');
    expect(task?.type).toBe('bug');
    expect(task?.causedBy).toBe('TASK-9');
  });

  it('leaves category/causedBy undefined when absent', () => {
    const parser = new BacklogParser('/fake/path');
    const md = `---
id: TASK-2
title: B task
status: To Do
assignee: []
dependencies: []
---

## Description

Body.
`;
    const task = parser.parseTaskContent(md, '/fake/path/tasks/task-2 - B-task.md');
    expect(task?.category).toBeUndefined();
    expect(task?.causedBy).toBeUndefined();
  });
});

describe('getCategories (tech-tree P1)', () => {
  it('unions config categories (order preserved) with discovered non-bug categories (sorted)', async () => {
    const parser = new BacklogParser('/fake/path');
    vi.spyOn(parser, 'getConfig').mockResolvedValue({ categories: ['Platform', 'Backend'] });
    vi.spyOn(parser, 'getTasks').mockResolvedValue([
      { id: 'TASK-1', category: 'Backend' } as never, // already declared
      { id: 'TASK-2', category: 'UI' } as never, // discovered
      { id: 'TASK-3', category: 'Auth' } as never, // discovered
      { id: 'TASK-4', category: 'Ignored', type: 'bug' } as never, // bug: excluded
      { id: 'TASK-5' } as never, // no category: excluded (Misc)
    ]);
    expect(await parser.getCategories()).toEqual(['Platform', 'Backend', 'Auth', 'UI']);
  });
});
```

(If the test file does not already import `vi`, add it to the existing `vitest` import line.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- BacklogParser`
Expected: FAIL — `category`/`causedBy` undefined; `getCategories` is not a function.

- [ ] **Step 3: Implement**

Edit `src/core/types.ts` `Task` interface — add after `type?: string;` (line ~65):

```ts
  type?: string;
  /** Tech-tree lane: free-form single value; absent/empty ⇒ Misc lane. Taskwright-only, written surgically. */
  category?: string;
  /** For `type: 'bug'` nodes: the task ID that introduced the bug. Taskwright-only, written surgically. */
  causedBy?: string;
```

Edit `src/core/types.ts` `BacklogConfig` — add next to `labels?: string[];`:

```ts
  labels?: string[];
  /** Predeclared tech-tree lanes (mirrors `labels`); drives lane rendering + category autocomplete. */
  categories?: string[];
```

Edit `src/core/BacklogParser.ts` `RawFrontmatter` (line ~25) — add (`type?: string` already exists at BacklogParser.ts:37 — do not re-add it):

```ts
  category?: string;
  caused_by?: string;
```

Edit `applyFrontmatter` (after the `if (fm.type) { task.type = String(fm.type); }` block, ~line 735):

```ts
if (fm.category) {
  task.category = String(fm.category).trim();
}
if (fm.caused_by) {
  task.causedBy = String(fm.caused_by).trim();
}
```

Add `getCategories` to `BacklogParser` (next to `getUniqueLabels`, ~line 426):

```ts
  /**
   * Tech-tree lane vocabulary: config `categories` (order preserved) unioned with
   * categories found on non-bug tasks (sorted). Reserved lanes (Bugs/Misc) are
   * intentionally excluded — those are constants owned by the layout module.
   */
  async getCategories(): Promise<string[]> {
    const [tasks, config] = await Promise.all([this.getTasks(), this.getConfig()]);
    const result: string[] = [];
    const seen = new Set<string>();
    for (const raw of config.categories ?? []) {
      const value = String(raw).trim();
      if (value && !seen.has(value.toLowerCase())) {
        seen.add(value.toLowerCase());
        result.push(value);
      }
    }
    const discovered: string[] = [];
    for (const task of tasks) {
      if (task.type === 'bug') continue;
      const value = task.category?.trim();
      if (value && !seen.has(value.toLowerCase())) {
        seen.add(value.toLowerCase());
        discovered.push(value);
      }
    }
    discovered.sort((a, b) => a.localeCompare(b));
    return [...result, ...discovered];
  }
```

- [ ] **Step 4: Run tests to verify green**

Run: `bun run test -- BacklogParser`
Expected: PASS.
Run: `bun run lint && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/BacklogParser.ts src/test/unit/BacklogParser.test.ts
git commit -m "feat(tech-tree P1): parse category/caused_by; add getCategories + config categories

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `TreeFieldService.ts` — surgical `category` / `caused_by` writers

**Files:**

- Create: `src/core/TreeFieldService.ts`
- Test: `src/test/unit/TreeFieldService.test.ts`

**Interfaces:**

- Consumes: `BacklogParser`, `upsertScalarField`/`removeField` (`frontmatterEdit.ts`), `detectCRLF`/`normalizeToLF`/`restoreLineEndings` (`BacklogWriter.ts`).
- Produces:
  - `setCategory(taskId: string, category: string, parser: BacklogParser): Promise<string>` — stores trimmed value, returns it.
  - `clearCategory(taskId: string, parser: BacklogParser): Promise<void>`
  - `setCausedBy(taskId: string, causedBy: string, parser: BacklogParser): Promise<string>` — stores trimmed value, returns it.
  - `clearCausedBy(taskId: string, parser: BacklogParser): Promise<void>`
  - `clearType(taskId: string, parser: BacklogParser): Promise<void>` — surgically removes the `type` field (used by `edit_task` when clearing a bug back to a plain task; BacklogWriter has no omit-if-empty path for `type`). No `setType` — BacklogWriter already serializes a non-empty `type`.

This is a byte-for-byte clone of `PlanService` (same private `resolveFilePath` + `rewrite` CRLF idiom), operating on the `category` and `caused_by` frontmatter keys (plus a clear-only `type` remover). All three keys are distinct prefixes (no `fieldKeyRe` false-match risk).

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/TreeFieldService.test.ts` (mirrors `PlanService.test.ts` fs-mock pattern):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TreeFieldService } from '../../core/TreeFieldService';
import { BacklogParser } from '../../core/BacklogParser';
import * as fs from 'fs';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn().mockReturnValue({ mtimeMs: 1000 }),
  };
});

function mockReaddirSync(files: string[]) {
  vi.mocked(fs.readdirSync).mockReturnValue(files as unknown as ReturnType<typeof fs.readdirSync>);
}

const TASK = `---
id: TASK-1
title: Sample task
status: To Do
assignee: []
dependencies: []
---

## Description

Body stays intact.
`;

describe('TreeFieldService', () => {
  let service: TreeFieldService;
  let parser: BacklogParser;

  beforeEach(() => {
    service = new TreeFieldService();
    parser = new BacklogParser('/fake/backlog');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockReaddirSync(['task-1 - Sample-task.md']);
    vi.mocked(fs.readFileSync).mockReturnValue(TASK);
  });

  afterEach(() => vi.clearAllMocks());

  it('writes category the parser reads back, preserving canonical frontmatter + body', async () => {
    const stored = await service.setCategory('TASK-1', '  Backend  ', parser);
    expect(stored).toBe('Backend');
    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    expect(written).toContain('Body stays intact.');
    const task = parser.parseTaskContent(written, '/fake/backlog/tasks/task-1 - Sample-task.md');
    expect(task?.category).toBe('Backend');
    expect(task?.title).toBe('Sample task');
    expect(task?.status).toBe('To Do');
  });

  it('writes caused_by and replaces (never duplicates) an existing value', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      TASK.replace('---\n\n##', 'caused_by: TASK-8\n---\n\n##')
    );
    const stored = await service.setCausedBy('TASK-1', 'TASK-9', parser);
    expect(stored).toBe('TASK-9');
    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    expect((written.match(/^caused_by:/gm) ?? []).length).toBe(1);
    expect(written).toContain('caused_by: TASK-9');
  });

  it('clearCategory / clearCausedBy remove the fields idempotently', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      TASK.replace('---\n\n##', 'category: Backend\ncaused_by: TASK-9\n---\n\n##')
    );
    await service.clearCategory('TASK-1', parser);
    let written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    expect(written).not.toContain('category:');
    // caused_by survives an unrelated clear
    expect(written).toContain('caused_by: TASK-9');
  });

  it('clearType removes the type field surgically, leaving siblings intact', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      TASK.replace('---\n\n##', 'type: bug\ncategory: Backend\n---\n\n##')
    );
    await service.clearType('TASK-1', parser);
    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    expect(written).not.toContain('type:');
    // an unrelated sibling field survives the clear
    expect(written).toContain('category: Backend');
  });

  it('preserves CRLF line endings', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(TASK.replace(/\n/g, '\r\n'));
    await service.setCategory('TASK-1', 'Backend', parser);
    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    expect(written).toContain('\r\n');
  });

  it('invalidates the parser cache for the written file', async () => {
    const spy = vi.spyOn(parser, 'invalidateTaskCache');
    await service.setCategory('TASK-1', 'Backend', parser);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('task-1 - Sample-task.md') as unknown as string
    );
  });

  it('throws when the task does not exist', async () => {
    mockReaddirSync([]);
    await expect(service.setCategory('TASK-404', 'Backend', parser)).rejects.toThrow('TASK-404');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- TreeFieldService`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/core/TreeFieldService.ts`:

```ts
import * as fs from 'fs';
import { BacklogParser } from './BacklogParser';
import { detectCRLF, normalizeToLF, restoreLineEndings } from './BacklogWriter';
import { removeField, upsertScalarField } from './frontmatterEdit';

/**
 * File-backed read/write of the Taskwright-only tech-tree fields `category` and
 * `caused_by`. Like claims and the superpowers `plan` link, these are written
 * **surgically** through frontmatterEdit so Backlog.md's canonical frontmatter
 * round-trips byte-for-byte. Line endings are preserved (CRLF-safe).
 */
export class TreeFieldService {
  /** Set (or replace) the task's lane category. Returns the stored (trimmed) value. */
  async setCategory(taskId: string, category: string, parser: BacklogParser): Promise<string> {
    const value = category.trim();
    const filePath = await this.resolveFilePath(taskId, parser);
    this.rewrite(filePath, (content) => upsertScalarField(content, 'category', value), parser);
    return value;
  }

  /** Remove the lane category. Idempotent. */
  async clearCategory(taskId: string, parser: BacklogParser): Promise<void> {
    const filePath = await this.resolveFilePath(taskId, parser);
    this.rewrite(filePath, (content) => removeField(content, 'category'), parser);
  }

  /** Set (or replace) the bug's `caused_by` reference. Returns the stored (trimmed) value. */
  async setCausedBy(taskId: string, causedBy: string, parser: BacklogParser): Promise<string> {
    const value = causedBy.trim();
    const filePath = await this.resolveFilePath(taskId, parser);
    this.rewrite(filePath, (content) => upsertScalarField(content, 'caused_by', value), parser);
    return value;
  }

  /** Remove the `caused_by` reference. Idempotent. */
  async clearCausedBy(taskId: string, parser: BacklogParser): Promise<void> {
    const filePath = await this.resolveFilePath(taskId, parser);
    this.rewrite(filePath, (content) => removeField(content, 'caused_by'), parser);
  }

  /** Surgically remove the `type` field (clears a bug back to a plain task). Idempotent. */
  async clearType(taskId: string, parser: BacklogParser): Promise<void> {
    const filePath = await this.resolveFilePath(taskId, parser);
    this.rewrite(filePath, (content) => removeField(content, 'type'), parser);
  }

  private async resolveFilePath(taskId: string, parser: BacklogParser): Promise<string> {
    const task = await parser.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    return task.filePath;
  }

  private rewrite(
    filePath: string,
    transform: (content: string) => string,
    parser: BacklogParser
  ): void {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const hasCRLF = detectCRLF(raw);
    const updated = transform(normalizeToLF(raw));
    fs.writeFileSync(filePath, restoreLineEndings(updated, hasCRLF), 'utf-8');
    parser.invalidateTaskCache(filePath);
  }
}
```

- [ ] **Step 4: Run tests to verify green**

Run: `bun run test -- TreeFieldService`
Expected: PASS.
Run: `bun run lint && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/TreeFieldService.ts src/test/unit/TreeFieldService.test.ts
git commit -m "feat(tech-tree P1): TreeFieldService surgical category/caused_by writers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `treeGate.ts` — pure gating + cycle detection

**Files:**

- Create: `src/core/treeGate.ts`
- Test: `src/test/unit/treeGate.test.ts`

**Interfaces:**

- Consumes: `Task` (types only).
- Produces:
  - `export function resolveDoneStatus(statuses: string[] | undefined): string` — last configured status, else `'Done'` (the shared done-status convention; new gating code MUST use this rather than re-deriving it).
  - `export function dependencySatisfied(dep: Pick<Task, 'status' | 'folder'> | undefined, doneStatus: string): boolean` — `undefined` → `false`; folder `completed`/`archive` → `true`; `status === doneStatus` → `true`; else `false`.
  - `export function computeBlockedBy(task: Pick<Task, 'dependencies'>, tasksById: Map<string, Task>, doneStatus: string): string[]` — uppercase-normalized blocking dep IDs; a **missing** dep is blocking (and included).
  - `export function isLocked(task: Pick<Task, 'dependencies'>, tasksById: Map<string, Task>, doneStatus: string): boolean`
  - `export function wouldCreateCycle(tasks: Pick<Task, 'id' | 'dependencies'>[], fromId: string, toId: string): boolean` — would adding `toId` to `fromId`'s dependencies create a cycle? Case-insensitive IDs.
  - `export function blockedByMessage(taskId: string, blockedBy: string[]): string` — human-readable refusal string (reused by MCP/dispatch/claim messaging).

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/treeGate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Task } from '../../core/types';
import {
  resolveDoneStatus,
  dependencySatisfied,
  computeBlockedBy,
  isLocked,
  wouldCreateCycle,
  blockedByMessage,
} from '../../core/treeGate';

function task(partial: Partial<Task> & { id: string }): Task {
  return {
    id: partial.id,
    title: partial.title ?? partial.id,
    status: partial.status ?? 'To Do',
    labels: [],
    assignee: [],
    dependencies: partial.dependencies ?? [],
    acceptanceCriteria: [],
    definitionOfDone: [],
    filePath: `/b/tasks/${partial.id}.md`,
    ...partial,
  } as Task;
}

function byId(tasks: Task[]): Map<string, Task> {
  return new Map(tasks.map((t) => [t.id.toUpperCase(), t]));
}

describe('resolveDoneStatus', () => {
  it('uses the last configured status, else Done', () => {
    expect(resolveDoneStatus(['To Do', 'In Progress', 'Pending Review', 'Done'])).toBe('Done');
    expect(resolveDoneStatus(['Backlog', 'Shipped'])).toBe('Shipped');
    expect(resolveDoneStatus([])).toBe('Done');
    expect(resolveDoneStatus(undefined)).toBe('Done');
  });
});

describe('dependencySatisfied', () => {
  it('undefined dep is never satisfied (missing = blocking)', () => {
    expect(dependencySatisfied(undefined, 'Done')).toBe(false);
  });
  it('done status or completed/archive folder satisfies', () => {
    expect(dependencySatisfied({ status: 'Done', folder: 'tasks' }, 'Done')).toBe(true);
    expect(dependencySatisfied({ status: 'To Do', folder: 'completed' }, 'Done')).toBe(true);
    expect(dependencySatisfied({ status: 'To Do', folder: 'archive' }, 'Done')).toBe(true);
    expect(dependencySatisfied({ status: 'In Progress', folder: 'tasks' }, 'Done')).toBe(false);
  });
});

describe('computeBlockedBy / isLocked', () => {
  const done = 'Done';
  it('lists unsatisfied and missing deps; a done dep does not block', () => {
    const t = task({ id: 'TASK-1', dependencies: ['TASK-2', 'TASK-3', 'TASK-404'] });
    const map = byId([
      t,
      task({ id: 'TASK-2', status: 'Done' }),
      task({ id: 'TASK-3', status: 'In Progress' }),
    ]);
    expect(computeBlockedBy(t, map, done)).toEqual(['TASK-3', 'TASK-404']);
    expect(isLocked(t, map, done)).toBe(true);
  });
  it('a completed-folder dep satisfies the gate', () => {
    const t = task({ id: 'TASK-1', dependencies: ['TASK-2'] });
    const map = byId([t, task({ id: 'TASK-2', status: 'To Do', folder: 'completed' })]);
    expect(computeBlockedBy(t, map, done)).toEqual([]);
    expect(isLocked(t, map, done)).toBe(false);
  });
  it('no dependencies means unlocked', () => {
    const t = task({ id: 'TASK-1' });
    expect(isLocked(t, byId([t]), done)).toBe(false);
  });
});

describe('wouldCreateCycle', () => {
  it('detects self edge', () => {
    expect(wouldCreateCycle([task({ id: 'TASK-1' })], 'TASK-1', 'TASK-1')).toBe(true);
  });
  it('detects a direct back-edge', () => {
    const tasks = [task({ id: 'TASK-1' }), task({ id: 'TASK-2', dependencies: ['TASK-1'] })];
    // TASK-2 already depends on TASK-1; adding TASK-1 -> TASK-2 closes the cycle.
    expect(wouldCreateCycle(tasks, 'TASK-1', 'TASK-2')).toBe(true);
  });
  it('detects a transitive cycle', () => {
    const tasks = [
      task({ id: 'TASK-1' }),
      task({ id: 'TASK-2', dependencies: ['TASK-1'] }),
      task({ id: 'TASK-3', dependencies: ['TASK-2'] }),
    ];
    expect(wouldCreateCycle(tasks, 'TASK-1', 'TASK-3')).toBe(true);
  });
  it('allows a diamond with no cycle', () => {
    const tasks = [
      task({ id: 'TASK-1' }),
      task({ id: 'TASK-2', dependencies: ['TASK-1'] }),
      task({ id: 'TASK-3', dependencies: ['TASK-1'] }),
      task({ id: 'TASK-4' }),
    ];
    // TASK-4 depending on both TASK-2 and TASK-3 introduces no cycle.
    expect(wouldCreateCycle(tasks, 'TASK-4', 'TASK-2')).toBe(false);
    expect(wouldCreateCycle(tasks, 'TASK-4', 'TASK-3')).toBe(false);
  });
  it('is case-insensitive over IDs', () => {
    const tasks = [task({ id: 'TASK-1' }), task({ id: 'TASK-2', dependencies: ['task-1'] })];
    expect(wouldCreateCycle(tasks, 'task-1', 'TASK-2')).toBe(true);
  });
});

describe('blockedByMessage', () => {
  it('names the blockers', () => {
    expect(blockedByMessage('TASK-1', ['TASK-2', 'TASK-3'])).toContain('TASK-2, TASK-3');
    expect(blockedByMessage('TASK-1', ['TASK-2'])).toContain('TASK-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- treeGate`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/core/treeGate.ts`:

```ts
import type { Task } from './types';

/**
 * The shared "done" status convention: the last configured status, falling back
 * to 'Done'. Every dependency-gate consumer resolves done-ness through this one
 * helper so the gate can never drift from the board's terminal column.
 */
export function resolveDoneStatus(statuses: string[] | undefined): string {
  return statuses && statuses.length > 0 ? statuses[statuses.length - 1] : 'Done';
}

/**
 * A dependency is satisfied when it exists and is either at the done status or
 * lives in the completed/archive folder. A missing dependency (undefined) is
 * never satisfied — it counts as blocking.
 */
export function dependencySatisfied(
  dep: Pick<Task, 'status' | 'folder'> | undefined,
  doneStatus: string
): boolean {
  if (!dep) return false;
  if (dep.folder === 'completed' || dep.folder === 'archive') return true;
  return dep.status === doneStatus;
}

/** Uppercase-normalized IDs of the dependencies currently blocking `task` (missing deps included). */
export function computeBlockedBy(
  task: Pick<Task, 'dependencies'>,
  tasksById: Map<string, Task>,
  doneStatus: string
): string[] {
  const blocked: string[] = [];
  for (const rawId of task.dependencies) {
    const id = rawId.trim().toUpperCase();
    if (!id) continue;
    const dep = tasksById.get(id);
    if (!dependencySatisfied(dep, doneStatus)) blocked.push(id);
  }
  return blocked;
}

/** A task is locked iff at least one dependency is blocking. */
export function isLocked(
  task: Pick<Task, 'dependencies'>,
  tasksById: Map<string, Task>,
  doneStatus: string
): boolean {
  return computeBlockedBy(task, tasksById, doneStatus).length > 0;
}

/**
 * Would adding `toId` to `fromId`'s dependencies create a cycle? True for a self
 * edge, or when `toId` can already reach `fromId` by following dependency edges.
 * IDs are compared case-insensitively (the parser uppercases task IDs).
 */
export function wouldCreateCycle(
  tasks: Pick<Task, 'id' | 'dependencies'>[],
  fromId: string,
  toId: string
): boolean {
  const from = fromId.trim().toUpperCase();
  const to = toId.trim().toUpperCase();
  if (from === to) return true;

  const deps = new Map<string, string[]>();
  for (const t of tasks) {
    deps.set(
      t.id.trim().toUpperCase(),
      t.dependencies.map((d) => d.trim().toUpperCase())
    );
  }

  // Does `to` reach `from` via dependency edges? If so, from -> to closes a cycle.
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === from) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of deps.get(node) ?? []) stack.push(next);
  }
  return false;
}

/** Human-readable refusal string for a locked task. */
export function blockedByMessage(taskId: string, blockedBy: string[]): string {
  return `${taskId} is blocked by ${blockedBy.join(', ')} — finish or unblock those first.`;
}
```

- [ ] **Step 4: Run tests to verify green**

Run: `bun run test -- treeGate`
Expected: PASS.
Run: `bun run lint && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/treeGate.ts src/test/unit/treeGate.test.ts
git commit -m "feat(tech-tree P1): treeGate — dependency gate, cycle detection, done-status helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `treeLayout.ts` — pure lane/band/depth/subRow derivation

**Files:**

- Create: `src/core/treeLayout.ts`
- Test: `src/test/unit/treeLayout.test.ts`

**Interfaces:**

- Consumes: `Task`, `compareByOrdinal` (`ordinalUtils.ts`), `priorityRank` (`priorityOrder.ts`).
- Produces:
  - `export const BUGS_LANE = 'Bugs'`, `export const MISC_LANE = 'Misc'`, `export const BACKBURNER_BAND = 'Backburner'`
  - `export interface TreeLayout { lane: string; band: string; depth: number; subRow: number }`
  - `export interface DeriveLayoutOptions { categories: string[]; milestoneOrder: string[]; doneStatus: string; priorities: string[] }`
  - `export interface DeriveLayoutResult { layout: Map<string, TreeLayout>; warnings: string[]; laneOrder: string[]; bandOrder: string[] }`
  - `export function laneOf(task: Pick<Task, 'type' | 'category'>): string`
  - `export function deriveTreeLayout(tasks: Task[], opts: DeriveLayoutOptions): DeriveLayoutResult`

> **Note (spec vs. directive reconciliation — flagged, not silently resolved):**
> (a) The directive's abbreviated opts list omits `categories`; but `laneOrder` must "include empty declared lanes," which requires the declared-category list as input. `categories` is added to `DeriveLayoutOptions` (fed from `parser.getCategories()`, which already returns config-order + discovered-sorted).
> (b) The directive says in-cell tie-break is "`compareByOrdinal` then `priorityRank` then id," but `compareByOrdinal` already embeds a **fixed** high/medium/low priority + id tiebreak that would shadow §10's config-driven `priorityRank`. Resolution: use `compareByOrdinal` for the **ordinal dimension only** (priority omitted), then `comparePriority`/`priorityRank(config)`, then id — so §10 config priorities actually drive ordering.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/treeLayout.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Task } from '../../core/types';
import {
  BUGS_LANE,
  MISC_LANE,
  BACKBURNER_BAND,
  laneOf,
  deriveTreeLayout,
  type DeriveLayoutOptions,
} from '../../core/treeLayout';

function task(partial: Partial<Task> & { id: string }): Task {
  return {
    id: partial.id,
    title: partial.title ?? partial.id,
    status: partial.status ?? 'To Do',
    labels: [],
    assignee: [],
    dependencies: partial.dependencies ?? [],
    acceptanceCriteria: [],
    definitionOfDone: [],
    filePath: `/b/tasks/${partial.id}.md`,
    ...partial,
  } as Task;
}

const opts = (over: Partial<DeriveLayoutOptions> = {}): DeriveLayoutOptions => ({
  categories: [],
  milestoneOrder: [],
  doneStatus: 'Done',
  priorities: ['high', 'medium', 'low'],
  ...over,
});

describe('laneOf', () => {
  it('bug -> Bugs; category -> that lane; absent -> Misc', () => {
    expect(laneOf({ type: 'bug', category: 'Backend' })).toBe(BUGS_LANE);
    expect(laneOf({ category: 'Backend' })).toBe('Backend');
    expect(laneOf({ category: '   ' })).toBe(MISC_LANE);
    expect(laneOf({})).toBe(MISC_LANE);
  });
});

describe('deriveTreeLayout — lanes and bands', () => {
  it('lane order: declared (config order), discovered (sorted), Misc, Bugs last', () => {
    const { laneOrder } = deriveTreeLayout(
      [
        task({ id: 'TASK-1', category: 'Zeta' }), // discovered
        task({ id: 'TASK-2', category: 'Alpha' }), // discovered
        task({ id: 'TASK-3' }), // Misc
        task({ id: 'TASK-4', type: 'bug' }), // Bugs
      ],
      opts({ categories: ['Platform', 'Backend'] })
    );
    expect(laneOrder).toEqual(['Platform', 'Backend', 'Alpha', 'Zeta', MISC_LANE, BUGS_LANE]);
  });

  it('band order follows config milestones, then unknown sorted, then Backburner; absent milestone -> Backburner', () => {
    const { layout, bandOrder } = deriveTreeLayout(
      [
        task({ id: 'TASK-1', milestone: 'v1.0' }),
        task({ id: 'TASK-2', milestone: 'v2.0' }),
        task({ id: 'TASK-3', milestone: 'Later' }), // unknown
        task({ id: 'TASK-4' }), // no milestone -> Backburner
      ],
      opts({ milestoneOrder: ['v1.0', 'v2.0'] })
    );
    expect(bandOrder).toEqual(['v1.0', 'v2.0', 'Later', BACKBURNER_BAND]);
    expect(layout.get('TASK-1')!.band).toBe('v1.0');
    expect(layout.get('TASK-3')!.band).toBe('Later');
    expect(layout.get('TASK-4')!.band).toBe(BACKBURNER_BAND);
  });
});

describe('deriveTreeLayout — depth and cross-band warnings', () => {
  it('depth = longest same-band prerequisite chain', () => {
    const { layout } = deriveTreeLayout(
      [
        task({ id: 'TASK-1', category: 'Backend', milestone: 'v1.0' }),
        task({ id: 'TASK-2', category: 'Backend', milestone: 'v1.0', dependencies: ['TASK-1'] }),
        task({ id: 'TASK-3', category: 'Backend', milestone: 'v1.0', dependencies: ['TASK-2'] }),
      ],
      opts({ milestoneOrder: ['v1.0'] })
    );
    expect(layout.get('TASK-1')!.depth).toBe(0);
    expect(layout.get('TASK-2')!.depth).toBe(1);
    expect(layout.get('TASK-3')!.depth).toBe(2);
  });

  it('a dependency in a later band is a soft warning (not a depth contribution)', () => {
    const { layout, warnings } = deriveTreeLayout(
      [
        task({ id: 'TASK-1', category: 'Backend', milestone: 'v1.0' }),
        // TASK-1 depends on TASK-2 which is in the LATER band v2.0.
        task({
          id: 'TASK-1b',
          category: 'Backend',
          milestone: 'v1.0',
          dependencies: ['TASK-2'],
        }),
        task({ id: 'TASK-2', category: 'Backend', milestone: 'v2.0' }),
      ],
      opts({ milestoneOrder: ['v1.0', 'v2.0'] })
    );
    expect(layout.get('TASK-1b')!.depth).toBe(0); // cross-band dep does not add depth
    expect(warnings.some((w) => w.includes('TASK-1b') && w.includes('TASK-2'))).toBe(true);
  });
});

describe('deriveTreeLayout — sub-row packing (diamond)', () => {
  it('parallel branches get distinct sub-rows; a linear chain inherits its prereq row', () => {
    const { layout } = deriveTreeLayout(
      [
        task({ id: 'TASK-1', category: 'Backend', milestone: 'v1.0' }),
        task({ id: 'TASK-2', category: 'Backend', milestone: 'v1.0', dependencies: ['TASK-1'] }),
        task({ id: 'TASK-3', category: 'Backend', milestone: 'v1.0', dependencies: ['TASK-1'] }),
      ],
      opts({ milestoneOrder: ['v1.0'] })
    );
    // TASK-2 inherits TASK-1's row (0); TASK-3 (same depth as TASK-2) takes the next free row.
    expect(layout.get('TASK-1')!.subRow).toBe(0);
    const rows = [layout.get('TASK-2')!.subRow, layout.get('TASK-3')!.subRow].sort();
    expect(rows).toEqual([0, 1]);
  });
});

describe('deriveTreeLayout — bug lane', () => {
  it('bugs are bandless, sorted by severity then open-before-done then recency', () => {
    const { layout } = deriveTreeLayout(
      [
        task({
          id: 'TASK-1',
          type: 'bug',
          priority: 'low',
          status: 'To Do',
          updatedAt: '2026-01-01 00:00',
        }),
        task({ id: 'TASK-2', type: 'bug', priority: 'high', status: 'Done' }),
        task({ id: 'TASK-3', type: 'bug', priority: 'high', status: 'To Do' }),
      ],
      opts()
    );
    // high+open (TASK-3) first, then high+done (TASK-2), then low (TASK-1).
    expect(layout.get('TASK-3')!.subRow).toBe(0);
    expect(layout.get('TASK-2')!.subRow).toBe(1);
    expect(layout.get('TASK-1')!.subRow).toBe(2);
    expect(layout.get('TASK-1')!.band).toBe('');
    expect(layout.get('TASK-1')!.lane).toBe(BUGS_LANE);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- treeLayout`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/core/treeLayout.ts`:

```ts
import type { Task } from './types';
import { compareByOrdinal } from './ordinalUtils';
import { comparePriority, priorityRank } from './priorityOrder';

/** Reserved lane for all `type: bug` nodes. */
export const BUGS_LANE = 'Bugs';
/** Default lane for uncategorized non-bug tasks. */
export const MISC_LANE = 'Misc';
/** Virtual rightmost band for tasks with no milestone. */
export const BACKBURNER_BAND = 'Backburner';

export interface TreeLayout {
  lane: string;
  band: string;
  depth: number;
  subRow: number;
}

export interface DeriveLayoutOptions {
  /** Declared lane vocabulary (config order + discovered), e.g. from parser.getCategories(). */
  categories: string[];
  /** Milestone band order (config order); unknown-but-set milestones append sorted; absent -> Backburner. */
  milestoneOrder: string[];
  doneStatus: string;
  priorities: string[];
}

export interface DeriveLayoutResult {
  layout: Map<string, TreeLayout>;
  warnings: string[];
  laneOrder: string[];
  bandOrder: string[];
}

/** `type: bug` ⇒ Bugs; else non-empty `category` ⇒ that lane; else Misc. */
export function laneOf(task: Pick<Task, 'type' | 'category'>): string {
  if (task.type === 'bug') return BUGS_LANE;
  const c = task.category?.trim();
  return c ? c : MISC_LANE;
}

function isDone(task: Task, doneStatus: string): boolean {
  return task.status === doneStatus || task.folder === 'completed' || task.folder === 'archive';
}

export function deriveTreeLayout(tasks: Task[], opts: DeriveLayoutOptions): DeriveLayoutResult {
  const warnings: string[] = [];
  const byId = new Map<string, Task>(tasks.map((t) => [t.id.trim().toUpperCase(), t]));

  // --- Band order: declared milestones, then discovered (sorted), then Backburner ---
  const bandOrder: string[] = [];
  const seenBand = new Set<string>();
  const pushBand = (value: string) => {
    const v = value.trim();
    if (v && !seenBand.has(v.toLowerCase())) {
      seenBand.add(v.toLowerCase());
      bandOrder.push(v);
    }
  };
  for (const m of opts.milestoneOrder) pushBand(m);
  const discoveredBands: string[] = [];
  for (const t of tasks) {
    if (t.type === 'bug') continue;
    const m = t.milestone?.trim();
    if (m && !seenBand.has(m.toLowerCase())) {
      seenBand.add(m.toLowerCase());
      discoveredBands.push(m);
    }
  }
  discoveredBands.sort((a, b) => a.localeCompare(b));
  for (const m of discoveredBands) bandOrder.push(m);
  bandOrder.push(BACKBURNER_BAND);
  const bandIndex = new Map<string, number>();
  bandOrder.forEach((b, i) => bandIndex.set(b.toLowerCase(), i));
  const backburnerIdx = bandOrder.length - 1;

  const bandOf = (t: Task): string => {
    const m = t.milestone?.trim();
    if (!m) return BACKBURNER_BAND;
    const idx = bandIndex.get(m.toLowerCase());
    return idx === undefined ? BACKBURNER_BAND : bandOrder[idx];
  };
  const bandIdxOf = (t: Task): number => bandIndex.get(bandOf(t).toLowerCase()) ?? backburnerIdx;

  // --- Lane order: declared (config order), discovered (sorted), Misc, Bugs last ---
  const laneOrder: string[] = [];
  const seenLane = new Set<string>();
  const pushLane = (value: string) => {
    const v = value.trim();
    if (v && v !== MISC_LANE && v !== BUGS_LANE && !seenLane.has(v.toLowerCase())) {
      seenLane.add(v.toLowerCase());
      laneOrder.push(v);
    }
  };
  for (const c of opts.categories) pushLane(c);
  const discoveredLanes: string[] = [];
  for (const t of tasks) {
    if (t.type === 'bug') continue;
    const lane = laneOf(t);
    if (lane !== MISC_LANE && !seenLane.has(lane.toLowerCase())) {
      seenLane.add(lane.toLowerCase());
      discoveredLanes.push(lane);
    }
  }
  discoveredLanes.sort((a, b) => a.localeCompare(b));
  for (const lane of discoveredLanes) laneOrder.push(lane);
  laneOrder.push(MISC_LANE, BUGS_LANE);

  const layout = new Map<string, TreeLayout>();

  // --- Bug lane (bandless): severity -> open-before-done -> recency desc -> id ---
  const bugs = tasks.filter((t) => t.type === 'bug');
  bugs.sort((a, b) => {
    const pr =
      priorityRank(a.priority, opts.priorities) - priorityRank(b.priority, opts.priorities);
    if (pr !== 0) return pr;
    const ad = isDone(a, opts.doneStatus) ? 1 : 0;
    const bd = isDone(b, opts.doneStatus) ? 1 : 0;
    if (ad !== bd) return ad - bd; // open (0) before done (1)
    const at = a.updatedAt ?? a.createdAt ?? '';
    const bt = b.updatedAt ?? b.createdAt ?? '';
    if (at !== bt) return bt.localeCompare(at); // recency descending
    return a.id.localeCompare(b.id);
  });
  bugs.forEach((bug, i) => layout.set(bug.id, { lane: BUGS_LANE, band: '', depth: 0, subRow: i }));

  // --- Depth: longest chain of same-band prerequisites (memoized) ---
  const depthMemo = new Map<string, number>();
  const inProgress = new Set<string>();
  const depthOf = (t: Task): number => {
    const key = t.id.trim().toUpperCase();
    const cached = depthMemo.get(key);
    if (cached !== undefined) return cached;
    if (inProgress.has(key)) return 0; // cycle guard (deps are cycle-free by invariant)
    inProgress.add(key);
    let best = 0;
    const myBand = bandOf(t);
    const myBandIdx = bandIdxOf(t);
    for (const rawDep of t.dependencies) {
      const dep = byId.get(rawDep.trim().toUpperCase());
      if (!dep || dep.type === 'bug') continue;
      if (bandOf(dep) === myBand) {
        best = Math.max(best, depthOf(dep) + 1);
      } else if (bandIdxOf(dep) > myBandIdx) {
        warnings.push(`${t.id} depends on ${dep.id} in a later band`);
      }
    }
    inProgress.delete(key);
    depthMemo.set(key, best);
    return best;
  };

  // --- Sub-row packing per lane ---
  const nonBugs = tasks.filter((t) => t.type !== 'bug');
  const laneGroups = new Map<string, Task[]>();
  for (const t of nonBugs) {
    const lane = laneOf(t);
    const group = laneGroups.get(lane);
    if (group) group.push(t);
    else laneGroups.set(lane, [t]);
  }

  for (const [lane, laneTasks] of laneGroups) {
    // Process prerequisites first: band index, then depth, then ordinal,
    // then config priority (§10 priorityRank), then id.
    const ordered = [...laneTasks].sort((a, b) => {
      const bi = bandIdxOf(a) - bandIdxOf(b);
      if (bi !== 0) return bi;
      const di = depthOf(a) - depthOf(b);
      if (di !== 0) return di;
      // Ordinal dimension only: identical taskIds neutralize compareByOrdinal's
      // embedded fixed-priority/id tiebreaks so §10 config priority below governs.
      const byOrd = compareByOrdinal(
        { taskId: '', ordinal: a.ordinal },
        { taskId: '', ordinal: b.ordinal }
      );
      if (byOrd !== 0) return byOrd;
      const byPri = comparePriority(a.priority, b.priority, opts.priorities);
      if (byPri !== 0) return byPri;
      return a.id.localeCompare(b.id);
    });

    const occupied = new Set<string>(); // `${band}|${depth}|${subRow}`
    const cell = (band: string, depth: number, sub: number) => `${band}|${depth}|${sub}`;

    for (const t of ordered) {
      const band = bandOf(t);
      const depth = depthOf(t);
      const prereqs = t.dependencies
        .map((d) => byId.get(d.trim().toUpperCase()))
        .filter(
          (d): d is Task =>
            !!d && d.type !== 'bug' && laneOf(d) === lane && bandOf(d) === band && layout.has(d.id)
        )
        .sort((a, b) => {
          const di = depthOf(a) - depthOf(b);
          return di !== 0 ? di : a.id.localeCompare(b.id);
        });

      const inherited = prereqs.length > 0 ? layout.get(prereqs[0].id)!.subRow : undefined;
      let sub = 0;
      if (inherited !== undefined && !occupied.has(cell(band, depth, inherited))) {
        sub = inherited;
      } else {
        while (occupied.has(cell(band, depth, sub))) sub++;
      }
      occupied.add(cell(band, depth, sub));
      layout.set(t.id, { lane, band, depth, subRow: sub });
    }
  }

  return { layout, warnings, laneOrder, bandOrder };
}
```

- [ ] **Step 4: Run tests to verify green**

Run: `bun run test -- treeLayout`
Expected: PASS.
Run: `bun run lint && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/treeLayout.ts src/test/unit/treeLayout.test.ts
git commit -m "feat(tech-tree P1): treeLayout — lane/band/depth/subRow derivation (pure)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `treeDerived.ts` — shared derived state + controller enrichment

**Files:**

- Create: `src/core/treeDerived.ts`
- Test: `src/test/unit/treeDerived.test.ts`
- Modify: `src/core/types.ts` (derived `Task` fields), `src/providers/TasksController.ts` (payload enrichment)

**Interfaces:**

- Consumes: `treeGate` (`computeBlockedBy`, `resolveDoneStatus`), `treeLayout` (`deriveTreeLayout`, `laneOf`, `TreeLayout`, `BACKBURNER_BAND`), `priorityOrder` (`resolvePriorities`), `BacklogParser`, `Task`.
- Produces:
  - `export interface TreeDerivedState { locked: boolean; blockedBy: string[]; bugs: string[]; activeBugIds: string[]; layout: TreeLayout }`
  - `export function deriveTreeState(tasks: Task[], opts: { doneStatus: string; milestoneOrder: string[]; priorities: string[]; categories: string[] }): Map<string, TreeDerivedState>` — pure. `bugs` = tasks with `type === 'bug' && causedBy === id`; `activeBugIds` = those bugs that are not done (`status !== doneStatus` and folder not completed/archive). Key = `task.id`.
  - `export async function loadTreeStateFromParser(parser: BacklogParser): Promise<Map<string, TreeDerivedState>>` — the single disk-reading convenience: loads `getTasks + getCompletedTasks + getArchivedTasks + getConfig + getMilestones + getCategories`, resolves done-status/milestone-order/priorities, and runs one `deriveTreeState` pass over the union. Used by the MCP handlers (Tasks 7/9) and the UI glue (Task 10).
- `Task` gains derived fields: `locked?`, `blockedBy?`, `bugs?`, `activeBugIds?`, `layout?: TreeLayout` (mirroring the existing derived `blocksTaskIds`/`blockingDependencyIds`).

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/treeDerived.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Task } from '../../core/types';
import { deriveTreeState } from '../../core/treeDerived';

function task(partial: Partial<Task> & { id: string }): Task {
  return {
    id: partial.id,
    title: partial.title ?? partial.id,
    status: partial.status ?? 'To Do',
    labels: [],
    assignee: [],
    dependencies: partial.dependencies ?? [],
    acceptanceCriteria: [],
    definitionOfDone: [],
    filePath: `/b/tasks/${partial.id}.md`,
    ...partial,
  } as Task;
}

const opts = {
  doneStatus: 'Done',
  milestoneOrder: [] as string[],
  priorities: ['high', 'medium', 'low'],
  categories: [] as string[],
};

describe('deriveTreeState', () => {
  it('composes locked/blockedBy from the gate and layout from the layout module', () => {
    const tasks = [
      task({ id: 'TASK-1', status: 'Done' }),
      task({ id: 'TASK-2', dependencies: ['TASK-1'] }),
      task({ id: 'TASK-3', dependencies: ['TASK-2'] }),
    ];
    const states = deriveTreeState(tasks, opts);
    expect(states.get('TASK-2')!.locked).toBe(false); // dep TASK-1 is Done
    expect(states.get('TASK-3')!.locked).toBe(true); // dep TASK-2 not done
    expect(states.get('TASK-3')!.blockedBy).toEqual(['TASK-2']);
    expect(states.get('TASK-1')!.layout.lane).toBeDefined();
  });

  it('backlinks bugs to the task that caused them; activeBugIds excludes done bugs', () => {
    const tasks = [
      task({ id: 'TASK-1' }),
      task({ id: 'TASK-2', type: 'bug', causedBy: 'TASK-1', status: 'To Do' }),
      task({ id: 'TASK-3', type: 'bug', causedBy: 'TASK-1', status: 'Done' }),
      task({ id: 'TASK-4', type: 'bug', causedBy: 'TASK-1', folder: 'completed' }),
    ];
    const s = deriveTreeState(tasks, opts).get('TASK-1')!;
    expect(s.bugs.sort()).toEqual(['TASK-2', 'TASK-3', 'TASK-4']);
    expect(s.activeBugIds).toEqual(['TASK-2']); // TASK-3 (done) and TASK-4 (completed) excluded
  });

  it('a task with no bugs has empty bug arrays', () => {
    const s = deriveTreeState([task({ id: 'TASK-1' })], opts).get('TASK-1')!;
    expect(s.bugs).toEqual([]);
    expect(s.activeBugIds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- treeDerived`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/core/treeDerived.ts`:

```ts
import type { Task } from './types';
import type { BacklogParser } from './BacklogParser';
import { computeBlockedBy, resolveDoneStatus } from './treeGate';
import { deriveTreeLayout, laneOf, BACKBURNER_BAND, type TreeLayout } from './treeLayout';
import { resolvePriorities } from './priorityOrder';

/** Per-task derived tech-tree state (never persisted). */
export interface TreeDerivedState {
  locked: boolean;
  blockedBy: string[];
  bugs: string[];
  activeBugIds: string[];
  layout: TreeLayout;
}

export interface DeriveTreeStateOptions {
  doneStatus: string;
  milestoneOrder: string[];
  priorities: string[];
  categories: string[];
}

/**
 * Pure composition of the gate (locked/blockedBy), the bug backlink
 * (bugs/activeBugIds), and layout for every task in `tasks`. Pass the full
 * universe (active + completed + archived) so a dependency on a done/completed
 * task counts as satisfied and bug backlinks resolve.
 */
export function deriveTreeState(
  tasks: Task[],
  opts: DeriveTreeStateOptions
): Map<string, TreeDerivedState> {
  const byId = new Map<string, Task>(tasks.map((t) => [t.id.trim().toUpperCase(), t]));
  const { layout } = deriveTreeLayout(tasks, {
    categories: opts.categories,
    milestoneOrder: opts.milestoneOrder,
    doneStatus: opts.doneStatus,
    priorities: opts.priorities,
  });

  const bugsByCause = new Map<string, string[]>();
  const activeByCause = new Map<string, string[]>();
  for (const t of tasks) {
    if (t.type !== 'bug') continue;
    const cause = t.causedBy?.trim().toUpperCase();
    if (!cause) continue;
    (bugsByCause.get(cause) ?? bugsByCause.set(cause, []).get(cause)!).push(t.id);
    const active =
      t.status !== opts.doneStatus && t.folder !== 'completed' && t.folder !== 'archive';
    if (active) (activeByCause.get(cause) ?? activeByCause.set(cause, []).get(cause)!).push(t.id);
  }

  const states = new Map<string, TreeDerivedState>();
  for (const t of tasks) {
    const key = t.id.trim().toUpperCase();
    const blockedBy = computeBlockedBy(t, byId, opts.doneStatus);
    states.set(t.id, {
      locked: blockedBy.length > 0,
      blockedBy,
      bugs: bugsByCause.get(key) ?? [],
      activeBugIds: activeByCause.get(key) ?? [],
      layout: layout.get(t.id) ?? { lane: laneOf(t), band: BACKBURNER_BAND, depth: 0, subRow: 0 },
    });
  }
  return states;
}

/**
 * The single disk-reading convenience: gather the full task universe and config,
 * then run one `deriveTreeState` pass. Vscode-free (BacklogParser only) so both
 * the MCP handlers and the extension providers can share it.
 */
export async function loadTreeStateFromParser(
  parser: BacklogParser
): Promise<Map<string, TreeDerivedState>> {
  const [tasks, completed, archived, config, milestones, categories] = await Promise.all([
    parser.getTasks(),
    parser.getCompletedTasks(),
    parser.getArchivedTasks(),
    parser.getConfig(),
    parser.getMilestones(),
    parser.getCategories(),
  ]);
  return deriveTreeState([...tasks, ...completed, ...archived], {
    doneStatus: resolveDoneStatus(config.statuses),
    milestoneOrder: milestones.map((m) => m.name),
    priorities: resolvePriorities(config),
    categories,
  });
}
```

Edit `src/core/types.ts` `Task` — add derived fields near `blockingDependencyIds?` (import `TreeLayout` as a type-only import at the top of the file: `import type { TreeLayout } from './treeLayout';`):

```ts
  blockingDependencyIds?: string[]; // Dependency IDs currently blocking this task in views

  // Tech-tree P1 derived state (computed at load; never persisted).
  locked?: boolean;
  blockedBy?: string[];
  bugs?: string[];
  activeBugIds?: string[];
  layout?: TreeLayout;
```

> Type-only imports (`import type`) between `types.ts` and `treeLayout.ts` do not create a runtime cycle; `treeLayout.ts` already imports `Task` as a type from `types.ts`.

Edit `src/providers/TasksController.ts` — enrich the payload. Add imports at the top:

```ts
import { loadTreeStateFromParser } from '../core/treeDerived';
```

Inside the load method, after `computeSubtasks(tasks)` and `const doneStatus = ...` (near line 252), compute the derived states once:

```ts
// Tech-tree P1 derived state (locked/blockedBy/bugs/activeBugIds/layout).
// Best-effort: a failure must not break loading the board.
let treeStates: Awaited<ReturnType<typeof loadTreeStateFromParser>> | undefined;
try {
  treeStates = await loadTreeStateFromParser(this.parser);
} catch {
  treeStates = undefined;
}
```

Then extend the `enhanced` object literal type and body inside `tasks.map` (near line 291) so each task carries the derived fields:

```ts
const enhanced: Task & {
  blocksTaskIds?: string[];
  subtaskProgress?: { total: number; done: number };
  blockingDependencyIds?: string[];
  isActiveTask?: boolean;
  claimStale?: boolean;
  mergeState?: MergeTaskState;
} = {
  ...task,
  blocksTaskIds: reverseDeps.get(task.id) || [],
  isActiveTask: !!activeTaskId && task.id === activeTaskId,
  claimStale: !!task.claimedBy && isClaimStale(task.claimedAt, stalenessMs),
  mergeState: mergeQueue ? mergeStateForTask(mergeQueue, task.id) : undefined,
};
const derived = treeStates?.get(task.id);
if (derived) {
  enhanced.locked = derived.locked;
  enhanced.blockedBy = derived.blockedBy;
  enhanced.bugs = derived.bugs;
  enhanced.activeBugIds = derived.activeBugIds;
  enhanced.layout = derived.layout;
}
```

(Leave the existing `blockingDependencyIds` computation below it untouched — it is retained for backward compatibility per the directive.)

- [ ] **Step 4: Run tests to verify green**

Run: `bun run test -- treeDerived`
Expected: PASS.
Run: `bun run test && bun run lint && bun run typecheck`
Expected: PASS. (The `TasksController` enrichment is thin data-wiring on top of the unit-tested `deriveTreeState`/`loadTreeStateFromParser`; existing controller tests must remain green.)

- [ ] **Step 5: Commit**

```bash
git add src/core/treeDerived.ts src/test/unit/treeDerived.test.ts src/core/types.ts src/providers/TasksController.ts
git commit -m "feat(tech-tree P1): deriveTreeState + loadTreeStateFromParser; enrich board payload

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Config + MCP read surface (`toSummary` derived fields)

**Files:**

- Modify: `src/mcp/handlers.ts`
- Test: `src/test/unit/mcpWriteHandlers.test.ts` (append)

**Interfaces:**

- Consumes: `loadTreeStateFromParser`, `TreeDerivedState` (`treeDerived.ts`), `TreeLayout` (`treeLayout.ts`).
- Produces:
  - `TaskSummary` gains: `category?`, `type?`, `causedBy?`, `milestone?`, `dependencies: string[]`, `locked?`, `blockedBy?`, `bugs?`, `activeBugIds?`, `layout?: TreeLayout`.
  - `toSummary(task, root, derived?: TreeDerivedState)` — new optional third param carries the derived state.
  - `requireSummary` and `getActiveTask` run **one** `loadTreeStateFromParser(deps.parser)` pass and pass the target's state to `toSummary`. `get_active_task` inherits automatically.

- [ ] **Step 1: Write the failing test**

Append to `src/test/unit/mcpWriteHandlers.test.ts` (reuse its `scaffold()`/`deps()` real-temp-dir helpers; `createTaskHandler`/`editTaskHandler` already imported — the edit fields land in Task 8, so this test only asserts derived read fields available now):

```ts
import { getActiveTask } from '../../mcp/handlers';
import { writeActiveTask } from '../../core/activeTask';

describe('MCP summaries expose tech-tree derived fields (P1)', () => {
  it('a task summary includes dependencies, locked, and layout', async () => {
    await createTaskHandler(deps(), { title: 'Root' }); // TASK-1
    await createTaskHandler(deps(), { title: 'Dependent' }); // TASK-2
    // Make TASK-2 depend on TASK-1 via the writer directly (edit_task deps land in Task 8).
    const d = deps();
    await d.writer.updateTask('TASK-2', { dependencies: ['TASK-1'] }, d.parser);

    writeActiveTask(root, 'TASK-2');
    const result = await getActiveTask(deps());
    expect(result.active).toBe(true);
    expect(result.task?.dependencies).toEqual(['TASK-1']);
    expect(result.task?.locked).toBe(true); // TASK-1 is To Do, not Done
    expect(result.task?.blockedBy).toEqual(['TASK-1']);
    expect(result.task?.layout).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- mcpWriteHandlers`
Expected: FAIL — `dependencies`/`locked`/`layout` absent on the summary.

- [ ] **Step 3: Implement**

Edit `src/mcp/handlers.ts`. Add imports:

```ts
import { loadTreeStateFromParser, type TreeDerivedState } from '../core/treeDerived';
import type { TreeLayout } from '../core/treeLayout';
```

Extend the `TaskSummary` interface (add fields after `filePath`... keep `filePath` last for stability by inserting before it):

```ts
export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  priority?: string;
  description?: string;
  acceptanceCriteria: ChecklistItem[];
  implementationPlan?: string;
  labels: string[];
  assignee: string[];
  claimedBy?: string;
  worktree?: string;
  claimedAt?: string;
  plan?: string;
  planProgress?: PlanProgressSummary;
  // Tech-tree P1 fields.
  category?: string;
  type?: string;
  causedBy?: string;
  milestone?: string;
  dependencies: string[];
  locked?: boolean;
  blockedBy?: string[];
  bugs?: string[];
  activeBugIds?: string[];
  layout?: TreeLayout;
  filePath: string;
}
```

Replace `toSummary` with the derived-aware version:

```ts
export function toSummary(task: Task, root: string, derived?: TreeDerivedState): TaskSummary {
  let planProgress: PlanProgressSummary | undefined;
  if (task.plan) {
    const loaded = loadPlanProgress(root, task.plan);
    planProgress = {
      total: loaded.progress.total,
      done: loaded.progress.done,
      percent: loaded.progress.percent,
      exists: loaded.exists,
    };
  }
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    implementationPlan: task.implementationPlan,
    labels: task.labels,
    assignee: task.assignee,
    claimedBy: task.claimedBy,
    worktree: task.worktree,
    claimedAt: task.claimedAt,
    plan: task.plan,
    planProgress,
    category: task.category,
    type: task.type,
    causedBy: task.causedBy,
    milestone: task.milestone,
    dependencies: task.dependencies,
    locked: derived?.locked,
    blockedBy: derived?.blockedBy,
    bugs: derived?.bugs,
    activeBugIds: derived?.activeBugIds,
    layout: derived?.layout,
    filePath: task.filePath,
  };
}
```

Update `getActiveTask` — pass derived state (one pass). Replace its final `return`:

```ts
const states = await loadTreeStateFromParser(deps.parser).catch(() => undefined);
return {
  active: true,
  task: toSummary(task, deps.root, states?.get(task.id)),
  queuePosition,
};
```

Update `requireSummary` to derive once and pass the state:

```ts
async function requireSummary(deps: McpHandlerDeps, taskId: string): Promise<TaskSummary> {
  const task = await deps.parser.getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} was written but could not be read back.`);
  }
  const states = await loadTreeStateFromParser(deps.parser).catch(() => undefined);
  return toSummary(task, deps.root, states?.get(task.id));
}
```

- [ ] **Step 4: Run tests to verify green**

Run: `bun run test -- mcpWriteHandlers`
Expected: PASS.
Run: `bun run test -- mcpHandlers && bun run lint && bun run typecheck`
Expected: PASS (existing `mcpHandlers.test.ts` still green — `toSummary`'s third arg is optional, so its current call sites keep compiling).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/handlers.ts src/test/unit/mcpWriteHandlers.test.ts
git commit -m "feat(tech-tree P1): MCP summaries carry category/type/causedBy + derived gate/layout

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: MCP write enforcement (`create_task` / `edit_task`)

**Files:**

- Modify: `src/mcp/taskWriteHelpers.ts`, `src/mcp/handlers.ts`, `src/mcp/server.ts`
- Test: `src/test/unit/taskWriteHelpers.test.ts`, `src/test/unit/mcpWriteHandlers.test.ts`

**Interfaces:**

- `assertValidPriority(priority: string, allowed: string[]): void` — case-insensitive validation against `resolvePriorities(config)`.
- `CreateTaskArgs` gains `category?`, `type?`, `causedBy?`, `dependencies?`; `priority` becomes `string`. `EditTaskArgs` gains `category?`, `type?`, `causedBy?`; `priority` becomes `string`.
- `McpHandlerDeps` gains `treeFieldService: TreeFieldService`.
- New handler helper `assertDependenciesValid(deps, dependencies, targetId?)` — existence (tasks/drafts/completed/archive) + `wouldCreateCycle` (when `targetId` set).
- `create_task`/`edit_task` schemas: `priority: z.string()`; add `category`, `type`, `causedBy`, `dependencies` (create).

> **Writer-serialization decision (investigated + locked).** `BacklogWriter.updateTask` maps only an explicit allow-list of fields (status/priority/title/labels/milestone/assignee/dependencies/references/documentation/type/reporter/ordinal) and `createTask` builds frontmatter solely from `CreateTaskOptions`. Neither serializes `category`/`caused_by` — they are **dropped**. `type` and `dependencies`, by contrast, ARE serialized (`type` is in `FRONTMATTER_FIELD_ORDER`; both are mapped by `updateTask`). **Approach B (locked):** write `category`/`causedBy` through `TreeFieldService` surgical writers **after** the BacklogWriter create/update — exactly like the existing Taskwright-only `plan`/`claimed_by` fields — so canonical Backlog.md frontmatter round-trips byte-for-byte. `type`/`dependencies`/`milestone` route through BacklogWriter (create uses `CreateTaskOptions.milestone`; `type`/`dependencies` on create use a follow-up `updateTask`; edit passes them straight through). Rationale: keeps the canonical serializer untouched and reuses the proven surgical path.

- [ ] **Step 1: Write the failing tests**

Update `src/test/unit/taskWriteHelpers.test.ts` — replace the `assertValidPriority` assertions with the new signature (find the existing block and rewrite it):

```ts
import { assertValidPriority } from '../../mcp/taskWriteHelpers';

describe('assertValidPriority (config-driven)', () => {
  it('accepts a case-insensitive match against the allowed list', () => {
    expect(() => assertValidPriority('HIGH', ['high', 'medium', 'low'])).not.toThrow();
    expect(() => assertValidPriority('Critical', ['Critical', 'Normal'])).not.toThrow();
  });
  it('throws for a value outside the allowed list', () => {
    expect(() => assertValidPriority('urgent', ['high', 'medium', 'low'])).toThrow(
      'Invalid priority'
    );
  });
});
```

Append to `src/test/unit/mcpWriteHandlers.test.ts` (extend `deps()` to include `treeFieldService`; the temp-dir scaffold makes real files):

```ts
import { TreeFieldService } from '../../core/TreeFieldService';

describe('create_task / edit_task tech-tree fields (P1)', () => {
  it('create_task persists category, type=bug, caused_by, dependencies', async () => {
    await createTaskHandler(deps(), { title: 'Origin' }); // TASK-1
    const summary = await createTaskHandler(deps(), {
      title: 'Broken login',
      type: 'bug',
      causedBy: 'TASK-1',
      category: 'Auth',
      dependencies: ['TASK-1'],
    });
    expect(summary.type).toBe('bug');
    expect(summary.causedBy).toBe('TASK-1');
    expect(summary.category).toBe('Auth');
    expect(summary.dependencies).toEqual(['TASK-1']);
  });

  it('edit_task sets and clears category/caused_by', async () => {
    await createTaskHandler(deps(), { title: 'A task' }); // TASK-1
    let s = await editTaskHandler(deps(), { taskId: 'TASK-1', category: 'Backend' });
    expect(s.category).toBe('Backend');
    s = await editTaskHandler(deps(), { taskId: 'TASK-1', category: '' });
    expect(s.category).toBeUndefined();
  });

  it('edit_task clears type surgically (empty string removes the field)', async () => {
    await createTaskHandler(deps(), { title: 'Was a bug', type: 'bug' }); // TASK-1
    let s = await editTaskHandler(deps(), { taskId: 'TASK-1', type: 'bug' });
    expect(s.type).toBe('bug');
    s = await editTaskHandler(deps(), { taskId: 'TASK-1', type: '' });
    expect(s.type).toBeUndefined();
  });

  it('rejects an invalid type value', async () => {
    await createTaskHandler(deps(), { title: 'A task' }); // TASK-1
    await expect(editTaskHandler(deps(), { taskId: 'TASK-1', type: 'feature' })).rejects.toThrow(
      'type'
    );
  });

  it('rejects caused_by on a non-bug task', async () => {
    await createTaskHandler(deps(), { title: 'Cause' }); // TASK-1
    await createTaskHandler(deps(), { title: 'Plain' }); // TASK-2
    await expect(editTaskHandler(deps(), { taskId: 'TASK-2', causedBy: 'TASK-1' })).rejects.toThrow(
      'bug'
    );
  });

  it('rejects a dependency that does not exist', async () => {
    await createTaskHandler(deps(), { title: 'A task' }); // TASK-1
    await expect(
      editTaskHandler(deps(), { taskId: 'TASK-1', dependencies: ['TASK-999'] })
    ).rejects.toThrow('does not exist');
  });

  it('rejects a dependency edit that would create a cycle', async () => {
    await createTaskHandler(deps(), { title: 'A' }); // TASK-1
    await createTaskHandler(deps(), { title: 'B' }); // TASK-2
    const d = deps();
    await d.writer.updateTask('TASK-2', { dependencies: ['TASK-1'] }, d.parser); // TASK-2 -> TASK-1
    // Now making TASK-1 depend on TASK-2 closes the cycle.
    await expect(
      editTaskHandler(deps(), { taskId: 'TASK-1', dependencies: ['TASK-2'] })
    ).rejects.toThrow('cycle');
  });
});
```

Update the existing `deps()` helper in that file to include the new dependency:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- taskWriteHelpers mcpWriteHandlers`
Expected: FAIL — `assertValidPriority` old signature; new fields/validation absent; `treeFieldService` not on `McpHandlerDeps`.

- [ ] **Step 3: Implement**

Edit `src/mcp/taskWriteHelpers.ts` `assertValidPriority`:

```ts
/** Throw unless `priority` matches one of the allowed priorities (case-insensitive). */
export function assertValidPriority(priority: string, allowed: string[]): void {
  if (!allowed.some((p) => p.toLowerCase() === priority.toLowerCase())) {
    throw new Error(
      `Invalid priority "${priority}". Allowed: ${allowed.join(', ') || '(none configured)'}.`
    );
  }
}
```

Edit `src/mcp/handlers.ts`. Add imports:

```ts
import { TreeFieldService } from '../core/TreeFieldService';
import { resolvePriorities } from '../core/priorityOrder';
import { wouldCreateCycle } from '../core/treeGate';
```

Add to `McpHandlerDeps` (next to `planService`):

```ts
planService: PlanService;
treeFieldService: TreeFieldService;
```

Add a shared dependency validator (place near `requireSummary`):

```ts
/**
 * Validate a proposed dependency set: every ID must resolve to a known task
 * (tasks/drafts/completed/archive), and — when editing an existing task —
 * adding any of them must not create a cycle.
 */
async function assertDependenciesValid(
  deps: McpHandlerDeps,
  dependencies: string[],
  targetId?: string
): Promise<void> {
  if (dependencies.length === 0) return;
  const [tasks, drafts, completed, archived] = await Promise.all([
    deps.parser.getTasks(),
    deps.parser.getDrafts(),
    deps.parser.getCompletedTasks(),
    deps.parser.getArchivedTasks(),
  ]);
  const all = [...tasks, ...drafts, ...completed, ...archived];
  const known = new Set(all.map((t) => t.id.trim().toUpperCase()));
  for (const dep of dependencies) {
    if (!known.has(dep.trim().toUpperCase())) {
      throw new Error(`Dependency ${dep} does not exist.`);
    }
  }
  if (targetId) {
    for (const dep of dependencies) {
      if (wouldCreateCycle(all, targetId, dep)) {
        throw new Error(`Adding dependency ${dep} to ${targetId} would create a dependency cycle.`);
      }
    }
  }
}

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

Replace `CreateTaskArgs` and `createTaskHandler`:

```ts
export interface CreateTaskArgs {
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
}

/** Create a task (or draft) and return its summary. */
export async function createTaskHandler(
  deps: McpHandlerDeps,
  args: CreateTaskArgs
): Promise<TaskSummary> {
  const title = args.title?.trim();
  if (!title) throw new Error('A task title is required.');
  const config = await deps.parser.getConfig();
  if (args.status !== undefined) assertValidStatus(args.status, config.statuses ?? []);
  if (args.priority !== undefined) assertValidPriority(args.priority, resolvePriorities(config));
  const type = normalizeType(args.type);
  const causedBy = args.causedBy?.trim();
  if (causedBy && type !== 'bug') {
    throw new Error('caused_by can only be set on a bug (type: bug).');
  }
  const dependencies = args.dependencies ?? [];
  await assertDependenciesValid(deps, dependencies); // no targetId: new task cannot form a cycle

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

  // type / dependencies go through BacklogWriter (both are serialized there).
  if (type !== undefined || dependencies.length > 0) {
    const canonical: Partial<Task> = {};
    if (type !== undefined) canonical.type = type;
    if (dependencies.length > 0) canonical.dependencies = dependencies;
    await deps.writer.updateTask(id, canonical, deps.parser);
  }
  // category / caused_by are Taskwright-only: write surgically after create.
  if (args.category !== undefined && args.category.trim() !== '') {
    await deps.treeFieldService.setCategory(id, args.category, deps.parser);
  }
  if (causedBy) {
    await deps.treeFieldService.setCausedBy(id, causedBy, deps.parser);
  }

  return requireSummary(deps, id);
}
```

Replace `EditTaskArgs` and `editTaskHandler`:

```ts
export interface EditTaskArgs {
  taskId: string;
  title?: string;
  status?: string;
  priority?: string;
  labels?: string[];
  assignee?: string[];
  milestone?: string;
  description?: string;
  acceptanceCriteria?: ChecklistInput[];
  definitionOfDone?: ChecklistInput[];
  implementationPlan?: string;
  implementationNotes?: string;
  finalSummary?: string;
  dependencies?: string[];
  references?: string[];
  category?: string;
  type?: string;
  causedBy?: string;
}

/** Apply partial edits to a task and return the updated summary. */
export async function editTaskHandler(
  deps: McpHandlerDeps,
  args: EditTaskArgs
): Promise<TaskSummary> {
  const config = await deps.parser.getConfig();
  if (args.status !== undefined) assertValidStatus(args.status, config.statuses ?? []);
  if (args.priority !== undefined) assertValidPriority(args.priority, resolvePriorities(config));

  const existing = await deps.parser.getTask(args.taskId);
  if (!existing) throw new Error(`Task ${args.taskId} not found`);

  const nextType = args.type !== undefined ? normalizeType(args.type) : existing.type;
  const causedBy = args.causedBy?.trim();
  if (args.causedBy !== undefined && causedBy && nextType !== 'bug') {
    throw new Error('caused_by can only be set on a bug (type: bug).');
  }
  if (args.dependencies !== undefined) {
    await assertDependenciesValid(deps, args.dependencies, args.taskId);
  }

  const updates: Record<string, unknown> = {};
  if (args.title !== undefined) updates.title = args.title;
  if (args.status !== undefined) updates.status = args.status;
  if (args.priority !== undefined) updates.priority = args.priority;
  if (args.labels !== undefined) updates.labels = args.labels;
  if (args.assignee !== undefined) updates.assignee = args.assignee;
  if (args.milestone !== undefined) updates.milestone = args.milestone;
  if (args.description !== undefined) updates.description = args.description;
  if (args.acceptanceCriteria !== undefined)
    updates.acceptanceCriteria = renderChecklist(args.acceptanceCriteria);
  if (args.definitionOfDone !== undefined)
    updates.definitionOfDone = renderChecklist(args.definitionOfDone);
  if (args.implementationPlan !== undefined) updates.implementationPlan = args.implementationPlan;
  if (args.implementationNotes !== undefined)
    updates.implementationNotes = args.implementationNotes;
  if (args.finalSummary !== undefined) updates.finalSummary = args.finalSummary;
  if (args.dependencies !== undefined) updates.dependencies = args.dependencies;
  if (args.references !== undefined) updates.references = args.references;
  // Only a non-empty `type` (i.e. 'bug') routes through BacklogWriter; clearing is surgical (below).
  if (args.type !== undefined && nextType !== undefined) updates.type = nextType;

  if (Object.keys(updates).length > 0) {
    await deps.writer.updateTask(args.taskId, updates as Partial<Task>, deps.parser);
  }

  // Clearing `type` is surgical: BacklogWriter has no omit-if-empty path for `type`,
  // so removing the field (rather than writing an empty value) keeps the file clean.
  if (args.type !== undefined && nextType === undefined) {
    await deps.treeFieldService.clearType(args.taskId, deps.parser);
  }
  // category / caused_by are Taskwright-only surgical fields.
  if (args.category !== undefined) {
    if (args.category.trim() === '')
      await deps.treeFieldService.clearCategory(args.taskId, deps.parser);
    else await deps.treeFieldService.setCategory(args.taskId, args.category, deps.parser);
  }
  if (args.causedBy !== undefined) {
    if (causedBy) await deps.treeFieldService.setCausedBy(args.taskId, causedBy, deps.parser);
    else await deps.treeFieldService.clearCausedBy(args.taskId, deps.parser);
  }

  return requireSummary(deps, args.taskId);
}
```

> Note on `type` writes vs. clears: a non-empty `type` (only `'bug'`) round-trips cleanly through `BacklogWriter` (it is in `FRONTMATTER_FIELD_ORDER`), so setting it routes through `updates`. But `BacklogWriter` has **no** omit-if-empty path for `type` — writing `type: ''` would emit a stray empty key. So a **clear** (`type: ''`/whitespace, i.e. `normalizeType` → `undefined`) skips the writer entirely and removes the field surgically via `TreeFieldService.clearType` (same `removeField` idiom as `clearCategory`). No `setType` is added — the writer already serializes a non-empty `type`.

Edit `src/mcp/server.ts`. Add the import and instantiate:

```ts
import { TreeFieldService } from '../core/TreeFieldService';
```

In `main()` `deps`:

```ts
const deps: McpHandlerDeps = {
  root,
  backlogPath,
  parser: new BacklogParser(backlogPath),
  writer: new BacklogWriter(),
  claimService: new ClaimService(),
  planService: new PlanService(),
  treeFieldService: new TreeFieldService(),
};
```

Update the `create_task` `inputSchema`:

```ts
      inputSchema: {
        title: z.string().describe('Task title, imperative mood.'),
        description: z.string().optional(),
        status: z.string().optional().describe('Defaults to the board default status.'),
        priority: z.string().optional().describe('One of the board\'s configured priorities.'),
        labels: z.array(z.string()).optional(),
        assignee: z.array(z.string()).optional(),
        milestone: z.string().optional(),
        category: z.string().optional().describe('Tech-tree lane. Absent/empty ⇒ Misc.'),
        type: z.string().optional().describe('Set to "bug" to file a bug node.'),
        causedBy: z.string().optional().describe('For bugs: the task ID that introduced the bug.'),
        dependencies: z.array(z.string()).optional().describe('Task IDs this task depends on (must exist; no cycles).'),
        draft: z.boolean().optional().describe('Create as a draft (DRAFT-N in drafts/).'),
      },
```

Update the `edit_task` `inputSchema` (change `priority` and add the three fields):

```ts
        priority: z.string().optional().describe('One of the board\'s configured priorities.'),
        // ... existing fields ...
        category: z.string().optional().describe('Tech-tree lane; empty string clears it.'),
        type: z.string().optional().describe('Set to "bug" or empty to clear.'),
        causedBy: z.string().optional().describe('Bug cause task ID; empty string clears it.'),
```

- [ ] **Step 4: Run tests to verify green**

Run: `bun run test -- taskWriteHelpers mcpWriteHandlers`
Expected: PASS.
Run: `bun run test -- mcpHandlers && bun run lint && bun run typecheck`
Expected: PASS.

Making `McpHandlerDeps.treeFieldService` **required** breaks every existing `McpHandlerDeps` literal in the test suites, so update each to add `treeFieldService: new TreeFieldService()` (adding `import { TreeFieldService } from '../../core/TreeFieldService';` at the top of each file). Line numbers are approximate anchors — locate each by searching for `McpHandlerDeps` literals:

1. `src/test/unit/mcpHandlers.test.ts` — the shared `deps` object (~lines 62–68) **and** the inline `const deps: McpHandlerDeps = { ... }` literals at ~lines 194, 212, 227, and 241.
2. `src/test/unit/mcpMergeHandlers.test.ts` — the `deps` literals at ~lines 126 and 155.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/taskWriteHelpers.ts src/mcp/handlers.ts src/mcp/server.ts src/test/unit/taskWriteHelpers.test.ts src/test/unit/mcpWriteHandlers.test.ts
git commit -m "feat(tech-tree P1): MCP create/edit accept + validate category/type/caused_by/deps

- priority validated against config priorities (case-insensitive)
- type restricted to 'bug'; caused_by rejected on non-bugs
- dependency edits validated for existence + cycles (wouldCreateCycle)
- category/caused_by written surgically via TreeFieldService (canonical frontmatter untouched)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: `claim_task` gate + `complete_task` bug rule (MCP)

**Files:**

- Modify: `src/mcp/handlers.ts`
- Test: `src/test/unit/mcpWriteHandlers.test.ts` (append)

**Interfaces:**

- `ClaimResult` gains `locked?: boolean` and `blockedBy?: string[]`.
- `claimTaskHandler` — **before** the sync fork: derive states, and if the target is locked return `{ claimed: false, taskId, locked: true, blockedBy }`. No `force` parameter (a dispatched agent can never self-unlock).
- `completeTaskHandler` — if the task is `type: 'bug'`, require `caused_by` set AND resolvable via `parser.getTask`; clear error strings otherwise.

- [ ] **Step 1: Write the failing tests**

Append to `src/test/unit/mcpWriteHandlers.test.ts`:

```ts
import { claimTaskHandler, completeTaskHandler } from '../../mcp/handlers';

describe('claim_task gate (P1)', () => {
  it('refuses a locked task with locked/blockedBy and no claim', async () => {
    await createTaskHandler(deps(), { title: 'Root' }); // TASK-1 (To Do)
    await createTaskHandler(deps(), { title: 'Dependent' }); // TASK-2
    const d = deps();
    await d.writer.updateTask('TASK-2', { dependencies: ['TASK-1'] }, d.parser);

    const result = await claimTaskHandler(deps(), { taskId: 'TASK-2' });
    expect(result.claimed).toBe(false);
    expect(result.locked).toBe(true);
    expect(result.blockedBy).toEqual(['TASK-1']);
  });

  it('allows claiming once the dependency is done', async () => {
    await createTaskHandler(deps(), { title: 'Root' }); // TASK-1
    await createTaskHandler(deps(), { title: 'Dependent' }); // TASK-2
    const d = deps();
    await d.writer.updateTask('TASK-2', { dependencies: ['TASK-1'] }, d.parser);
    await d.writer.updateTask('TASK-1', { status: 'Done' }, d.parser);

    const result = await claimTaskHandler(deps(), { taskId: 'TASK-2', claimedBy: '@me' });
    expect(result.claimed).toBe(true);
  });
});

describe('complete_task bug rule (P1)', () => {
  it('refuses to complete a bug with no caused_by', async () => {
    await createTaskHandler(deps(), { title: 'Bug', type: 'bug' }); // TASK-1
    await expect(completeTaskHandler(deps(), { taskId: 'TASK-1' })).rejects.toThrow('caused_by');
  });

  it('refuses when caused_by points at a nonexistent task', async () => {
    await createTaskHandler(deps(), { title: 'Bug', type: 'bug' }); // TASK-1
    const d = deps();
    await d.treeFieldService.setCausedBy('TASK-1', 'TASK-999', d.parser);
    await expect(completeTaskHandler(deps(), { taskId: 'TASK-1' })).rejects.toThrow(
      'does not exist'
    );
  });

  it('completes a bug with a valid caused_by', async () => {
    await createTaskHandler(deps(), { title: 'Cause' }); // TASK-1
    await createTaskHandler(deps(), { title: 'Bug', type: 'bug', causedBy: 'TASK-1' }); // TASK-2
    const result = await completeTaskHandler(deps(), { taskId: 'TASK-2' });
    expect(result.outcome).toBe('completed');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- mcpWriteHandlers`
Expected: FAIL — claim gate absent; bug rule absent.

- [ ] **Step 3: Implement**

Edit `src/mcp/handlers.ts`. Extend `ClaimResult`:

```ts
export interface ClaimResult {
  claimed: boolean;
  taskId: string;
  claimedBy?: string;
  worktree?: string;
  claimedAt?: string;
  surrendered?: boolean;
  heldBy?: string;
  /** True when the task cannot be claimed because its dependencies are unmet. */
  locked?: boolean;
  /** The blocking dependency IDs when `locked` is true. */
  blockedBy?: string[];
}
```

In `claimTaskHandler`, **replace** the two existing consecutive lines — `const claimedBy = args.claimedBy?.trim() || '@agent';` immediately followed by `const cfg = await resolveSyncConfig(deps);` (real handlers.ts ~lines 412–413) — with the gate block below. Its first line re-declares `claimedBy` and its last line re-declares `cfg`, so replacing (not inserting) leaves no duplicate `const claimedBy`/`const cfg`:

```ts
const claimedBy = args.claimedBy?.trim() || '@agent';

// Dependency gate (all modes): a locked task cannot be claimed by an agent.
const states = await loadTreeStateFromParser(deps.parser).catch(() => undefined);
const derived = states?.get(args.taskId) ?? states?.get(args.taskId.trim().toUpperCase());
if (derived?.locked) {
  return { claimed: false, taskId: args.taskId, locked: true, blockedBy: derived.blockedBy };
}

const cfg = await resolveSyncConfig(deps);
```

(Because this block **replaces** the original `claimedBy`/`cfg` declarations at ~lines 412–413, no duplicate `const claimedBy` or `const cfg` remains — do not leave the originals in place.)

Replace `completeTaskHandler` with the bug-rule-enforcing version:

```ts
/** Move a task into completed/. Bugs must be traced to their cause first. */
export async function completeTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<MoveResult> {
  const task = await deps.parser.getTask(args.taskId);
  if (task?.type === 'bug') {
    const cause = task.causedBy?.trim();
    if (!cause) {
      throw new Error(
        'A bug must be traced to the task that caused it (set caused_by) before it can be completed.'
      );
    }
    const causeTask = await deps.parser.getTask(cause);
    if (!causeTask) {
      throw new Error(`caused_by references ${cause} which does not exist.`);
    }
  }
  const dest = await deps.writer.completeTask(args.taskId, deps.parser);
  return { taskId: args.taskId, outcome: 'completed', path: dest };
}
```

- [ ] **Step 4: Run tests to verify green**

Run: `bun run test -- mcpWriteHandlers`
Expected: PASS.
Run: `bun run test -- mcpHandlers && bun run lint && bun run typecheck`
Expected: PASS (the claim gate runs before the sync fork; `mcpHandlers.test.ts`'s synced-routing cases use tasks with no unmet deps, so they stay green).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/handlers.ts src/test/unit/mcpWriteHandlers.test.ts
git commit -m "feat(tech-tree P1): claim_task refuses locked tasks; complete_task enforces bug trace

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: UI-side gate — dispatch refusal, force claim, config priorities

**Files:**

- Modify: `src/providers/dispatchActions.ts`, `src/providers/claimActions.ts`, `src/providers/TaskDetailProvider.ts`, `src/extension.ts`, `package.json`
- Test: `src/test/unit/TaskDetailProvider.test.ts` (config-priorities assertion)

**Interfaces:**

- `dispatchTask` refuses a locked task (message via `blockedByMessage`), returns `undefined`.
- `claimTaskForCurrentUser(taskId, parser, opts?: { force?: boolean })` — when not forced and the task is locked, shows a modal offering **Force claim**; declining returns `undefined`. `force: true` bypasses the gate only (claim-conflict/surrender resolution unchanged).
- New command `taskwright.forceClaimTask` (human-only override) registered in `package.json` + `extension.ts` next to `taskwright.claimTask`.
- `TaskDetailData.priorities` is populated from `resolvePriorities(config)` instead of the hardcoded `['high','medium','low']`.

> This task is primarily VS Code-facing wiring on top of already-unit-tested cores (`loadTreeStateFromParser`, `treeGate`, `resolvePriorities`); per the house TDD exception it is UI/glue. The one cleanly unit-testable seam — the detail panel's config-driven priorities — gets a red→green cycle; the dispatch/claim refusals are exercised by `e2e/dispatch.spec.ts` and verified by the full gate + a manual F5 smoke.

- [ ] **Step 1: Write the failing test**

Append to `src/test/unit/TaskDetailProvider.test.ts` and add `getConfig` to the `mockParser` (in `beforeEach`, add `getConfig: vi.fn().mockResolvedValue({}),` to the `mockParser` object). Then add a test that opens a task and asserts the posted `taskData.priorities` reflects config:

```ts
it('sends config-driven priorities in taskData (tech-tree P1)', async () => {
  (mockParser.getConfig as Mock).mockResolvedValue({ priorities: ['Critical', 'Normal', 'Low'] });
  (mockParser.getTask as Mock).mockResolvedValue({
    id: 'TASK-1',
    title: 'T',
    status: 'To Do',
    labels: [],
    assignee: [],
    dependencies: [],
    acceptanceCriteria: [],
    definitionOfDone: [],
    filePath: '/fake/backlog/tasks/task-1.md',
  });

  const provider = new TaskDetailProvider(extensionUri, mockParser);
  provider.setBacklogPath('/fake/backlog');
  await provider.openTask('TASK-1');
  // openTask defers the first send by 100ms.
  await new Promise((r) => setTimeout(r, 150));

  const taskDataCall = (mockWebview.postMessage as Mock).mock.calls
    .map((c) => c[0])
    .find((m) => m?.type === 'taskData');
  expect(taskDataCall?.data.priorities).toEqual(['Critical', 'Normal', 'Low']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- TaskDetailProvider`
Expected: FAIL — `priorities` is still the hardcoded `['high','medium','low']`.

- [ ] **Step 3: Implement**

Edit `src/providers/TaskDetailProvider.ts`. Add the import:

```ts
import { resolvePriorities } from '../core/priorityOrder';
```

In `sendTaskData` (where the `TaskDetailData` object is built, ~line 505), replace the hardcoded priorities. Just before the `const data: TaskDetailData = {` block, resolve config:

```ts
const config = await this.parser.getConfig();
const priorities = resolvePriorities(config);
```

and change the field:

```ts
        statuses,
        priorities,
```

Edit `src/providers/dispatchActions.ts`. Add imports:

```ts
import { loadTreeStateFromParser } from '../core/treeDerived';
import { blockedByMessage } from '../core/treeGate';
```

In `dispatchTask`, after the `if (!task) { ... }` guard and before creating the worktree, add the gate:

```ts
// Dependency gate: never dispatch a locked task.
try {
  const states = await loadTreeStateFromParser(parser);
  const derived = states.get(task.id);
  if (derived?.locked) {
    vscode.window.showErrorMessage(blockedByMessage(task.id, derived.blockedBy));
    return undefined;
  }
} catch {
  // If derivation fails (e.g. transient IO), do not block dispatch.
}
```

Edit `src/providers/claimActions.ts`. Add imports:

```ts
import { loadTreeStateFromParser } from '../core/treeDerived';
import { blockedByMessage } from '../core/treeGate';
```

Change the signature and add the lock modal at the top of `claimTaskForCurrentUser`:

```ts
export async function claimTaskForCurrentUser(
  taskId: string,
  parser: BacklogParser,
  opts: { force?: boolean } = {}
): Promise<Claim | undefined> {
  const identity = getClaimIdentity();

  // Dependency gate (human-overridable). Skipped when force is set.
  if (!opts.force) {
    try {
      const states = await loadTreeStateFromParser(parser);
      const derived = states.get(taskId);
      if (derived?.locked) {
        const choice = await vscode.window.showWarningMessage(
          blockedByMessage(taskId, derived.blockedBy),
          { modal: true },
          'Force claim'
        );
        if (choice !== 'Force claim') return undefined;
      }
    } catch {
      // derivation failure must not block a claim
    }
  }

  const syncTarget = await resolveSyncTarget(parser);
  // ... rest of the existing function unchanged ...
```

(The remainder of `claimTaskForCurrentUser` — sync target, conflict resolution, `claimService.claimTask` — is unchanged.)

Edit `src/extension.ts`. Register the force-claim command immediately after the `taskwright.claimTask` registration (inside the same `context.subscriptions.push(...)` group, before the closing `)`), mirroring the claim command:

```ts
    vscode.commands.registerCommand('taskwright.forceClaimTask', async (arg?: unknown) => {
      if (!parser) {
        vscode.window.showErrorMessage('No backlog folder found in workspace');
        return;
      }
      const taskId = resolveClaimTarget(arg);
      if (!taskId) {
        vscode.window.showInformationMessage('Open a task to force-claim it.');
        return;
      }
      try {
        const claim = await claimTaskForCurrentUser(taskId, parser, { force: true });
        if (!claim) return;
        refreshAllViews();
        vscode.window.showInformationMessage(`Force-claimed ${taskId} as ${claim.claimedBy}`);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to force-claim task: ${error}`);
      }
    }),
```

Edit `package.json` — add the command contribution after `taskwright.claimTask` (in `contributes.commands`):

```json
      {
        "command": "taskwright.forceClaimTask",
        "title": "Taskwright: Force Claim Task (override dependency gate)",
        "icon": "$(lock)"
      },
```

- [ ] **Step 4: Run tests to verify green**

Run: `bun run test -- TaskDetailProvider`
Expected: PASS.
Run: `bun run test && bun run lint && bun run typecheck`
Expected: PASS. Manually verify (F5) that dispatching/claiming a task whose dependency is not Done refuses with the blocked-by message and offers Force claim; a `taskwright.forceClaimTask` invocation bypasses the gate.

- [ ] **Step 5: Commit**

```bash
git add src/providers/dispatchActions.ts src/providers/claimActions.ts src/providers/TaskDetailProvider.ts src/extension.ts package.json src/test/unit/TaskDetailProvider.test.ts
git commit -m "feat(tech-tree P1): UI dependency gate — dispatch refusal, force-claim override, config priorities

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec § → task coverage**

| Spec / directive area                                                                              | Task(s)                                                                                |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| §3.1 `category` (surgical), `type: bug`, `caused_by` fields                                        | Tasks 2 (model/parse), 3 (surgical write)                                              |
| §3.1 / §10 priority → user-defined ordered list (config `priorities`)                              | Task 1 (`priorityOrder`, relax `TaskPriority`, `parsePriority`)                        |
| §3.2 config `categories`; reserved lanes/band constants                                            | Tasks 2 (`categories`, `getCategories`), 5 (`BUGS_LANE`/`MISC_LANE`/`BACKBURNER_BAND`) |
| §3.3 derived `locked`/`blockedBy`                                                                  | Tasks 4 (`treeGate`), 6 (`deriveTreeState`)                                            |
| §3.3 derived `bugs`/`activeBugIds`                                                                 | Task 6                                                                                 |
| §3.3 / §10 derived `layout {lane, band, depth, subRow}`                                            | Task 5 (`treeLayout`), 6 (compose)                                                     |
| §4 layout rules (lane/band/depth/in-cell order); §10 sub-rows                                      | Task 5                                                                                 |
| §5.1 gate: `claim_task` refuses; dispatch refuses                                                  | Tasks 9 (MCP claim), 10 (dispatch)                                                     |
| §5.2 human-only Force claim; no MCP `force`; DAG invariant `wouldCreateCycle`                      | Tasks 10 (`forceClaimTask`), 8 (cycle validation), 4 (`wouldCreateCycle`)              |
| §6 bug lifecycle: `complete_task` requires resolvable `caused_by`                                  | Task 9                                                                                 |
| §7 MCP surface: create/edit fields, claim gate, complete rule, summaries, `forceClaimTask` command | Tasks 7, 8, 9, 10                                                                      |
| §8 TDD (gate, cycle, layout, bug-completion, surgical round-trip)                                  | Tasks 3, 4, 5, 6, 8, 9                                                                 |

**2. Placeholder scan:** No TBD/TODO; every code and test step is complete and runnable.

**3. Type consistency:** `TaskPriority = string` (Task 1) flows through parser, `CardData`, `TaskSummary`, and detail data. `TreeLayout`/`TreeDerivedState` names are stable across `treeLayout.ts` (Task 5), `treeDerived.ts` (Task 6), `types.ts` (Task 6), and `handlers.ts` (Task 7). `resolveDoneStatus`/`computeBlockedBy`/`wouldCreateCycle`/`blockedByMessage` signatures match every call site (Tasks 4, 6, 8, 9, 10). `McpHandlerDeps.treeFieldService` is added in Task 8 and consumed in Tasks 8/9; the temp-dir `deps()` helper is updated alongside.

**4. Investigated open sub-choice (Task 8 writer serialization):** locked to Approach B (surgical `TreeFieldService` after create/update for `category`/`caused_by`; `type`/`dependencies` via BacklogWriter) with the verified rationale documented inline.

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Work in `.worktrees/tech-tree-p1` on branch `tech-tree-p1`. Which approach?
