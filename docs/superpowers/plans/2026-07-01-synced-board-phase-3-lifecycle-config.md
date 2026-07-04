# Synced Board — Phase 3: `syncConfig` + `boardLifecycle` Implementation Plan

> **Superseded by Board Sync v2** — see
> [`docs/superpowers/specs/2026-07-04-board-sync-v2-single-shared-board-design.md`](../specs/2026-07-04-board-sync-v2-single-shared-board-design.md).
> `syncConfig.ts` was **repurposed** to the v2 `off | git` mode set, but `boardLifecycle.ts`'s live
> reconcile/poll + compaction (built here) was **deleted outright** once its own callers were
> repointed. Kept for historical context only; do not execute this plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the two pieces that make the synced board self-managing: `src/core/syncConfig.ts` (a shared, MCP-readable settings file, mirroring `mergeConfig.ts`) and `src/core/boardLifecycle.ts` (automatic create/seed/fetch/push reconciliation of the board ref, plus throttled history compaction).

**Architecture:** `syncConfig` is a pure settings model persisted under the git common dir (`<commonDir>/taskwright/sync-config.json`) so both the extension and the out-of-process MCP server read the same source of truth — exactly the pattern `mergeConfig` already uses. `boardLifecycle` composes Plan 1/2 primitives into an idempotent `reconcileBoardRef` (a five-case matrix over local-tip × remote-tip) and a `compactBoardRef` that rewrites the disposable board history via a **lease-guarded** force-push (never a blind force).

**Tech Stack:** TypeScript, Vitest (pure model tests for `syncConfig`; fake-deps matrix tests for `boardLifecycle`).

## Where this fits

**Plan 3 of 4** from `docs/superpowers/specs/2026-07-01-github-synced-board-design.md` (spec §6). Depends on **Plans 1–2**. Do not start Plan 4 (wire-in/UI/migration) here.

### Spec refinement recorded here

Spec §8 says "never force-push the board ref." Compaction (§6) rewrites the disposable board history and therefore _must_ rewrite the ref. This plan refines the rule precisely: **no blind `--force`; compaction uses `--force-with-lease`** (a compare-and-swap on the expected old tip), so it can never clobber a concurrent writer — a lease-failed compaction simply aborts and retries next cycle. This is consistent with the spec's intent ("disposable state, safe to rewrite") and preserves the anti-clobber guarantee.

## Global Constraints

_Every task's requirements implicitly includes this section._

- **Runtime:** Node **≥ 22**; build/test via **Bun** (`bun run test`, `bun run lint`, `bun run typecheck`).
- **Core purity:** both new modules are **vscode-free**; effects via injectable deps / `QueueFsDeps`.
- **MCP-readable config:** `syncConfig` persists to `<commonDir>/taskwright/sync-config.json` (same directory as `merge-queue.json` / `merge-config.json`) so the MCP server reads it with no vscode dependency.
- **No blind force-push:** compaction uses `--force-with-lease=<ref>:<expectedOldTip>` only.
- **Reuse:** `QueueFsDeps` / `nodeQueueFs` (`src/core/mergeQueue.ts`); `SyncTarget` (`src/core/boardSyncEngine.ts`); ref primitives (`src/core/boardRef.ts`).
- **TDD:** failing test first; red; minimal implement; green; commit.
- **Commit trailer:** end each commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (workers substitute their own model line per `AGENTS.md`).

---

## File Structure

- **Create** `src/core/syncConfig.ts` — `SyncMode`, `SyncConfig`, `DEFAULT_SYNC_CONFIG`, `syncConfigPath`, `resolveSyncConfigFromSettings`, `readSyncConfig`, `writeSyncConfig` (mirrors `src/core/mergeConfig.ts`).
- **Modify** `src/core/boardRef.ts` — add `isAncestor`, `revCount`, `commitTreeRoot`, `pushRefForceWithLease`.
- **Create** `src/core/boardLifecycle.ts` — `reconcileBoardRef`, `compactBoardRef`, injectable `LifecycleDeps` + defaults.
- **Modify** `package.json` — `taskwright.sync.*` settings.
- **Create** `src/test/unit/syncConfig.test.ts`.
- **Modify** `src/test/unit/boardRef.test.ts` — tests for the four new ref helpers.
- **Create** `src/test/unit/boardLifecycle.test.ts`.
- **Modify** `src/test/unit/configDefaults.test.ts` — assert the new manifest defaults (create the file if it does not exist, mirroring the existing manifest-reading pattern).

---

## Task 1: `syncConfig` — shared settings model (mirror `mergeConfig`)

**Files:**

- Create: `src/core/syncConfig.ts`
- Test: `src/test/unit/syncConfig.test.ts`

**Interfaces:**

- Consumes: `QueueFsDeps` (`src/core/mergeQueue.ts`).
- Produces:
  - `export type SyncMode = 'off' | 'local' | 'github'`
  - `export interface SyncConfig { mode: SyncMode; ref: string; remote: string; pollSeconds: number }`
  - `export const DEFAULT_SYNC_CONFIG: SyncConfig` = `{ mode: 'off', ref: 'taskwright-board', remote: 'origin', pollSeconds: 20 }`
  - `export function syncConfigPath(commonDir: string): string` → `<commonDir>/taskwright/sync-config.json`
  - `export function resolveSyncConfigFromSettings(raw: { mode?: unknown; ref?: unknown; remote?: unknown; pollSeconds?: unknown }): SyncConfig`
  - `export function readSyncConfig(filePath: string, fsDeps: Pick<QueueFsDeps, 'exists' | 'read'>): SyncConfig`
  - `export function writeSyncConfig(filePath: string, config: SyncConfig, fsDeps: Pick<QueueFsDeps, 'writeAtomic'>): void`

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/syncConfig.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SYNC_CONFIG,
  syncConfigPath,
  resolveSyncConfigFromSettings,
  readSyncConfig,
  writeSyncConfig,
  type SyncConfig,
} from '../../core/syncConfig';
import type { QueueFsDeps } from '../../core/mergeQueue';

function memFs(seed: Record<string, string> = {}): QueueFsDeps & { store: Record<string, string> } {
  const store = { ...seed };
  return {
    store,
    exists: (p) => p in store,
    read: (p) => store[p],
    writeAtomic: (p, data) => {
      store[p] = data;
    },
  };
}

describe('syncConfig', () => {
  it('path is under the common dir taskwright folder', () => {
    expect(syncConfigPath('/repo/.git')).toBe(
      '/repo/.git/taskwright/sync-config.json'.replace(/\//g, require('path').sep)
    );
  });

  it('defaults to off with the canonical ref/remote/poll', () => {
    expect(DEFAULT_SYNC_CONFIG).toEqual({
      mode: 'off',
      ref: 'taskwright-board',
      remote: 'origin',
      pollSeconds: 20,
    });
  });

  it('coerces partial/invalid settings to defaults', () => {
    expect(resolveSyncConfigFromSettings({ mode: 'github', ref: 'my-board' })).toEqual({
      mode: 'github',
      ref: 'my-board',
      remote: 'origin',
      pollSeconds: 20,
    });
    expect(resolveSyncConfigFromSettings({ mode: 'bogus', pollSeconds: -3 })).toEqual(
      DEFAULT_SYNC_CONFIG
    );
  });

  it('round-trips through read/write; missing file → defaults', () => {
    const fsd = memFs();
    expect(readSyncConfig('/x/sync-config.json', fsd)).toEqual(DEFAULT_SYNC_CONFIG);
    const cfg: SyncConfig = { mode: 'local', ref: 'b', remote: 'upstream', pollSeconds: 30 };
    writeSyncConfig('/x/sync-config.json', cfg, fsd);
    expect(readSyncConfig('/x/sync-config.json', fsd)).toEqual(cfg);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- syncConfig`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/syncConfig.ts` (mirroring `src/core/mergeConfig.ts`):

```ts
import * as path from 'path';
import type { QueueFsDeps } from './mergeQueue';

export type SyncMode = 'off' | 'local' | 'github';

export interface SyncConfig {
  mode: SyncMode;
  ref: string;
  remote: string;
  pollSeconds: number;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  mode: 'off',
  ref: 'taskwright-board',
  remote: 'origin',
  pollSeconds: 20,
};

export function syncConfigPath(commonDir: string): string {
  return path.join(commonDir, 'taskwright', 'sync-config.json');
}

function isSyncMode(v: unknown): v is SyncMode {
  return v === 'off' || v === 'local' || v === 'github';
}

function coerceString(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : fallback;
}

function coercePoll(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 5
    ? v
    : DEFAULT_SYNC_CONFIG.pollSeconds;
}

export function resolveSyncConfigFromSettings(raw: {
  mode?: unknown;
  ref?: unknown;
  remote?: unknown;
  pollSeconds?: unknown;
}): SyncConfig {
  return {
    mode: isSyncMode(raw.mode) ? raw.mode : DEFAULT_SYNC_CONFIG.mode,
    ref: coerceString(raw.ref, DEFAULT_SYNC_CONFIG.ref),
    remote: coerceString(raw.remote, DEFAULT_SYNC_CONFIG.remote),
    pollSeconds: coercePoll(raw.pollSeconds),
  };
}

export function readSyncConfig(
  filePath: string,
  fsDeps: Pick<QueueFsDeps, 'exists' | 'read'>
): SyncConfig {
  if (!fsDeps.exists(filePath)) return resolveSyncConfigFromSettings({});
  try {
    return resolveSyncConfigFromSettings(JSON.parse(fsDeps.read(filePath)));
  } catch {
    return resolveSyncConfigFromSettings({});
  }
}

export function writeSyncConfig(
  filePath: string,
  config: SyncConfig,
  fsDeps: Pick<QueueFsDeps, 'writeAtomic'>
): void {
  fsDeps.writeAtomic(filePath, `${JSON.stringify(config, null, 2)}\n`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- syncConfig`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/syncConfig.ts src/test/unit/syncConfig.test.ts
git commit -m "feat(sync): syncConfig shared settings model (MCP-readable, mirrors mergeConfig)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Ref-relation helpers on `boardRef` — `isAncestor`, `revCount`, `commitTreeRoot`, `pushRefForceWithLease`

**Files:**

- Modify: `src/core/boardRef.ts`
- Test: `src/test/unit/boardRef.test.ts`

**Interfaces:**

- Consumes: `qualifyRef`, `BoardGitExec`, `defaultBoardExec`, `PushResult` (Plans 1–2).
- Produces:
  - `export function isAncestor(repoRoot: string, maybeAncestor: string, descendant: string, exec?: BoardGitExec): Promise<boolean>` — `git merge-base --is-ancestor` (exit 0 ⇒ true).
  - `export function revCount(repoRoot: string, ref: string, exec?: BoardGitExec): Promise<number>` — `git rev-list --count <qualified>`; `0` when the ref is absent.
  - `export function commitTreeRoot(repoRoot: string, ref: string, message: string, exec?: BoardGitExec): Promise<string>` — `git commit-tree <qualified>^{tree} -m <message>` (a new **parentless** commit wrapping the ref's current tree). Returns the new commit sha.
  - `export function pushRefForceWithLease(repoRoot: string, remote: string, ref: string, expectedOldTip: string, exec?: BoardGitExec): Promise<PushResult>` — `git push --force-with-lease=<qualified>:<expectedOldTip> <remote> <qualified>:<qualified>`; `rejected` set on a stale-lease/rejection.

- [ ] **Step 1: Write the failing test**

Append to `src/test/unit/boardRef.test.ts`:

```ts
import { isAncestor, revCount, commitTreeRoot } from '../../core/boardRef';

describe('ref-relation helpers', () => {
  let repo: TempRepo;
  const indexFile = () => path.join(repo.root, '.taskwright', 'board.index');
  beforeEach(async () => {
    repo = await makeTempGitRepo();
    repo.addGitignore(['backlog/tasks/']);
    repo.writeFile('backlog/tasks/task-1 - A.md', 'A\n');
  });
  afterEach(() => repo.cleanup());

  it('revCount is 0 for a missing ref and grows per snapshot', async () => {
    expect(await revCount(repo.root, 'taskwright-board', defaultBoardExec)).toBe(0);
    const c1 = await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 's1',
      exec: defaultBoardExec,
    });
    expect(await revCount(repo.root, 'taskwright-board', defaultBoardExec)).toBe(1);
    repo.writeFile('backlog/tasks/task-2 - B.md', 'B\n');
    await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 's2',
      parent: c1.commit,
      exec: defaultBoardExec,
    });
    expect(await revCount(repo.root, 'taskwright-board', defaultBoardExec)).toBe(2);
  });

  it('isAncestor reflects the commit chain', async () => {
    const c1 = await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 's1',
      exec: defaultBoardExec,
    });
    repo.writeFile('backlog/tasks/task-2 - B.md', 'B\n');
    const c2 = await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 's2',
      parent: c1.commit,
      exec: defaultBoardExec,
    });
    expect(await isAncestor(repo.root, c1.commit, c2.commit, defaultBoardExec)).toBe(true);
    expect(await isAncestor(repo.root, c2.commit, c1.commit, defaultBoardExec)).toBe(false);
  });

  it('commitTreeRoot wraps the ref tree in a parentless commit', async () => {
    await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 's1',
      exec: defaultBoardExec,
    });
    const root = await commitTreeRoot(repo.root, 'taskwright-board', 'compact', defaultBoardExec);
    const parents = (await repo.git(['rev-list', '--parents', '-n', '1', root])).trim().split(' ');
    expect(parents).toHaveLength(1); // no parents
    // same tree as the ref
    const refTree = (await repo.git(['rev-parse', 'refs/heads/taskwright-board^{tree}'])).trim();
    const rootTree = (await repo.git(['rev-parse', `${root}^{tree}`])).trim();
    expect(rootTree).toBe(refTree);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- boardRef`
Expected: FAIL — the four helpers are not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/core/boardRef.ts`:

```ts
/** True when `maybeAncestor` is an ancestor of (or equal to) `descendant`. */
export async function isAncestor(
  repoRoot: string,
  maybeAncestor: string,
  descendant: string,
  exec: BoardGitExec = defaultBoardExec
): Promise<boolean> {
  try {
    await exec(repoRoot, ['merge-base', '--is-ancestor', maybeAncestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/** Number of commits reachable from `ref`; 0 when the ref does not exist. */
export async function revCount(
  repoRoot: string,
  ref: string,
  exec: BoardGitExec = defaultBoardExec
): Promise<number> {
  try {
    const { stdout } = await exec(repoRoot, ['rev-list', '--count', qualifyRef(ref)]);
    return Number.parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/** Create a new parentless commit wrapping `ref`'s current tree (for compaction). */
export async function commitTreeRoot(
  repoRoot: string,
  ref: string,
  message: string,
  exec: BoardGitExec = defaultBoardExec
): Promise<string> {
  const { stdout } = await exec(repoRoot, [
    'commit-tree',
    `${qualifyRef(ref)}^{tree}`,
    '-m',
    message,
  ]);
  return stdout.trim();
}

/** Force-push `ref` with a lease on `expectedOldTip` (safe CAS force; never blind). */
export async function pushRefForceWithLease(
  repoRoot: string,
  remote: string,
  ref: string,
  expectedOldTip: string,
  exec: BoardGitExec = defaultBoardExec
): Promise<PushResult> {
  const q = qualifyRef(ref);
  try {
    const { stderr } = await exec(repoRoot, [
      'push',
      `--force-with-lease=${q}:${expectedOldTip}`,
      remote,
      `${q}:${q}`,
    ]);
    return { ok: true, rejected: false, stderr: stderr ?? '' };
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    const stderr = String(err.stderr ?? err.message ?? '');
    const rejected = /\b(rejected|stale info|non-fast-forward|fetch first)\b/i.test(stderr);
    return { ok: false, rejected, stderr };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- boardRef`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/boardRef.ts src/test/unit/boardRef.test.ts
git commit -m "feat(boardRef): isAncestor, revCount, commitTreeRoot, pushRefForceWithLease

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `reconcileBoardRef` — the automatic setup/heal matrix

**Files:**

- Create: `src/core/boardLifecycle.ts`
- Test: `src/test/unit/boardLifecycle.test.ts`

**Interfaces:**

- Consumes: `SyncTarget` (`src/core/boardSyncEngine.ts`); `refTip`, `fetchRef`, `setLocalRef`, `pushRef`, `isAncestor`, `snapshotBoardToRef`, `materializeRefToWorktree` (`src/core/boardRef.ts`).
- Produces:
  - `export type ReconcileAction = 'created' | 'fetched' | 'pushed' | 'reset-to-remote' | 'noop'`
  - `export interface LifecycleDeps { refTip; fetchRef; setLocalRef; pushRef; isAncestor; snapshot; materialize; revCount; commitTreeRoot; pushForceWithLease }` (signatures in Step 3)
  - `export const defaultLifecycleDeps: LifecycleDeps`
  - `export function reconcileBoardRef(target: SyncTarget, opts?: { deps?: Partial<LifecycleDeps> }): Promise<{ action: ReconcileAction }>` — idempotent reconciliation of local-tip × remote-tip.

**Matrix** (local `L`, remote `R`; `R` only consulted when `target.remote` is set):

| L   | R                   | Action                                                                          |
| --- | ------------------- | ------------------------------------------------------------------------------- |
| —   | —                   | `created` — snapshot the current working-copy board (no parent), push if remote |
| —   | ✓                   | `fetched` — `setLocalRef(R)`, materialize                                       |
| ✓   | —                   | `pushed` — push local to remote (or `noop` when no remote)                      |
| ✓   | =L                  | `noop`                                                                          |
| ✓   | ≠L, L ancestor of R | `fetched` — fast-forward to R, materialize                                      |
| ✓   | ≠L, R ancestor of L | `pushed`                                                                        |
| ✓   | ≠L, diverged        | `reset-to-remote` — `setLocalRef(R)`, materialize (prefer shared remote)        |

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/boardLifecycle.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { reconcileBoardRef, type LifecycleDeps } from '../../core/boardLifecycle';
import type { SyncTarget } from '../../core/boardSyncEngine';

const TARGET: SyncTarget = {
  repoRoot: '/repo',
  ref: 'taskwright-board',
  remote: 'origin',
  indexFile: '/repo/.taskwright/board.index',
  backlogDir: 'backlog',
};

function deps(over: Partial<LifecycleDeps> = {}): Partial<LifecycleDeps> {
  return {
    refTip: async () => null,
    fetchRef: async () => null,
    setLocalRef: async () => {},
    pushRef: async () => ({ ok: true, rejected: false, stderr: '' }),
    isAncestor: async () => false,
    snapshot: async () => ({ commit: 'seed' }),
    materialize: async () => {},
    ...over,
  };
}

describe('reconcileBoardRef', () => {
  it('creates + pushes when neither local nor remote exists', async () => {
    let snapped = 0;
    let pushed = 0;
    const out = await reconcileBoardRef(TARGET, {
      deps: deps({
        snapshot: async () => {
          snapped += 1;
          return { commit: 'seed' };
        },
        pushRef: async () => {
          pushed += 1;
          return { ok: true, rejected: false, stderr: '' };
        },
      }),
    });
    expect(out).toEqual({ action: 'created' });
    expect(snapped).toBe(1);
    expect(pushed).toBe(1);
  });

  it('fetches when only the remote exists', async () => {
    let materialized = 0;
    const out = await reconcileBoardRef(TARGET, {
      deps: deps({
        refTip: async () => null,
        fetchRef: async () => 'R',
        materialize: async () => {
          materialized += 1;
        },
      }),
    });
    expect(out).toEqual({ action: 'fetched' });
    expect(materialized).toBe(1);
  });

  it('pushes when only local exists', async () => {
    const out = await reconcileBoardRef(TARGET, {
      deps: deps({ refTip: async () => 'L', fetchRef: async () => null }),
    });
    expect(out).toEqual({ action: 'pushed' });
  });

  it('noop when local equals remote', async () => {
    const out = await reconcileBoardRef(TARGET, {
      deps: deps({ refTip: async () => 'X', fetchRef: async () => 'X' }),
    });
    expect(out).toEqual({ action: 'noop' });
  });

  it('fast-forwards when local is an ancestor of remote', async () => {
    const out = await reconcileBoardRef(TARGET, {
      deps: deps({
        refTip: async () => 'L',
        fetchRef: async () => 'R',
        isAncestor: async (_r, a, b) => a === 'L' && b === 'R',
      }),
    });
    expect(out).toEqual({ action: 'fetched' });
  });

  it('resets to remote when the two diverged', async () => {
    const out = await reconcileBoardRef(TARGET, {
      deps: deps({
        refTip: async () => 'L',
        fetchRef: async () => 'R',
        isAncestor: async () => false,
      }),
    });
    expect(out).toEqual({ action: 'reset-to-remote' });
  });

  it('local-only target: creates without pushing', async () => {
    const out = await reconcileBoardRef(
      { ...TARGET, remote: undefined },
      { deps: deps({ refTip: async () => null }) }
    );
    expect(out).toEqual({ action: 'created' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- boardLifecycle`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/boardLifecycle.ts`:

```ts
import type { SyncTarget } from './boardSyncEngine';
import {
  refTip as realRefTip,
  fetchRef as realFetchRef,
  setLocalRef as realSetLocalRef,
  pushRef as realPushRef,
  isAncestor as realIsAncestor,
  revCount as realRevCount,
  commitTreeRoot as realCommitTreeRoot,
  pushRefForceWithLease as realPushForceWithLease,
  snapshotBoardToRef,
  materializeRefToWorktree,
} from './boardRef';

export type ReconcileAction = 'created' | 'fetched' | 'pushed' | 'reset-to-remote' | 'noop';

export interface LifecycleDeps {
  refTip: (repoRoot: string, ref: string) => Promise<string | null>;
  fetchRef: (repoRoot: string, remote: string, ref: string) => Promise<string | null>;
  setLocalRef: (repoRoot: string, ref: string, sha: string) => Promise<void>;
  pushRef: (
    repoRoot: string,
    remote: string,
    ref: string
  ) => Promise<{ ok: boolean; rejected: boolean; stderr: string }>;
  isAncestor: (repoRoot: string, a: string, b: string) => Promise<boolean>;
  snapshot: (args: {
    repoRoot: string;
    ref: string;
    indexFile: string;
    message: string;
    parent?: string;
    backlogDir?: string;
  }) => Promise<{ commit: string }>;
  materialize: (target: SyncTarget) => Promise<void>;
  revCount: (repoRoot: string, ref: string) => Promise<number>;
  commitTreeRoot: (repoRoot: string, ref: string, message: string) => Promise<string>;
  pushForceWithLease: (
    repoRoot: string,
    remote: string,
    ref: string,
    expectedOldTip: string
  ) => Promise<{ ok: boolean; rejected: boolean; stderr: string }>;
}

export const defaultLifecycleDeps: LifecycleDeps = {
  refTip: (r, ref) => realRefTip(r, ref),
  fetchRef: (r, remote, ref) => realFetchRef(r, remote, ref),
  setLocalRef: (r, ref, sha) => realSetLocalRef(r, ref, sha),
  pushRef: (r, remote, ref) => realPushRef(r, remote, ref),
  isAncestor: (r, a, b) => realIsAncestor(r, a, b),
  snapshot: (a) => snapshotBoardToRef(a).then((x) => ({ commit: x.commit })),
  materialize: (t) =>
    materializeRefToWorktree({
      repoRoot: t.repoRoot,
      ref: t.ref,
      indexFile: t.indexFile,
      backlogDir: t.backlogDir,
    }).then(() => undefined),
  revCount: (r, ref) => realRevCount(r, ref),
  commitTreeRoot: (r, ref, m) => realCommitTreeRoot(r, ref, m),
  pushForceWithLease: (r, remote, ref, tip) => realPushForceWithLease(r, remote, ref, tip),
};

export async function reconcileBoardRef(
  target: SyncTarget,
  opts: { deps?: Partial<LifecycleDeps> } = {}
): Promise<{ action: ReconcileAction }> {
  const d: LifecycleDeps = { ...defaultLifecycleDeps, ...opts.deps };
  const local = await d.refTip(target.repoRoot, target.ref);
  const remote = target.remote
    ? await d.fetchRef(target.repoRoot, target.remote, target.ref)
    : null;

  // neither exists → seed from the working copy
  if (!local && !remote) {
    await d.snapshot({
      repoRoot: target.repoRoot,
      ref: target.ref,
      indexFile: target.indexFile,
      message: 'seed board',
      backlogDir: target.backlogDir,
    });
    if (target.remote) await d.pushRef(target.repoRoot, target.remote, target.ref);
    return { action: 'created' };
  }

  // only remote exists → adopt it
  if (!local && remote) {
    await d.setLocalRef(target.repoRoot, target.ref, remote);
    await d.materialize(target);
    return { action: 'fetched' };
  }

  // only local exists → publish it
  if (local && !remote) {
    if (target.remote) await d.pushRef(target.repoRoot, target.remote, target.ref);
    return { action: 'pushed' };
  }

  // both exist
  if (local === remote) return { action: 'noop' };
  if (await d.isAncestor(target.repoRoot, local!, remote!)) {
    await d.setLocalRef(target.repoRoot, target.ref, remote!);
    await d.materialize(target);
    return { action: 'fetched' };
  }
  if (await d.isAncestor(target.repoRoot, remote!, local!)) {
    await d.pushRef(target.repoRoot, target.remote!, target.ref);
    return { action: 'pushed' };
  }
  // diverged → prefer the shared remote
  await d.setLocalRef(target.repoRoot, target.ref, remote!);
  await d.materialize(target);
  return { action: 'reset-to-remote' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- boardLifecycle`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/boardLifecycle.ts src/test/unit/boardLifecycle.test.ts
git commit -m "feat(sync): reconcileBoardRef auto setup/heal matrix

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `compactBoardRef` — throttled, lease-guarded history squash

**Files:**

- Modify: `src/core/boardLifecycle.ts`
- Test: `src/test/unit/boardLifecycle.test.ts`

**Interfaces:**

- Consumes: `LifecycleDeps` (Task 3), `SyncTarget`.
- Produces:
  - `export const DEFAULT_COMPACT_THRESHOLD = 200`
  - `export function compactBoardRef(target: SyncTarget, opts?: { maxCommits?: number; deps?: Partial<LifecycleDeps> }): Promise<{ squashed: boolean }>` — when `revCount(ref) > maxCommits`, replace history with a single parentless commit of the current tree (`commitTreeRoot`), `setLocalRef` to it, and `pushForceWithLease(expectedOldTip = the pre-compaction remote tip)`. A stale lease (someone pushed meanwhile) aborts without squashing. Below threshold: no-op.

- [ ] **Step 1: Write the failing test**

Append to `src/test/unit/boardLifecycle.test.ts`:

```ts
import { compactBoardRef, DEFAULT_COMPACT_THRESHOLD } from '../../core/boardLifecycle';

describe('compactBoardRef', () => {
  it('does nothing below the threshold', async () => {
    const out = await compactBoardRef(TARGET, {
      maxCommits: 200,
      deps: deps({ revCount: async () => 10 }),
    });
    expect(out).toEqual({ squashed: false });
  });

  it('squashes with a lease-guarded force-push above the threshold', async () => {
    let leaseTip: string | undefined;
    const out = await compactBoardRef(TARGET, {
      maxCommits: 200,
      deps: deps({
        revCount: async () => 500,
        fetchRef: async () => 'REMOTE_TIP',
        commitTreeRoot: async () => 'ROOT',
        setLocalRef: async () => {},
        pushForceWithLease: async (_r, _rem, _ref, tip) => {
          leaseTip = tip;
          return { ok: true, rejected: false, stderr: '' };
        },
      }),
    });
    expect(out).toEqual({ squashed: true });
    expect(leaseTip).toBe('REMOTE_TIP'); // lease is on the observed remote tip
  });

  it('aborts (no squash) when the lease is stale', async () => {
    const out = await compactBoardRef(TARGET, {
      maxCommits: 200,
      deps: deps({
        revCount: async () => 500,
        fetchRef: async () => 'REMOTE_TIP',
        commitTreeRoot: async () => 'ROOT',
        pushForceWithLease: async () => ({ ok: false, rejected: true, stderr: 'stale info' }),
      }),
    });
    expect(out).toEqual({ squashed: false });
  });

  it('exposes a sane default threshold', () => {
    expect(DEFAULT_COMPACT_THRESHOLD).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- boardLifecycle`
Expected: FAIL — `compactBoardRef` / `DEFAULT_COMPACT_THRESHOLD` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/core/boardLifecycle.ts`:

```ts
export const DEFAULT_COMPACT_THRESHOLD = 200;

/**
 * When the board history exceeds `maxCommits`, replace it with a single
 * parentless commit of the current tree, published via a lease-guarded
 * force-push (never a blind force). A stale lease aborts without squashing.
 */
export async function compactBoardRef(
  target: SyncTarget,
  opts: { maxCommits?: number; deps?: Partial<LifecycleDeps> } = {}
): Promise<{ squashed: boolean }> {
  const d: LifecycleDeps = { ...defaultLifecycleDeps, ...opts.deps };
  const maxCommits = opts.maxCommits ?? DEFAULT_COMPACT_THRESHOLD;

  if ((await d.revCount(target.repoRoot, target.ref)) <= maxCommits) return { squashed: false };

  // The lease is on the current remote tip so a concurrent push aborts us.
  const leaseTip = target.remote
    ? ((await d.fetchRef(target.repoRoot, target.remote, target.ref)) ?? '')
    : '';

  const root = await d.commitTreeRoot(target.repoRoot, target.ref, 'compact board history');
  await d.setLocalRef(target.repoRoot, target.ref, root);

  if (!target.remote) return { squashed: true };

  const push = await d.pushForceWithLease(target.repoRoot, target.remote, target.ref, leaseTip);
  return { squashed: push.ok };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- boardLifecycle`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/boardLifecycle.ts src/test/unit/boardLifecycle.test.ts
git commit -m "feat(sync): compactBoardRef (throttled, lease-guarded squash)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `taskwright.sync.*` settings + manifest-default test

**Files:**

- Modify: `package.json`
- Modify/Create: `src/test/unit/configDefaults.test.ts`

**Interfaces:**

- Consumes: nothing (manifest + test).
- Produces: manifest settings `taskwright.sync.mode` / `taskwright.sync.ref` / `taskwright.sync.remote` / `taskwright.sync.pollIntervalSeconds`, whose defaults match `DEFAULT_SYNC_CONFIG` (Task 1). Plan 4 reads these to publish `sync-config.json`.

- [ ] **Step 1: Write the failing test**

If `src/test/unit/configDefaults.test.ts` exists, append; otherwise create it (mirror the existing manifest-reading pattern — a static import of `package.json`):

```ts
import { describe, it, expect } from 'vitest';
import manifest from '../../../package.json';

describe('taskwright.sync.* manifest defaults', () => {
  const props = (manifest as any).contributes.configuration.properties as Record<string, any>;

  it('sync.mode defaults to off with the three modes', () => {
    expect(props['taskwright.sync.mode'].default).toBe('off');
    expect(props['taskwright.sync.mode'].enum).toEqual(['off', 'local', 'github']);
  });

  it('sync.ref / sync.remote / sync.pollIntervalSeconds match DEFAULT_SYNC_CONFIG', () => {
    expect(props['taskwright.sync.ref'].default).toBe('taskwright-board');
    expect(props['taskwright.sync.remote'].default).toBe('origin');
    expect(props['taskwright.sync.pollIntervalSeconds'].default).toBe(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- configDefaults`
Expected: FAIL — the `taskwright.sync.*` properties do not exist yet.

- [ ] **Step 3: Add the settings to `package.json`**

Insert into `contributes.configuration.properties` (alongside the other `taskwright.*` settings):

```json
"taskwright.sync.mode": {
  "type": "string",
  "enum": ["off", "local", "github"],
  "default": "off",
  "markdownDescription": "How the Taskwright board is stored and shared. `off` (default): tasks are committed to your code branches as today. `local`: the board lives on a dedicated local ref (off your code branches) — kills cross-branch read-only ghosts, no sync. `github`: additionally push/pull that ref to a shared remote for near-real-time, collision-proof multi-user claims. Enable via the board's **Enable sync** action, which performs the one-time off-branch migration."
},
"taskwright.sync.ref": {
  "type": "string",
  "default": "taskwright-board",
  "markdownDescription": "Name of the dedicated orphan branch that stores the synced board (kept off your code branches). Change only if it collides with an existing branch."
},
"taskwright.sync.remote": {
  "type": "string",
  "default": "origin",
  "markdownDescription": "Git remote used to share the board when `taskwright.sync.mode` is `github`. Uses your existing push credentials — no separate account or service."
},
"taskwright.sync.pollIntervalSeconds": {
  "type": "number",
  "default": 20,
  "minimum": 5,
  "markdownDescription": "How often (seconds) Taskwright fetches the shared board ref to show teammates' changes. Claims are collision-proof the instant they happen (atomic push); this only controls display latency."
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- configDefaults`
Expected: PASS.

- [ ] **Step 5: Run the full gate**

Run: `bun run test && bun run lint && bun run typecheck`
Expected: PASS (minus the known ~22 Windows POSIX-path upstream failures — see `CLAUDE.md`).

- [ ] **Step 6: Commit**

```bash
git add package.json src/test/unit/configDefaults.test.ts
git commit -m "feat(sync): taskwright.sync.* settings (mode/ref/remote/poll) + default test

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (spec §6):**

- Shared, MCP-readable config → Task 1 (`syncConfig` under the common dir, mirrors `mergeConfig`).
- Automatic create/seed/fetch/push reconciliation → Task 3 `reconcileBoardRef` (full matrix incl. local-only).
- Self-healing (ref missing on one side; divergence) → Task 3 matrix rows (`fetched`, `pushed`, `reset-to-remote`).
- History compaction, throttled and non-destructive → Task 4 `compactBoardRef` (lease-guarded, threshold-gated) + the §8 refinement note.
- Opt-in default `off` + settings → Task 5 manifest + `DEFAULT_SYNC_CONFIG.mode = 'off'`.
- Deferred to Plan 4 (correctly out of scope): publishing settings → `sync-config.json` on activation, the migration command, MCP/loader/UI wire-in.

**2. Placeholder scan:** none.

**3. Type consistency:** `SyncTarget` is imported from `boardSyncEngine` (same shape used in Plan 2). `LifecycleDeps.pushRef`/`pushForceWithLease` return `{ ok, rejected, stderr }` matching Plan 2's `PushResult`. `snapshot` dep signature matches `snapshotBoardToRef`'s option subset (identical to Plan 2's engine dep). `SyncConfig` field names (`mode`/`ref`/`remote`/`pollSeconds`) match `resolveSyncConfigFromSettings` and the manifest keys (`mode`/`ref`/`remote`/`pollIntervalSeconds` → mapped in Plan 4). Note for Plan 4: the manifest key `pollIntervalSeconds` maps to the config field `pollSeconds` during publish.

No issues found.

---

## Handoff

Planning artifact. Implementation begins after Plan 4 is drafted (per "draft all specs and plans first, then implement").
