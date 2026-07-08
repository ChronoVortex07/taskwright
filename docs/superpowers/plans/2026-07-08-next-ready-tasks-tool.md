# `next_ready_tasks` Selection Core + MCP Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Taskwright MCP tool `next_ready_tasks` (backed by a pure selection core `src/core/readyTasks.ts`) that returns the board tasks which are **ready to execute right now** — status not Done, every dependency Done, no live foreign claim, not locked/blocked, and not already in the merge queue — sorted by priority then ordinal, so an orchestrator can pull the next unit(s) of work.

**Architecture.** This mirrors the P4 read-tool pattern end-to-end (`search_tasks`): a **vscode-free pure core** does the interesting, fully-unit-testable work (the READY predicate + the priority/ordinal sort over `Task[]`), and a **thin MCP handler** in `src/mcp/handlers.ts` does the disk/git I/O (load the derived board, read the shared merge queue) and shapes the selected tasks into the exact same compact rows `get_board` returns via the existing private `toBoardSummary`. Registration in `src/mcp/server.ts` follows the sibling read tools (`jsonContent(await handler(...))`). No new frontmatter, no writes, no new `McpHandlerDeps` field.

**Tech Stack:** TypeScript, Vitest (pure-core temp-free unit tests + parser-backed handler tests over a temp `backlog/`). The MCP server is a separate stdio process that imports only `src/core` + `src/mcp`. Node ≥ 22, build/test via Bun.

## Prerequisites

**None — this draft is independent.** DRAFT-5 reuses only already-landed cores (`searchTasks.ts` pattern, `treeDerived.ts`, `treeGate.ts`, `priorityOrder.ts`, `claims.ts`, `claimResolution.ts`, `mergeQueue.ts`, `toBoardSummary`). It does **not** depend on DRAFT-3 (`start_task`) or DRAFT-4 (`request_merge worktree?`) code, and touches none of their files, so this worktree may be carved from the current base at any time.

## Global Constraints

_Every task's requirements implicitly include this section._

- **This task is ONE dispatched PR.** It runs in its own `.worktrees/<branch>` created by the board Dispatch / `/execute-task` flow. Work only inside that worktree; run all git/file/test commands there. NEVER git checkout/commit/merge in the repo root (shared; a pre-commit hook blocks it). A fresh worktree has no `node_modules` (git-ignored) — run `bun install` there ONCE before the first build/test.
- **Runtime:** Node >= 22; build/test via **Bun**: `bun run test` (Vitest), `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test:playwright`, `bun run test:e2e`, `bun run test:cdp`.
- **Commit with `--no-verify`** (the repo's lint-staged pre-commit hook flips the whole tree CRLF->LF on Windows). Stage only the files each task names.
- **Baseline:** after `bun install`, run `bun run test` once in the worktree and record the actual pass count. Windows shows ~22 KNOWN upstream POSIX-path unit failures — unrelated, do NOT "fix" them. Confirm no previously-green test regresses.
- **Verify gate at the end of every `### Task N`:** `bun run test && bun run lint && bun run typecheck` must pass (plus any task-specific webview/e2e suite named in that task).
- **Commit trailer:** end each commit message with `Co-Authored-By: <your model> <noreply@anthropic.com>` and `Completes <this task id>.` (the dispatched agent substitutes its own model line per AGENTS.md, and — since DRAFT-5 is promoted to a `TASK-N` id at dispatch — the real promoted task id in place of `DRAFT-5`).
- **Close:** the `/execute-task` flow closes via `request_merge` from inside the worktree — do NOT ff-merge or push from the repo root yourself.

- **MCP primary-build live-caveat (CRITICAL for src/mcp changes):** the `taskwright` MCP server running in a worktree is the PRIMARY checkout's already-built `dist/mcp/server.js` (via `scripts/taskwright-mcp.cjs`). Your changes to `src/mcp/handlers.ts`/`src/mcp/server.ts` (Task 2) are NOT live in the worktree until this branch merges and the primary rebuilds. Therefore exercise them ONLY via unit tests (`bun run test`) — never by calling the new `next_ready_tasks` tool live from the worktree.

## Locked names & wire conventions (do not rename)

- **`next_ready_tasks` MCP tool** (DRAFT-5): input `{ limit?: number; category?: string; milestone?: string }`; output `TaskSummary[]` **identical in shape to `get_board` rows** — i.e. the existing `BoardTaskSummary` (`{ id, title, status, priority?, category?, milestone?, type?, causedBy?, dependencies, blockedBy, locked, draft }`), because the tool reuses `get_board`'s `toBoardSummary` builder verbatim. Filtered to READY = status not Done AND every dependency Done AND not claimed by a live (non-stale) session AND not locked/blocked AND not currently in the merge queue; ordered by priority (high>medium>low) then ordinal.
- **Pure core** `src/core/readyTasks.ts` exporting `selectReadyTasks(tasks, board, opts): Task[]` and `DEFAULT_CLAIM_STALENESS_HOURS`. It returns the **selected `Task[]`** (exactly as the P4 core `searchTasks` returns the ranked `T[]`); the handler maps them to `BoardTaskSummary` rows. `opts: SelectReadyOptions` = `{ doneStatus, priorities, stalenessMs, inMergeQueue?, category?, milestone?, limit?, now? }`.
- **Handler** `nextReadyTasksHandler(deps: McpHandlerDeps, args: NextReadyArgs = {}): Promise<BoardTaskSummary[]>` in `src/mcp/handlers.ts`, with `interface NextReadyArgs { limit?: number; category?: string; milestone?: string }`. Registered in `src/mcp/server.ts` as `next_ready_tasks` via `jsonContent(await nextReadyTasksHandler(deps, args))` (mirrors `get_board`/`search_tasks`).

### Design notes bound before coding (read once)

1. **"Every dependency Done" == "not locked".** The board derivation already computes `blockedBy` (deps not at the Done status and not in completed/archive) and `locked = blockedBy.length > 0` per task (`src/core/treeGate.ts` `computeBlockedBy`, surfaced via `src/core/treeDerived.ts` `board.states`). So the READY conditions "every dependency is Done" and "not locked/blocked" are the **same** check — implement both via `!derived.locked`. No re-derivation.
2. **"Live claim".** A task is claimed by a *live* session when `task.claimedBy` is set AND the claim is **not stale**. Reuse `isClaimStale(claimedAt, stalenessMs, now)` (`src/core/claims.ts`). Match `resolveClaimAction` semantics exactly (`src/core/claimResolution.ts`): when `stalenessMs <= 0` (staleness disabled) every claim is treated as **live** (never stale). Staleness window = `stalenessMsFromHours(DEFAULT_CLAIM_STALENESS_HOURS)`, `DEFAULT_CLAIM_STALENESS_HOURS = 12` (mirrors the `taskwright.claimStalenessHours` setting default in `package.json`; the vscode-free MCP server cannot read VS Code settings, so the pure-core constant is the fallback).
3. **"In the merge queue".** The shared queue lives at `<commonDir>/taskwright/merge-queue.json` (`src/core/mergeQueue.ts` `mergeQueuePath`); each `QueueEntry` has `active`/`activeAt` (True while the head performs its merge). A task with **any** queue entry is mid-integration (its head entry flips `active` during the merge), so the handler excludes **every** queued task id — `queue.entries.map(e => e.taskId)`. The handler reads `commonDir` via `git rev-parse --git-common-dir` and is **fail-open**: no git / no queue file ⇒ nothing to exclude (mirrors `getActiveTask`'s queue-position lookup).
4. **Universe = active tasks only.** The handler passes `parser.getTasks()` (folder `tasks`) — **not** drafts. A draft is a proposal that must be promoted before it can be dispatched, so drafts are never "ready". This is the deliberate difference from `get_board` (which unions tasks + drafts). The pure core additionally guards `folder === 'completed' | 'archive'` defensively.
5. **Sort.** Primary key: priority via `priorityRank(task.priority, priorities)` ascending (rank 0 = highest; unknown/absent sorts last — `src/core/priorityOrder.ts`). Secondary: `ordinal` ascending, tasks with no ordinal last. Final stable tiebreak: `id.localeCompare`.
6. **Row shape.** The handler maps each selected task via the existing **private** `toBoardSummary(task, board)` in `handlers.ts` (it needs the board for `blockedBy`/`locked`). `nextReadyTasksHandler` lives in the same file, so it calls it directly — do not export it, do not duplicate it.

---

## File Structure

**Create:**

- `src/core/readyTasks.ts` — vscode-free selection core: `selectReadyTasks(tasks, board, opts): Task[]` (READY predicate + priority/ordinal sort + category/milestone/limit) and `DEFAULT_CLAIM_STALENESS_HOURS`.
- `src/test/unit/readyTasks.test.ts` — pure-core unit tests (undone-dep excluded / dep-done included, live-claim excluded, stale-claim NOT excluded, in-merge-queue excluded, priority-then-ordinal order, filters + limit clamp, staleness-disabled).
- `src/test/unit/nextReadyTasks.test.ts` — parser-backed handler tests over a temp `backlog/` (mirrors `mcpReadHandlers.test.ts`): dependency gating, Done exclusion, live claim, injected merge queue, category filter + limit, draft exclusion.

**Modify:**

- `src/mcp/handlers.ts` — add imports (`selectReadyTasks` + `DEFAULT_CLAIM_STALENESS_HOURS` from `../core/readyTasks`; `stalenessMsFromHours` from `../core/claimResolution`); add `interface NextReadyArgs` + `nextReadyTasksHandler`.
- `src/mcp/server.ts` — import `nextReadyTasksHandler`; register the `next_ready_tasks` tool.

---

## Task 1: `src/core/readyTasks.ts` selection core + unit tests

**Files:**

- Create: `src/core/readyTasks.ts`
- Test: `src/test/unit/readyTasks.test.ts`

**Goal:** The pure, fully-unit-testable heart of the feature. It has **no consumers yet**, so it lands green in isolation. Build the READY predicate and the priority/ordinal sort over `Task[]`, taking the already-derived `TreeBoard` (for `locked`/`bandOrder`) and an options bag so every branch (staleness, queue, filters, limit) is deterministic under test.

- [ ] **Step 1: Write the failing tests**

Create `src/test/unit/readyTasks.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Task } from '../../core/types';
import { deriveTreeBoard, type TreeBoard } from '../../core/treeDerived';
import { claimTimestamp } from '../../core/claims';
import { selectReadyTasks, type SelectReadyOptions } from '../../core/readyTasks';

/** Minimal Task factory: an active To-Do task with no deps/claims. */
const T = (over: Partial<Task> & { id: string }): Task => ({
  title: over.id,
  status: 'To Do',
  labels: [],
  assignee: [],
  dependencies: [],
  acceptanceCriteria: [],
  definitionOfDone: [],
  filePath: `backlog/tasks/${over.id}.md`,
  folder: 'tasks',
  ...over,
});

/** Build a real derived board (real locked/blockedBy) from the task universe. */
const boardOf = (tasks: Task[]): TreeBoard =>
  deriveTreeBoard(tasks, {
    doneStatus: 'Done',
    milestoneOrder: [],
    priorities: ['high', 'medium', 'low'],
    categories: [],
  });

/** Base options: 12h staleness, a fixed clock so claim freshness is deterministic. */
const opts = (over: Partial<SelectReadyOptions> = {}): SelectReadyOptions => ({
  doneStatus: 'Done',
  priorities: ['high', 'medium', 'low'],
  stalenessMs: 12 * 3600_000,
  now: new Date('2026-07-08T12:00:00').getTime(),
  ...over,
});

describe('selectReadyTasks', () => {
  it('excludes a task with an undone dependency; includes it once the dep is Done', () => {
    const blocked = [
      T({ id: 'TASK-1', status: 'To Do' }),
      T({ id: 'TASK-2', dependencies: ['TASK-1'] }),
    ];
    expect(selectReadyTasks(blocked, boardOf(blocked), opts()).map((t) => t.id)).toEqual([
      'TASK-1',
    ]); // TASK-2 is blocked by the undone TASK-1

    const unblocked = [
      T({ id: 'TASK-1', status: 'Done' }),
      T({ id: 'TASK-2', dependencies: ['TASK-1'] }),
    ];
    // TASK-1 is Done (excluded); TASK-2's only dep is satisfied ⇒ ready.
    expect(selectReadyTasks(unblocked, boardOf(unblocked), opts()).map((t) => t.id)).toEqual([
      'TASK-2',
    ]);
  });

  it('excludes a task under a LIVE claim but includes one whose claim is STALE', () => {
    const now = new Date('2026-07-08T12:00:00');
    const live = T({
      id: 'TASK-1',
      claimedBy: '@other',
      claimedAt: claimTimestamp(new Date(now.getTime() - 1 * 3600_000)), // 1h ago → live
    });
    const stale = T({
      id: 'TASK-2',
      claimedBy: '@other',
      claimedAt: claimTimestamp(new Date(now.getTime() - 13 * 3600_000)), // 13h ago → stale (>12h)
    });
    const tasks = [live, stale];
    // Live claim hides TASK-1; a stale claim is abandoned/reclaimable ⇒ TASK-2 stays.
    expect(selectReadyTasks(tasks, boardOf(tasks), opts({ now: now.getTime() })).map((t) => t.id)).toEqual(
      ['TASK-2']
    );
  });

  it('treats every claim as live when staleness is disabled (stalenessMs <= 0)', () => {
    const now = new Date('2026-07-08T12:00:00');
    const old = T({
      id: 'TASK-1',
      claimedBy: '@x',
      claimedAt: claimTimestamp(new Date(now.getTime() - 100 * 3600_000)), // ancient, but…
    });
    // …staleness disabled ⇒ the claim is still LIVE ⇒ excluded (matches resolveClaimAction).
    expect(selectReadyTasks([old], boardOf([old]), opts({ stalenessMs: 0, now: now.getTime() }))).toEqual(
      []
    );
  });

  it('excludes a task that is currently in the merge queue', () => {
    const tasks = [T({ id: 'TASK-1' }), T({ id: 'TASK-2' })];
    expect(
      selectReadyTasks(tasks, boardOf(tasks), opts({ inMergeQueue: ['TASK-2'] })).map((t) => t.id)
    ).toEqual(['TASK-1']); // TASK-2 is mid-integration
  });

  it('orders by priority (high>medium>low), then ordinal ascending', () => {
    const tasks = [
      T({ id: 'TASK-1', priority: 'low' }),
      T({ id: 'TASK-2', priority: 'high', ordinal: 2000 }),
      T({ id: 'TASK-3', priority: 'high', ordinal: 1000 }),
      T({ id: 'TASK-4', priority: 'medium' }),
    ];
    // high(ord 1000) < high(ord 2000) < medium < low
    expect(selectReadyTasks(tasks, boardOf(tasks), opts()).map((t) => t.id)).toEqual([
      'TASK-3',
      'TASK-2',
      'TASK-4',
      'TASK-1',
    ]);
  });

  it('filters by category and milestone (Backburner matches unset), and clamps the limit', () => {
    const tasks = [
      T({ id: 'TASK-1', category: 'Features', milestone: 'v1', priority: 'high' }),
      T({ id: 'TASK-2', category: 'Platform', milestone: 'v1', priority: 'high' }),
      T({ id: 'TASK-3', category: 'Features', priority: 'medium' }), // no milestone ⇒ Backburner
    ];
    const board = boardOf(tasks);
    expect(selectReadyTasks(tasks, board, opts({ category: 'Features' })).map((t) => t.id)).toEqual([
      'TASK-1',
      'TASK-3',
    ]);
    expect(selectReadyTasks(tasks, board, opts({ milestone: 'v1' })).map((t) => t.id)).toEqual([
      'TASK-1',
      'TASK-2',
    ]);
    expect(
      selectReadyTasks(tasks, board, opts({ milestone: 'Backburner' })).map((t) => t.id)
    ).toEqual(['TASK-3']);
    // limit clamps to >= 1 and floors; omitted ⇒ all.
    expect(selectReadyTasks(tasks, board, opts({ limit: 0 }))).toHaveLength(1);
    expect(selectReadyTasks(tasks, board, opts({ limit: 2 }))).toHaveLength(2);
    expect(selectReadyTasks(tasks, board, opts())).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- readyTasks`
Expected: FAIL — Vitest cannot resolve the import `../../core/readyTasks` (module does not exist yet), so every case in the file errors at collection time.

- [ ] **Step 3: Write `src/core/readyTasks.ts`**

```ts
import type { Task } from './types';
import type { TreeBoard } from './treeDerived';
import { laneOf, BACKBURNER_BAND } from './treeLayout';
import { priorityRank } from './priorityOrder';
import { isClaimStale } from './claims';

/**
 * Default claim-staleness window (hours) when the caller supplies none. Mirrors the
 * `taskwright.claimStalenessHours` setting default (12) in package.json. The MCP server
 * is vscode-free and cannot read VS Code settings, so the handler falls back to this.
 */
export const DEFAULT_CLAIM_STALENESS_HOURS = 12;

export interface SelectReadyOptions {
  /** Terminal/Done status name — resolveDoneStatus(config.statuses). */
  doneStatus: string;
  /** Highest-first priority vocabulary — resolvePriorities(config); drives the primary sort. */
  priorities: string[];
  /** Claim-staleness window in ms; a claim older than this is NOT live (reclaimable).
   *  `<= 0` disables expiry — every claim is then treated as live (matches resolveClaimAction). */
  stalenessMs: number;
  /** Task IDs currently in the shared merge queue (mid-integration) — excluded. */
  inMergeQueue?: Iterable<string>;
  /** Lane filter (case-insensitive), matched via laneOf so 'Bugs'/'Misc' work. */
  category?: string;
  /** Band filter (case-insensitive); 'Backburner' matches an unset/unknown milestone. */
  milestone?: string;
  /** Max rows to return (clamped to >= 1, floored); omitted ⇒ all ready tasks. */
  limit?: number;
  /** Injectable clock (ms) for claim-staleness; defaults to Date.now(). */
  now?: number;
}

/**
 * A task is held by a LIVE claim when someone holds it and the claim is not stale.
 * `stalenessMs <= 0` disables expiry, so every claim is live — this matches
 * resolveClaimAction, which returns 'conflict' (not 'stale') when staleness is off.
 */
function hasLiveClaim(task: Task, stalenessMs: number, now: number): boolean {
  if (!task.claimedBy || !task.claimedBy.trim()) return false;
  if (stalenessMs <= 0) return true;
  return !isClaimStale(task.claimedAt, stalenessMs, now);
}

/**
 * A task's canonical band: its trimmed milestone matched case-insensitively to a known
 * band, else Backburner (mirrors get_board's makeBandResolver so filtering agrees).
 */
function bandOf(task: Task, bandOrder: string[]): string {
  const m = task.milestone?.trim();
  if (!m) return BACKBURNER_BAND;
  const match = bandOrder.find((b) => b.toLowerCase() === m.toLowerCase());
  return match ?? BACKBURNER_BAND;
}

/**
 * Ready-task sort: priority (high>medium>low via the configured vocabulary; unknown last),
 * then ordinal ascending (tasks with no ordinal last), then id for a stable final tiebreak.
 */
function compareReady(a: Task, b: Task, priorities: string[]): number {
  const pr = priorityRank(a.priority, priorities) - priorityRank(b.priority, priorities);
  if (pr !== 0) return pr;
  const ao = a.ordinal;
  const bo = b.ordinal;
  if (ao !== undefined && bo === undefined) return -1;
  if (ao === undefined && bo !== undefined) return 1;
  if (ao !== undefined && bo !== undefined && ao !== bo) return ao - bo;
  return a.id.localeCompare(b.id);
}

/**
 * The pure selector behind `next_ready_tasks`: the subset of `tasks` ready to execute now,
 * sorted by priority then ordinal. A task is READY when:
 *   1. its status is not the Done status (and it is not in completed/archive);
 *   2. every dependency is Done — i.e. it is NOT locked/blocked (board.states);
 *   3. it is not held by a LIVE (non-stale) claim;
 *   4. it is not currently in the shared merge queue.
 * Optional category/milestone filters use the same lane/band semantics as get_board.
 *
 * Mirrors the P4 read-tool core (searchTasks): returns the selected `Task[]`; the handler
 * shapes them into get_board rows via toBoardSummary. Callers pass the ACTIVE task universe
 * (parser.getTasks()) — drafts are never ready (they must be promoted first).
 */
export function selectReadyTasks(
  tasks: Task[],
  board: TreeBoard,
  opts: SelectReadyOptions
): Task[] {
  const now = opts.now ?? Date.now();
  const inQueue = new Set<string>();
  for (const id of opts.inMergeQueue ?? []) inQueue.add(id.trim().toUpperCase());
  const catF = opts.category?.trim().toLowerCase();
  const mileF = opts.milestone?.trim().toLowerCase();

  const ready = tasks.filter((t) => {
    if (t.status === opts.doneStatus) return false;
    if (t.folder === 'completed' || t.folder === 'archive') return false;
    const derived = board.states.get(t.id.trim().toUpperCase());
    if (derived?.locked) return false;
    if (hasLiveClaim(t, opts.stalenessMs, now)) return false;
    if (inQueue.has(t.id.trim().toUpperCase())) return false;
    if (catF && laneOf(t).toLowerCase() !== catF) return false;
    if (mileF && bandOf(t, board.bandOrder).toLowerCase() !== mileF) return false;
    return true;
  });

  ready.sort((a, b) => compareReady(a, b, opts.priorities));
  if (opts.limit === undefined) return ready;
  return ready.slice(0, Math.max(1, Math.floor(opts.limit)));
}
```

- [ ] **Step 4: Run the tests + typecheck**

Run: `bun run test -- readyTasks && bun run typecheck`
Expected: PASS — all 6 cases green; typecheck clean (`selectReadyTasks`/`SelectReadyOptions` resolve, `TreeBoard`/`Task` imports type-check).

- [ ] **Step 5: Full task gate**

Run: `bun run test && bun run lint && bun run typecheck`
Expected: PASS (modulo the ~22 known Windows POSIX-path failures recorded in your baseline — no NEW failures; the new file adds 6 passing cases). No consumers yet, so nothing else can regress.

- [ ] **Step 6: Commit**

```bash
git add src/core/readyTasks.ts src/test/unit/readyTasks.test.ts
git commit --no-verify -m "feat: readyTasks selection core (READY predicate + priority/ordinal sort)

- src/core/readyTasks.ts: selectReadyTasks(tasks, board, opts) returns the active tasks
  that are ready to execute — not Done, every dependency Done (not locked), no live
  (non-stale) claim, not in the merge queue — sorted by priority then ordinal, with
  optional category/milestone filters and a clamped limit. DEFAULT_CLAIM_STALENESS_HOURS=12
  mirrors the taskwright.claimStalenessHours setting default.
- unit tests: undone-dep excluded / dep-done included, live-claim excluded, stale-claim
  NOT excluded, staleness-disabled treats claims as live, in-merge-queue excluded,
  priority-then-ordinal order, category/milestone filters + limit clamp.

Co-Authored-By: <your model> <noreply@anthropic.com>
Completes DRAFT-5."
```

**Dependencies:** none (leaf core).

---

## Task 2: `next_ready_tasks` MCP handler + registration + handler tests

**Files:**

- Modify: `src/mcp/handlers.ts`, `src/mcp/server.ts`
- Test: `src/test/unit/nextReadyTasks.test.ts`

**Goal:** Wire the pure core to the MCP surface. The handler reads the derived board + active tasks + config, resolves the shared merge queue (fail-open), calls `selectReadyTasks`, and maps the result through the existing private `toBoardSummary` so the rows are byte-identical to `get_board`'s. Register the tool in `server.ts` following the sibling read tools. **Live-caveat:** exercise ONLY via unit tests — the worktree's MCP process runs the primary build.

- [ ] **Step 1: Write the failing handler tests**

Create `src/test/unit/nextReadyTasks.test.ts` (mirrors `src/test/unit/mcpReadHandlers.test.ts` — its own temp `backlog/` scaffold + a `deps()` helper):

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
  claimTaskHandler,
  nextReadyTasksHandler,
} from '../../mcp/handlers';
import type { McpHandlerDeps } from '../../mcp/handlers';
import type { GitExecFn } from '../../core/finishTask';
import { mergeQueuePath, type QueueFsDeps } from '../../core/mergeQueue';

let root: string, backlogPath: string;
function scaffold(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-ready-'));
  backlogPath = path.join(root, 'backlog');
  fs.mkdirSync(path.join(backlogPath, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(backlogPath, 'drafts'), { recursive: true });
  fs.writeFileSync(
    path.join(backlogPath, 'config.yml'),
    'project_name: "t"\nstatuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: "task"\n',
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

describe('nextReadyTasksHandler', () => {
  it('includes a task once its dependency is Done; excludes blocked and Done tasks', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'Base' }); // TASK-1
    await createTaskHandler(d, { title: 'Dep', dependencies: ['TASK-1'] }); // TASK-2

    // Blocked while TASK-1 is open: only TASK-1 is ready.
    let ready = await nextReadyTasksHandler(d, {});
    expect(ready.map((r) => r.id)).toEqual(['TASK-1']);

    // Finish TASK-1 ⇒ it drops out (Done) and TASK-2 unblocks.
    await editTaskHandler(d, { taskId: 'TASK-1', status: 'Done' });
    ready = await nextReadyTasksHandler(d, {});
    expect(ready.map((r) => r.id)).toEqual(['TASK-2']);
    // Rows are the get_board compact shape:
    expect(ready[0]).toHaveProperty('blockedBy');
    expect(ready[0]).toHaveProperty('locked', false);
  });

  it('excludes a task held by a live claim', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'A' }); // TASK-1
    await createTaskHandler(d, { title: 'B' }); // TASK-2
    await claimTaskHandler(d, { taskId: 'TASK-1', claimedBy: '@other' }); // claimedAt = now → live
    const ready = await nextReadyTasksHandler(d, {});
    expect(ready.map((r) => r.id)).toEqual(['TASK-2']);
  });

  it('excludes a task that is in the shared merge queue (injected git + queue fs)', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'A' }); // TASK-1
    await createTaskHandler(d, { title: 'B' }); // TASK-2

    const commonDir = path.join(root, '.git');
    const queueFile = mergeQueuePath(commonDir);
    const queue = {
      version: 1,
      entries: [
        {
          taskId: 'TASK-2',
          branch: 'b',
          worktree: '.worktrees/b',
          mode: 'auto-merge',
          submittedAt: '',
          approved: false,
          active: true,
          activeAt: null,
        },
      ],
    };
    const gitExec: GitExecFn = async (_cwd, args) => {
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) {
        return { stdout: `${commonDir}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    const fsDeps: QueueFsDeps = {
      exists: (p) => p === queueFile,
      read: (p) => (p === queueFile ? `${JSON.stringify(queue)}\n` : ''),
      writeAtomic: () => {},
    };

    const ready = await nextReadyTasksHandler({ ...d, gitExec, fsDeps }, {});
    expect(ready.map((r) => r.id)).toEqual(['TASK-1']); // TASK-2 is mid-integration
  });

  it('filters by category and honors limit; sorts by priority', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'Hi', category: 'Features', priority: 'high' }); // TASK-1
    await createTaskHandler(d, { title: 'Lo', category: 'Features', priority: 'low' }); // TASK-2
    await createTaskHandler(d, { title: 'Other', category: 'Platform' }); // TASK-3 (no priority)

    // Category filter → only the Features lane, high before low.
    const feats = await nextReadyTasksHandler(d, { category: 'Features' });
    expect(feats.map((r) => r.id)).toEqual(['TASK-1', 'TASK-2']);

    // Limit caps to the top of the priority order across the whole board.
    const one = await nextReadyTasksHandler(d, { limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0].id).toBe('TASK-1'); // highest priority overall
  });

  it('never returns drafts (a draft must be promoted before dispatch)', async () => {
    const d = deps();
    await createTaskHandler(d, { title: 'Real' }); // TASK-1
    await createTaskHandler(d, { title: 'Idea', draft: true }); // DRAFT-1
    const ready = await nextReadyTasksHandler(d, {});
    expect(ready.map((r) => r.id)).toEqual(['TASK-1']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- nextReadyTasks`
Expected: FAIL — `nextReadyTasksHandler` is not exported from `../../mcp/handlers`, so the import is unresolved and the suite errors at collection.

- [ ] **Step 3: Add the imports to `src/mcp/handlers.ts`**

Immediately after the `finishTask` import block (`handlers.ts` — match the closing line `} from '../core/finishTask';`, currently around line 59):

```ts
import {
  requestMerge,
  type BoardOps,
  type GitExecFn,
  type RunFn,
  type RequestMergeResult,
} from '../core/finishTask';
```

add:

```ts
import { selectReadyTasks, DEFAULT_CLAIM_STALENESS_HOURS } from '../core/readyTasks';
import { stalenessMsFromHours } from '../core/claimResolution';
```

> `resolveDoneStatus` (from `../core/treeGate`), `resolvePriorities` (from `../core/priorityOrder`), and `loadTreeBoardFromParser` (from `../core/treeDerived`) are already imported at the top of the file — do not re-import them. `path`, `nodeQueueFs`, `queueStoreFor`, and `defaultGitExec` are already in scope in this module.

- [ ] **Step 4: Add the handler to `src/mcp/handlers.ts`**

Insert **after** `searchTasksHandler` — match its closing lines (currently around line 753):

```ts
  const ranked = searchTasks([...tasks, ...drafts], args.query, { limit: args.limit });
  return ranked.map((t) => toBoardSummary(t, board));
}
```

and add directly below:

```ts
export interface NextReadyArgs {
  limit?: number;
  category?: string;
  milestone?: string;
}

/**
 * `next_ready_tasks`: the subset of the ACTIVE board (tasks/, never drafts) that is ready
 * to execute right now — status not Done, every dependency Done (not locked), no live
 * (non-stale) foreign claim, and not currently in the shared merge queue — sorted by
 * priority then ordinal, returned as the same compact rows as get_board. The heavy lifting
 * (the READY predicate + sort) is the pure core selectReadyTasks; this handler does the
 * disk/git I/O and shapes the rows via toBoardSummary. Filter by category / milestone; cap
 * with limit. Drafts are excluded — a draft must be promoted before it can be dispatched.
 */
export async function nextReadyTasksHandler(
  deps: McpHandlerDeps,
  args: NextReadyArgs = {}
): Promise<BoardTaskSummary[]> {
  const [board, tasks, config] = await Promise.all([
    loadTreeBoardFromParser(deps.parser),
    deps.parser.getTasks(),
    deps.parser.getConfig(),
  ]);

  // Exclude tasks that are mid-integration in the shared merge queue. Fail-open:
  // not a git repo / no queue ⇒ exclude nothing (mirrors getActiveTask's queue lookup).
  let inMergeQueue: string[] = [];
  try {
    const exec = deps.gitExec ?? defaultGitExec;
    const fsDeps = deps.fsDeps ?? nodeQueueFs;
    const commonDir = path.resolve(
      (await exec(deps.root, ['rev-parse', '--git-common-dir'])).stdout.trim()
    );
    inMergeQueue = queueStoreFor(commonDir, fsDeps)
      .read()
      .entries.map((e) => e.taskId);
  } catch {
    // not a git repo / no queue — nothing to exclude
  }

  const ready = selectReadyTasks(tasks, board, {
    doneStatus: resolveDoneStatus(config.statuses),
    priorities: resolvePriorities(config),
    stalenessMs: stalenessMsFromHours(DEFAULT_CLAIM_STALENESS_HOURS),
    inMergeQueue,
    category: args.category,
    milestone: args.milestone,
    limit: args.limit,
  });
  return ready.map((t) => toBoardSummary(t, board));
}
```

> `BoardTaskSummary`, `toBoardSummary`, `queueStoreFor`, and `defaultGitExec` are all defined earlier in this same file, so the handler references them directly (no export/import needed). This is the identical shape/plumbing `get_board` and `search_tasks` use.

- [ ] **Step 5: Register the tool in `src/mcp/server.ts`**

(a) Add `nextReadyTasksHandler` to the handler import list — match:

```ts
  getBoardHandler,
  searchTasksHandler,
  createTaskHandler,
```

→

```ts
  getBoardHandler,
  searchTasksHandler,
  nextReadyTasksHandler,
  createTaskHandler,
```

(b) Register the tool right **after** the `search_tasks` registration — match its closing lines:

```ts
    async (args) => jsonContent(await searchTasksHandler(deps, args))
  );
```

and add directly below:

```ts
  server.registerTool(
    'next_ready_tasks',
    {
      title: 'Next ready tasks',
      description:
        'List the tasks that are READY to execute right now — status not Done, every dependency Done (unblocked), no live claim by another session, and not already in the merge queue — sorted by priority then ordinal. Returns the same compact rows as get_board ({ id, title, status, priority?, category?, milestone?, type?, causedBy?, dependencies, blockedBy, locked, draft }). Use this to pull the next unit(s) of work to dispatch. Drafts are excluded (promote first). Filter by category / milestone; cap with limit.',
      inputSchema: {
        limit: z.number().optional().describe('Max ready tasks to return (default: all).'),
        category: z.string().optional().describe('Lane filter (incl. reserved "Bugs"/"Misc").'),
        milestone: z
          .string()
          .optional()
          .describe('Band filter ("Backburner" matches an unset milestone).'),
      },
    },
    async (args) => jsonContent(await nextReadyTasksHandler(deps, args))
  );
```

- [ ] **Step 6: Run the tests + typecheck**

Run: `bun run test -- nextReadyTasks && bun run typecheck`
Expected: PASS — all 5 handler cases green; typecheck clean (handler return type `Promise<BoardTaskSummary[]>`, `NextReadyArgs`, and the new imports all resolve; `server.ts` registration type-checks against the `z` schema).

- [ ] **Step 7: Full task gate**

Run: `bun run test && bun run lint && bun run typecheck`
Expected: PASS — the full unit suite green except the ~22 known Windows POSIX-path failures from your recorded baseline (no NEW failures); this task adds 5 passing cases and leaves every previously-green test green. Lint clean (no unused imports — `stalenessMsFromHours`, `selectReadyTasks`, `DEFAULT_CLAIM_STALENESS_HOURS`, and `nextReadyTasksHandler` are all used).

> **Do NOT smoke-test the live tool from the worktree.** Per the MCP primary-build live-caveat, the worktree's `taskwright` MCP process runs the primary checkout's `dist/mcp/server.js`; `next_ready_tasks` becomes callable there only after this branch merges and the primary rebuilds. The unit tests are the verification.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/handlers.ts src/mcp/server.ts src/test/unit/nextReadyTasks.test.ts
git commit --no-verify -m "feat(mcp): next_ready_tasks tool (pull ready-to-execute work)

- nextReadyTasksHandler loads the derived board + active tasks + config, resolves the
  shared merge queue (fail-open on no-git/no-queue), runs the pure selectReadyTasks core,
  and returns get_board-shaped rows via toBoardSummary. Input { limit?, category?, milestone? }.
- register next_ready_tasks in server.ts (mirrors get_board/search_tasks: jsonContent).
- handler tests (parser-backed temp backlog, mirrors mcpReadHandlers): dependency gating +
  Done exclusion, live claim, injected merge-queue exclusion, category filter + limit + sort,
  draft exclusion.

Co-Authored-By: <your model> <noreply@anthropic.com>
Completes DRAFT-5."
```

**Dependencies:** Task 1 (imports `selectReadyTasks` + `DEFAULT_CLAIM_STALENESS_HOURS`).

---

## Self-Review

- **Spec coverage.** The locked contract is met exactly: MCP tool `next_ready_tasks` with input `{ limit?, category?, milestone? }`, output the `get_board`-identical `BoardTaskSummary[]`; pure core `src/core/readyTasks.ts` exporting `selectReadyTasks(...)`. READY = status not Done AND every dependency Done (implemented as `!derived.locked`, which IS the "all deps Done" check per `computeBlockedBy`) AND no live (non-stale) claim AND not locked/blocked AND not in the merge queue; ordered by priority then ordinal. All six required pure-core cases are present (undone-dep excluded, dep-done included, live-claim excluded, stale-claim NOT excluded, in-merge-queue excluded, priority-then-ordinal order) plus filters/limit and the staleness-disabled edge; the handler test mirrors `mcpReadHandlers.test.ts`.
- **P4 pattern reuse.** Structure matches `search_tasks` end-to-end: a pure `src/core` selector returning the raw `Task[]`, a thin handler that maps to rows via the existing `toBoardSummary`, and a `jsonContent(await handler(...))` registration. No new `McpHandlerDeps` field; the merge-queue read reuses `mergeQueuePath`/`queueStoreFor` and the fail-open pattern already used by `getActiveTask`.
- **No placeholders.** Every code and test block is complete and self-contained; every referenced symbol is either shown here (`selectReadyTasks`, `SelectReadyOptions`, `DEFAULT_CLAIM_STALENESS_HOURS`, `NextReadyArgs`, `nextReadyTasksHandler`) or already exists in the repo at the quoted anchors (`Task`, `TreeBoard`, `deriveTreeBoard`, `claimTimestamp`, `isClaimStale`, `laneOf`, `BACKBURNER_BAND`, `priorityRank`, `resolveDoneStatus`, `resolvePriorities`, `stalenessMsFromHours`, `loadTreeBoardFromParser`, `toBoardSummary`, `BoardTaskSummary`, `queueStoreFor`, `nodeQueueFs`, `defaultGitExec`, `mergeQueuePath`, `QueueFsDeps`, `GitExecFn`).
- **Type/name consistency.** `selectReadyTasks(tasks: Task[], board: TreeBoard, opts: SelectReadyOptions): Task[]`; `nextReadyTasksHandler(deps: McpHandlerDeps, args: NextReadyArgs = {}): Promise<BoardTaskSummary[]>`. The tool returns `BoardTaskSummary[]` — the exact `get_board` row type — satisfying "TaskSummary[] identical in shape to get_board rows". Anchors quote exact existing text (match the quoted text, not the line number).
- **Live-caveat honored.** The only `src/mcp` edits (Task 2) are verified by unit tests alone; the plan explicitly forbids live-calling the new tool from the worktree, because the worktree's MCP process runs the primary build until merge + rebuild.
