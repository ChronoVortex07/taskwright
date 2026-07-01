# Component C — Merge-review board status + approval UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the merge queue a human-facing surface — a mode-named intermediate board status (`Pending Review` / `Awaiting Merge` / `Awaiting PR`) that appears between `In Progress` and `Done`, plus Approve / Send-back controls that grant or reject a queued task by writing to the shared merge-queue file.

**Architecture:** Component C meets Component B (already shipped) **only at the shared queue file** (`<git-common-dir>/taskwright/merge-queue.json`). All new business logic is pure and vscode-free in `src/core/` (injectable `fs`), matching `mergeQueue`/`mergeConfig`. The board column is config-driven: adding the intermediate status to `backlog/config.yml` makes the kanban column, drag rules, and language providers render it automatically. The extension host reads the queue to annotate cards and writes approvals/removals; the MCP `request_merge` long-poll (Component B) observes them. No direct IPC.

**Tech Stack:** TypeScript, Svelte 5 (runes), Vitest (unit), Playwright (webview), Bun toolchain, VS Code extension API.

## Global Constraints

- Node **≥ 22**, Bun toolchain. Build: `bun run build`. Gates: `bun run test && bun run lint && bun run typecheck` — all green before any task is Done.
- **TDD:** write the failing Vitest test first, watch it fail, then implement. Webview interaction behavior uses Playwright (`bun run test:playwright`).
- **Subscription-safe:** never spawn `claude -p` / `--print`. This component shells nothing to Claude; it only reads/writes the queue file and the task board.
- **Icons:** Lucide inline SVG (copy from lucide.dev), never emojis, in webviews; must work in all themes (use `--vscode-*` vars / `currentColor`).
- **Cross-platform:** use `path.*`, tolerate `\r\n`. ~22 upstream unit tests assert POSIX paths and fail on Windows — that is expected; do not "fix" the code to match them.
- **Backlog.md compatibility:** task frontmatter stays byte-for-byte compatible. Board statuses come from `config.yml`; `BacklogWriter.updateTask` writes `status` with no config validation, so an intermediate status not yet in `config.yml` still round-trips.
- **The three modes → intermediate statuses** (already in `src/core/mergeConfig.ts` via `intermediateStatusForMode`): `manual-review` → `Pending Review` (default), `auto-merge` → `Awaiting Merge`, `auto-pr` → `Awaiting PR`. `mergeMode` is a single global setting, so exactly one intermediate status is ever active.

---

## File Structure

**New files**

- `src/core/mergeStatusConfig.ts` — pure: compute the canonical statuses list for a mode, surgically rewrite the `statuses:` line in `config.yml`, and plan a status rename + task migration.
- `src/core/mergeBoard.ts` — pure: derive a per-task `MergeTaskState` (queued? position, approved, active/merging) from a `MergeQueue`.
- `src/providers/mergeActions.ts` — extension-side: approve (write `approved:true`) and send-back (remove entry + reset status) against the shared queue.
- `src/test/unit/mergeStatusConfig.test.ts`, `src/test/unit/mergeBoard.test.ts`, `src/test/unit/mergeActions.test.ts` — unit tests.
- `e2e/merge-review.spec.ts` — Playwright: card badge + detail-panel controls post the right messages.

**Modified files**

- `src/core/mergeConfig.ts` — export `INTERMEDIATE_STATUSES`.
- `src/core/types.ts` — `mergeState?` on the enriched task, `mergeMode?` in `TasksViewSettings`, new webview/extension message variants.
- `src/providers/TasksController.ts` — enrich tasks with `mergeState`, send `mergeMode`, handle `approveMerge`/`sendBackMerge` messages, injectable queue reader.
- `src/extension.ts` — `syncMergeStatus` (rename+migrate config on activation / `mergeMode` change), a queue `FileSystemWatcher` that refreshes the board, wire the controller's queue reader, register `taskwright.approveMerge` / `taskwright.sendBackMerge`.
- `src/webview/components/shared/TaskCard.svelte` — merge badge.
- `src/webview/components/task-detail/TaskDetail.svelte` + `src/providers/TaskDetailProvider.ts` — merge-review banner with Approve / Send-back.
- `backlog/config.yml` — add `Pending Review` to the repo's own board (dogfooding; the default mode is `manual-review`).

---

## Task 1: Pure status-config core (`mergeStatusConfig.ts`)

**Files:**

- Create: `src/core/mergeStatusConfig.ts`
- Modify: `src/core/mergeConfig.ts` (add `INTERMEDIATE_STATUSES` export)
- Test: `src/test/unit/mergeStatusConfig.test.ts`

**Interfaces:**

- Consumes: `MergeMode` and `intermediateStatusForMode(mode)` / `MERGE_MODES` from `./mergeConfig`.
- Produces:
  - `INTERMEDIATE_STATUSES: string[]` (in `mergeConfig.ts`) — `['Pending Review','Awaiting Merge','Awaiting PR']`, derived from `MERGE_MODES.map(intermediateStatusForMode)`.
  - `parseStatusesLine(configText: string): string[]`
  - `desiredStatuses(current: string[], mode: MergeMode): string[]`
  - `rewriteStatusesLine(configText: string, statuses: string[]): string`
  - `intermediateStatusOf(statuses: string[]): string | undefined`
  - `statusesEqual(a: string[], b: string[]): boolean`
  - `planStatusSync(current: string[], mode: MergeMode): { statuses: string[]; changed: boolean; migrateFrom?: string; migrateTo?: string }`

- [ ] **Step 1: Add `INTERMEDIATE_STATUSES` to `mergeConfig.ts`**

In `src/core/mergeConfig.ts`, immediately after the `STATUS_BY_MODE` map / `intermediateStatusForMode` function, add:

```ts
/** All three mode-named intermediate statuses (order follows MERGE_MODES). */
export const INTERMEDIATE_STATUSES: string[] = MERGE_MODES.map(intermediateStatusForMode);
```

- [ ] **Step 2: Write the failing test**

Create `src/test/unit/mergeStatusConfig.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  parseStatusesLine,
  desiredStatuses,
  rewriteStatusesLine,
  intermediateStatusOf,
  statusesEqual,
  planStatusSync,
} from '../../core/mergeStatusConfig';

const CONFIG = `project_name: "taskwright"
default_status: "To Do"
statuses: ["To Do", "In Progress", "Done"]
labels: []
task_prefix: "task"
`;

describe('parseStatusesLine', () => {
  it('parses a quoted statuses array', () => {
    expect(parseStatusesLine(CONFIG)).toEqual(['To Do', 'In Progress', 'Done']);
  });
  it('returns [] when no statuses line', () => {
    expect(parseStatusesLine('project_name: "x"\n')).toEqual([]);
  });
});

describe('desiredStatuses', () => {
  it('inserts the intermediate just before the done (last) status', () => {
    expect(desiredStatuses(['To Do', 'In Progress', 'Done'], 'manual-review')).toEqual([
      'To Do',
      'In Progress',
      'Pending Review',
      'Done',
    ]);
  });
  it('renames a different intermediate in place', () => {
    expect(
      desiredStatuses(['To Do', 'In Progress', 'Pending Review', 'Done'], 'auto-merge')
    ).toEqual(['To Do', 'In Progress', 'Awaiting Merge', 'Done']);
  });
  it('is idempotent when already correct', () => {
    const s = ['To Do', 'In Progress', 'Awaiting PR', 'Done'];
    expect(desiredStatuses(s, 'auto-pr')).toEqual(s);
  });
  it('normalizes a misplaced intermediate to before-done', () => {
    expect(
      desiredStatuses(['To Do', 'Pending Review', 'In Progress', 'Done'], 'manual-review')
    ).toEqual(['To Do', 'In Progress', 'Pending Review', 'Done']);
  });
});

describe('intermediateStatusOf', () => {
  it('finds the active intermediate status', () => {
    expect(intermediateStatusOf(['To Do', 'Awaiting Merge', 'Done'])).toBe('Awaiting Merge');
  });
  it('returns undefined when none present', () => {
    expect(intermediateStatusOf(['To Do', 'In Progress', 'Done'])).toBeUndefined();
  });
});

describe('rewriteStatusesLine', () => {
  it('replaces only the statuses line and preserves the rest', () => {
    const out = rewriteStatusesLine(CONFIG, ['To Do', 'In Progress', 'Pending Review', 'Done']);
    expect(out).toContain('statuses: ["To Do", "In Progress", "Pending Review", "Done"]');
    expect(out).toContain('project_name: "taskwright"');
    expect(out).toContain('task_prefix: "task"');
  });
  it('leaves text unchanged when there is no statuses line', () => {
    const text = 'project_name: "x"\n';
    expect(rewriteStatusesLine(text, ['A', 'B'])).toBe(text);
  });
  it('preserves CRLF line endings', () => {
    const crlf = CONFIG.replace(/\n/g, '\r\n');
    expect(rewriteStatusesLine(crlf, ['To Do', 'Done'])).toContain('\r\n');
  });
});

describe('statusesEqual', () => {
  it('true for same order, false otherwise', () => {
    expect(statusesEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(statusesEqual(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(statusesEqual(['a'], ['a', 'b'])).toBe(false);
  });
});

describe('planStatusSync', () => {
  it('reports the change + migration when adding the intermediate', () => {
    const plan = planStatusSync(['To Do', 'In Progress', 'Done'], 'manual-review');
    expect(plan.changed).toBe(true);
    expect(plan.statuses).toEqual(['To Do', 'In Progress', 'Pending Review', 'Done']);
    expect(plan.migrateFrom).toBeUndefined();
    expect(plan.migrateTo).toBeUndefined();
  });
  it('reports a rename migration when the mode changes', () => {
    const plan = planStatusSync(['To Do', 'In Progress', 'Pending Review', 'Done'], 'auto-merge');
    expect(plan.changed).toBe(true);
    expect(plan.migrateFrom).toBe('Pending Review');
    expect(plan.migrateTo).toBe('Awaiting Merge');
  });
  it('reports no change when already correct', () => {
    const plan = planStatusSync(
      ['To Do', 'In Progress', 'Pending Review', 'Done'],
      'manual-review'
    );
    expect(plan.changed).toBe(false);
    expect(plan.migrateFrom).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bunx vitest run src/test/unit/mergeStatusConfig.test.ts`
Expected: FAIL — `Cannot find module '../../core/mergeStatusConfig'`.

- [ ] **Step 4: Implement `mergeStatusConfig.ts`**

Create `src/core/mergeStatusConfig.ts`:

```ts
import type { MergeMode } from './mergeQueue';
import { INTERMEDIATE_STATUSES, intermediateStatusForMode } from './mergeConfig';

/** Parse the `statuses: ["A", "B", ...]` line from raw config.yml text. */
export function parseStatusesLine(configText: string): string[] {
  const m = configText.match(/^statuses:\s*\[(.*)\]\s*$/m);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/**
 * The canonical statuses list for `mode`: exactly one intermediate status (the
 * mode's), placed immediately before the last (done) status. Any pre-existing
 * intermediate is removed first, so this both inserts (none present) and renames
 * (a different one present) in one pass.
 */
export function desiredStatuses(current: string[], mode: MergeMode): string[] {
  const target = intermediateStatusForMode(mode);
  const withoutIntermediate = current.filter((s) => !INTERMEDIATE_STATUSES.includes(s));
  if (withoutIntermediate.length === 0) return [target];
  const result = [...withoutIntermediate];
  result.splice(result.length - 1, 0, target); // before the done (last) status
  return result;
}

/** The active intermediate status in a list, or undefined when none. */
export function intermediateStatusOf(statuses: string[]): string | undefined {
  return statuses.find((s) => INTERMEDIATE_STATUSES.includes(s));
}

/** Order-sensitive equality for a statuses list. */
export function statusesEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Surgically replace the `statuses:` line, preserving all other lines + EOL. */
export function rewriteStatusesLine(configText: string, statuses: string[]): string {
  const esc = (s: string) => s.replace(/"/g, '\\"');
  const rendered = `statuses: [${statuses.map((s) => `"${esc(s)}"`).join(', ')}]`;
  const eol = configText.includes('\r\n') ? '\r\n' : '\n';
  const lines = configText.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^statuses:\s*\[/.test(l));
  if (idx === -1) return configText;
  lines[idx] = rendered;
  return lines.join(eol);
}

/**
 * Plan the config sync for a mode: the target statuses list, whether it differs
 * from `current`, and (when an existing intermediate is being renamed) the
 * from/to statuses so in-flight tasks can be migrated.
 */
export function planStatusSync(
  current: string[],
  mode: MergeMode
): { statuses: string[]; changed: boolean; migrateFrom?: string; migrateTo?: string } {
  const statuses = desiredStatuses(current, mode);
  const changed = !statusesEqual(current, statuses);
  const from = intermediateStatusOf(current);
  const to = intermediateStatusForMode(mode);
  const rename = from && from !== to ? { migrateFrom: from, migrateTo: to } : {};
  return { statuses, changed, ...rename };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run src/test/unit/mergeStatusConfig.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/core/mergeStatusConfig.ts src/core/mergeConfig.ts src/test/unit/mergeStatusConfig.test.ts
git commit -m "feat: mode-named board status config core (Component C Task 1)"
```

---

## Task 2: Pure per-task merge state (`mergeBoard.ts`)

**Files:**

- Create: `src/core/mergeBoard.ts`
- Test: `src/test/unit/mergeBoard.test.ts`

**Interfaces:**

- Consumes: `MergeQueue`, `MergeMode`, `positionOf` from `./mergeQueue`.
- Produces:
  - `interface MergeTaskState { queued: boolean; position: number; approved: boolean; active: boolean; mode: MergeMode; }`
  - `mergeStateForTask(queue: MergeQueue, taskId: string): MergeTaskState | undefined` — `undefined` when the task is not in the queue.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/mergeBoard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mergeStateForTask } from '../../core/mergeBoard';
import type { MergeQueue } from '../../core/mergeQueue';

function q(entries: Partial<MergeQueue['entries'][number]>[]): MergeQueue {
  return {
    version: 1,
    entries: entries.map((e) => ({
      taskId: e.taskId ?? 'TASK-1',
      branch: e.branch ?? 'b',
      worktree: e.worktree ?? '.worktrees/b',
      mode: e.mode ?? 'manual-review',
      submittedAt: e.submittedAt ?? '2026-07-01T00:00:00Z',
      approved: e.approved ?? false,
      active: e.active ?? false,
      activeAt: e.activeAt ?? null,
    })),
  };
}

describe('mergeStateForTask', () => {
  it('returns undefined when the task is not queued', () => {
    expect(mergeStateForTask(q([{ taskId: 'TASK-1' }]), 'TASK-9')).toBeUndefined();
  });
  it('reports 1-based position and the entry mode', () => {
    const queue = q([{ taskId: 'TASK-1' }, { taskId: 'TASK-2', mode: 'auto-merge' }]);
    expect(mergeStateForTask(queue, 'TASK-2')).toEqual({
      queued: true,
      position: 2,
      approved: false,
      active: false,
      mode: 'auto-merge',
    });
  });
  it('reflects approved + active flags', () => {
    const queue = q([
      { taskId: 'TASK-1', approved: true, active: true, activeAt: '2026-07-01T00:00:00Z' },
    ]);
    expect(mergeStateForTask(queue, 'TASK-1')).toMatchObject({
      approved: true,
      active: true,
      position: 1,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/test/unit/mergeBoard.test.ts`
Expected: FAIL — `Cannot find module '../../core/mergeBoard'`.

- [ ] **Step 3: Implement `mergeBoard.ts`**

Create `src/core/mergeBoard.ts`:

```ts
import { type MergeMode, type MergeQueue, positionOf } from './mergeQueue';

/** A queued task's board-facing state, derived from the shared merge queue. */
export interface MergeTaskState {
  queued: boolean;
  /** 1-based FIFO position (1 = right-of-way head). */
  position: number;
  /** Human-approved (manual-review gate satisfied). */
  approved: boolean;
  /** The head is performing its merge right now. */
  active: boolean;
  /** The integration mode captured on the entry at submission. */
  mode: MergeMode;
}

/** Derive `taskId`'s merge state from the queue, or undefined when not queued. */
export function mergeStateForTask(queue: MergeQueue, taskId: string): MergeTaskState | undefined {
  const entry = queue.entries.find((e) => e.taskId === taskId);
  if (!entry) return undefined;
  return {
    queued: true,
    position: positionOf(queue, taskId),
    approved: entry.approved,
    active: entry.active,
    mode: entry.mode,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run src/test/unit/mergeBoard.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/mergeBoard.ts src/test/unit/mergeBoard.test.ts
git commit -m "feat: derive per-task merge state from the queue (Component C Task 2)"
```

---

## Task 3: Config status sync + migration on activation / mode change

**Files:**

- Modify: `src/extension.ts` (add `syncMergeStatus`; call it after `syncMergeConfig` at activation and in the config-change listener)
- Modify: `backlog/config.yml` (dogfood the default `Pending Review` status)
- Test: `src/test/unit/mergeStatusConfig.test.ts` (extend — `planStatusSync` already covers the pure logic; add one guard test below)

**Interfaces:**

- Consumes: `planStatusSync`, `parseStatusesLine`, `rewriteStatusesLine` from `./core/mergeStatusConfig`; `getTaskwrightConfig`; existing `parser`/`writer`; `MergeMode` from `./core/mergeQueue`.
- Produces: `syncMergeStatus(backlogPath: string): Promise<void>` (module-private in `extension.ts`).

- [ ] **Step 1: Add a guard test for the no-op case**

Append to `src/test/unit/mergeStatusConfig.test.ts`:

```ts
describe('planStatusSync — auto-pr from a fresh 3-status board', () => {
  it('inserts Awaiting PR with no rename migration', () => {
    const plan = planStatusSync(['To Do', 'In Progress', 'Done'], 'auto-pr');
    expect(plan.statuses).toEqual(['To Do', 'In Progress', 'Awaiting PR', 'Done']);
    expect(plan.changed).toBe(true);
    expect(plan.migrateFrom).toBeUndefined();
  });
});
```

Run: `bunx vitest run src/test/unit/mergeStatusConfig.test.ts` → PASS (logic already implemented in Task 1).

- [ ] **Step 2: Add `syncMergeStatus` to `extension.ts`**

Add these imports to the merge-config import block near the top of `src/extension.ts`:

```ts
import { planStatusSync, parseStatusesLine, rewriteStatusesLine } from './core/mergeStatusConfig';
import type { MergeMode } from './core/mergeQueue';
```

Add this function directly below `syncMergeConfig` (uses the module-level `parser`/`writer`? No — those are inside `activate`. Instead accept them as params). Define it as a free function that takes what it needs:

```ts
/**
 * Ensure `backlog/config.yml` carries the intermediate board status that matches
 * the current `taskwright.mergeMode`, renaming it (and migrating any in-flight
 * task parked in the old intermediate status) when the mode changes. Idempotent:
 * writes only when the statuses line actually differs. Best-effort — never throws
 * into activation.
 */
async function syncMergeStatus(
  backlogPath: string,
  parser: BacklogParser | undefined,
  writer: BacklogWriter,
  onChanged: () => void
): Promise<void> {
  try {
    const configPath = path.join(backlogPath, 'config.yml');
    if (!fs.existsSync(configPath)) return;
    const mode = getTaskwrightConfig<MergeMode>('mergeMode', 'manual-review');
    const text = fs.readFileSync(configPath, 'utf-8');
    const current = parseStatusesLine(text);
    if (current.length === 0) return;
    const plan = planStatusSync(current, mode);
    if (!plan.changed) return;

    fs.writeFileSync(configPath, rewriteStatusesLine(text, plan.statuses), 'utf-8');

    // Migrate any task currently sitting in the old intermediate status.
    if (plan.migrateFrom && plan.migrateTo && parser) {
      const tasks = await parser.getTasks();
      for (const task of tasks) {
        if (task.status === plan.migrateFrom) {
          await writer.updateTask(task.id, { status: plan.migrateTo }, parser);
        }
      }
    }
    onChanged();
  } catch (e) {
    console.warn('[Taskwright] Merge status sync failed:', e);
  }
}
```

- [ ] **Step 3: Call it at activation**

`BacklogWriter` is already instantiated inside `activate` as `const writer = new BacklogWriter();` — that line is below the guard-sync call. Move nothing; instead add the `syncMergeStatus` call in the config-change listener and at activation **after** `writer` exists. At activation, find the block:

```ts
if (workspaceRootPath) {
  syncWorktreeGuard(workspaceRootPath, context.extensionUri);
  void syncMergeConfig(workspaceRootPath);
}
```

Leave it as-is (it runs before `writer` is declared). Add a second activation call right after `const writer = new BacklogWriter();` (search for that line):

```ts
const writer = new BacklogWriter();
const activeBacklogForStatus = manager.getActiveRoot()?.backlogPath;
if (activeBacklogForStatus) {
  void syncMergeStatus(activeBacklogForStatus, parser, writer, () =>
    tasksHosts.forEach((host) => host.refresh())
  );
}
```

- [ ] **Step 4: Call it on `mergeMode` change**

In the `onDidChangeConfiguration` listener, extend the merge block so a `mergeMode` change also re-syncs the status. Replace:

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

with:

```ts
if (
  workspaceRootPath &&
  (affectsTaskwrightConfig(event, 'mergeMode') ||
    affectsTaskwrightConfig(event, 'mergeVerifyCommands') ||
    affectsTaskwrightConfig(event, 'mergeQueueStaleMinutes'))
) {
  void syncMergeConfig(workspaceRootPath);
}
if (affectsTaskwrightConfig(event, 'mergeMode')) {
  const backlogForStatus = manager.getActiveRoot()?.backlogPath;
  if (backlogForStatus) {
    void syncMergeStatus(backlogForStatus, parser, writer, () =>
      tasksHosts.forEach((host) => host.refresh())
    );
  }
}
```

- [ ] **Step 5: Dogfood — add `Pending Review` to the repo board**

Edit `backlog/config.yml` line 3 from:

```yaml
statuses: ['To Do', 'In Progress', 'Done']
```

to:

```yaml
statuses: ['To Do', 'In Progress', 'Pending Review', 'Done']
```

(This is exactly what `syncMergeStatus` writes on first activation with the default `manual-review` mode; pre-adding it lets the board show the column immediately.)

- [ ] **Step 6: Build + typecheck + full test suite**

Run: `bun run compile && bun run typecheck && bun run lint && bun run test`
Expected: extension compiles; suite green (Windows path-assertion failures excepted per Global Constraints).

- [ ] **Step 7: Commit**

```bash
git add src/extension.ts backlog/config.yml src/test/unit/mergeStatusConfig.test.ts
git commit -m "feat: sync mode-named board status + migrate on mode change (Component C Task 3)"
```

---

## Task 4: Approve / send-back queue actions (`mergeActions.ts`) + commands

**Files:**

- Create: `src/providers/mergeActions.ts`
- Modify: `src/extension.ts` (register `taskwright.approveMerge` / `taskwright.sendBackMerge`; add a `resolveCommonDir` helper)
- Test: `src/test/unit/mergeActions.test.ts`

**Interfaces:**

- Consumes: `MergeQueueStore`, `mergeQueuePath`, `approveEntry`, `removeEntry`, `nodeQueueFs`, `type QueueFsDeps` from `../core/mergeQueue`; `BacklogParser`, `BacklogWriter`.
- Produces:
  - `approveMergeInQueue(commonDir: string, taskId: string, fsDeps?: QueueFsDeps): void`
  - `sendBackInQueue(commonDir: string, taskId: string, fsDeps?: QueueFsDeps): void` — removes the entry only.
  - `sendBackMerge(commonDir: string, taskId: string, parser: BacklogParser, writer: BacklogWriter, fsDeps?: QueueFsDeps): Promise<void>` — removes the entry **and** resets the task status to `In Progress` so the board reflects the rejection even if no agent is currently blocked.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/mergeActions.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { approveMergeInQueue, sendBackInQueue } from '../../providers/mergeActions';
import { MergeQueueStore, mergeQueuePath, nodeQueueFs } from '../../core/mergeQueue';

let dir: string;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function seed(commonDir: string): void {
  const store = new MergeQueueStore(mergeQueuePath(commonDir), nodeQueueFs);
  store.mutate(() => ({
    version: 1,
    entries: [
      {
        taskId: 'TASK-7',
        branch: 'task-7-x',
        worktree: '.worktrees/task-7-x',
        mode: 'manual-review',
        submittedAt: '2026-07-01T00:00:00Z',
        approved: false,
        active: false,
        activeAt: null,
      },
    ],
  }));
}

describe('approveMergeInQueue', () => {
  it('sets approved:true on the entry', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-ma-'));
    seed(dir);
    approveMergeInQueue(dir, 'TASK-7');
    const store = new MergeQueueStore(mergeQueuePath(dir), nodeQueueFs);
    expect(store.read().entries[0].approved).toBe(true);
  });
});

describe('sendBackInQueue', () => {
  it('removes the entry', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-mb-'));
    seed(dir);
    sendBackInQueue(dir, 'TASK-7');
    const store = new MergeQueueStore(mergeQueuePath(dir), nodeQueueFs);
    expect(store.read().entries).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/test/unit/mergeActions.test.ts`
Expected: FAIL — `Cannot find module '../../providers/mergeActions'`.

- [ ] **Step 3: Implement `mergeActions.ts`**

Create `src/providers/mergeActions.ts`:

```ts
import {
  MergeQueueStore,
  mergeQueuePath,
  approveEntry,
  removeEntry,
  nodeQueueFs,
  type QueueFsDeps,
} from '../core/mergeQueue';
import type { BacklogParser } from '../core/BacklogParser';
import type { BacklogWriter } from '../core/BacklogWriter';

const IN_PROGRESS = 'In Progress';

function storeFor(commonDir: string, fsDeps: QueueFsDeps): MergeQueueStore {
  return new MergeQueueStore(mergeQueuePath(commonDir), fsDeps);
}

/** Grant the manual-review gate: set `approved:true` on the queued task. */
export function approveMergeInQueue(
  commonDir: string,
  taskId: string,
  fsDeps: QueueFsDeps = nodeQueueFs
): void {
  storeFor(commonDir, fsDeps).mutate((q) => approveEntry(q, taskId));
}

/** Reject: drop the task from the queue (does not touch the board status). */
export function sendBackInQueue(
  commonDir: string,
  taskId: string,
  fsDeps: QueueFsDeps = nodeQueueFs
): void {
  storeFor(commonDir, fsDeps).mutate((q) => removeEntry(q, taskId));
}

/**
 * Send a queued task back to work: remove its queue entry and reset its board
 * status to `In Progress`. The status reset makes the board reflect the
 * rejection immediately, even if no agent is currently blocked on the entry
 * (a blocked agent's `request_merge` also returns `sent_back` and resets the
 * status; both write the same value, so this is safe/idempotent).
 */
export async function sendBackMerge(
  commonDir: string,
  taskId: string,
  parser: BacklogParser,
  writer: BacklogWriter,
  fsDeps: QueueFsDeps = nodeQueueFs
): Promise<void> {
  sendBackInQueue(commonDir, taskId, fsDeps);
  const task = await parser.getTask(taskId);
  if (task) {
    await writer.updateTask(taskId, { status: IN_PROGRESS }, parser);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx vitest run src/test/unit/mergeActions.test.ts`
Expected: PASS.

- [ ] **Step 5: Register commands in `extension.ts`**

Add a common-dir resolver near `syncMergeConfig` (reuses the same `execFileAsync` already imported):

```ts
/** Resolve the shared git common dir (identical from every worktree). */
async function resolveCommonDir(repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
      cwd: repoRoot,
      timeout: 15_000,
    });
    return path.resolve(repoRoot, stdout.trim());
  } catch {
    return undefined;
  }
}
```

Add the import for the actions near the other provider imports:

```ts
import { approveMergeInQueue, sendBackMerge } from './providers/mergeActions';
```

Register the two commands alongside the claim/release commands (inside `activate`, using the existing `resolveClaimTarget`, `refreshAllViews`, `parser`, `writer`, `workspaceRootPath`, `taskDetailProvider`):

```ts
context.subscriptions.push(
  vscode.commands.registerCommand('taskwright.approveMerge', async (arg?: unknown) => {
    const taskId = resolveClaimTarget(arg);
    if (!taskId || !workspaceRootPath) {
      vscode.window.showInformationMessage('Open a task awaiting review to approve it.');
      return;
    }
    const commonDir = await resolveCommonDir(workspaceRootPath);
    if (!commonDir) {
      vscode.window.showErrorMessage('Not a git repository — no merge queue to approve.');
      return;
    }
    try {
      approveMergeInQueue(commonDir, taskId);
      refreshAllViews();
      TaskDetailProvider.refreshCurrent(taskDetailProvider);
      vscode.window.showInformationMessage(`Approved ${taskId} — the agent will merge it.`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to approve merge: ${error}`);
    }
  }),
  vscode.commands.registerCommand('taskwright.sendBackMerge', async (arg?: unknown) => {
    const taskId = resolveClaimTarget(arg);
    if (!taskId || !workspaceRootPath || !parser) {
      vscode.window.showInformationMessage('Open a task awaiting review to send it back.');
      return;
    }
    const commonDir = await resolveCommonDir(workspaceRootPath);
    if (!commonDir) {
      vscode.window.showErrorMessage('Not a git repository — no merge queue to update.');
      return;
    }
    try {
      await sendBackMerge(commonDir, taskId, parser, writer);
      refreshAllViews();
      TaskDetailProvider.refreshCurrent(taskDetailProvider);
      vscode.window.showInformationMessage(`Sent ${taskId} back to In Progress.`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to send back: ${error}`);
    }
  })
);
```

- [ ] **Step 6: Declare the commands in `package.json`**

Add to `contributes.commands` (match the surrounding style; titles under the `Taskwright:` category):

```json
{ "command": "taskwright.approveMerge", "title": "Approve Merge", "category": "Taskwright" },
{ "command": "taskwright.sendBackMerge", "title": "Send Back Merge", "category": "Taskwright" }
```

- [ ] **Step 7: Build + gates**

Run: `bun run compile && bun run typecheck && bun run lint && bunx vitest run src/test/unit/mergeActions.test.ts`
Expected: compiles; tests green.

- [ ] **Step 8: Commit**

```bash
git add src/providers/mergeActions.ts src/extension.ts package.json src/test/unit/mergeActions.test.ts
git commit -m "feat: approve/send-back merge-queue commands (Component C Task 4)"
```

---

## Task 5: Board enrichment + kanban card badge

**Files:**

- Modify: `src/core/types.ts` (enriched-task `mergeState?`, `TasksViewSettings.mergeMode?`, `MergeTaskState` re-export, message variants)
- Modify: `src/providers/TasksController.ts` (inject a queue reader, enrich tasks, send `mergeMode`, handle `approveMerge`/`sendBackMerge`)
- Modify: `src/extension.ts` (resolve the queue reader once, wire it into both hosts; add a queue `FileSystemWatcher`)
- Modify: `src/webview/components/shared/TaskCard.svelte` (merge badge)
- Modify: `src/webview/lib/types.ts` (mirror the `mergeState` field for the webview `Task`)
- Test: `src/test/unit/TasksController.test.ts` (enrichment), `e2e/merge-review.spec.ts` (card badge — shared with Task 6)

**Interfaces:**

- Consumes: `mergeStateForTask` + `MergeTaskState` from `../core/mergeBoard`; `MergeQueue`/`MergeMode` from `../core/mergeQueue`; `intermediateStatusForMode` from `../core/mergeConfig`.
- Produces:
  - `TasksController.setMergeQueueReader(reader: () => MergeQueue | undefined): void`
  - Enriched task field `mergeState?: MergeTaskState` on the objects sent in `tasksUpdated`.
  - `TasksViewSettings.mergeMode?: MergeMode`.
  - New `WebviewMessage` variants: `{ type: 'approveMerge'; taskId: string }`, `{ type: 'sendBackMerge'; taskId: string }`.

- [ ] **Step 1: Extend types**

In `src/core/types.ts`:

Add the import at the top (near other core imports — keep type-only):

```ts
import type { MergeTaskState } from './mergeBoard';
import type { MergeMode } from './mergeQueue';
```

Add to `TasksViewSettings` (find the interface):

```ts
  /** Active merge mode; drives the merge-review controls shown on the board. */
  mergeMode?: MergeMode;
```

Add to the `WebviewMessage` union (alongside `claimTask`-style entries):

```ts
  | { type: 'approveMerge'; taskId: string }
  | { type: 'sendBackMerge'; taskId: string }
```

Re-export the state type so webview/provider code has one import site:

```ts
export type { MergeTaskState } from './mergeBoard';
```

The enriched task object is an inline intersection type in `TasksController` (see existing `tasksWithBlocks`), so no change to the `Task` interface itself — `mergeState?` is added to that inline type in Step 3.

- [ ] **Step 2: Write the failing controller test**

Add to `src/test/unit/TasksController.test.ts` (follow the file's existing harness for constructing a controller with a fake host + parser; reuse its helpers). Add a test that injects a queue reader and asserts the enriched task carries `mergeState`:

```ts
import { mergeStateForTask } from '../../core/mergeBoard';

it('enriches tasks with mergeState from the injected queue reader', async () => {
  // `makeController` / `fakeHost` / `fakeParser` are this file's existing helpers;
  // fakeParser returns one task TASK-1 in status "Pending Review".
  const { controller, host } =
    makeController(/* tasks: [taskWith({ id: 'TASK-1', status: 'Pending Review' })] */);
  controller.setMergeQueueReader(() => ({
    version: 1,
    entries: [
      {
        taskId: 'TASK-1',
        branch: 'b',
        worktree: '.worktrees/b',
        mode: 'manual-review',
        submittedAt: '2026-07-01T00:00:00Z',
        approved: false,
        active: false,
        activeAt: null,
      },
    ],
  }));
  await controller.refresh();
  const msg = host.messages.find((m) => m.type === 'tasksUpdated');
  const task = msg.tasks.find((t: { id: string }) => t.id === 'TASK-1');
  expect(task.mergeState).toMatchObject({ queued: true, position: 1, mode: 'manual-review' });
});
```

> If the existing test file uses different helper names, adapt to them — the assertion (an enriched task exposes `mergeState`) is what matters. Also assert the `settingsUpdated` message carries `mergeMode` when the reader is set.

- [ ] **Step 3: Implement enrichment in `TasksController.ts`**

Add imports:

```ts
import { mergeStateForTask, type MergeTaskState } from '../core/mergeBoard';
import type { MergeQueue, MergeMode } from '../core/mergeQueue';
```

Add the field + setter to the class:

```ts
  private mergeQueueReader?: () => MergeQueue | undefined;

  /** Inject a reader for the shared merge queue (best-effort board enrichment). */
  setMergeQueueReader(reader: () => MergeQueue | undefined): void {
    this.mergeQueueReader = reader;
  }
```

In `getTasksViewSettings()`, include the mode:

```ts
const mergeMode = getTaskwrightConfig<MergeMode>('mergeMode', 'manual-review');
return { taskIdDisplay, mergeMode };
```

In `refresh()`, after `activeTaskId`/`stalenessMs` are resolved and before building `tasksWithBlocks`, read the queue once:

```ts
let mergeQueue: MergeQueue | undefined;
try {
  mergeQueue = this.mergeQueueReader?.();
} catch {
  mergeQueue = undefined;
}
```

Extend the enriched-task inline type and the mapping. Change the `enhanced` type annotation to add `mergeState?: MergeTaskState;` and set it:

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
```

Add message handling in `handleMessage` (new `case`s):

```ts
      case 'approveMerge': {
        vscode.commands.executeCommand('taskwright.approveMerge', message.taskId);
        break;
      }

      case 'sendBackMerge': {
        vscode.commands.executeCommand('taskwright.sendBackMerge', message.taskId);
        break;
      }
```

- [ ] **Step 4: Wire the queue reader + watcher in `extension.ts`**

Add imports:

```ts
import { MergeQueueStore, mergeQueuePath, type MergeQueue } from './core/mergeQueue';
```

(Adjust the existing `import { nodeQueueFs } from './core/mergeQueue';` to include these names, or add a second import — keep one import statement per module.)

After `workspaceRootPath` is known and both hosts exist, resolve the common dir and inject the reader:

```ts
if (workspaceRootPath) {
  void (async () => {
    const commonDir = await resolveCommonDir(workspaceRootPath);
    if (!commonDir) return;
    const store = new MergeQueueStore(mergeQueuePath(commonDir), nodeQueueFs);
    const reader = (): MergeQueue => store.read();
    tasksHosts.forEach((host) => host.setMergeQueueReader(reader));
    tasksHosts.forEach((host) => host.refresh());

    // The queue mutates out-of-process (request_merge merges/dequeues); watch it
    // so the board reflects position changes and "merging…" without a manual reload.
    const watcher = vscode.workspace.createFileSystemWatcher(mergeQueuePath(commonDir));
    const onQueueChange = () => tasksHosts.forEach((host) => host.refresh());
    watcher.onDidChange(onQueueChange);
    watcher.onDidCreate(onQueueChange);
    watcher.onDidDelete(onQueueChange);
    context.subscriptions.push(watcher);
  })();
}
```

Add `setMergeQueueReader` to the `TasksBoardSurface` interface:

```ts
  setMergeQueueReader(reader: () => MergeQueue | undefined): void;
```

> Note: `TasksViewProvider` / `TasksPanelProvider` delegate to their `TasksController`. Add a thin `setMergeQueueReader(reader) { this.controller.setMergeQueueReader(reader); }` pass-through to each (mirroring how `setWorkspaceRoot` delegates).

- [ ] **Step 5: Mirror `mergeState` on the webview `Task` type**

In `src/webview/lib/types.ts`, add to the `Task` interface (webview copy) the optional field so the Svelte components typecheck:

```ts
  mergeState?: {
    queued: boolean;
    position: number;
    approved: boolean;
    active: boolean;
    mode: 'manual-review' | 'auto-merge' | 'auto-pr';
  };
```

- [ ] **Step 6: Render the badge in `TaskCard.svelte`**

Add a derived value in the `<script>` block (near `isActiveTask`):

```ts
let mergeState = $derived(task.mergeState);
let mergeLabel = $derived(
  !mergeState
    ? ''
    : mergeState.active
      ? 'merging…'
      : mergeState.approved
        ? 'approved'
        : mergeState.mode === 'manual-review'
          ? `review · #${mergeState.position}`
          : `queued · #${mergeState.position}`
);
```

Add the badge in the `task-card-meta` block, after the claim indicator (Lucide `git-merge` icon; inherits theme via `currentColor`):

```svelte
    {#if mergeState}
      <span
        class="merge-indicator"
        class:approved={mergeState.approved}
        data-testid="merge-indicator-{task.id}"
        title="In the merge queue: {mergeLabel}"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>
        <span class="merge-indicator-label">{mergeLabel}</span>
      </span>
    {/if}
```

Add matching CSS near the other indicator styles (use theme vars, amber-ish accent consistent with the stale-claim badge; do not hardcode light-mode-only colors):

```css
.merge-indicator {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--vscode-charts-blue, #3794ff);
  border: 1px solid color-mix(in srgb, currentColor 40%, transparent);
}
.merge-indicator.approved {
  color: var(--vscode-charts-green, #89d185);
}
.merge-indicator-label {
  line-height: 1;
}
```

- [ ] **Step 7: Validate the Svelte component**

Run the Svelte autofixer via the Svelte MCP on the edited `TaskCard.svelte` (per repo guidance) and resolve any issues. Then build the webview:

Run: `bun run compile:webview`
Expected: builds without errors.

- [ ] **Step 8: Run controller test + full gates**

Run: `bunx vitest run src/test/unit/TasksController.test.ts && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/core/types.ts src/providers/TasksController.ts src/extension.ts src/webview/components/shared/TaskCard.svelte src/webview/lib/types.ts src/test/unit/TasksController.test.ts
git commit -m "feat: enrich board with merge state + kanban badge (Component C Task 5)"
```

---

## Task 6: Detail-panel merge-review banner (Approve / Send back)

**Files:**

- Modify: `src/providers/TaskDetailProvider.ts` (compute `mergeState` + `mergeMode` for the open task; handle `approveMerge`/`sendBackMerge` messages)
- Modify: `src/webview/components/task-detail/TaskDetail.svelte` (merge-review banner + buttons)
- Modify: `src/core/types.ts` (`TaskDetailData` gains `mergeState?` + `mergeMode?`)
- Test: `e2e/merge-review.spec.ts` (Playwright — buttons post `approveMerge`/`sendBackMerge`; auto-mode shows a read-only indicator)

**Interfaces:**

- Consumes: `mergeStateForTask` + `MergeTaskState` from `../core/mergeBoard`; `MergeQueueStore`/`mergeQueuePath`/`nodeQueueFs` from `../core/mergeQueue`; `intermediateStatusForMode` from `../core/mergeConfig`; `getTaskwrightConfig`.
- Produces: `TaskDetailData.mergeState?: MergeTaskState`, `TaskDetailData.mergeMode?: MergeMode`; the detail webview posts `{ type: 'approveMerge'|'sendBackMerge', taskId }`.

- [ ] **Step 1: Extend `TaskDetailData`**

In `src/core/types.ts`, find the `TaskDetailData` interface (the payload of the `taskData` message) and add:

```ts
  /** Merge-queue state for this task, when it is awaiting integration. */
  mergeState?: MergeTaskState;
  /** Active merge mode (drives which review controls show). */
  mergeMode?: MergeMode;
```

- [ ] **Step 2: Provider computes merge state for the open task**

In `src/providers/TaskDetailProvider.ts`, add imports:

```ts
import { mergeStateForTask } from '../core/mergeBoard';
import { MergeQueueStore, mergeQueuePath, nodeQueueFs, type MergeMode } from '../core/mergeQueue';
import { getTaskwrightConfig } from '../config';
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsyncDetail = promisify(execFile);
```

Add a private best-effort helper on the provider that resolves the queue state for a task (repo root = the workspace folder containing the task file):

```ts
  private async resolveMergeState(taskId: string, repoRoot: string) {
    try {
      const { stdout } = await execFileAsyncDetail('git', ['rev-parse', '--git-common-dir'], {
        cwd: repoRoot,
        timeout: 15_000,
      });
      const commonDir = path.resolve(repoRoot, stdout.trim());
      const store = new MergeQueueStore(mergeQueuePath(commonDir), nodeQueueFs);
      return mergeStateForTask(store.read(), taskId);
    } catch {
      return undefined;
    }
  }
```

Where the provider assembles the `taskData` payload (the object that already sets `claimIdentity` — around line 485), add the two fields. Use the workspace root available to the provider (the task file's workspace folder / `this.parser`'s workspace root — mirror how the provider already derives paths):

```ts
        claimIdentity: getClaimIdentity(),
        mergeMode: getTaskwrightConfig<MergeMode>('mergeMode', 'manual-review'),
        mergeState: workspaceRoot ? await this.resolveMergeState(task.id, workspaceRoot) : undefined,
```

> Derive `workspaceRoot` the same way the provider already locates the repo (e.g. `path.dirname(this.parser.getBacklogPath())` or the existing workspace-folder lookup used for `openWorkspaceFile`). If the assembly function is not already `async`, make it `async` and `await` the payload.

- [ ] **Step 3: Handle the two new messages in the provider**

In the provider's `handleMessage` switch (near the `claimTask` / `dispatchTask` cases), add:

```ts
      case 'approveMerge': {
        if (TaskDetailProvider.currentTaskId) {
          vscode.commands.executeCommand('taskwright.approveMerge', TaskDetailProvider.currentTaskId);
        }
        break;
      }

      case 'sendBackMerge': {
        if (TaskDetailProvider.currentTaskId) {
          vscode.commands.executeCommand('taskwright.sendBackMerge', TaskDetailProvider.currentTaskId);
        }
        break;
      }
```

Also widen the `handleMessage` parameter type union to include the two message `type` string literals (the method uses an inline union — add `'approveMerge'` and `'sendBackMerge'`).

- [ ] **Step 4: Render the banner in `TaskDetail.svelte`**

Add state wiring in the `<script>` (near the claim state):

```ts
let mergeState:
  | { queued: boolean; position: number; approved: boolean; active: boolean; mode: string }
  | undefined = $state(undefined);
let mergeMode: string | undefined = $state(undefined);
```

In the `taskData` message handler where `claimedBy = data.task.claimedBy` etc. are assigned, add:

```ts
mergeState = data.mergeState;
mergeMode = data.mergeMode;
```

Add derived + handlers:

```ts
let inManualReview = $derived(
  !!mergeState && mergeState.mode === 'manual-review' && !mergeState.approved && !mergeState.active
);
let mergeStatusText = $derived(
  !mergeState
    ? ''
    : mergeState.active
      ? 'Merging…'
      : mergeState.approved
        ? 'Approved — the agent is integrating it'
        : `In the merge queue · position #${mergeState.position}`
);

function handleApproveMerge() {
  if (task) vscode.postMessage({ type: 'approveMerge', taskId: task.id });
}
function handleSendBackMerge() {
  if (task) vscode.postMessage({ type: 'sendBackMerge', taskId: task.id });
}
```

Add the banner near the claim banner (reuse the `claim-banner` visual language for consistency):

```svelte
  {#if mergeState}
    <div class="claim-banner merge-review-banner" data-testid="merge-review-banner">
      <span class="claim-info">{mergeStatusText}</span>
      {#if inManualReview}
        <div class="claim-banner-actions">
          <button class="claim-btn" data-testid="approve-merge-btn" onclick={handleApproveMerge}>Approve &amp; merge</button>
          <button class="claim-release-btn" data-testid="send-back-merge-btn" onclick={handleSendBackMerge}>Send back</button>
        </div>
      {/if}
    </div>
  {/if}
```

- [ ] **Step 5: Write the Playwright behavior test**

Create `e2e/merge-review.spec.ts` following the repo's webview-fixture pattern (`e2e/fixtures/`, `installVsCodeMock`, `data-testid` selectors). Cover:

1. Load `/task-detail.html`, inject `taskData` with `mergeState { mode:'manual-review', approved:false, active:false, position:1 }` → assert both buttons render; clicking `approve-merge-btn` posts `{type:'approveMerge'}`, `send-back-merge-btn` posts `{type:'sendBackMerge'}`.
2. Inject `mergeState { mode:'auto-merge', ... }` → assert the banner shows the read-only queue text and **no** buttons.
3. (Kanban) Load `/tasks.html`, inject a task with `mergeState` → assert `merge-indicator-<id>` renders with the position label.

```ts
import { test, expect } from '@playwright/test';
// Mirror the setup used by e2e/dispatch.spec.ts (installVsCodeMock, fixture URLs,
// postMessage injection). Assert on captured postMessage calls via the mock.

test('manual-review shows Approve & Send back and posts the right messages', async ({ page }) => {
  // ...load /task-detail.html, install mock, postMessage taskData with mergeState...
  // await page.getByTestId('approve-merge-btn').click();
  // expect(await getPostedMessages(page)).toContainEqual({ type: 'approveMerge', taskId: 'TASK-1' });
});
```

> Model the harness on `e2e/dispatch.spec.ts`; keep assertions on the posted messages, not on extension side effects.

- [ ] **Step 6: Validate Svelte + run Playwright**

Run the Svelte autofixer on `TaskDetail.svelte`, then:

Run: `bun run compile:webview && bun run test:playwright -- merge-review`
Expected: the new spec passes (build the webview first so the fixture loads the current bundle).

- [ ] **Step 7: Full gates**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: green (Windows path-assertion failures excepted).

- [ ] **Step 8: Commit**

```bash
git add src/providers/TaskDetailProvider.ts src/webview/components/task-detail/TaskDetail.svelte src/core/types.ts e2e/merge-review.spec.ts
git commit -m "feat: detail-panel merge-review banner with Approve/Send back (Component C Task 6)"
```

---

## Post-plan: whole-branch review + integration

After Task 6, before merging:

1. **Whole-branch review** (opus) against this plan + the Component C spec (§7 of `docs/superpowers/specs/2026-07-01-safe-concurrent-agents-merge-queue-design.md`). Pay special attention to: the config auto-edit is idempotent and never corrupts a custom board; the send-back status-reset does not race destructively with a blocked agent's own reset; the queue `FileSystemWatcher` path is correct across worktrees; no emojis crept into the webviews.
2. **Update `TASK-15`** via `edit_task`: check AC #4, extend Implementation Notes with the Component C summary, and (only once A+B+C are all green) write the Final Summary + mark Done.
3. **Manual smoke / visual proof** (optional but recommended): invoke the `visual-proof` skill to capture the new column + Approve/Send-back controls.
4. **Merge to `main` locally** (per the standing directive): fast-forward, delete the branch, confirm clean state.

## Self-review notes (coverage check)

- Spec §7 "mode-dependent intermediate status" → Task 1 (`desiredStatuses`) + Task 3 (`syncMergeStatus`, default `Pending Review`).
- Spec §7 "rename + migrate on mode change" → Task 1 (`planStatusSync` migrateFrom/To) + Task 3 (write + task migration).
- Spec §7 "controls … Approve & merge / Send back" (manual-review) → Task 4 (queue writes + commands) + Task 6 (detail buttons).
- Spec §7 "read-only queued · position N / merging…" (auto modes) → Task 5 (card badge) + Task 6 (banner read-only text).
- Spec §7 "coordinate purely through the shared queue file" → Task 4 writes the queue; Task 5 reads it; Component B's long-poll observes it. No IPC.
- Spec §13-C "mergeMode plumbing" → Task 5 (`TasksViewSettings.mergeMode`) + Task 6 (`TaskDetailData.mergeMode`).
- Spec §12 testing: unit (Tasks 1, 2, 4, 5-controller), webview Playwright (Task 6, shared spec). CDP is listed optional in the spec — deferred.
