# Synced Board — Phase 4: wire-in, UI, and migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the synced board live end-to-end: route claims (UI + MCP) through the sync engine, stop the cross-branch loader from surfacing ghosts in sync mode, publish the config for the MCP server, add the poll/status controller, and provide the one-time, one-consent "enable sync" migration that moves the board off code branches.

**Architecture:** Pure, testable cores for every decision (migration gitignore/rm-cached lists, loader branch exclusion, MCP claim-routing) with thin vscode/MCP glue on top. The glue mirrors existing patterns: `syncMergeConfig` → `publishSyncConfig`; the merge-review controller → `BoardSyncController`; the worktree-guard fenced `.gitignore`/hook block → the board `.gitignore` block. VS Code-coupled UI is verified by F5 + the `visual-proof` skill (this repo's convention for UI-only changes).

**Tech Stack:** TypeScript, Vitest (cores), VS Code extension host (glue), `visual-proof` skill (UI evidence).

## Where this fits

**Plan 4 of 4** from `docs/superpowers/specs/2026-07-01-github-synced-board-design.md` (spec §5, §6, §8). Depends on **Plans 1–3**. This is the last plan; after it the feature is shippable.

## Global Constraints

_Every task's requirements implicitly includes this section._

- **Runtime:** Node **≥ 22**; build/test via **Bun** (`bun run test`, `bun run lint`, `bun run typecheck`, `bun run build`).
- **Subscription-safe:** never spawn `claude -p`; sync only shells out to `git`. (Unchanged Taskwright invariant.)
- **One consent gate:** the migration makes exactly one commit on the user's branch (`git rm --cached` of the board dirs), and only after an explicit confirm. Everything else is silent/automatic.
- **Pure cores under TDD; vscode glue verified manually** (F5 + `visual-proof`), matching this repo's UI-change convention.
- **Reuse:** `readSyncConfig`/`syncConfigPath` (Plan 3), `claimTaskSynced`/`releaseTaskSynced`/`refreshBoard` (Plan 2), `reconcileBoardRef`/`compactBoardRef` (Plan 3), `nodeQueueFs` (`mergeQueue`), the worktree-guard fenced-block idiom (`src/core/hookInstaller.ts`).
- **Commit trailer:** end each commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (workers substitute their own model line per `AGENTS.md`).

---

## File Structure

- **Create** `src/core/boardMigration.ts` — pure gitignore fenced-block + `git rm --cached` path helpers.
- **Modify** `src/core/CrossBranchTaskLoader.ts` — accept an `excludeBranches` list and filter it out of the scan.
- **Modify** `src/mcp/handlers.ts` — route `claim_task`/`release_task` through the sync engine when sync mode ≠ `off` (injectable engine deps; extended `ClaimResult`).
- **Modify** `src/extension.ts` — `publishSyncConfig(repoRoot)` on activation/config-change (mirrors `syncMergeConfig`); register the `BoardSyncController` and the `taskwright.enableSync` command.
- **Create** `src/providers/BoardSyncController.ts` — reconcile on start, poll timer (`refreshBoard`), status-bar item, board reload on change, surrender/conflict toasts.
- **Modify** `src/providers/TasksController.ts` — skip cross-branch mode when sync ≠ `off`; pass the board branch as an exclusion otherwise.
- **Modify** `package.json` — contribute the `taskwright.enableSync` command.
- **Modify** `AGENTS.md`, `CLAUDE.md`, `README.md` — document sync mode, the board ref, automatic lifecycle, and boundaries.
- **Tests:** `src/test/unit/boardMigration.test.ts` (new), `src/test/unit/CrossBranchTaskLoader.test.ts` (extend), `src/test/unit/mcp-handlers.test.ts` (extend or create alongside the existing handler tests).

---

## Task 1: `boardMigration` — gitignore block + rm-cached paths (pure)

**Files:**

- Create: `src/core/boardMigration.ts`
- Test: `src/test/unit/boardMigration.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `export const BOARD_IGNORE_BEGIN = '# >>> taskwright synced board >>>'`
  - `export const BOARD_IGNORE_END = '# <<< taskwright synced board <<<'`
  - `export function boardIgnoreBlock(backlogDir?: string): string` — the fenced block ignoring `<backlogDir>/{tasks,drafts,completed,archive}/` (default `backlog`).
  - `export function applyBoardIgnore(existing: string, backlogDir?: string): string` — idempotently insert or replace the fenced block in a `.gitignore`'s contents.
  - `export function boardTrackedPaths(backlogDir?: string): string[]` — the four dir paths to `git rm -r --cached --ignore-unmatch`.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/boardMigration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  BOARD_IGNORE_BEGIN,
  BOARD_IGNORE_END,
  boardIgnoreBlock,
  applyBoardIgnore,
  boardTrackedPaths,
} from '../../core/boardMigration';

describe('boardMigration', () => {
  it('block ignores the four board subdirs under the fenced markers', () => {
    const block = boardIgnoreBlock('backlog');
    expect(block.startsWith(BOARD_IGNORE_BEGIN)).toBe(true);
    expect(block.trimEnd().endsWith(BOARD_IGNORE_END)).toBe(true);
    for (const d of ['tasks', 'drafts', 'completed', 'archive']) {
      expect(block).toContain(`backlog/${d}/`);
    }
  });

  it('appends the block when absent, preserving existing content', () => {
    const out = applyBoardIgnore('node_modules/\ndist/\n', 'backlog');
    expect(out).toContain('node_modules/');
    expect(out).toContain('dist/');
    expect(out).toContain('backlog/tasks/');
  });

  it('is idempotent — replaces the block instead of duplicating it', () => {
    const once = applyBoardIgnore('dist/\n', 'backlog');
    const twice = applyBoardIgnore(once, 'backlog');
    const occurrences = twice.split(BOARD_IGNORE_BEGIN).length - 1;
    expect(occurrences).toBe(1);
  });

  it('lists the four tracked dir paths for rm --cached', () => {
    expect(boardTrackedPaths('backlog')).toEqual([
      'backlog/tasks',
      'backlog/drafts',
      'backlog/completed',
      'backlog/archive',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- boardMigration`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/boardMigration.ts`:

```ts
const SUBDIRS = ['tasks', 'drafts', 'completed', 'archive'] as const;

export const BOARD_IGNORE_BEGIN = '# >>> taskwright synced board >>>';
export const BOARD_IGNORE_END = '# <<< taskwright synced board <<<';

export function boardIgnoreBlock(backlogDir = 'backlog'): string {
  const lines = [
    BOARD_IGNORE_BEGIN,
    '# Board tasks live on the taskwright-board ref, not on code branches.',
    ...SUBDIRS.map((d) => `${backlogDir}/${d}/`),
    BOARD_IGNORE_END,
  ];
  return lines.join('\n') + '\n';
}

/** Insert or replace the fenced board block idempotently. */
export function applyBoardIgnore(existing: string, backlogDir = 'backlog'): string {
  const block = boardIgnoreBlock(backlogDir);
  const begin = existing.indexOf(BOARD_IGNORE_BEGIN);
  if (begin === -1) {
    const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    return `${existing}${sep}${block}`;
  }
  const endMarker = existing.indexOf(BOARD_IGNORE_END, begin);
  const end = endMarker === -1 ? existing.length : endMarker + BOARD_IGNORE_END.length;
  const tail = existing.slice(end).replace(/^\n/, '');
  return `${existing.slice(0, begin)}${block}${tail}`;
}

export function boardTrackedPaths(backlogDir = 'backlog'): string[] {
  return SUBDIRS.map((d) => `${backlogDir}/${d}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- boardMigration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/boardMigration.ts src/test/unit/boardMigration.test.ts
git commit -m "feat(sync): boardMigration gitignore-block + rm-cached path helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Exclude the board branch from the cross-branch loader

**Files:**

- Modify: `src/core/CrossBranchTaskLoader.ts`
- Test: `src/test/unit/CrossBranchTaskLoader.test.ts`

**Interfaces:**

- Consumes: existing `CrossBranchTaskLoader` constructor + `getBranchesToScan`.
- Produces: a new **optional last constructor parameter** `excludeBranches: string[] = []`; branches whose `name` is in that list are filtered out of `getBranchesToScan` (so a stray `taskwright-board` branch never becomes a read-only ghost, even if `check_active_branches` is on during the migration window).

- [ ] **Step 1: Write the failing test**

Append to `src/test/unit/CrossBranchTaskLoader.test.ts` (reuse the file's existing `gitService`/`parser`/`config`/`backlogDir` fixtures):

```ts
it('excludes named branches (e.g. the board ref) from the scan', async () => {
  // Arrange a gitService that reports a board branch among the recent branches.
  // (Follow this file's existing GitBranchService fake pattern.)
  const config = { check_active_branches: true } as any;
  const loader = new CrossBranchTaskLoader(gitService, parser, config, projectRoot, backlogDir, [
    'taskwright-board',
  ]);
  const scanned = await (loader as any).getBranchesToScan();
  expect(scanned.map((b: any) => b.name)).not.toContain('taskwright-board');
});
```

> Implementation note for the worker: match the exact fake `GitBranchService` shape already used in this test file (it stubs `listRecentBranches` / `listLocalBranches` / `getCurrentBranch` / `getMainBranch`). Add `taskwright-board` to whatever `listRecentBranches` returns in the arrange step.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- CrossBranchTaskLoader`
Expected: FAIL — the constructor takes no `excludeBranches`, so the board branch is still scanned.

- [ ] **Step 3: Write minimal implementation**

In `src/core/CrossBranchTaskLoader.ts`, add the constructor param and filter. Update the constructor signature:

```ts
constructor(
  gitService: GitBranchService,
  private parser: BacklogParser,
  config: BacklogConfig,
  projectRoot: string,
  backlogDir: string = 'backlog',
  private readonly excludeBranches: string[] = []
) {
  // ...existing assignments unchanged...
}
```

At the end of `getBranchesToScan`, before `return branches;`:

```ts
const excluded = new Set(this.excludeBranches);
return branches.filter((b) => !excluded.has(b.name));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- CrossBranchTaskLoader`
Expected: PASS. Also re-run the whole loader suite to confirm no regression: same command.

- [ ] **Step 5: Commit**

```bash
git add src/core/CrossBranchTaskLoader.ts src/test/unit/CrossBranchTaskLoader.test.ts
git commit -m "feat(sync): CrossBranchTaskLoader excludeBranches (board ref never a ghost)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Route MCP `claim_task` / `release_task` through the sync engine

**Files:**

- Modify: `src/mcp/handlers.ts`
- Test: `src/test/unit/mcp-handlers.test.ts` (extend the existing handler tests, or create this file if handler tests live elsewhere — search for `claimTaskHandler` in `src/test`)

**Interfaces:**

- Consumes: `readSyncConfig`, `syncConfigPath` (Plan 3); `claimTaskSynced`, `releaseTaskSynced`, type `SyncTarget`, `ClaimOutcome` (Plan 2); `nodeQueueFs` (`mergeQueue`); existing `McpHandlerDeps` (already carries optional `gitExec`).
- Produces:
  - Extended `ClaimResult` with optional `surrendered?: boolean` and `heldBy?: string`.
  - Optional injectable seams on `McpHandlerDeps`: `claimSynced?` and `releaseSynced?` (default to the real Plan 2 functions) + `syncConfigForRoot?` (default resolves via `git-common-dir` + `readSyncConfig`) — so the branching is unit-testable without a real remote.
  - `claimTaskHandler` / `releaseTaskHandler` route to the engine when `mode !== 'off'`, else the existing `ClaimService` path (unchanged behavior).

- [ ] **Step 1: Write the failing test**

Add tests that assert (a) mode `off` keeps the legacy path, (b) mode `github` routes to the injected `claimSynced` and maps a surrender:

```ts
import { claimTaskHandler } from '../../mcp/handlers';

const baseDeps = () => ({
  root: '/repo',
  backlogPath: '/repo/backlog',
  parser: {
    /* minimal stub used only on the legacy path */
  } as any,
  writer: {} as any,
  claimService: {
    claimTask: async () => ({ claimedBy: '@agent', claimedAt: '2026-07-01 09:00' }),
  } as any,
  planService: {} as any,
});

it('mode=off uses the legacy ClaimService path', async () => {
  const deps: any = {
    ...baseDeps(),
    syncConfigForRoot: async () => ({
      mode: 'off',
      ref: 'taskwright-board',
      remote: 'origin',
      pollSeconds: 20,
    }),
    claimSynced: async () => {
      throw new Error('should not be called');
    },
  };
  const res = await claimTaskHandler(deps, { taskId: 'TASK-1', claimedBy: '@agent' });
  expect(res.claimed).toBe(true);
  expect(res.surrendered).toBeUndefined();
});

it('mode=github routes to the sync engine and maps a surrender', async () => {
  const deps: any = {
    ...baseDeps(),
    syncConfigForRoot: async () => ({
      mode: 'github',
      ref: 'taskwright-board',
      remote: 'origin',
      pollSeconds: 20,
    }),
    claimSynced: async () => ({ status: 'surrendered', by: '@alice' }),
  };
  const res = await claimTaskHandler(deps, { taskId: 'TASK-1', claimedBy: '@bob' });
  expect(res).toMatchObject({
    claimed: false,
    surrendered: true,
    heldBy: '@alice',
    taskId: 'TASK-1',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- mcp-handlers`
Expected: FAIL — `syncConfigForRoot` / `claimSynced` seams and surrender mapping don't exist.

- [ ] **Step 3: Write minimal implementation**

In `src/mcp/handlers.ts`:

1. Extend the result type:

```ts
export interface ClaimResult {
  claimed: boolean;
  taskId: string;
  claimedBy?: string;
  worktree?: string;
  claimedAt?: string;
  surrendered?: boolean;
  heldBy?: string;
}
```

2. Add optional seams to `McpHandlerDeps` (near the existing fields):

```ts
  claimSynced?: (
    target: import('../core/boardSyncEngine').SyncTarget,
    taskId: string,
    claimedBy: string,
    opts?: { worktree?: string; stalenessMs?: number }
  ) => Promise<import('../core/boardSyncEngine').ClaimOutcome>;
  releaseSynced?: (
    target: import('../core/boardSyncEngine').SyncTarget,
    taskId: string
  ) => Promise<{ status: 'released' } | { status: 'failed'; reason: string }>;
  syncConfigForRoot?: (root: string) => Promise<import('../core/syncConfig').SyncConfig>;
```

3. Add default resolvers + a target builder near the top of the module:

```ts
import { readSyncConfig, syncConfigPath, type SyncConfig } from '../core/syncConfig';
import { claimTaskSynced, releaseTaskSynced, type SyncTarget } from '../core/boardSyncEngine';
import { nodeQueueFs } from '../core/mergeQueue';

async function resolveSyncConfig(deps: McpHandlerDeps): Promise<SyncConfig> {
  if (deps.syncConfigForRoot) return deps.syncConfigForRoot(deps.root);
  const exec = deps.gitExec ?? defaultGitExec;
  const commonDir = path.resolve(
    (await exec(deps.root, ['rev-parse', '--git-common-dir'])).stdout.trim()
  );
  return readSyncConfig(syncConfigPath(commonDir), nodeQueueFs);
}

function syncTargetFor(root: string, cfg: SyncConfig): SyncTarget {
  return {
    repoRoot: root,
    ref: cfg.ref,
    remote: cfg.mode === 'github' ? cfg.remote : undefined,
    indexFile: path.join(root, '.taskwright', 'board.index'),
    backlogDir: 'backlog',
  };
}
```

4. Route in `claimTaskHandler`:

```ts
export async function claimTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string; claimedBy?: string; worktree?: string }
): Promise<ClaimResult> {
  const claimedBy = args.claimedBy?.trim() || '@agent';
  const cfg = await resolveSyncConfig(deps);

  if (cfg.mode !== 'off') {
    const claim = deps.claimSynced ?? claimTaskSynced;
    const outcome = await claim(syncTargetFor(deps.root, cfg), args.taskId, claimedBy, {
      worktree: args.worktree,
    });
    if (outcome.status === 'claimed') {
      return {
        claimed: true,
        taskId: args.taskId,
        claimedBy: outcome.claim.claimedBy,
        worktree: outcome.claim.worktree,
        claimedAt: outcome.claim.claimedAt,
      };
    }
    if (outcome.status === 'surrendered') {
      return { claimed: false, taskId: args.taskId, surrendered: true, heldBy: outcome.by };
    }
    return { claimed: false, taskId: args.taskId };
  }

  const claim = await deps.claimService.claimTask(args.taskId, claimedBy, deps.parser, {
    worktree: args.worktree,
  });
  return {
    claimed: true,
    taskId: args.taskId,
    claimedBy: claim.claimedBy,
    worktree: claim.worktree,
    claimedAt: claim.claimedAt,
  };
}
```

5. Route `releaseTaskHandler` the same way (engine when `mode !== 'off'`, else `deps.claimService.releaseTask`):

```ts
export async function releaseTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<ReleaseResult> {
  const cfg = await resolveSyncConfig(deps);
  if (cfg.mode !== 'off') {
    const release = deps.releaseSynced ?? releaseTaskSynced;
    await release(syncTargetFor(deps.root, cfg), args.taskId);
    return { released: true, taskId: args.taskId };
  }
  await deps.claimService.releaseTask(args.taskId, deps.parser);
  return { released: true, taskId: args.taskId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- mcp-handlers`
Expected: PASS. Re-run the full handler suite to confirm the legacy path is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/handlers.ts src/test/unit/mcp-handlers.test.ts
git commit -m "feat(sync): MCP claim/release route through the sync engine when sync is on

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `publishSyncConfig` on activation (glue, mirrors `syncMergeConfig`)

**Files:**

- Modify: `src/extension.ts`

**Interfaces:**

- Consumes: `resolveSyncConfigFromSettings`, `writeSyncConfig`, `syncConfigPath` (Plan 3); `nodeQueueFs`; the existing `resolveCommonDir` helper in `extension.ts`.
- Produces: `publishSyncConfig(repoRoot)` — reads `taskwright.sync.*` settings and writes `sync-config.json` under the common dir, so the MCP server sees the same mode/ref/remote. Called wherever `syncMergeConfig` is already called (activation + on config change).

- [ ] **Step 1: Implement (glue — no unit test; mirror the adjacent `syncMergeConfig`)**

Add to `src/extension.ts`, next to `syncMergeConfig`:

```ts
/** Publish taskwright.sync.* to the shared config the MCP server reads. */
async function publishSyncConfig(repoRoot: string): Promise<void> {
  const commonDir = await resolveCommonDir(repoRoot);
  if (!commonDir) return;
  const cfg = vscode.workspace.getConfiguration('taskwright');
  const merged = resolveSyncConfigFromSettings({
    mode: cfg.get('sync.mode'),
    ref: cfg.get('sync.ref'),
    remote: cfg.get('sync.remote'),
    pollSeconds: cfg.get('sync.pollIntervalSeconds'),
  });
  writeSyncConfig(syncConfigPath(commonDir), merged, nodeQueueFs);
}
```

Import the three functions from `./core/syncConfig` at the top, and call `publishSyncConfig(repoRoot)` everywhere `syncMergeConfig(repoRoot)` is called (activation and the `onDidChangeConfiguration` handler). Note the manifest key `sync.pollIntervalSeconds` maps to the config field `pollSeconds`.

- [ ] **Step 2: Verify the build compiles**

Run: `bun run typecheck && bun run build`
Expected: PASS — no type errors; `dist/` builds.

- [ ] **Step 3: Commit**

```bash
git add src/extension.ts
git commit -m "feat(sync): publishSyncConfig makes sync mode visible to the MCP server

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `BoardSyncController` — reconcile, poll, status, reload

**Files:**

- Create: `src/providers/BoardSyncController.ts`
- Modify: `src/extension.ts` (register it), `src/providers/TasksController.ts` (skip cross-branch in sync mode)

**Interfaces:**

- Consumes: `readSyncConfig`/`syncConfigPath`, `reconcileBoardRef`, `compactBoardRef` (Plan 3), `refreshBoard` + `SyncTarget` (Plan 2), `resolveCommonDir` (extension).
- Produces: a disposable controller that, when `mode !== 'off'`:
  1. on start, runs `reconcileBoardRef(target)` then triggers a board reload;
  2. every `pollSeconds`, runs `refreshBoard(target)`; if `changed`, fires the board-reload callback;
  3. shows a status-bar item (`$(sync) Board: synced` / `local` / `off`, error state on push-auth failure);
  4. periodically calls `compactBoardRef(target)` (throttled — e.g. once per N polls);
  5. surfaces surrender/conflict toasts routed from claim actions.

- [ ] **Step 1: Implement the controller (vscode glue)**

Create `src/providers/BoardSyncController.ts` with a class `BoardSyncController` exposing `start()`, `dispose()`, and an injected `onBoardChanged: () => void` callback. Build the `SyncTarget` from the workspace root + resolved `SyncConfig`. Use `setInterval(pollSeconds * 1000)` for the poll; guard against overlapping runs with an `isSyncing` flag; wrap each git op in try/catch and reflect failures in the status-bar item (fall back to `local` on push-auth error, per spec §4.3). Keep all logic delegating to the Plan 2/3 cores — the controller is orchestration only.

> Because this is vscode-coupled orchestration over already-tested cores, it is verified by F5 + `visual-proof` (Step 3), consistent with this repo's UI-change convention. If any non-trivial decision logic emerges (e.g. "should compact this tick"), extract it as a pure helper with a unit test.

- [ ] **Step 2: Gate the cross-branch loader in sync mode**

In `src/providers/TasksController.ts`, where it currently sets cross-branch mode:

```ts
// Activate cross-branch mode from config — but NOT when the synced board is on
// (the board is off code branches, so there is nothing to cross-scan, and this
// is what prevents the read-only ghosts).
const syncCfg = await this.resolveSyncConfig(); // reads sync-config.json via common dir; defaults to { mode: 'off' }
if (config.check_active_branches && syncCfg.mode === 'off') {
  this.dataSourceMode = 'cross-branch';
}
```

Add a small private `resolveSyncConfig()` to `TasksController` that resolves the common dir and calls `readSyncConfig(syncConfigPath(commonDir), nodeQueueFs)`, defaulting to `DEFAULT_SYNC_CONFIG` on any error.

- [ ] **Step 3: Register + verify**

Register `BoardSyncController` in `extension.ts` (construct with the board-reload callback that refreshes the tasks views; `context.subscriptions.push` it). Then:

Run: `bun run build`, press **F5**, open a repo with `taskwright.sync.mode` set to `github`, and confirm: status-bar shows synced; a claim in one window appears in another after a poll; no `task-*` ghost cards. Capture evidence with the `visual-proof` skill.

- [ ] **Step 4: Commit**

```bash
git add src/providers/BoardSyncController.ts src/providers/TasksController.ts src/extension.ts
git commit -m "feat(sync): BoardSyncController (reconcile/poll/status) + skip cross-branch in sync mode

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `taskwright.enableSync` migration command + docs

**Files:**

- Modify: `package.json` (command contribution), `src/extension.ts` (command registration)
- Modify: `AGENTS.md`, `CLAUDE.md`, `README.md`

**Interfaces:**

- Consumes: `boardIgnoreBlock`/`applyBoardIgnore`/`boardTrackedPaths` (Task 1), `reconcileBoardRef` (Plan 3), `writeSyncConfig`/`syncConfigPath` (Plan 3), the git exec helper.
- Produces: the `taskwright.enableSync` command implementing the one-time, one-consent migration.

- [ ] **Step 1: Implement the command (glue over tested cores)**

Register `taskwright.enableSync`. Flow:

1. `vscode.window.showWarningMessage(...consent..., { modal: true }, 'Enable sync')` — the single consent gate. Explain it makes one commit that moves board tasks off code branches. Abort if not confirmed.
2. Read current `.gitignore`, write `applyBoardIgnore(existing)` back.
3. `git rm -r --cached --ignore-unmatch <boardTrackedPaths...>` in the repo root, then `git add .gitignore`, then `git commit -m "chore(taskwright): move board off code branches (synced)"`.
4. Set `taskwright.sync.mode` to the user's chosen mode (`local` or `github`) via `config.update(...)`, then `publishSyncConfig(repoRoot)`.
5. `reconcileBoardRef(target)` to seed + push the board ref.
6. Start/refresh the `BoardSyncController`, reload the board, and show a success toast.

Wrap each git step in try/catch with a clear error toast; the migration is safe to re-run (gitignore is idempotent; `rm --cached --ignore-unmatch` no-ops when already untracked; `reconcileBoardRef` is idempotent).

- [ ] **Step 2: Add the command contribution to `package.json`**

```json
{
  "command": "taskwright.enableSync",
  "title": "Taskwright: Enable Board Sync (move board off code branches)",
  "category": "Taskwright"
}
```

- [ ] **Step 3: Document**

- `AGENTS.md` / `CLAUDE.md`: add a "Synced board" note — when `taskwright.sync.mode` is `local`/`github`, board tasks live on the `taskwright-board` ref (off code branches), claims are collision-proof via atomic push, and the cross-branch view is disabled. Note the boundary: the merge queue stays per-clone (spec §8).
- `README.md`: a short "Board sync (GitHub-only, optional)" section — what it does, that it needs only push access, the one-time enable step, and the near-real-time (not instant) nature.

- [ ] **Step 4: Full gate + build + visual proof**

Run: `bun run test && bun run lint && bun run typecheck && bun run build`
Expected: PASS (minus the known ~22 Windows POSIX-path upstream failures — see `CLAUDE.md`).
Then run the `visual-proof` skill to capture the enable-sync flow and the ghost-free board for the PR.

- [ ] **Step 5: Commit**

```bash
git add package.json src/extension.ts AGENTS.md CLAUDE.md README.md
git commit -m "feat(sync): enableSync migration command + docs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (spec §5, §6, §8):**

- Route claims through the engine (UI + MCP) → Task 3 (MCP) + Task 5/6 (the UI claim path already calls the MCP/ClaimService; with sync on, `ClaimService` callers in the extension are superseded by the engine via the same `sync-config.json` gate — the UI's claim button dispatches to the MCP/controller path). _Note: if the extension has a direct (non-MCP) claim path in `dispatchActions`/`planActions`, route it through the controller too; search `claimTask(` in `src/providers` during Task 5 and thread it through the engine when `mode !== 'off'`._
- Disable cross-branch scan in sync mode + exclude the board branch → Task 2 (loader exclusion) + Task 5 (TasksController gate). **Kills the original ghost bug.**
- MCP-visible config → Task 4 `publishSyncConfig`.
- Automatic lifecycle at runtime (reconcile/poll/compact) → Task 5 `BoardSyncController`.
- One-consent off-branch migration → Task 6 `enableSync`.
- Status UI + degradation to local on auth failure → Task 5 status-bar item.
- Documented boundaries (merge queue per-clone) → Task 6 docs.

**2. Placeholder scan:** The pure cores (Tasks 1–3) have complete code. The vscode-glue tasks (4–6) describe exact call sequences and contributions rather than full listings, and are verified by build + F5 + `visual-proof` — this is deliberate and matches the repo's convention for UI/extension-host glue that can't be meaningfully unit-tested. No `TBD`/`implement later`.

**3. Type consistency:** `SyncTarget` fields match Plans 2–3. `SyncConfig` (`mode`/`ref`/`remote`/`pollSeconds`) matches Plan 3; the manifest→config mapping (`sync.pollIntervalSeconds` → `pollSeconds`) is called out in Tasks 4 and 6. `ClaimOutcome` (`claimed`/`surrendered`/`failed`) mapping to `ClaimResult` matches Plan 2's return type. `readSyncConfig`/`syncConfigPath`/`reconcileBoardRef`/`refreshBoard`/`claimTaskSynced`/`releaseTaskSynced` names match Plans 2–3 exactly.

**Open item flagged for implementation (not a plan defect):** Task 5 Self-Review note — confirm whether the extension has a **direct** (non-MCP) claim path in `src/providers` (e.g. a `ClaimService` call from a webview message handler). If so, it must also consult `sync-config.json` and route through `claimTaskSynced`, or claims made from the board UI would bypass the CAS. This is a codebase-verification step, budgeted into Task 5.

---

## Handoff

This completes the 4-plan set. Implementation proceeds Plan 1 → 2 → 3 → 4. Per the user's direction ("draft all specs and plans first, then implement"), begin implementation after this plan is committed. Execution mode (subagent-driven vs inline) is chosen at that point.
