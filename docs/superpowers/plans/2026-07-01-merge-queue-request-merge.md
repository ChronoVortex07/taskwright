# Component B — Merge queue + `request_merge` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize integration so only one dispatched task merges into `main` at a time, behind a right-of-way FIFO queue, and give the agent a single blocking `request_merge` call that validates, verifies, waits for its turn (and human approval when configured), then merges (or opens a PR) and cleans up.

**Architecture:** A shared FIFO queue file at `<git-common-dir>/taskwright/merge-queue.json` (visible identically from every worktree and the primary tree) whose _head_ holds the exclusive right to mutate `main`. A shared config file `<git-common-dir>/taskwright/merge-config.json` carries the active mode + verify commands + stale timeout to the out-of-process MCP server. `request_merge` (MCP tool → `src/core/finishTask.ts`) runs the lifecycle: clean-check → rebase → verify → enqueue → long-poll for the green light → re-verify → ff-merge or open-PR → complete/cleanup → dequeue. All logic lives in vscode-free `src/core/` with injectable `exec`/`run`/`fs`/clock, matching `WorktreeService`/`ClaimService`.

**Tech Stack:** TypeScript, Node `child_process` (git + shell verify + `gh`), Vitest, `@modelcontextprotocol/sdk` (stdio MCP), esbuild bundling (`dist/mcp/server.js` — already an entry point).

## Global Constraints

- **All new business logic in `src/core/`** — vscode-free, with injectable `exec` (git), `run` (shell verify/`gh`), `fs`, and `now`/`sleep`. The MCP server (`src/mcp/`) and extension host (`src/extension.ts`) are the only wiring layers. Matches `WorktreeService.ts` / `ClaimService.ts`.
- **Shared state lives under the git common dir**, never `.taskwright/` (which is per-worktree, git-ignored, and NOT shared): queue at `<commonDir>/taskwright/merge-queue.json`, config at `<commonDir>/taskwright/merge-config.json`. `git rev-parse --git-common-dir` returns the same path from every worktree.
- **Atomic writes** (write `<path>.tmp` then rename); readers tolerate a missing or corrupt file as "empty queue" / "default config" and **never throw**.
- **Modes** (`taskwright.mergeMode`): `manual-review` → status `"Pending Review"` (**default**); `auto-merge` → `"Awaiting Merge"`; `auto-pr` → `"Awaiting PR"`. The mode is captured on the queue entry **at submission**, so changing the setting mid-flight never re-gates already-queued tasks.
- **Right-of-way:** only the head of the queue may mutate `main`. Strict FIFO. No reordering / skip in v1.
- **Board writes target the PRIMARY tree** (`primaryRoot`), because the human watches the primary checkout's `backlog/`. `request_merge` runs from inside a worktree; it writes the intermediate status, the final `Done`, and the completed/ move against a board bound to `primaryRoot`, injected as a `BoardOps`.
- **ff-only integration.** Merge is `git -C <primaryRoot> merge --ff-only <branch>` into the base branch (`main`, else `master`). Guarded by: primary is on the base branch, and the primary tree has **no uncommitted changes outside `backlog/`** (board bookkeeping under `backlog/` is expected to be dirty because `auto_commit: false`; real code WIP aborts the merge to protect it).
- **Subscription-safe.** `request_merge` shells to `git` / the configured test runner / `gh` — **never** `claude -p`.
- **Blocking semantics.** `request_merge` is one suspended tool call: it long-polls the shared queue (interval ~1s, jittered) until it is the head AND (mode is auto OR `approved`). Injectable `sleep`/`now` keep tests deterministic. The timeout-proof re-call fallback (§6.3 of the spec) is **deferred**; implement the single-block path only.
- **Timestamps:** queue entry `submittedAt`/`activeAt` are ISO-8601 (`new Date().toISOString()`), matching `activeTask.ts`. Board frontmatter dates stay in Backlog.md format via the existing writer.
- **Windows-safe tests:** never assert raw OS paths; normalize with `.replace(/\\/g, '/')` or use `path.*`. Use forward-slash `.worktrees/<branch>` as the stored relative worktree path.
- TDD, DRY, YAGNI, frequent commits. Run `bun run test && bun run lint && bun run typecheck` green before every commit.

## File Structure

New `src/core/`:

- `mergeQueue.ts` — types (`MergeMode`, `QueueEntry`, `MergeQueue`), pure transforms (enqueue/head/approve/remove/markActive/position/isHeadStale), the queue path helper, and `MergeQueueStore` (atomic read-modify-write over injectable fs).
- `mergeConfig.ts` — mode constants + `intermediateStatusForMode`, `MergeConfig` type + defaults, config path helper, `readMergeConfig`/`writeMergeConfig`, and `resolveMergeConfigFromSettings` (VS Code settings → `MergeConfig`).
- `finishTask.ts` — verify primitives (clean-check, base-branch, rebase, verify commands), action primitives (ff-merge, open-PR, worktree/branch cleanup), the `BoardOps` interface + `makePrimaryBoard`, and the `requestMerge` orchestrator.

Wiring:

- `src/mcp/handlers.ts` + `src/mcp/server.ts` — `requestMergeHandler` + `request_merge` tool; queue position added to `get_active_task`.
- `src/extension.ts` + `package.json` — three settings; extension writes `merge-config.json` from settings on activation + config change.
- `src/core/dispatchPrompt.ts` + `AGENTS.md` — `request_merge` closing step.

New tests: `mergeQueue.test.ts`, `mergeConfig.test.ts`, `finishTaskVerify.test.ts`, `finishTaskActions.test.ts`, `requestMerge.test.ts`, `mcpMergeHandlers.test.ts`; additions to `dispatchPrompt.test.ts`.

---

### Task 1: Merge queue core (`mergeQueue.ts`)

**Files:**

- Create: `src/core/mergeQueue.ts`
- Test: `src/test/unit/mergeQueue.test.ts`

**Interfaces:**

- Consumes: nothing (leaf module).
- Produces:
  - `type MergeMode = 'manual-review' | 'auto-merge' | 'auto-pr'`
  - `interface QueueEntry { taskId: string; branch: string; worktree: string; mode: MergeMode; submittedAt: string; approved: boolean; active: boolean; activeAt: string | null }`
  - `interface MergeQueue { version: 1; entries: QueueEntry[] }`; `const EMPTY_QUEUE`
  - Pure transforms (return a new queue, never mutate): `enqueueEntry(q, entry)`, `headEntry(q): QueueEntry | undefined`, `approveEntry(q, taskId)`, `removeEntry(q, taskId)`, `markEntryActive(q, taskId, atIso)`, `positionOf(q, taskId): number` (1-based, 0 if absent), `isHeadStale(q, timeoutMinutes, now: Date): boolean`
  - `interface QueueFsDeps { exists(p): boolean; read(p): string; writeAtomic(p, data): void }`; `nodeQueueFs: QueueFsDeps`
  - `mergeQueuePath(commonDir): string`
  - `class MergeQueueStore { constructor(path, fs); read(): MergeQueue; mutate(fn: (q) => MergeQueue): MergeQueue }`

- [ ] **Step 1: Write the failing tests**

```ts
// src/test/unit/mergeQueue.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  EMPTY_QUEUE,
  enqueueEntry,
  headEntry,
  approveEntry,
  removeEntry,
  markEntryActive,
  positionOf,
  isHeadStale,
  mergeQueuePath,
  MergeQueueStore,
  nodeQueueFs,
  type QueueEntry,
  type MergeQueue,
  type QueueFsDeps,
} from '../../core/mergeQueue';

function entry(taskId: string, over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    taskId,
    branch: `${taskId.toLowerCase()}-x`,
    worktree: `.worktrees/${taskId.toLowerCase()}-x`,
    mode: 'manual-review',
    submittedAt: '2026-07-01T12:00:00.000Z',
    approved: false,
    active: false,
    activeAt: null,
    ...over,
  };
}

describe('pure queue transforms', () => {
  it('enqueues in FIFO order and is idempotent per taskId', () => {
    let q: MergeQueue = EMPTY_QUEUE;
    q = enqueueEntry(q, entry('TASK-1'));
    q = enqueueEntry(q, entry('TASK-2'));
    q = enqueueEntry(q, entry('TASK-1')); // duplicate → no-op
    expect(q.entries.map((e) => e.taskId)).toEqual(['TASK-1', 'TASK-2']);
    expect(headEntry(q)?.taskId).toBe('TASK-1');
  });

  it('does not mutate the input queue', () => {
    const q0 = EMPTY_QUEUE;
    enqueueEntry(q0, entry('TASK-1'));
    expect(q0.entries).toHaveLength(0);
  });

  it('approve, remove, markActive, position', () => {
    let q: MergeQueue = EMPTY_QUEUE;
    q = enqueueEntry(q, entry('TASK-1'));
    q = enqueueEntry(q, entry('TASK-2'));
    expect(positionOf(q, 'TASK-2')).toBe(2);
    expect(positionOf(q, 'TASK-9')).toBe(0);
    q = approveEntry(q, 'TASK-1');
    expect(q.entries[0].approved).toBe(true);
    q = markEntryActive(q, 'TASK-1', '2026-07-01T12:05:00.000Z');
    expect(q.entries[0].active).toBe(true);
    expect(q.entries[0].activeAt).toBe('2026-07-01T12:05:00.000Z');
    q = removeEntry(q, 'TASK-1');
    expect(q.entries.map((e) => e.taskId)).toEqual(['TASK-2']);
  });

  it('isHeadStale is true only when the head is active beyond the timeout', () => {
    const now = new Date('2026-07-01T13:00:00.000Z');
    const idle = enqueueEntry(EMPTY_QUEUE, entry('TASK-1')); // not active
    expect(isHeadStale(idle, 30, now)).toBe(false);
    const fresh = markEntryActive(idle, 'TASK-1', '2026-07-01T12:45:00.000Z'); // 15m
    expect(isHeadStale(fresh, 30, now)).toBe(false);
    const stale = markEntryActive(idle, 'TASK-1', '2026-07-01T12:20:00.000Z'); // 40m
    expect(isHeadStale(stale, 30, now)).toBe(true);
    expect(isHeadStale(EMPTY_QUEUE, 30, now)).toBe(false);
  });
});

describe('mergeQueuePath', () => {
  it('nests under <commonDir>/taskwright/merge-queue.json', () => {
    expect(mergeQueuePath('/repo/.git').replace(/\\/g, '/')).toBe(
      '/repo/.git/taskwright/merge-queue.json'
    );
  });
});

describe('MergeQueueStore', () => {
  it('reads a missing file as the empty queue', () => {
    const store = new MergeQueueStore('/nope/merge-queue.json', memFs({}));
    expect(store.read()).toEqual(EMPTY_QUEUE);
  });

  it('reads a corrupt file as the empty queue', () => {
    const store = new MergeQueueStore('/q.json', memFs({ '/q.json': '{ not json' }));
    expect(store.read()).toEqual(EMPTY_QUEUE);
  });

  it('mutate does a read-modify-write and returns the new queue', () => {
    const files: Record<string, string> = {};
    const store = new MergeQueueStore('/q.json', memFs(files));
    const result = store.mutate((q) => enqueueEntry(q, entry('TASK-1')));
    expect(result.entries[0].taskId).toBe('TASK-1');
    expect(store.read().entries[0].taskId).toBe('TASK-1');
  });

  it('round-trips through the real node fs adapter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twq-'));
    const p = mergeQueuePath(dir);
    const store = new MergeQueueStore(p, nodeQueueFs);
    store.mutate((q) => enqueueEntry(q, entry('TASK-7')));
    expect(store.read().entries[0].taskId).toBe('TASK-7');
    expect(fs.existsSync(p)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

function memFs(files: Record<string, string>): QueueFsDeps {
  return {
    exists: (p) => p in files,
    read: (p) => {
      if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[p];
    },
    writeAtomic: (p, data) => {
      files[p] = data;
    },
  };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run src/test/unit/mergeQueue.test.ts`
Expected: FAIL — `Cannot find module '../../core/mergeQueue'`.

- [ ] **Step 3: Implement `mergeQueue.ts`**

```ts
// src/core/mergeQueue.ts
import * as fs from 'fs';
import * as path from 'path';

/** Integration mode chosen at submission; drives gate, action, and status name. */
export type MergeMode = 'manual-review' | 'auto-merge' | 'auto-pr';

/** One task's place in the shared right-of-way queue. */
export interface QueueEntry {
  taskId: string;
  branch: string;
  /** Repo-root-relative worktree path, e.g. `.worktrees/task-7-login`. */
  worktree: string;
  mode: MergeMode;
  /** ISO-8601 submission time. */
  submittedAt: string;
  /** Set by the board UI (manual-review gate). */
  approved: boolean;
  /** True while the head performs its merge. */
  active: boolean;
  /** ISO-8601 time the head went active, or null. */
  activeAt: string | null;
}

export interface MergeQueue {
  version: 1;
  entries: QueueEntry[];
}

export const EMPTY_QUEUE: MergeQueue = { version: 1, entries: [] };

/** Append `entry` unless its taskId is already queued (idempotent). */
export function enqueueEntry(queue: MergeQueue, entry: QueueEntry): MergeQueue {
  if (queue.entries.some((e) => e.taskId === entry.taskId)) return queue;
  return { version: 1, entries: [...queue.entries, entry] };
}

/** The right-of-way holder (first entry), or undefined when empty. */
export function headEntry(queue: MergeQueue): QueueEntry | undefined {
  return queue.entries[0];
}

/** 1-based position of `taskId`, or 0 when absent. */
export function positionOf(queue: MergeQueue, taskId: string): number {
  const i = queue.entries.findIndex((e) => e.taskId === taskId);
  return i < 0 ? 0 : i + 1;
}

function patchEntry(queue: MergeQueue, taskId: string, patch: Partial<QueueEntry>): MergeQueue {
  return {
    version: 1,
    entries: queue.entries.map((e) => (e.taskId === taskId ? { ...e, ...patch } : e)),
  };
}

/** Mark a queued task approved (written by the board's Approve control). */
export function approveEntry(queue: MergeQueue, taskId: string): MergeQueue {
  return patchEntry(queue, taskId, { approved: true });
}

/** Remove a task from the queue (dequeue on completion, or Send back). */
export function removeEntry(queue: MergeQueue, taskId: string): MergeQueue {
  return { version: 1, entries: queue.entries.filter((e) => e.taskId !== taskId) };
}

/** Mark a task as the active head performing its merge, at ISO time `atIso`. */
export function markEntryActive(queue: MergeQueue, taskId: string, atIso: string): MergeQueue {
  return patchEntry(queue, taskId, { active: true, activeAt: atIso });
}

/**
 * True when the head has been `active` longer than `timeoutMinutes` — a crashed
 * agent that wedged the queue. Reclaimable: drop the stale head, promote next.
 */
export function isHeadStale(queue: MergeQueue, timeoutMinutes: number, now: Date): boolean {
  const head = headEntry(queue);
  if (!head || !head.active || !head.activeAt) return false;
  const startedMs = Date.parse(head.activeAt);
  if (Number.isNaN(startedMs)) return false;
  return now.getTime() - startedMs > timeoutMinutes * 60_000;
}

/** Injectable fs for the queue store; `writeAtomic` must be crash-safe. */
export interface QueueFsDeps {
  exists(p: string): boolean;
  read(p: string): string;
  writeAtomic(p: string, data: string): void;
}

/** Default adapter: real fs with mkdir + temp-then-rename atomic write. */
export const nodeQueueFs: QueueFsDeps = {
  exists: (p) => fs.existsSync(p),
  read: (p) => fs.readFileSync(p, 'utf-8'),
  writeAtomic: (p, data) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, data, 'utf-8');
    fs.renameSync(tmp, p);
  },
};

/** `<commonDir>/taskwright/merge-queue.json` — shared across all worktrees. */
export function mergeQueuePath(commonDir: string): string {
  return path.join(commonDir, 'taskwright', 'merge-queue.json');
}

/**
 * File-backed shared queue. `read` tolerates missing/corrupt files as
 * {@link EMPTY_QUEUE}; `mutate` is a read-modify-write persisted atomically.
 * (Single-writer-at-a-time is enforced by the right-of-way rule, not by locking.)
 */
export class MergeQueueStore {
  constructor(
    private readonly filePath: string,
    private readonly fsDeps: QueueFsDeps
  ) {}

  read(): MergeQueue {
    if (!this.fsDeps.exists(this.filePath)) return EMPTY_QUEUE;
    try {
      const data = JSON.parse(this.fsDeps.read(this.filePath)) as Partial<MergeQueue>;
      if (Array.isArray(data?.entries))
        return { version: 1, entries: data.entries as QueueEntry[] };
    } catch {
      // fall through — treat as empty
    }
    return EMPTY_QUEUE;
  }

  mutate(fn: (queue: MergeQueue) => MergeQueue): MergeQueue {
    const next = fn(this.read());
    this.fsDeps.writeAtomic(this.filePath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run src/test/unit/mergeQueue.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/core/mergeQueue.ts src/test/unit/mergeQueue.test.ts
git commit -m "Add shared FIFO merge queue core (Component B Task 1)"
```

---

### Task 2: Merge config + mode→status mapping + settings (`mergeConfig.ts`)

**Files:**

- Create: `src/core/mergeConfig.ts`
- Modify: `package.json` (add three `taskwright.*` settings in `contributes.configuration.properties`, after `taskwright.enforceWorktreeIsolation` at `package.json:99-103`)
- Test: `src/test/unit/mergeConfig.test.ts`

**Interfaces:**

- Consumes: `MergeMode`, `QueueFsDeps` from `mergeQueue.ts`.
- Produces:
  - `const MERGE_MODES: MergeMode[]`; `isMergeMode(x): x is MergeMode`
  - `intermediateStatusForMode(mode): string` → `'Pending Review' | 'Awaiting Merge' | 'Awaiting PR'`
  - `const DEFAULT_VERIFY_COMMANDS: string[]`, `DEFAULT_STALE_MINUTES = 30`
  - `interface MergeConfig { mode: MergeMode; verifyCommands: string[]; staleMinutes: number }`; `DEFAULT_MERGE_CONFIG`
  - `mergeConfigPath(commonDir): string`
  - `readMergeConfig(path, fs: Pick<QueueFsDeps,'exists'|'read'>): MergeConfig`
  - `writeMergeConfig(path, cfg, fs: Pick<QueueFsDeps,'writeAtomic'>): void`
  - `resolveMergeConfigFromSettings(raw: { mode?: unknown; verifyCommands?: unknown; staleMinutes?: unknown }): MergeConfig`

- [ ] **Step 1: Write the failing tests**

```ts
// src/test/unit/mergeConfig.test.ts
import { describe, it, expect } from 'vitest';
import {
  MERGE_MODES,
  isMergeMode,
  intermediateStatusForMode,
  DEFAULT_MERGE_CONFIG,
  DEFAULT_VERIFY_COMMANDS,
  mergeConfigPath,
  readMergeConfig,
  writeMergeConfig,
  resolveMergeConfigFromSettings,
} from '../../core/mergeConfig';

describe('mode helpers', () => {
  it('exposes the three modes and validates them', () => {
    expect(MERGE_MODES).toEqual(['manual-review', 'auto-merge', 'auto-pr']);
    expect(isMergeMode('auto-merge')).toBe(true);
    expect(isMergeMode('nonsense')).toBe(false);
  });

  it('maps each mode to its intermediate status name', () => {
    expect(intermediateStatusForMode('manual-review')).toBe('Pending Review');
    expect(intermediateStatusForMode('auto-merge')).toBe('Awaiting Merge');
    expect(intermediateStatusForMode('auto-pr')).toBe('Awaiting PR');
  });
});

describe('mergeConfigPath', () => {
  it('nests under <commonDir>/taskwright/merge-config.json', () => {
    expect(mergeConfigPath('/repo/.git').replace(/\\/g, '/')).toBe(
      '/repo/.git/taskwright/merge-config.json'
    );
  });
});

describe('readMergeConfig', () => {
  it('returns defaults when the file is missing', () => {
    const cfg = readMergeConfig('/nope.json', { exists: () => false, read: () => '' });
    expect(cfg).toEqual(DEFAULT_MERGE_CONFIG);
    expect(cfg.mode).toBe('manual-review');
  });

  it('returns defaults when the file is corrupt', () => {
    const cfg = readMergeConfig('/c.json', { exists: () => true, read: () => 'nope' });
    expect(cfg).toEqual(DEFAULT_MERGE_CONFIG);
  });

  it('reads a valid config', () => {
    const json = JSON.stringify({ mode: 'auto-pr', verifyCommands: ['x'], staleMinutes: 5 });
    const cfg = readMergeConfig('/c.json', { exists: () => true, read: () => json });
    expect(cfg).toEqual({ mode: 'auto-pr', verifyCommands: ['x'], staleMinutes: 5 });
  });

  it('falls back field-by-field on partial/invalid values', () => {
    const json = JSON.stringify({ mode: 'bogus', staleMinutes: -3 });
    const cfg = readMergeConfig('/c.json', { exists: () => true, read: () => json });
    expect(cfg.mode).toBe('manual-review');
    expect(cfg.verifyCommands).toEqual(DEFAULT_VERIFY_COMMANDS);
    expect(cfg.staleMinutes).toBe(30);
  });
});

describe('writeMergeConfig', () => {
  it('serializes through writeAtomic', () => {
    let written = '';
    writeMergeConfig('/c.json', DEFAULT_MERGE_CONFIG, { writeAtomic: (_p, d) => (written = d) });
    expect(JSON.parse(written).mode).toBe('manual-review');
  });
});

describe('resolveMergeConfigFromSettings', () => {
  it('coerces VS Code settings, clamping bad values to defaults', () => {
    expect(
      resolveMergeConfigFromSettings({
        mode: 'auto-merge',
        verifyCommands: ['a', 'b'],
        staleMinutes: 12,
      })
    ).toEqual({ mode: 'auto-merge', verifyCommands: ['a', 'b'], staleMinutes: 12 });
    expect(resolveMergeConfigFromSettings({}).mode).toBe('manual-review');
    expect(resolveMergeConfigFromSettings({ staleMinutes: 0 }).staleMinutes).toBe(0);
    expect(resolveMergeConfigFromSettings({ verifyCommands: [] }).verifyCommands).toEqual([]);
    expect(resolveMergeConfigFromSettings({ staleMinutes: -1 }).staleMinutes).toBe(30);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run src/test/unit/mergeConfig.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mergeConfig.ts`**

```ts
// src/core/mergeConfig.ts
import * as path from 'path';
import type { MergeMode, QueueFsDeps } from './mergeQueue';

export const MERGE_MODES: MergeMode[] = ['manual-review', 'auto-merge', 'auto-pr'];

export function isMergeMode(value: unknown): value is MergeMode {
  return typeof value === 'string' && (MERGE_MODES as string[]).includes(value);
}

const STATUS_BY_MODE: Record<MergeMode, string> = {
  'manual-review': 'Pending Review',
  'auto-merge': 'Awaiting Merge',
  'auto-pr': 'Awaiting PR',
};

/** The intermediate board status a mode parks tasks in while they await integration. */
export function intermediateStatusForMode(mode: MergeMode): string {
  return STATUS_BY_MODE[mode];
}

export const DEFAULT_VERIFY_COMMANDS = ['bun run test', 'bun run lint', 'bun run typecheck'];
export const DEFAULT_STALE_MINUTES = 30;

export interface MergeConfig {
  mode: MergeMode;
  verifyCommands: string[];
  staleMinutes: number;
}

export const DEFAULT_MERGE_CONFIG: MergeConfig = {
  mode: 'manual-review',
  verifyCommands: DEFAULT_VERIFY_COMMANDS,
  staleMinutes: DEFAULT_STALE_MINUTES,
};

/** `<commonDir>/taskwright/merge-config.json` — shared, written by the extension. */
export function mergeConfigPath(commonDir: string): string {
  return path.join(commonDir, 'taskwright', 'merge-config.json');
}

function coerceCommands(value: unknown): string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : DEFAULT_VERIFY_COMMANDS;
}

function coerceStale(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_STALE_MINUTES;
}

/** Coerce loosely-typed input (settings object or parsed JSON) into a MergeConfig. */
export function resolveMergeConfigFromSettings(raw: {
  mode?: unknown;
  verifyCommands?: unknown;
  staleMinutes?: unknown;
}): MergeConfig {
  return {
    mode: isMergeMode(raw.mode) ? raw.mode : DEFAULT_MERGE_CONFIG.mode,
    verifyCommands: coerceCommands(raw.verifyCommands),
    staleMinutes: coerceStale(raw.staleMinutes),
  };
}

/** Read the shared config, tolerating missing/corrupt files as defaults. Never throws. */
export function readMergeConfig(
  filePath: string,
  fsDeps: Pick<QueueFsDeps, 'exists' | 'read'>
): MergeConfig {
  if (!fsDeps.exists(filePath)) return DEFAULT_MERGE_CONFIG;
  try {
    return resolveMergeConfigFromSettings(JSON.parse(fsDeps.read(filePath)));
  } catch {
    return DEFAULT_MERGE_CONFIG;
  }
}

/** Persist the shared config atomically. */
export function writeMergeConfig(
  filePath: string,
  config: MergeConfig,
  fsDeps: Pick<QueueFsDeps, 'writeAtomic'>
): void {
  fsDeps.writeAtomic(filePath, `${JSON.stringify(config, null, 2)}\n`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run src/test/unit/mergeConfig.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the three settings to `package.json`**

Insert after the `taskwright.enforceWorktreeIsolation` property block (`package.json:99-103`), before the closing `}` of `properties`:

```json
        "taskwright.mergeMode": {
          "type": "string",
          "enum": [
            "manual-review",
            "auto-merge",
            "auto-pr"
          ],
          "default": "manual-review",
          "markdownDescription": "How `request_merge` integrates a finished task once it reaches the head of the merge queue. `manual-review` (default) parks it in **Pending Review** and waits for you to Approve on the board before fast-forward-merging to `main`. `auto-merge` (**Awaiting Merge**) fast-forward-merges with no review. `auto-pr` (**Awaiting PR**) pushes the branch and opens a GitHub pull request instead. The mode also names the intermediate board column."
        },
        "taskwright.mergeVerifyCommands": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "default": [
            "bun run test",
            "bun run lint",
            "bun run typecheck"
          ],
          "markdownDescription": "Commands `request_merge` runs (in order, in the worktree) to verify a task before and after it reaches the head of the merge queue. Any non-zero exit aborts the merge and returns the failing output to the agent. Set to `[]` to skip verification."
        },
        "taskwright.mergeQueueStaleMinutes": {
          "type": "number",
          "default": 30,
          "minimum": 0,
          "markdownDescription": "Minutes after which the active head of the merge queue (a task mid-merge) is treated as abandoned — a crashed agent — and reclaimed so the next task can proceed. Set to `0` to reclaim immediately (not recommended)."
        }
```

- [ ] **Step 6: Verify the JSON is well-formed and lint/typecheck pass**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" && bunx vitest run src/test/unit/mergeConfig.test.ts && bun run lint`
Expected: no output from the JSON check (valid), tests PASS, lint clean.

- [ ] **Step 7: Commit**

```bash
git add src/core/mergeConfig.ts src/test/unit/mergeConfig.test.ts package.json
git commit -m "Add merge config + mode/status mapping + settings (Component B Task 2)"
```

---

### Task 3: `request_merge` verification primitives (`finishTask.ts`)

**Files:**

- Create: `src/core/finishTask.ts` (verification primitives only; the rest is added in Tasks 4-5)
- Test: `src/test/unit/finishTaskVerify.test.ts`

**Interfaces:**

- Consumes: nothing yet.
- Produces:
  - `type GitExecFn = (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>`
  - `type RunFn = (cwd: string, commandLine: string) => Promise<{ code: number; stdout: string; stderr: string }>`
  - `isWorktreeClean(exec, cwd): Promise<boolean>`
  - `resolveBaseBranch(exec, cwd): Promise<string>`
  - `interface RebaseResult { ok: boolean; conflicts?: string[] }`; `rebaseOntoBase(exec, cwd, base): Promise<RebaseResult>`
  - `interface VerifyResult { ok: boolean; failedCommand?: string; output?: string }`; `runVerifyCommands(run, cwd, commands): Promise<VerifyResult>`

- [ ] **Step 1: Write the failing tests**

```ts
// src/test/unit/finishTaskVerify.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  isWorktreeClean,
  resolveBaseBranch,
  rebaseOntoBase,
  runVerifyCommands,
  type GitExecFn,
  type RunFn,
} from '../../core/finishTask';

/** Build a GitExecFn from a map keyed by the git subcommand (args joined by space). */
function gitExec(
  handler: (args: string[]) => { stdout?: string; stderr?: string } | Error
): GitExecFn {
  return async (_cwd, args) => {
    const r = handler(args);
    if (r instanceof Error) throw r;
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

describe('isWorktreeClean', () => {
  it('is true when status --porcelain is empty', async () => {
    expect(
      await isWorktreeClean(
        gitExec(() => ({ stdout: '' })),
        '/wt'
      )
    ).toBe(true);
  });
  it('is false when there are changes', async () => {
    expect(
      await isWorktreeClean(
        gitExec(() => ({ stdout: ' M src/x.ts\n' })),
        '/wt'
      )
    ).toBe(false);
  });
});

describe('resolveBaseBranch', () => {
  it('prefers main when it exists', async () => {
    const exec = gitExec((a) =>
      a.includes('refs/heads/main') ? { stdout: 'abc' } : new Error('no')
    );
    expect(await resolveBaseBranch(exec, '/wt')).toBe('main');
  });
  it('falls back to master', async () => {
    const exec = gitExec((a) =>
      a.includes('refs/heads/master') ? { stdout: 'abc' } : new Error('no')
    );
    expect(await resolveBaseBranch(exec, '/wt')).toBe('master');
  });
});

describe('rebaseOntoBase', () => {
  it('returns ok when the rebase succeeds', async () => {
    const calls: string[][] = [];
    const exec = gitExec((a) => {
      calls.push(a);
      return { stdout: '' };
    });
    expect(await rebaseOntoBase(exec, '/wt', 'main')).toEqual({ ok: true });
    expect(calls).toContainEqual(['rebase', 'main']);
  });

  it('captures conflicts and aborts on failure', async () => {
    const calls: string[][] = [];
    const exec = gitExec((a) => {
      calls.push(a);
      if (a[0] === 'rebase' && a[1] === 'main') return new Error('conflict');
      if (a.join(' ') === 'diff --name-only --diff-filter=U')
        return { stdout: 'src/a.ts\nsrc/b.ts\n' };
      return { stdout: '' };
    });
    const result = await rebaseOntoBase(exec, '/wt', 'main');
    expect(result.ok).toBe(false);
    expect(result.conflicts).toEqual(['src/a.ts', 'src/b.ts']);
    expect(calls).toContainEqual(['rebase', '--abort']);
  });
});

describe('runVerifyCommands', () => {
  it('runs all commands in order and passes when all exit 0', async () => {
    const seen: string[] = [];
    const run: RunFn = async (_cwd, cmd) => {
      seen.push(cmd);
      return { code: 0, stdout: 'ok', stderr: '' };
    };
    expect(await runVerifyCommands(run, '/wt', ['a', 'b'])).toEqual({ ok: true });
    expect(seen).toEqual(['a', 'b']);
  });

  it('stops at the first failure and returns its output', async () => {
    const seen: string[] = [];
    const run: RunFn = async (_cwd, cmd) => {
      seen.push(cmd);
      return cmd === 'b'
        ? { code: 1, stdout: 'boom-out', stderr: 'boom-err' }
        : { code: 0, stdout: '', stderr: '' };
    };
    const result = await runVerifyCommands(run, '/wt', ['a', 'b', 'c']);
    expect(result.ok).toBe(false);
    expect(result.failedCommand).toBe('b');
    expect(result.output).toContain('boom-out');
    expect(result.output).toContain('boom-err');
    expect(seen).toEqual(['a', 'b']); // 'c' never runs
  });

  it('passes trivially on an empty command list', async () => {
    const run: RunFn = async () => ({ code: 0, stdout: '', stderr: '' });
    expect(await runVerifyCommands(run, '/wt', [])).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run src/test/unit/finishTaskVerify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the verification primitives in `finishTask.ts`**

```ts
// src/core/finishTask.ts

/** Runs a git subcommand in `cwd`, resolving with its captured output. */
export type GitExecFn = (
  cwd: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

/** Runs a shell command line in `cwd`, resolving with its exit code + output. */
export type RunFn = (
  cwd: string,
  commandLine: string
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** True when the worktree has no uncommitted changes. */
export async function isWorktreeClean(exec: GitExecFn, cwd: string): Promise<boolean> {
  const { stdout } = await exec(cwd, ['status', '--porcelain']);
  return stdout.trim() === '';
}

/** The integration branch: `main` if it exists, else `master`. */
export async function resolveBaseBranch(exec: GitExecFn, cwd: string): Promise<string> {
  for (const branch of ['main', 'master']) {
    try {
      await exec(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      return branch;
    } catch {
      // try the next candidate
    }
  }
  return 'main';
}

export interface RebaseResult {
  ok: boolean;
  /** Unmerged file paths, present only when `ok` is false. */
  conflicts?: string[];
}

/** Rebase the current branch onto `base`; on conflict, capture the list and abort. */
export async function rebaseOntoBase(
  exec: GitExecFn,
  cwd: string,
  base: string
): Promise<RebaseResult> {
  try {
    await exec(cwd, ['rebase', base]);
    return { ok: true };
  } catch {
    let conflicts: string[] = [];
    try {
      const { stdout } = await exec(cwd, ['diff', '--name-only', '--diff-filter=U']);
      conflicts = stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      // best-effort conflict list
    }
    try {
      await exec(cwd, ['rebase', '--abort']);
    } catch {
      // leave the repo as-is if abort fails; caller still reports the conflict
    }
    return { ok: false, conflicts };
  }
}

export interface VerifyResult {
  ok: boolean;
  failedCommand?: string;
  output?: string;
}

/** Run each verify command in order; stop and report at the first non-zero exit. */
export async function runVerifyCommands(
  run: RunFn,
  cwd: string,
  commands: string[]
): Promise<VerifyResult> {
  for (const command of commands) {
    const { code, stdout, stderr } = await run(cwd, command);
    if (code !== 0) {
      return { ok: false, failedCommand: command, output: `${stdout}\n${stderr}`.trim() };
    }
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run src/test/unit/finishTaskVerify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/finishTask.ts src/test/unit/finishTaskVerify.test.ts
git commit -m "Add request_merge verification primitives (Component B Task 3)"
```

---

### Task 4: `request_merge` action primitives (`finishTask.ts`)

**Files:**

- Modify: `src/core/finishTask.ts` (append action primitives)
- Test: `src/test/unit/finishTaskActions.test.ts`

**Interfaces:**

- Consumes: `GitExecFn`, `RunFn` from Task 3.
- Produces:
  - `interface FfMergeResult { ok: boolean; reason?: string }`; `ffMergeToBase(exec, primaryRoot, base, branch): Promise<FfMergeResult>`
  - `interface PrResult { ok: boolean; url?: string; reason?: string }`; `openPullRequest(exec, run, cwd, branch, base): Promise<PrResult>`
  - `removeWorktree(exec, primaryRoot, worktreeRelPath): Promise<void>` (best-effort)
  - `deleteBranch(exec, primaryRoot, branch): Promise<void>` (best-effort)
  - `hasCodeWip(porcelain: string): boolean` (pure helper — dirty outside `backlog/`)

- [ ] **Step 1: Write the failing tests**

```ts
// src/test/unit/finishTaskActions.test.ts
import { describe, it, expect } from 'vitest';
import {
  hasCodeWip,
  ffMergeToBase,
  openPullRequest,
  removeWorktree,
  deleteBranch,
  type GitExecFn,
  type RunFn,
} from '../../core/finishTask';

function gitExec(
  handler: (args: string[]) => { stdout?: string; stderr?: string } | Error
): GitExecFn {
  return async (_cwd, args) => {
    const r = handler(args);
    if (r instanceof Error) throw r;
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

describe('hasCodeWip', () => {
  it('ignores dirty files under backlog/ (board bookkeeping)', () => {
    expect(hasCodeWip(' M backlog/tasks/TASK-7 - x.md\n')).toBe(false);
    expect(hasCodeWip('')).toBe(false);
  });
  it('flags dirty files outside backlog/', () => {
    expect(hasCodeWip(' M src/app.ts\n')).toBe(true);
    expect(hasCodeWip(' M backlog/tasks/a.md\n M src/app.ts\n')).toBe(true);
  });
  it('handles rename entries (arrow syntax)', () => {
    expect(hasCodeWip('R  backlog/a.md -> backlog/b.md\n')).toBe(false);
    expect(hasCodeWip('R  src/a.ts -> src/b.ts\n')).toBe(true);
  });
});

describe('ffMergeToBase', () => {
  it('fast-forwards when primary is on base and has no code WIP', async () => {
    const calls: string[][] = [];
    const exec = gitExec((a) => {
      calls.push(a);
      if (a[0] === 'symbolic-ref') return { stdout: 'main' };
      if (a[0] === 'status') return { stdout: ' M backlog/tasks/x.md\n' }; // board only
      return { stdout: '' };
    });
    expect(await ffMergeToBase(exec, '/primary', 'main', 'task-7-x')).toEqual({ ok: true });
    expect(calls).toContainEqual(['merge', '--ff-only', 'task-7-x']);
  });

  it('aborts when primary is not on the base branch', async () => {
    const exec = gitExec((a) => (a[0] === 'symbolic-ref' ? { stdout: 'other' } : { stdout: '' }));
    const r = await ffMergeToBase(exec, '/primary', 'main', 'task-7-x');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('main');
  });

  it('aborts when the primary tree has code WIP', async () => {
    const exec = gitExec((a) => {
      if (a[0] === 'symbolic-ref') return { stdout: 'main' };
      if (a[0] === 'status') return { stdout: ' M src/app.ts\n' };
      return { stdout: '' };
    });
    const r = await ffMergeToBase(exec, '/primary', 'main', 'task-7-x');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('uncommitted');
  });

  it('aborts when the fast-forward merge fails', async () => {
    const exec = gitExec((a) => {
      if (a[0] === 'symbolic-ref') return { stdout: 'main' };
      if (a[0] === 'status') return { stdout: '' };
      if (a[0] === 'merge') return new Error('not possible to fast-forward');
      return { stdout: '' };
    });
    const r = await ffMergeToBase(exec, '/primary', 'main', 'task-7-x');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('fast-forward');
  });
});

describe('openPullRequest', () => {
  it('pushes and opens a PR, capturing the URL', async () => {
    const exec = gitExec((a) => (a[0] === 'remote' ? { stdout: 'origin\n' } : { stdout: '' }));
    const ran: string[] = [];
    const run: RunFn = async (_cwd, cmd) => {
      ran.push(cmd);
      if (cmd.startsWith('gh pr create'))
        return { code: 0, stdout: 'https://github.com/o/r/pull/42\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const r = await openPullRequest(exec, run, '/wt', 'task-7-x', 'main');
    expect(r).toEqual({ ok: true, url: 'https://github.com/o/r/pull/42' });
    expect(ran.some((c) => c.startsWith('gh pr create'))).toBe(true);
  });

  it('aborts with a setup message when there is no remote', async () => {
    const exec = gitExec((a) => (a[0] === 'remote' ? { stdout: '' } : { stdout: '' }));
    const run: RunFn = async () => ({ code: 0, stdout: '', stderr: '' });
    const r = await openPullRequest(exec, run, '/wt', 'task-7-x', 'main');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('remote');
  });

  it('aborts when gh fails (e.g. not installed)', async () => {
    const exec = gitExec((a) => (a[0] === 'remote' ? { stdout: 'origin\n' } : { stdout: '' }));
    const run: RunFn = async (_cwd, cmd) =>
      cmd.startsWith('gh')
        ? { code: 127, stdout: '', stderr: 'gh: command not found' }
        : { code: 0, stdout: '', stderr: '' };
    const r = await openPullRequest(exec, run, '/wt', 'task-7-x', 'main');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('gh');
  });
});

describe('best-effort cleanup', () => {
  it('removeWorktree forces removal then prunes, swallowing errors', async () => {
    const calls: string[][] = [];
    const exec: GitExecFn = async (_cwd, args) => {
      calls.push(args);
      if (args.includes('remove')) throw new Error('busy'); // e.g. cwd still inside on Windows
      return { stdout: '', stderr: '' };
    };
    await expect(removeWorktree(exec, '/primary', '.worktrees/task-7-x')).resolves.toBeUndefined();
    expect(calls).toContainEqual(['worktree', 'remove', '--force', '.worktrees/task-7-x']);
    expect(calls).toContainEqual(['worktree', 'prune']);
  });

  it('deleteBranch swallows errors', async () => {
    const exec: GitExecFn = async () => {
      throw new Error('branch not fully merged');
    };
    await expect(deleteBranch(exec, '/primary', 'task-7-x')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run src/test/unit/finishTaskActions.test.ts`
Expected: FAIL — the new exports don't exist.

- [ ] **Step 3: Append the action primitives to `finishTask.ts`**

```ts
// --- append to src/core/finishTask.ts ---

/**
 * True when `git status --porcelain` output contains any change **outside**
 * `backlog/`. Board files under `backlog/` are expected to be dirty (Taskwright
 * runs with `auto_commit: false`); real code WIP must block the ff-merge.
 */
export function hasCodeWip(porcelain: string): boolean {
  return porcelain
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => {
      // strip the 2-char XY status + space; take the destination path for renames
      const rest = line.slice(2).trim();
      const target = rest.includes(' -> ') ? rest.split(' -> ')[1] : rest;
      return !target.replace(/^"|"$/g, '').startsWith('backlog/');
    });
}

export interface FfMergeResult {
  ok: boolean;
  reason?: string;
}

/**
 * Fast-forward `base` in the primary tree up to `branch`. Requires the primary
 * tree to be on `base` and free of code WIP (board changes allowed). The
 * right-of-way makes touching the primary tree safe.
 */
export async function ffMergeToBase(
  exec: GitExecFn,
  primaryRoot: string,
  base: string,
  branch: string
): Promise<FfMergeResult> {
  let current: string;
  try {
    current = (await exec(primaryRoot, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
  } catch {
    return {
      ok: false,
      reason: 'The primary tree has a detached HEAD; check out the base branch first.',
    };
  }
  if (current !== base) {
    return {
      ok: false,
      reason: `The primary tree is on "${current}", not "${base}"; check out ${base} first.`,
    };
  }
  const { stdout: porcelain } = await exec(primaryRoot, ['status', '--porcelain']);
  if (hasCodeWip(porcelain)) {
    return {
      ok: false,
      reason:
        'The primary tree has uncommitted changes outside backlog/; commit or stash them first.',
    };
  }
  try {
    await exec(primaryRoot, ['merge', '--ff-only', branch]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `fast-forward merge failed: ${detail}` };
  }
  return { ok: true };
}

export interface PrResult {
  ok: boolean;
  url?: string;
  reason?: string;
}

/** Push `branch` and open a PR targeting `base` via `gh`, capturing the URL. */
export async function openPullRequest(
  exec: GitExecFn,
  run: RunFn,
  cwd: string,
  branch: string,
  base: string
): Promise<PrResult> {
  const { stdout: remotes } = await exec(cwd, ['remote']);
  if (remotes.trim() === '') {
    return {
      ok: false,
      reason: 'auto-pr requires a configured git remote; none found (git remote is empty).',
    };
  }
  try {
    await exec(cwd, ['push', '-u', 'origin', branch]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `git push failed: ${detail}` };
  }
  const create = await run(cwd, `gh pr create --base ${base} --head ${branch} --fill`);
  if (create.code !== 0) {
    return {
      ok: false,
      reason: `gh pr create failed (is the GitHub CLI installed and authenticated?): ${`${create.stdout}\n${create.stderr}`.trim()}`,
    };
  }
  const url = (create.stdout.match(/https?:\/\/\S+/) ?? [''])[0].trim();
  return { ok: true, url };
}

/**
 * Best-effort worktree removal, run from the primary tree. `--force` also sweeps
 * stray untracked files. On Windows the dir may be busy if a process cwd is still
 * inside it; we swallow the error and `prune` to self-heal the registration.
 */
export async function removeWorktree(
  exec: GitExecFn,
  primaryRoot: string,
  worktreeRelPath: string
): Promise<void> {
  try {
    await exec(primaryRoot, ['worktree', 'remove', '--force', worktreeRelPath]);
  } catch {
    // leftover dir; prune below cleans the registration
  }
  try {
    await exec(primaryRoot, ['worktree', 'prune']);
  } catch {
    // non-fatal
  }
}

/** Best-effort local branch delete, run from the primary tree. */
export async function deleteBranch(
  exec: GitExecFn,
  primaryRoot: string,
  branch: string
): Promise<void> {
  try {
    await exec(primaryRoot, ['branch', '-D', branch]);
  } catch {
    // non-fatal — the merge already succeeded
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run src/test/unit/finishTaskActions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/finishTask.ts src/test/unit/finishTaskActions.test.ts
git commit -m "Add request_merge action primitives (ff-merge/PR/cleanup) (Component B Task 4)"
```

---

### Task 5: `requestMerge` orchestrator + wait loop (`finishTask.ts`)

**Files:**

- Modify: `src/core/finishTask.ts` (append `BoardOps`, `requestMerge`, and the wait loop)
- Test: `src/test/unit/requestMerge.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 1-4 (`MergeQueueStore` + transforms, `MergeConfig` + `intermediateStatusForMode`, verify + action primitives).
- Produces:
  - `interface BoardOps { setStatus(taskId, status): Promise<void>; complete(taskId): Promise<void>; release(taskId): Promise<void> }`
  - `interface FinishDeps { root; primaryRoot; branch; worktreeRel; config: MergeConfig; queue: MergeQueueStore; board: BoardOps; exec: GitExecFn; run: RunFn; now: () => Date; sleep: (ms: number) => Promise<void>; pollIntervalMs?: number }`
  - `type RequestMergeResult = { status: 'merged'; taskId; branch } | { status: 'pr_opened'; taskId; url } | { status: 'sent_back'; taskId; reason } | { status: 'aborted'; reason; detail? }`
  - `requestMerge(deps: FinishDeps, taskId: string): Promise<RequestMergeResult>`

**Lifecycle (spec §6.2):** clean-check → rebase → verify → **enqueue + set intermediate status** → wait (head AND (auto OR approved); reclaim a stale foreign head; detect Send-back = entry vanished) → mark active → re-rebase + re-verify → action (ff-merge | open-PR) → complete + release + branch/worktree cleanup → **dequeue in `finally`**. Aborts before enqueue leave the queue untouched; aborts after enqueue reset the status to `In Progress` and dequeue.

- [ ] **Step 1: Write the failing tests**

```ts
// src/test/unit/requestMerge.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  requestMerge,
  type FinishDeps,
  type BoardOps,
  type GitExecFn,
  type RunFn,
} from '../../core/finishTask';
import {
  MergeQueueStore,
  enqueueEntry,
  EMPTY_QUEUE,
  type QueueFsDeps,
} from '../../core/mergeQueue';
import { DEFAULT_MERGE_CONFIG, type MergeConfig } from '../../core/mergeConfig';

/** In-memory queue store fixture. */
function memQueue(): { store: MergeQueueStore; file: () => string } {
  const files: Record<string, string> = {};
  const fsDeps: QueueFsDeps = {
    exists: (p) => p in files,
    read: (p) => files[p],
    writeAtomic: (p, d) => (files[p] = d),
  };
  return { store: new MergeQueueStore('/q.json', fsDeps), file: () => files['/q.json'] };
}

function board(): BoardOps & { statuses: string[]; completed: string[]; released: string[] } {
  const rec = {
    statuses: [] as string[],
    completed: [] as string[],
    released: [] as string[],
    setStatus: async (_id: string, s: string) => {
      rec.statuses.push(s);
    },
    complete: async (id: string) => {
      rec.completed.push(id);
    },
    release: async (id: string) => {
      rec.released.push(id);
    },
  };
  return rec;
}

/** Happy-path git exec: clean, main exists, rebase/merge succeed, remote present. */
function okGit(over?: (args: string[]) => { stdout?: string } | Error | undefined): GitExecFn {
  return async (_cwd, args) => {
    const custom = over?.(args);
    if (custom instanceof Error) throw custom;
    if (custom) return { stdout: custom.stdout ?? '', stderr: '' };
    if (args[0] === 'status') return { stdout: '', stderr: '' }; // clean
    if (args[0] === 'rev-parse' && args.includes('refs/heads/main'))
      return { stdout: 'abc', stderr: '' };
    if (args[0] === 'rev-parse') throw new Error('no such ref');
    if (args[0] === 'symbolic-ref') return { stdout: 'main', stderr: '' };
    if (args[0] === 'remote') return { stdout: 'origin\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
}

const greenRun: RunFn = async () => ({ code: 0, stdout: '', stderr: '' });

function deps(over: Partial<FinishDeps>): FinishDeps {
  return {
    root: '/wt',
    primaryRoot: '/primary',
    branch: 'task-7-x',
    worktreeRel: '.worktrees/task-7-x',
    config: DEFAULT_MERGE_CONFIG,
    queue: memQueue().store,
    board: board(),
    exec: okGit(),
    run: greenRun,
    now: () => new Date('2026-07-01T12:00:00.000Z'),
    sleep: async () => {},
    pollIntervalMs: 1,
    ...over,
  };
}

describe('requestMerge — abort before enqueue', () => {
  it('aborts on a dirty worktree without enqueuing', async () => {
    const q = memQueue();
    const d = deps({
      queue: q.store,
      exec: okGit((a) => (a[0] === 'status' ? { stdout: ' M x.ts\n' } : undefined)),
    });
    const r = await requestMerge(d, 'TASK-7');
    expect(r.status).toBe('aborted');
    expect(q.store.read()).toEqual(EMPTY_QUEUE);
  });

  it('aborts on rebase conflict with the conflict list', async () => {
    const d = deps({
      exec: okGit((a) => {
        if (a[0] === 'rebase' && a[1] === 'main') return new Error('conflict');
        if (a.join(' ') === 'diff --name-only --diff-filter=U') return { stdout: 'src/a.ts\n' };
        return undefined;
      }),
    });
    const r = await requestMerge(d, 'TASK-7');
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.detail).toContain('src/a.ts');
  });

  it('aborts on red verification without enqueuing', async () => {
    const q = memQueue();
    const run: RunFn = async (_c, cmd) =>
      cmd === 'bun run lint'
        ? { code: 1, stdout: 'lint fail', stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    const r = await requestMerge(deps({ queue: q.store, run }), 'TASK-7');
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.reason).toContain('bun run lint');
    expect(q.store.read()).toEqual(EMPTY_QUEUE);
  });
});

describe('requestMerge — auto-merge happy path', () => {
  it('merges immediately as sole head, completes, and dequeues', async () => {
    const q = memQueue();
    const b = board();
    const cfg: MergeConfig = { ...DEFAULT_MERGE_CONFIG, mode: 'auto-merge' };
    const merged: string[][] = [];
    const d = deps({
      queue: q.store,
      board: b,
      config: cfg,
      exec: okGit((a) => {
        if (a[0] === 'merge') merged.push(a);
        return undefined;
      }),
    });
    const r = await requestMerge(d, 'TASK-7');
    expect(r.status).toBe('merged');
    expect(b.statuses[0]).toBe('Awaiting Merge');
    expect(b.completed).toEqual(['TASK-7']);
    expect(b.released).toEqual(['TASK-7']);
    expect(merged).toContainEqual(['merge', '--ff-only', 'task-7-x']);
    expect(q.store.read().entries).toHaveLength(0); // dequeued
  });
});

describe('requestMerge — manual-review gate', () => {
  it('waits until approved, then merges', async () => {
    const q = memQueue();
    // pre-approve on the 2nd queue read by flipping approved after the first poll
    let polls = 0;
    const sleep = vi.fn(async () => {
      polls++;
      if (polls === 1) {
        const cur = q.store.read();
        q.store.mutate(() => ({
          version: 1,
          entries: cur.entries.map((e) => ({ ...e, approved: true })),
        }));
      }
    });
    const r = await requestMerge(
      deps({ queue: q.store, sleep, config: DEFAULT_MERGE_CONFIG }),
      'TASK-7'
    );
    expect(r.status).toBe('merged');
    expect(sleep).toHaveBeenCalled();
  });

  it('returns sent_back and resets status when its entry is removed during the wait', async () => {
    const q = memQueue();
    const b = board();
    const sleep = vi.fn(async () => {
      q.store.mutate((cur) => ({
        version: 1,
        entries: cur.entries.filter((e) => e.taskId !== 'TASK-7'),
      }));
    });
    const r = await requestMerge(deps({ queue: q.store, board: b, sleep }), 'TASK-7');
    expect(r.status).toBe('sent_back');
    expect(b.statuses).toContain('In Progress'); // reset
  });
});

describe('requestMerge — stale head reclaim', () => {
  it('reclaims a stale foreign head and proceeds', async () => {
    const q = memQueue();
    // TASK-1 is an active, stale head ahead of us
    q.store.mutate((cur) =>
      enqueueEntry(cur, {
        taskId: 'TASK-1',
        branch: 'task-1-y',
        worktree: '.worktrees/task-1-y',
        mode: 'auto-merge',
        submittedAt: '2026-07-01T10:00:00.000Z',
        approved: false,
        active: true,
        activeAt: '2026-07-01T11:00:00.000Z', // ~60m before now → stale (>30m)
      })
    );
    const cfg: MergeConfig = { ...DEFAULT_MERGE_CONFIG, mode: 'auto-merge' };
    const r = await requestMerge(deps({ queue: q.store, config: cfg }), 'TASK-7');
    expect(r.status).toBe('merged');
    expect(q.store.read().entries.some((e) => e.taskId === 'TASK-1')).toBe(false); // reclaimed
  });
});

describe('requestMerge — auto-pr', () => {
  it('opens a PR, keeps the branch, and returns the URL', async () => {
    const q = memQueue();
    const b = board();
    const cfg: MergeConfig = { ...DEFAULT_MERGE_CONFIG, mode: 'auto-pr' };
    const deleted: string[][] = [];
    const run: RunFn = async (_c, cmd) =>
      cmd.startsWith('gh pr create')
        ? { code: 0, stdout: 'https://github.com/o/r/pull/9\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' };
    const d = deps({
      queue: q.store,
      board: b,
      config: cfg,
      run,
      exec: okGit((a) => {
        if (a[0] === 'branch') deleted.push(a);
        return undefined;
      }),
    });
    const r = await requestMerge(d, 'TASK-7');
    expect(r.status).toBe('pr_opened');
    if (r.status === 'pr_opened') expect(r.url).toBe('https://github.com/o/r/pull/9');
    expect(b.statuses[0]).toBe('Awaiting PR');
    expect(deleted).toHaveLength(0); // branch kept for the PR
  });
});

describe('requestMerge — abort at ff-merge resets status and dequeues', () => {
  it('resets to In Progress and dequeues when the primary tree has code WIP', async () => {
    const q = memQueue();
    const b = board();
    const cfg: MergeConfig = { ...DEFAULT_MERGE_CONFIG, mode: 'auto-merge' };
    const d = deps({
      queue: q.store,
      board: b,
      config: cfg,
      exec: okGit((a) => {
        // primary status dirty with code; worktree status (also 'status') must stay clean
        if (a[0] === 'status') return { stdout: '' }; // keep worktree clean check happy
        return undefined;
      }),
    });
    // Override just the primary ff-merge path: make symbolic-ref ok but merge fail.
    d.exec = okGit((a) => {
      if (a[0] === 'merge') return new Error('not possible to fast-forward');
      return undefined;
    });
    const r = await requestMerge(d, 'TASK-7');
    expect(r.status).toBe('aborted');
    expect(b.statuses).toContain('In Progress');
    expect(q.store.read().entries).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run src/test/unit/requestMerge.test.ts`
Expected: FAIL — `requestMerge` not exported.

- [ ] **Step 3: Append `BoardOps` + `requestMerge` to `finishTask.ts`**

```ts
// --- append to src/core/finishTask.ts ---
import {
  MergeQueueStore,
  enqueueEntry,
  removeEntry,
  approveEntry, // re-exported for callers/tests convenience
  headEntry,
  markEntryActive,
  isHeadStale,
  positionOf,
  type QueueEntry,
} from './mergeQueue';
import { intermediateStatusForMode, type MergeConfig } from './mergeConfig';

/** Board mutations `request_merge` performs against the PRIMARY tree's board. */
export interface BoardOps {
  setStatus(taskId: string, status: string): Promise<void>;
  complete(taskId: string): Promise<void>;
  release(taskId: string): Promise<void>;
}

export interface FinishDeps {
  /** The worktree cwd the agent runs in. */
  root: string;
  /** The primary working tree root (ff-merge target, branch/worktree cleanup). */
  primaryRoot: string;
  /** The current branch of the worktree. */
  branch: string;
  /** Repo-root-relative worktree path, e.g. `.worktrees/task-7-x`. */
  worktreeRel: string;
  config: MergeConfig;
  queue: MergeQueueStore;
  board: BoardOps;
  exec: GitExecFn;
  run: RunFn;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Base long-poll interval; jittered per iteration. Default 1000ms. */
  pollIntervalMs?: number;
}

export type RequestMergeResult =
  | { status: 'merged'; taskId: string; branch: string }
  | { status: 'pr_opened'; taskId: string; url: string }
  | { status: 'sent_back'; taskId: string; reason: string }
  | { status: 'aborted'; reason: string; detail?: string };

const IN_PROGRESS = 'In Progress';

/**
 * The full `request_merge` lifecycle. One blocking call: it suspends on the
 * long-poll until this task is the head AND (auto-mode OR human-approved), then
 * integrates and cleans up. Aborts before enqueue never touch the queue; aborts
 * after enqueue reset the board status and always dequeue.
 */
export async function requestMerge(deps: FinishDeps, taskId: string): Promise<RequestMergeResult> {
  const { exec, run, queue, board, config, root, primaryRoot, branch, worktreeRel } = deps;

  // 1. Validate + verify up front (aborts here never enqueue).
  if (!(await isWorktreeClean(exec, root))) {
    return {
      status: 'aborted',
      reason: 'Your worktree has uncommitted changes; commit or discard them first.',
    };
  }
  const base = await resolveBaseBranch(exec, root);
  const preRebase = await rebaseOntoBase(exec, root, base);
  if (!preRebase.ok) {
    return {
      status: 'aborted',
      reason: `Rebase onto ${base} hit conflicts; resolve them, then call request_merge again.`,
      detail: (preRebase.conflicts ?? []).join(', '),
    };
  }
  const preVerify = await runVerifyCommands(run, root, config.verifyCommands);
  if (!preVerify.ok) {
    return {
      status: 'aborted',
      reason: `Verification failed on \`${preVerify.failedCommand}\`; fix it and call request_merge again.`,
      detail: preVerify.output,
    };
  }

  // 2. Enqueue + park in the mode's intermediate status.
  const entry: QueueEntry = {
    taskId,
    branch,
    worktree: worktreeRel,
    mode: config.mode,
    submittedAt: deps.now().toISOString(),
    approved: false,
    active: false,
    activeAt: null,
  };
  queue.mutate((q) => enqueueEntry(q, entry));
  await board.setStatus(taskId, intermediateStatusForMode(config.mode));

  try {
    // 3. Wait for the green light.
    const waited = await waitForTurn(deps, taskId);
    if (waited === 'sent_back') {
      await board.setStatus(taskId, IN_PROGRESS);
      return { status: 'sent_back', taskId, reason: 'A reviewer sent this task back for changes.' };
    }

    // Mark active so the stale-head reclaim protects us while we merge.
    queue.mutate((q) => markEntryActive(q, taskId, deps.now().toISOString()));

    // 4. Re-validate — `main` may have advanced while we waited.
    const reRebase = await rebaseOntoBase(exec, root, base);
    if (!reRebase.ok) {
      await board.setStatus(taskId, IN_PROGRESS);
      return {
        status: 'aborted',
        reason: `Rebase onto ${base} hit conflicts after waiting; resolve them and call request_merge again.`,
        detail: (reRebase.conflicts ?? []).join(', '),
      };
    }
    const reVerify = await runVerifyCommands(run, root, config.verifyCommands);
    if (!reVerify.ok) {
      await board.setStatus(taskId, IN_PROGRESS);
      return {
        status: 'aborted',
        reason: `Verification failed on \`${reVerify.failedCommand}\` after waiting; fix it and call request_merge again.`,
        detail: reVerify.output,
      };
    }

    // 5-6. Perform the action, then complete + clean up.
    if (config.mode === 'auto-pr') {
      const pr = await openPullRequest(exec, run, root, branch, base);
      if (!pr.ok) {
        await board.setStatus(taskId, IN_PROGRESS);
        return { status: 'aborted', reason: pr.reason ?? 'Opening the pull request failed.' };
      }
      await board.complete(taskId);
      await board.release(taskId);
      await removeWorktree(exec, primaryRoot, worktreeRel); // keep the branch for the PR
      return { status: 'pr_opened', taskId, url: pr.url ?? '' };
    }

    const merge = await ffMergeToBase(exec, primaryRoot, base, branch);
    if (!merge.ok) {
      await board.setStatus(taskId, IN_PROGRESS);
      return { status: 'aborted', reason: merge.reason ?? 'Fast-forward merge failed.' };
    }
    await board.complete(taskId);
    await board.release(taskId);
    await deleteBranch(exec, primaryRoot, branch);
    await removeWorktree(exec, primaryRoot, worktreeRel);
    return { status: 'merged', taskId, branch };
  } finally {
    // 7. Dequeue — unblocks the next head. Safe/no-op if already removed.
    queue.mutate((q) => removeEntry(q, taskId));
  }
}

/**
 * Long-poll the shared queue until this task may proceed. Returns 'proceed' when
 * it is the head and (auto-mode or approved); 'sent_back' when its entry vanished
 * (a reviewer's Send back). Reclaims a stale foreign head each iteration.
 */
async function waitForTurn(deps: FinishDeps, taskId: string): Promise<'proceed' | 'sent_back'> {
  const { queue, config, now } = deps;
  const base = deps.pollIntervalMs ?? 1000;
  for (;;) {
    const q = queue.read();
    if (positionOf(q, taskId) === 0) return 'sent_back';

    // Reclaim a stale foreign head so a crashed agent can't wedge the queue.
    const head = headEntry(q);
    if (head && head.taskId !== taskId && isHeadStale(q, config.staleMinutes, now())) {
      queue.mutate((cur) => removeEntry(cur, head.taskId));
      continue;
    }

    const isHead = head?.taskId === taskId;
    const gated = config.mode !== 'manual-review';
    const approved = q.entries.find((e) => e.taskId === taskId)?.approved === true;
    if (isHead && (gated || approved)) return 'proceed';

    await deps.sleep(base + Math.floor(Math.random() * base)); // jittered
  }
}

export { positionOf, approveEntry };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run src/test/unit/requestMerge.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Run the full suite + lint + typecheck**

Run: `bun run test && bun run lint && bun run typecheck`
Expected: all green (no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/core/finishTask.ts src/test/unit/requestMerge.test.ts
git commit -m "Add requestMerge orchestrator + right-of-way wait loop (Component B Task 5)"
```

---

### Task 6: MCP `request_merge` tool + queue position in `get_active_task`

**Files:**

- Modify: `src/mcp/handlers.ts` (add `requestMergeHandler`, `makePrimaryBoard`, git-fact resolver; add `queuePosition` to `getActiveTask`)
- Modify: `src/mcp/server.ts` (register the `request_merge` tool)
- Test: `src/test/unit/mcpMergeHandlers.test.ts`

**Interfaces:**

- Consumes: `requestMerge`, `BoardOps`, `GitExecFn`, `RunFn` (finishTask); `MergeQueueStore`, `mergeQueuePath`, `nodeQueueFs`, `positionOf` (mergeQueue); `readMergeConfig`, `mergeConfigPath` (mergeConfig); `isPrimaryTree` (worktreeGuard).
- Produces:
  - `requestMergeHandler(deps: McpHandlerDeps, args: { taskId: string }): Promise<RequestMergeResult>`
  - `getActiveTask` result gains `queuePosition?: number` (0/undefined when not queued).

Add to `McpHandlerDeps` a small optional injection seam so the handler is testable without real git/child_process:

```ts
// in McpHandlerDeps (handlers.ts)
export interface McpHandlerDeps {
  // ...existing fields...
  /** Injectable git runner (defaults to execFile('git')). Tests override. */
  gitExec?: GitExecFn;
  /** Injectable shell runner for verify/gh (defaults to child_process.exec). */
  shellRun?: RunFn;
  /** Injectable clock/sleep for the wait loop (defaults to wall clock). */
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable board (defaults to makePrimaryBoard(primaryRoot)). Tests override. */
  board?: BoardOps;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/test/unit/mcpMergeHandlers.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';
import { ClaimService } from '../../core/ClaimService';
import { PlanService } from '../../core/PlanService';
import { requestMergeHandler, getActiveTask, type McpHandlerDeps } from '../../mcp/handlers';
import type { GitExecFn, RunFn } from '../../core/finishTask';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const store: Record<string, string> = {};
  return {
    ...actual,
    __store: store,
    existsSync: vi.fn((p: string) => String(p) in store),
    readFileSync: vi.fn((p: string) => {
      const key = String(p);
      if (key in store) return store[key];
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
    writeFileSync: vi.fn((p: string, d: string) => {
      store[String(p)] = String(d);
    }),
    renameSync: vi.fn((a: string, b: string) => {
      store[String(b)] = store[String(a)];
      delete store[String(a)];
    }),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn((p: string) => {
      delete store[String(p)];
    }),
    statSync: vi.fn().mockReturnValue({ mtimeMs: 1 }),
    readdirSync: vi.fn(() => []),
  };
});

const ROOT = path.join('/primary', '.worktrees', 'task-7-x');
const TASK = `---
id: TASK-7
title: Sample
status: In Progress
assignee: []
dependencies: []
---
## Description
<!-- SECTION:DESCRIPTION:BEGIN -->
x
<!-- SECTION:DESCRIPTION:END -->
`;

/** Git facts: worktree gitDir, common dir, branch, plus happy-path merge ops. */
function gitExec(): GitExecFn {
  return async (_cwd, args) => {
    if (args.join(' ') === 'rev-parse --git-dir')
      return { stdout: '/primary/.git/worktrees/task-7-x', stderr: '' };
    if (args.join(' ') === 'rev-parse --git-common-dir')
      return { stdout: '/primary/.git', stderr: '' };
    if (args[0] === 'symbolic-ref') return { stdout: 'task-7-x', stderr: '' };
    if (args[0] === 'status') return { stdout: '', stderr: '' };
    if (args[0] === 'rev-parse' && args.includes('refs/heads/main'))
      return { stdout: 'abc', stderr: '' };
    if (args[0] === 'rev-parse') throw new Error('no ref');
    return { stdout: '', stderr: '' };
  };
}

function deps(over: Partial<McpHandlerDeps> = {}): McpHandlerDeps {
  const backlog = path.join(ROOT, 'backlog');
  return {
    root: ROOT,
    backlogPath: backlog,
    parser: new BacklogParser(backlog),
    writer: new BacklogWriter(),
    claimService: new ClaimService(),
    planService: new PlanService(),
    gitExec: gitExec(),
    shellRun: (async () => ({ code: 0, stdout: '', stderr: '' })) as RunFn,
    now: () => new Date('2026-07-01T12:00:00.000Z'),
    sleep: async () => {},
    ...over,
  };
}

beforeEach(() => {
  const store = (fs as unknown as { __store: Record<string, string> }).__store;
  for (const k of Object.keys(store)) delete store[k];
  store[path.join(ROOT, 'backlog', 'tasks', 'task-7 - Sample.md')] = TASK;
});

describe('requestMergeHandler', () => {
  it('rejects when run from the primary tree (not a worktree)', async () => {
    const primaryExec: GitExecFn = async (_c, a) =>
      a.join(' ') === 'rev-parse --git-dir'
        ? { stdout: '/primary/.git', stderr: '' }
        : gitExec()(_c, a);
    const r = await requestMergeHandler(deps({ gitExec: primaryExec }), { taskId: 'TASK-7' });
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.reason).toMatch(/worktree/i);
  });

  it('auto-merge integrates the task end-to-end', async () => {
    // merge-config → auto-merge, so no human gate.
    const store = (fs as unknown as { __store: Record<string, string> }).__store;
    store[path.join('/primary/.git', 'taskwright', 'merge-config.json')] = JSON.stringify({
      mode: 'auto-merge',
    });
    // Inject a fake board so the handler test does not drive real BacklogWriter
    // file-moves through the mocked fs (that path is covered by requestMerge.test.ts).
    const completed: string[] = [];
    const board = {
      setStatus: async () => {},
      complete: async (id: string) => {
        completed.push(id);
      },
      release: async () => {},
    };
    const r = await requestMergeHandler(deps({ board }), { taskId: 'TASK-7' });
    expect(r.status).toBe('merged');
    expect(completed).toEqual(['TASK-7']);
  });
});

describe('getActiveTask queue position', () => {
  it('reports queuePosition when the active task is queued', async () => {
    const store = (fs as unknown as { __store: Record<string, string> }).__store;
    store[path.join(ROOT, '.taskwright', 'active-task.json')] = JSON.stringify({
      taskId: 'TASK-7',
      setAt: '2026-07-01T00:00:00Z',
    });
    store[path.join('/primary/.git', 'taskwright', 'merge-queue.json')] = JSON.stringify({
      version: 1,
      entries: [
        {
          taskId: 'TASK-7',
          branch: 'task-7-x',
          worktree: '.worktrees/task-7-x',
          mode: 'manual-review',
          submittedAt: 'x',
          approved: false,
          active: false,
          activeAt: null,
        },
      ],
    });
    const result = await getActiveTask(deps());
    expect(result.active).toBe(true);
    expect(result.queuePosition).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run src/test/unit/mcpMergeHandlers.test.ts`
Expected: FAIL — `requestMergeHandler` not exported / `queuePosition` missing.

- [ ] **Step 3: Implement the handler + git-fact resolver + board factory in `handlers.ts`**

Add these imports at the top of `src/mcp/handlers.ts`:

```ts
import { execFile, exec as childExec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { isPrimaryTree } from '../core/worktreeGuard';
import { MergeQueueStore, mergeQueuePath, nodeQueueFs, positionOf } from '../core/mergeQueue';
import { mergeConfigPath, readMergeConfig } from '../core/mergeConfig';
import {
  requestMerge,
  type BoardOps,
  type GitExecFn,
  type RunFn,
  type RequestMergeResult,
} from '../core/finishTask';
```

Extend `McpHandlerDeps` with the optional injection seam (see Interfaces above), then add:

```ts
const execFileAsync = promisify(execFile);
const childExecAsync = promisify(childExec);

const defaultGitExec: GitExecFn = (cwd, args) =>
  execFileAsync('git', args, { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });

const defaultShellRun: RunFn = async (cwd, commandLine) => {
  try {
    const { stdout, stderr } = await childExecAsync(commandLine, {
      cwd,
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? e.message ?? ''),
    };
  }
};

/** Git facts needed to run `request_merge` from a worktree. */
interface GitFacts {
  gitDir: string;
  commonDir: string;
  primaryRoot: string;
  branch: string | null;
}

async function gitFacts(exec: GitExecFn, cwd: string): Promise<GitFacts> {
  const gitDir = path.resolve((await exec(cwd, ['rev-parse', '--git-dir'])).stdout.trim());
  const commonDir = path.resolve(
    (await exec(cwd, ['rev-parse', '--git-common-dir'])).stdout.trim()
  );
  let branch: string | null;
  try {
    branch = (await exec(cwd, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
  } catch {
    branch = null;
  }
  return { gitDir, commonDir, primaryRoot: path.dirname(commonDir), branch };
}

/** A BoardOps bound to the PRIMARY tree's board (what the human watches). */
function makePrimaryBoard(primaryRoot: string): BoardOps {
  const backlogPath = path.join(primaryRoot, 'backlog');
  const parser = new BacklogParser(backlogPath);
  const writer = new BacklogWriter();
  const claims = new ClaimService();
  return {
    async setStatus(taskId, status) {
      await writer.updateTask(taskId, { status } as Partial<Task>, parser);
    },
    async complete(taskId) {
      await writer.completeTask(taskId, parser);
    },
    async release(taskId) {
      await claims.releaseTask(taskId, parser);
    },
  };
}

function queueStoreFor(commonDir: string): MergeQueueStore {
  return new MergeQueueStore(mergeQueuePath(commonDir), nodeQueueFs);
}

/**
 * `request_merge`: submit the active task for integration and block until it is
 * merged / a PR is opened / it is sent back — the single closing call an agent
 * makes from inside its worktree.
 */
export async function requestMergeHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<RequestMergeResult> {
  const exec = deps.gitExec ?? defaultGitExec;
  const run = deps.shellRun ?? defaultShellRun;
  const facts = await gitFacts(exec, deps.root);

  if (isPrimaryTree(facts.gitDir)) {
    return {
      status: 'aborted',
      reason:
        'request_merge must be called from inside your .worktrees/<branch>, not the primary tree. cd into the worktree and try again.',
    };
  }
  if (!facts.branch) {
    return {
      status: 'aborted',
      reason: 'Your worktree has a detached HEAD; check out your task branch first.',
    };
  }

  const config = readMergeConfig(mergeConfigPath(facts.commonDir), nodeQueueFs);
  return requestMerge(
    {
      root: deps.root,
      primaryRoot: facts.primaryRoot,
      branch: facts.branch,
      worktreeRel: `.worktrees/${facts.branch}`,
      config,
      queue: queueStoreFor(facts.commonDir),
      board: deps.board ?? makePrimaryBoard(facts.primaryRoot),
      exec,
      run,
      now: deps.now ?? (() => new Date()),
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    },
    args.taskId
  );
}
```

Then add `queuePosition` to `getActiveTask`. Replace its final `return { active: true, task: toSummary(task, deps.root) };` with:

```ts
let queuePosition: number | undefined;
try {
  const exec = deps.gitExec ?? defaultGitExec;
  const commonDir = path.resolve(
    (await exec(deps.root, ['rev-parse', '--git-common-dir'])).stdout.trim()
  );
  const pos = positionOf(queueStoreFor(commonDir).read(), active.taskId);
  if (pos > 0) queuePosition = pos;
} catch {
  // not a git repo / no queue — omit the field
}
return { active: true, task: toSummary(task, deps.root), queuePosition };
```

And add `queuePosition?: number;` to the `ActiveTaskResult` interface.

- [ ] **Step 4: Register the tool in `server.ts`**

Add `requestMergeHandler` to the handler import list, then register (after the `create_subtask` block, before `const transport = ...`):

```ts
server.registerTool(
  'request_merge',
  {
    title: 'Request merge',
    description:
      'Submit your finished task for integration and wait. From inside your .worktrees/<branch>, this rebases onto the base branch, runs the verify commands, then enqueues you in the shared merge queue. It blocks until you reach the head and (in manual-review mode) a human approves, then fast-forward-merges to the base branch (or opens a PR), completes the task, and removes your worktree. Call this once when the task is committed and clean; do not merge or commit to the repo root yourself.',
    inputSchema: { taskId: z.string().describe('Task ID to integrate, e.g. TASK-7.') },
  },
  async (args) => runTool(() => requestMergeHandler(deps, args))
);
```

- [ ] **Step 5: Run tests + build to verify the MCP bundles**

Run: `bunx vitest run src/test/unit/mcpMergeHandlers.test.ts && bun run compile`
Expected: tests PASS; esbuild emits `dist/mcp/server.js` without errors.

- [ ] **Step 6: Full suite + lint + typecheck**

Run: `bun run test && bun run lint && bun run typecheck`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/handlers.ts src/mcp/server.ts src/test/unit/mcpMergeHandlers.test.ts
git commit -m "Wire request_merge MCP tool + queue position in get_active_task (Component B Task 6)"
```

---

### Task 7: Extension writes `merge-config.json` from settings

**Files:**

- Modify: `src/extension.ts` (write the shared merge config on activation + on config change)
- Test: none new — this is thin host glue over the already-tested `resolveMergeConfigFromSettings` / `writeMergeConfig` / `nodeQueueFs`; verified via `bun run compile` + `typecheck`. (Mirrors how Component A's `syncWorktreeGuard` glue is host-only.)

**Interfaces:**

- Consumes: `resolveMergeConfigFromSettings`, `writeMergeConfig`, `mergeConfigPath` (mergeConfig); `nodeQueueFs` (mergeQueue); the existing `affectsTaskwrightConfig` helper + `workspaceRootPath` already in `extension.ts` (added for Component A).

- [ ] **Step 1: Add a `syncMergeConfig` helper in `extension.ts`**

Near `syncWorktreeGuard` (added in Component A), add:

```ts
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  resolveMergeConfigFromSettings,
  writeMergeConfig,
  mergeConfigPath,
} from './core/mergeConfig';
import { nodeQueueFs } from './core/mergeQueue';

const execFileAsync = promisify(execFile);

/**
 * Publish the merge settings to the shared config file the out-of-process MCP
 * server reads. Written under the git common dir so every worktree sees it.
 */
async function syncMergeConfig(repoRoot: string): Promise<void> {
  let commonDir: string;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
      cwd: repoRoot,
      timeout: 15_000,
    });
    commonDir = path.resolve(repoRoot, stdout.trim());
  } catch {
    return; // not a git repo — nothing to publish
  }
  const cfg = vscode.workspace.getConfiguration('taskwright');
  const merged = resolveMergeConfigFromSettings({
    mode: cfg.get('mergeMode'),
    verifyCommands: cfg.get('mergeVerifyCommands'),
    staleMinutes: cfg.get('mergeQueueStaleMinutes'),
  });
  writeMergeConfig(mergeConfigPath(commonDir), merged, nodeQueueFs);
}
```

(Reuse the existing top-of-file `path`/`vscode` imports if present; only add `execFile`/`promisify`/the core imports if they aren't already imported for Component A.)

- [ ] **Step 2: Call it on activation + config change**

Where `syncWorktreeGuard(workspaceRootPath, context.extensionUri)` is called in `activate`, add alongside it:

```ts
void syncMergeConfig(workspaceRootPath);
```

In the existing `onDidChangeConfiguration` listener, alongside the `enforceWorktreeIsolation` branch, add:

```ts
if (
  workspaceRootPath &&
  (affectsTaskwrightConfig(event, 'mergeMode') ||
    affectsTaskwrightConfig(event, 'mergeVerifyCommands') ||
    affectsTaskwrightConfig(event, 'mergeQueueStaleMinutes'))
) {
  void syncMergeConfig(workspaceRootPath);
}
```

- [ ] **Step 3: Compile + typecheck**

Run: `bun run compile && bun run typecheck && bun run lint`
Expected: no errors.

- [ ] **Step 4: Run the full suite (no regressions)**

Run: `bun run test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts
git commit -m "Publish merge settings to shared merge-config.json (Component B Task 7)"
```

---

### Task 8: Dispatch template + `AGENTS.md` closing step (`request_merge`)

**Files:**

- Modify: `src/core/dispatchPrompt.ts` (`DEFAULT_DISPATCH_TEMPLATE` closing paragraph)
- Modify: `AGENTS.md` (make `request_merge` the closing step of the task workflow)
- Test: `src/test/unit/dispatchPrompt.test.ts` (append)

**Interfaces:**

- Consumes: nothing new.
- Produces: no new exports — content changes only.

- [ ] **Step 1: Write the failing test**

Append to `src/test/unit/dispatchPrompt.test.ts`:

```ts
import { DEFAULT_DISPATCH_TEMPLATE } from '../../core/dispatchPrompt';

describe('DEFAULT_DISPATCH_TEMPLATE closing step', () => {
  it('instructs the agent to close with request_merge from the worktree', () => {
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('request_merge');
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('wait for it to return');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/test/unit/dispatchPrompt.test.ts -t "closing step"`
Expected: FAIL — the template has no `request_merge` yet.

- [ ] **Step 3: Update the closing paragraph of `DEFAULT_DISPATCH_TEMPLATE`**

Replace the final paragraph (`src/core/dispatchPrompt.ts:51`, the line beginning "Before writing code…") with:

```ts
Before writing code, call the \`taskwright\` MCP tool \`get_active_task\` to confirm your assignment and load full context, then \`claim_task\` with id \`{{id}}\` (worktree \`{{worktree}}\`). Follow the project's TDD / superpowers workflow. Record what you learn in the task's Implementation Notes. When the task is committed and your worktree is clean, call \`request_merge\` (taskwright MCP) from inside your worktree and wait for it to return — it rebases onto the base branch, runs the verify commands, waits for its turn in the merge queue (and your approval, in manual-review mode), then integrates and cleans up. Do not merge, commit, or push from the repository root yourself.`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/test/unit/dispatchPrompt.test.ts`
Expected: PASS (new case + existing cases still green).

- [ ] **Step 5: Update `AGENTS.md`**

In the `<CRITICAL_INSTRUCTION>` "Task workflow (Taskwright MCP)" list, change step 5 from the ad-hoc `release_task` close to make `request_merge` the closing action:

> 5. **Close with `request_merge`.** When the task is committed and your worktree is clean, call `request_merge` from inside your worktree and wait for it to return. It rebases onto the base branch, runs the verify commands, waits for its turn in the shared merge queue (and, in manual-review mode, for your human's approval on the board), then fast-forward-merges to the base branch (or opens a PR), marks the task Done, and removes your worktree. Do not merge, commit, or push from the repo root yourself. (`release_task` is called for you as part of cleanup; call it directly only if you hand off without integrating.)

- [ ] **Step 6: Full suite + lint + typecheck**

Run: `bun run test && bun run lint && bun run typecheck`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/core/dispatchPrompt.ts AGENTS.md src/test/unit/dispatchPrompt.test.ts
git commit -m "Make request_merge the dispatch/AGENTS closing step (Component B Task 8)"
```

---

## Self-Review

**Spec coverage (spec §5, §6, §10, §11, §13-B):**

- Shared FIFO queue file, atomic writes, missing=empty → Task 1 (`mergeQueue.ts`). ✅
- `enqueue`/`head`/`approve`/`sendBack`(=`removeEntry`)/`markActive`/`dequeue`(=`removeEntry`)/`isHeadStale` → Task 1. ✅
- Modes + intermediate status names + verify commands + stale minutes settings → Task 2. ✅
- `request_merge` lifecycle: validate/clean → rebase → verify → enqueue+status → wait (head AND auto|approved) → re-rebase+re-verify → ff-merge|PR → complete/cleanup/dequeue → Tasks 3-5. ✅
- All abort branches (dirty, rebase conflict, red verify, dirty-primary ff, no-remote/no-gh, main-advanced re-verify, sent-back, stale-head reclaim, idempotent duplicate) → Task 5 tests. ✅
- MCP `request_merge` tool + structured outcomes + queue position in `get_active_task` → Task 6. ✅
- `mergeMode`/`mergeVerifyCommands`/`mergeQueueStaleMinutes` reaching the out-of-process MCP via shared `merge-config.json` → Tasks 2/6/7. ✅
- Dispatch/`AGENTS.md` closing-step hardening → Task 8. ✅

**Deliberate scope boundaries (documented, not gaps):**

- The **board column rename + migrate on mode change**, the **kanban Approve / Send-back UI**, and the `taskwright.approveMerge` / `taskwright.sendBackMerge` commands are **Component C** (spec §7, §13-C). Component B writes the intermediate status string and reads `approved`/entry-removal from the shared queue; C provides the human controls that flip them. Until C ships, `manual-review` approval can be exercised by writing `approved:true` into the queue file (or by selecting `auto-merge`), which is exactly what the Task 5 tests simulate.
- The **timeout-proof re-call fallback** (`{status:"waiting"}`) is deferred per spec §6.3 ("implement the single-block path first").

**Documented design decisions (flag to reviewer):**

1. **Board writes target the primary tree** (`makePrimaryBoard(primaryRoot)`), because the human watches the primary checkout. The spec says "via the writer, surgically" without naming the tree; primary is the correct target and keeps the worktree clean for git ops.
2. **The ff-merge clean-check ignores `backlog/`** (`hasCodeWip`), implementing spec §9's "protects human WIP" intent without tripping on routine board edits (Taskwright runs `auto_commit:false`, so board files are habitually dirty).
3. **Worktree removal is best-effort** (`removeWorktree` swallows errors + `prune`s): on Windows the MCP process cwd may be inside the worktree, so a hard failure there must not fail an otherwise-successful merge; the registration self-heals on the next `prune`.

**Placeholder scan:** none — every step has complete test + implementation code.

**Type consistency:** `MergeMode`/`QueueEntry`/`MergeQueue` defined in Task 1 and reused verbatim in Tasks 2/5/6; `GitExecFn`/`RunFn` defined in Task 3 and reused in Tasks 4/5/6; `MergeConfig` from Task 2 flows into `FinishDeps` (Task 5) and the MCP handler (Task 6); `BoardOps` defined in Task 5 and implemented by `makePrimaryBoard` in Task 6. `worktree` field is the repo-root-relative `.worktrees/<branch>` throughout.
