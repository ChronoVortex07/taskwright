# Synced Board — Phase 2: `boardSyncEngine` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/core/boardSyncEngine.ts` — the fetch → materialize → check → mutate → snapshot → push **compare-and-swap** loop that makes claims collision-proof over a shared git remote, plus a `refreshBoard` for near-real-time display.

**Architecture:** A vscode-free core that depends on **injectable higher-level primitives** (`fetchRef` / `setLocalRef` / `materialize` / `snapshot` / `pushRef` / claim read-write / `findTaskFile` / `sleep` / `now`). The real defaults wire to Plan 1's `boardRef` and the existing `claims` helpers; unit tests inject fakes so the CAS logic is tested with **no git at all**. Correctness rests on `git push` being an atomic ref compare-and-swap: the loser of a race re-fetches, sees the winning claim, and surrenders.

**Tech Stack:** TypeScript, Vitest (fake-deps unit tests for the loop; real two-repo git integration test for the end-to-end guarantee).

## Where this fits

**Plan 2 of 4** from `docs/superpowers/specs/2026-07-01-github-synced-board-design.md` (spec §4). Depends on **Plan 1** (`boardRef.ts`) being merged. Do not start Plan 3/4 work here.

## Global Constraints

_Every task's requirements implicitly includes this section._

- **Runtime:** Node **≥ 22**; build/test via **Bun** (`bun run test`, `bun run lint`, `bun run typecheck`).
- **Core purity:** `src/core/boardSyncEngine.ts` must be **vscode-free**; all git and fs effects go through injectable deps. No direct `child_process` calls.
- **No blind force-push:** `pushRef` is fast-forward-only (never `--force`). A rejected push means "remote advanced" → re-fetch and retry, never overwrite.
- **Determinism:** no `Date.now()` / `Math.random()` in the core; time comes from an injected `now()` and backoff is a fixed function of attempt number.
- **Reuse, don't reinvent:** claim read/write reuses `applyClaim` / `clearClaim` / `claimTimestamp` / `isClaimStale` from `src/core/claims.ts` and the CRLF helpers from `src/core/BacklogWriter.ts`.
- **TDD:** failing test first; red; minimal implement; green; commit.
- **Commit trailer:** end each commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (workers substitute their own model line per `AGENTS.md`).

---

## File Structure

- **Modify** `src/core/claims.ts` — add a pure `readClaim(content)` parser (the inverse of `applyClaim`).
- **Modify** `src/core/boardRef.ts` — add remote/ref helpers `setLocalRef`, `fetchRef`, `pushRef` (git-ref operations belong with the other ref plumbing).
- **Create** `src/core/boardSyncEngine.ts` — `findTaskFile`, the injectable `SyncEngineDeps` + real defaults, the CAS loop, and `claimTaskSynced` / `releaseTaskSynced` / `refreshBoard`.
- **Modify** `src/test/unit/claims.test.ts` — `readClaim` tests.
- **Modify** `src/test/unit/boardRef.test.ts` — remote-helper integration tests (origin + clone).
- **Create** `src/test/unit/boardSyncEngine.test.ts` — fake-deps CAS unit tests + one real two-repo integration test.

---

## Task 1: `readClaim` — parse a claim out of task content (pure)

**Files:**

- Modify: `src/core/claims.ts`
- Test: `src/test/unit/claims.test.ts`

**Interfaces:**

- Consumes: `splitFrontmatter` (`src/core/frontmatterEdit.ts`), `Claim` (this file).
- Produces: `export function readClaim(content: string): Claim | undefined` — returns the claim from a task file's frontmatter, or `undefined` when there is no `claimed_by`. The inverse of `applyClaim`.

- [ ] **Step 1: Write the failing test**

Append to `src/test/unit/claims.test.ts`:

```ts
import { readClaim, applyClaim } from '../../core/claims';

describe('readClaim', () => {
  const base = ['---', 'id: TASK-1', 'title: X', 'status: To Do', '---', '', 'body', ''].join('\n');

  it('returns undefined when there is no claim', () => {
    expect(readClaim(base)).toBeUndefined();
  });

  it('reads back a claim written by applyClaim', () => {
    const claimed = applyClaim(base, {
      claimedBy: '@alice',
      worktree: 'task-1-x',
      claimedAt: '2026-07-01 09:30',
    });
    expect(readClaim(claimed)).toEqual({
      claimedBy: '@alice',
      worktree: 'task-1-x',
      claimedAt: '2026-07-01 09:30',
    });
  });

  it('omits worktree when absent', () => {
    const claimed = applyClaim(base, { claimedBy: '@bob', claimedAt: '2026-07-01 10:00' });
    expect(readClaim(claimed)).toEqual({ claimedBy: '@bob', claimedAt: '2026-07-01 10:00' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- claims`
Expected: FAIL — `readClaim` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/core/claims.ts`:

```ts
/** Unquote a frontmatter scalar: strips matching single/double quotes and unescapes doubled single-quotes. */
function unquote(value: string): string {
  const v = value.trim();
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

/**
 * Parse the claim from a task file's frontmatter, or undefined when unclaimed.
 * The inverse of {@link applyClaim}.
 */
export function readClaim(content: string): Claim | undefined {
  const split = splitFrontmatter(content);
  if (!split) return undefined;
  let claimedBy: string | undefined;
  let worktree: string | undefined;
  let claimedAt: string | undefined;
  for (const line of split.fields) {
    const m = line.match(/^(claimed_by|worktree|claimed_at):(.*)$/);
    if (!m) continue;
    const val = unquote(m[2]);
    if (m[1] === 'claimed_by') claimedBy = val;
    else if (m[1] === 'worktree') worktree = val;
    else claimedAt = val;
  }
  if (!claimedBy) return undefined;
  return { claimedBy, claimedAt: claimedAt ?? '', ...(worktree ? { worktree } : {}) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- claims`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/claims.ts src/test/unit/claims.test.ts
git commit -m "feat(claims): readClaim parser (inverse of applyClaim)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Remote/ref helpers on `boardRef` — `setLocalRef`, `fetchRef`, `pushRef`

**Files:**

- Modify: `src/core/boardRef.ts`
- Test: `src/test/unit/boardRef.test.ts`

**Interfaces:**

- Consumes: `qualifyRef`, `BoardGitExec`, `defaultBoardExec` (Plan 1).
- Produces:
  - `export function setLocalRef(repoRoot: string, ref: string, sha: string, exec?: BoardGitExec): Promise<void>` — `git update-ref <qualified> <sha>`.
  - `export function fetchRef(repoRoot: string, remote: string, ref: string, exec?: BoardGitExec): Promise<string | null>` — `git fetch <remote> <ref>`; returns the fetched remote tip (via `FETCH_HEAD`), or `null` when the remote has no such ref.
  - `export interface PushResult { ok: boolean; rejected: boolean; stderr: string }`
  - `export function pushRef(repoRoot: string, remote: string, ref: string, exec?: BoardGitExec): Promise<PushResult>` — `git push <remote> <qualified>:<qualified>` (fast-forward only). `rejected` is true on a non-fast-forward rejection; other failures set `ok:false, rejected:false`.

- [ ] **Step 1: Write the failing test**

Add to `src/test/unit/boardRef.test.ts` a two-repo helper and tests. First append this helper near the top-level (after imports):

```ts
import { setLocalRef, fetchRef, pushRef } from '../../core/boardRef';
import { execFile as _execFile } from 'child_process';
import { promisify as _promisify } from 'util';
const execFileAsync2 = _promisify(_execFile);

/** Make `origin` a bare repo and `clone` a working clone of it, both in tmp. */
async function makeOriginAndClone(): Promise<{
  origin: string;
  clone: TempRepo;
  cleanup: () => void;
}> {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-origin-'));
  await execFileAsync2('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const clone = await makeTempGitRepo();
  await clone.git(['remote', 'add', 'origin', origin]);
  await clone.git(['push', '-q', 'origin', 'main']);
  return {
    origin,
    clone,
    cleanup: () => {
      clone.cleanup();
      fs.rmSync(origin, { recursive: true, force: true });
    },
  };
}
```

(Add `os` and `fs` imports at the top of the test file if not already present.)

Then append:

```ts
describe('remote ref helpers', () => {
  let origin: string;
  let clone: TempRepo;
  let cleanup: () => void;
  const indexFile = () => path.join(clone.root, '.taskwright', 'board.index');

  beforeEach(async () => {
    ({ origin, clone, cleanup } = await makeOriginAndClone());
    clone.addGitignore(['backlog/tasks/']);
    clone.writeFile('backlog/tasks/task-1 - A.md', 'A\n');
  });
  afterEach(() => cleanup());

  it('setLocalRef points a ref at a sha', async () => {
    const head = await clone.headSha();
    await setLocalRef(clone.root, 'taskwright-board', head, defaultBoardExec);
    expect(await refTip(clone.root, 'taskwright-board', defaultBoardExec)).toBe(head);
  });

  it('fetchRef returns null when origin lacks the ref, sha once it exists', async () => {
    expect(await fetchRef(clone.root, 'origin', 'taskwright-board', defaultBoardExec)).toBeNull();

    const { commit } = await snapshotBoardToRef({
      repoRoot: clone.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'seed',
      exec: defaultBoardExec,
    });
    const push = await pushRef(clone.root, 'origin', 'taskwright-board', defaultBoardExec);
    expect(push.ok).toBe(true);

    expect(await fetchRef(clone.root, 'origin', 'taskwright-board', defaultBoardExec)).toBe(commit);
  });

  it('pushRef reports a non-fast-forward rejection', async () => {
    // Seed origin from clone A.
    await snapshotBoardToRef({
      repoRoot: clone.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 's1',
      exec: defaultBoardExec,
    });
    await pushRef(clone.root, 'origin', 'taskwright-board', defaultBoardExec);

    // Second clone advances origin.
    const cloneB = await makeTempGitRepo();
    await cloneB.git(['remote', 'add', 'origin', origin]);
    await cloneB.git(['fetch', '-q', 'origin', 'taskwright-board']);
    await setLocalRef(
      cloneB.root,
      'taskwright-board',
      (await fetchRef(cloneB.root, 'origin', 'taskwright-board', defaultBoardExec))!,
      defaultBoardExec
    );
    cloneB.addGitignore(['backlog/tasks/']);
    cloneB.writeFile('backlog/tasks/task-2 - B.md', 'B\n');
    await snapshotBoardToRef({
      repoRoot: cloneB.root,
      ref: 'taskwright-board',
      indexFile: path.join(cloneB.root, '.taskwright/board.index'),
      message: 's2',
      parent: (await refTip(cloneB.root, 'taskwright-board', defaultBoardExec)) ?? undefined,
      exec: defaultBoardExec,
    });
    await pushRef(cloneB.root, 'origin', 'taskwright-board', defaultBoardExec);

    // Clone A makes a divergent commit on the OLD base and pushes → rejected.
    clone.writeFile('backlog/tasks/task-3 - C.md', 'C\n');
    await snapshotBoardToRef({
      repoRoot: clone.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 's3',
      parent: (await refTip(clone.root, 'taskwright-board', defaultBoardExec)) ?? undefined,
      exec: defaultBoardExec,
    });
    const push = await pushRef(clone.root, 'origin', 'taskwright-board', defaultBoardExec);
    expect(push.ok).toBe(false);
    expect(push.rejected).toBe(true);

    cloneB.cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- boardRef`
Expected: FAIL — `setLocalRef` / `fetchRef` / `pushRef` are not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/core/boardRef.ts`:

```ts
/** Point a local ref at `sha` (`git update-ref`). */
export async function setLocalRef(
  repoRoot: string,
  ref: string,
  sha: string,
  exec: BoardGitExec = defaultBoardExec
): Promise<void> {
  await exec(repoRoot, ['update-ref', qualifyRef(ref), sha]);
}

/**
 * Fetch `ref` from `remote` and return the fetched remote tip, or null when the
 * remote does not have the ref. Does not move any local branch itself.
 */
export async function fetchRef(
  repoRoot: string,
  remote: string,
  ref: string,
  exec: BoardGitExec = defaultBoardExec
): Promise<string | null> {
  try {
    await exec(repoRoot, ['fetch', '--quiet', remote, qualifyRef(ref)]);
  } catch {
    return null; // remote has no such ref (or unreachable)
  }
  try {
    const { stdout } = await exec(repoRoot, ['rev-parse', '--verify', '--quiet', 'FETCH_HEAD']);
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

export interface PushResult {
  ok: boolean;
  rejected: boolean;
  stderr: string;
}

/** Push `ref` to `remote` fast-forward-only; `rejected` marks a non-ff rejection. */
export async function pushRef(
  repoRoot: string,
  remote: string,
  ref: string,
  exec: BoardGitExec = defaultBoardExec
): Promise<PushResult> {
  const q = qualifyRef(ref);
  try {
    const { stderr } = await exec(repoRoot, ['push', remote, `${q}:${q}`]);
    return { ok: true, rejected: false, stderr: stderr ?? '' };
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    const stderr = String(err.stderr ?? err.message ?? '');
    const rejected = /\b(rejected|non-fast-forward|fetch first|stale info)\b/i.test(stderr);
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
git commit -m "feat(boardRef): setLocalRef, fetchRef, pushRef (ff-only) remote helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `findTaskFile` — locate a task's file in the board (helper)

**Files:**

- Create: `src/core/boardSyncEngine.ts`
- Test: `src/test/unit/boardSyncEngine.test.ts`

**Interfaces:**

- Consumes: `BOARD_SUBDIRS` (Plan 1, currently only `tasks` is scanned for claims).
- Produces: `export function findTaskFile(repoRoot: string, backlogDir: string, taskId: string): string | null` — absolute path of the file in `<backlogDir>/tasks` whose ID prefix (`^[A-Za-z]+-\d+(?:\.\d+)*`) uppercases to `taskId`, or `null`.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/boardSyncEngine.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findTaskFile } from '../../core/boardSyncEngine';

describe('findTaskFile', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-find-'));
    fs.mkdirSync(path.join(root, 'backlog', 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'backlog', 'tasks', 'task-1 - A.md'), 'A');
    fs.writeFileSync(path.join(root, 'backlog', 'tasks', 'task-12 - Long.md'), 'B');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('finds the file whose id prefix matches the task id (case-insensitive)', () => {
    expect(findTaskFile(root, 'backlog', 'TASK-1')).toBe(
      path.join(root, 'backlog', 'tasks', 'task-1 - A.md')
    );
    expect(findTaskFile(root, 'backlog', 'TASK-12')).toBe(
      path.join(root, 'backlog', 'tasks', 'task-12 - Long.md')
    );
  });

  it('returns null when no file matches', () => {
    expect(findTaskFile(root, 'backlog', 'TASK-99')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- boardSyncEngine`
Expected: FAIL — module/`findTaskFile` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/boardSyncEngine.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';

/** Absolute path of the task file whose id prefix equals `taskId`, else null. */
export function findTaskFile(repoRoot: string, backlogDir: string, taskId: string): string | null {
  const dir = path.join(repoRoot, backlogDir, 'tasks');
  if (!fs.existsSync(dir)) return null;
  const want = taskId.toUpperCase();
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const m = name.match(/^([a-zA-Z]+-\d+(?:\.\d+)*)/);
    if (m && m[1].toUpperCase() === want) return path.join(dir, name);
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- boardSyncEngine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/boardSyncEngine.ts src/test/unit/boardSyncEngine.test.ts
git commit -m "feat(sync): findTaskFile helper for the board working copy

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: The CAS loop + `claimTaskSynced`

**Files:**

- Modify: `src/core/boardSyncEngine.ts`
- Test: `src/test/unit/boardSyncEngine.test.ts`

**Interfaces:**

- Consumes: `findTaskFile` (Task 3); `Claim`, `claimTimestamp`, `isClaimStale`, `applyClaim`, `clearClaim`, `readClaim` (`src/core/claims.ts`); `detectCRLF`, `normalizeToLF`, `restoreLineEndings` (`src/core/BacklogWriter.ts`); `setLocalRef`, `fetchRef`, `pushRef`, `refTip`, `materializeRefToWorktree`, `snapshotBoardToRef` (`src/core/boardRef.ts`).
- Produces:
  - `export interface SyncTarget { repoRoot: string; ref: string; remote?: string; indexFile: string; backlogDir?: string }`
  - `export type ClaimOutcome = { status: 'claimed'; claim: Claim } | { status: 'surrendered'; by: string } | { status: 'failed'; reason: string }`
  - `export interface SyncEngineDeps { fetchRef; setLocalRef; refTip; materialize; snapshot; pushRef; readTaskClaim; writeClaimToFile; clearClaimInFile; findTaskFile; sleep; now }` (exact member signatures in Step 3)
  - `export const defaultSyncEngineDeps: SyncEngineDeps`
  - `export const MAX_SYNC_ATTEMPTS = 5`
  - `export function claimTaskSynced(target: SyncTarget, taskId: string, claimedBy: string, opts?: { worktree?: string; stalenessMs?: number; deps?: Partial<SyncEngineDeps> }): Promise<ClaimOutcome>`

- [ ] **Step 1: Write the failing test**

Append to `src/test/unit/boardSyncEngine.test.ts`:

```ts
import {
  claimTaskSynced,
  MAX_SYNC_ATTEMPTS,
  type SyncEngineDeps,
  type SyncTarget,
} from '../../core/boardSyncEngine';
import type { Claim } from '../../core/claims';

const TARGET: SyncTarget = {
  repoRoot: '/repo',
  ref: 'taskwright-board',
  remote: 'origin',
  indexFile: '/repo/.taskwright/board.index',
  backlogDir: 'backlog',
};

/** Build fully-faked deps; each test overrides only what it needs. */
function fakeDeps(over: Partial<SyncEngineDeps> = {}): SyncEngineDeps {
  let claimOnDisk: Claim | undefined;
  return {
    fetchRef: async () => 'remote-tip',
    setLocalRef: async () => {},
    refTip: async () => 'remote-tip',
    materialize: async () => {},
    snapshot: async () => ({ commit: 'new-commit' }),
    pushRef: async () => ({ ok: true, rejected: false, stderr: '' }),
    readTaskClaim: () => claimOnDisk,
    writeClaimToFile: (_f, c) => {
      claimOnDisk = c;
    },
    clearClaimInFile: () => {
      claimOnDisk = undefined;
    },
    findTaskFile: () => '/repo/backlog/tasks/task-1 - A.md',
    sleep: async () => {},
    now: () => new Date('2026-07-01T09:00:00Z'),
    ...over,
  };
}

describe('claimTaskSynced', () => {
  it('claims a free task and returns claimed', async () => {
    const out = await claimTaskSynced(TARGET, 'TASK-1', '@alice', { deps: fakeDeps() });
    expect(out.status).toBe('claimed');
    if (out.status === 'claimed') expect(out.claim.claimedBy).toBe('@alice');
  });

  it('surrenders when someone else already holds a live claim', async () => {
    const deps = fakeDeps({
      readTaskClaim: () => ({ claimedBy: '@bob', claimedAt: '2026-07-01 08:59' }),
    });
    const out = await claimTaskSynced(TARGET, 'TASK-1', '@alice', {
      stalenessMs: 60 * 60 * 1000,
      deps,
    });
    expect(out).toEqual({ status: 'surrendered', by: '@bob' });
  });

  it('reclaims a STALE foreign claim (past staleness window)', async () => {
    const deps = fakeDeps({
      readTaskClaim: () => ({ claimedBy: '@bob', claimedAt: '2026-06-01 08:00' }),
    });
    const out = await claimTaskSynced(TARGET, 'TASK-1', '@alice', {
      stalenessMs: 60 * 60 * 1000,
      deps,
    });
    expect(out.status).toBe('claimed');
  });

  it('retries on a rejected push, then succeeds', async () => {
    let pushes = 0;
    const deps = fakeDeps({
      pushRef: async () => {
        pushes += 1;
        return pushes === 1
          ? { ok: false, rejected: true, stderr: 'non-fast-forward' }
          : { ok: true, rejected: false, stderr: '' };
      },
    });
    const out = await claimTaskSynced(TARGET, 'TASK-1', '@alice', { deps });
    expect(out.status).toBe('claimed');
    expect(pushes).toBe(2);
  });

  it('surrenders if the race winner claimed the task before our retry', async () => {
    let pushes = 0;
    let claim: Claim | undefined;
    const deps = fakeDeps({
      readTaskClaim: () => claim,
      writeClaimToFile: (_f, c) => {
        claim = c;
      },
      pushRef: async () => {
        pushes += 1;
        if (pushes === 1) {
          // Simulate the winner's claim landing on the remote before our retry.
          claim = { claimedBy: '@winner', claimedAt: '2026-07-01 09:00' };
          return { ok: false, rejected: true, stderr: 'rejected' };
        }
        return { ok: true, rejected: false, stderr: '' };
      },
    });
    const out = await claimTaskSynced(TARGET, 'TASK-1', '@alice', {
      stalenessMs: 60 * 60 * 1000,
      deps,
    });
    expect(out).toEqual({ status: 'surrendered', by: '@winner' });
  });

  it('fails after MAX_SYNC_ATTEMPTS of persistent rejection', async () => {
    const deps = fakeDeps({
      pushRef: async () => ({ ok: false, rejected: true, stderr: 'rejected' }),
    });
    const out = await claimTaskSynced(TARGET, 'TASK-1', '@alice', { deps });
    expect(out.status).toBe('failed');
  });

  it('returns failed when the task file is missing', async () => {
    const deps = fakeDeps({ findTaskFile: () => null });
    const out = await claimTaskSynced(TARGET, 'TASK-1', '@alice', { deps });
    expect(out).toEqual({ status: 'failed', reason: 'Task TASK-1 not found on the board' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- boardSyncEngine`
Expected: FAIL — `claimTaskSynced` / `MAX_SYNC_ATTEMPTS` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/core/boardSyncEngine.ts` (imports at top):

```ts
import {
  applyClaim,
  clearClaim,
  claimTimestamp,
  isClaimStale,
  readClaim,
  type Claim,
} from './claims';
import { detectCRLF, normalizeToLF, restoreLineEndings } from './BacklogWriter';
import {
  fetchRef as realFetchRef,
  setLocalRef as realSetLocalRef,
  refTip as realRefTip,
  pushRef as realPushRef,
  materializeRefToWorktree,
  snapshotBoardToRef,
} from './boardRef';
```

```ts
export interface SyncTarget {
  repoRoot: string;
  ref: string;
  /** When omitted, the engine works local-only (no fetch/push). */
  remote?: string;
  indexFile: string;
  backlogDir?: string;
}

export type ClaimOutcome =
  | { status: 'claimed'; claim: Claim }
  | { status: 'surrendered'; by: string }
  | { status: 'failed'; reason: string };

export interface SyncEngineDeps {
  fetchRef: (repoRoot: string, remote: string, ref: string) => Promise<string | null>;
  setLocalRef: (repoRoot: string, ref: string, sha: string) => Promise<void>;
  refTip: (repoRoot: string, ref: string) => Promise<string | null>;
  materialize: (target: SyncTarget) => Promise<void>;
  snapshot: (args: {
    repoRoot: string;
    ref: string;
    indexFile: string;
    message: string;
    parent?: string;
    backlogDir?: string;
  }) => Promise<{ commit: string }>;
  pushRef: (
    repoRoot: string,
    remote: string,
    ref: string
  ) => Promise<{ ok: boolean; rejected: boolean; stderr: string }>;
  readTaskClaim: (filePath: string) => Claim | undefined;
  writeClaimToFile: (filePath: string, claim: Claim) => void;
  clearClaimInFile: (filePath: string) => void;
  findTaskFile: (repoRoot: string, backlogDir: string, taskId: string) => string | null;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

export const MAX_SYNC_ATTEMPTS = 5;

function rewriteFile(filePath: string, transform: (content: string) => string): void {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const hadCRLF = detectCRLF(raw);
  const updated = transform(normalizeToLF(raw));
  fs.writeFileSync(filePath, restoreLineEndings(updated, hadCRLF), 'utf-8');
}

export const defaultSyncEngineDeps: SyncEngineDeps = {
  fetchRef: (r, remote, ref) => realFetchRef(r, remote, ref),
  setLocalRef: (r, ref, sha) => realSetLocalRef(r, ref, sha),
  refTip: (r, ref) => realRefTip(r, ref),
  materialize: (t) =>
    materializeRefToWorktree({
      repoRoot: t.repoRoot,
      ref: t.ref,
      indexFile: t.indexFile,
      backlogDir: t.backlogDir,
    }).then(() => undefined),
  snapshot: (a) => snapshotBoardToRef(a).then((r) => ({ commit: r.commit })),
  pushRef: (r, remote, ref) => realPushRef(r, remote, ref),
  readTaskClaim: (filePath) => {
    try {
      return readClaim(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return undefined;
    }
  },
  writeClaimToFile: (filePath, claim) => rewriteFile(filePath, (c) => applyClaim(c, claim)),
  clearClaimInFile: (filePath) => rewriteFile(filePath, clearClaim),
  findTaskFile,
  sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  now: () => new Date(),
};

/** Fixed, deterministic backoff: 25ms, 50ms, 100ms, ... capped. */
function backoffMs(attempt: number): number {
  return Math.min(25 * 2 ** (attempt - 1), 500);
}

/** Sync the local ref to the remote head (if any) and materialize; returns the base sha. */
async function syncToRemoteBase(
  target: SyncTarget,
  d: SyncEngineDeps
): Promise<string | undefined> {
  let base = (await d.refTip(target.repoRoot, target.ref)) ?? undefined;
  if (target.remote) {
    const remoteTip = await d.fetchRef(target.repoRoot, target.remote, target.ref);
    if (remoteTip) {
      await d.setLocalRef(target.repoRoot, target.ref, remoteTip);
      base = remoteTip;
    }
  }
  await d.materialize(target);
  return base;
}

export async function claimTaskSynced(
  target: SyncTarget,
  taskId: string,
  claimedBy: string,
  opts: { worktree?: string; stalenessMs?: number; deps?: Partial<SyncEngineDeps> } = {}
): Promise<ClaimOutcome> {
  const d: SyncEngineDeps = { ...defaultSyncEngineDeps, ...opts.deps };
  const backlogDir = target.backlogDir ?? 'backlog';
  const stalenessMs = opts.stalenessMs ?? Number.POSITIVE_INFINITY;

  for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
    const base = await syncToRemoteBase(target, d);

    const file = d.findTaskFile(target.repoRoot, backlogDir, taskId);
    if (!file) return { status: 'failed', reason: `Task ${taskId} not found on the board` };

    const existing = d.readTaskClaim(file);
    if (
      existing &&
      existing.claimedBy !== claimedBy &&
      !isClaimStale(existing.claimedAt, stalenessMs, d.now().getTime())
    ) {
      return { status: 'surrendered', by: existing.claimedBy };
    }

    const claim: Claim = {
      claimedBy,
      claimedAt: claimTimestamp(d.now()),
      ...(opts.worktree ? { worktree: opts.worktree } : {}),
    };
    d.writeClaimToFile(file, claim);
    await d.snapshot({
      repoRoot: target.repoRoot,
      ref: target.ref,
      indexFile: target.indexFile,
      message: `claim ${taskId} by ${claimedBy}`,
      parent: base,
      backlogDir,
    });

    if (!target.remote) return { status: 'claimed', claim };

    const push = await d.pushRef(target.repoRoot, target.remote, target.ref);
    if (push.ok) return { status: 'claimed', claim };
    if (!push.rejected) return { status: 'failed', reason: push.stderr || 'push failed' };

    await d.sleep(backoffMs(attempt)); // remote advanced — re-fetch and retry
  }
  return { status: 'failed', reason: 'exhausted retries (remote kept advancing)' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- boardSyncEngine`
Expected: PASS (all `claimTaskSynced` cases).

- [ ] **Step 5: Commit**

```bash
git add src/core/boardSyncEngine.ts src/test/unit/boardSyncEngine.test.ts
git commit -m "feat(sync): claimTaskSynced CAS loop (surrender/retry/stale-reclaim)

- fetch -> setLocalRef -> materialize -> check -> claim -> snapshot -> push
- surrenders to a live foreign claim, reclaims a stale one
- retries on non-ff rejection; deterministic backoff, injectable deps

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `releaseTaskSynced` + `refreshBoard`

**Files:**

- Modify: `src/core/boardSyncEngine.ts`
- Test: `src/test/unit/boardSyncEngine.test.ts`

**Interfaces:**

- Consumes: everything from Task 4.
- Produces:
  - `export function releaseTaskSynced(target: SyncTarget, taskId: string, opts?: { deps?: Partial<SyncEngineDeps> }): Promise<{ status: 'released' } | { status: 'failed'; reason: string }>` — same CAS loop, mutation = clear claim, no surrender check.
  - `export function refreshBoard(target: SyncTarget, opts?: { deps?: Partial<SyncEngineDeps> }): Promise<{ changed: boolean }>` — fetch; if the remote tip differs from the local ref, fast-forward the local ref and materialize; `changed` reflects whether the working copy was updated.

- [ ] **Step 1: Write the failing test**

Append to `src/test/unit/boardSyncEngine.test.ts`:

```ts
import { releaseTaskSynced, refreshBoard } from '../../core/boardSyncEngine';

describe('releaseTaskSynced', () => {
  it('clears the claim and pushes', async () => {
    let claim: Claim | undefined = { claimedBy: '@alice', claimedAt: '2026-07-01 09:00' };
    const out = await releaseTaskSynced(TARGET, 'TASK-1', {
      deps: fakeDeps({
        readTaskClaim: () => claim,
        clearClaimInFile: () => {
          claim = undefined;
        },
      }),
    });
    expect(out).toEqual({ status: 'released' });
    expect(claim).toBeUndefined();
  });
});

describe('refreshBoard', () => {
  it('materializes when the remote tip advanced', async () => {
    let materialized = 0;
    const out = await refreshBoard(TARGET, {
      deps: fakeDeps({
        refTip: async () => 'old',
        fetchRef: async () => 'new',
        materialize: async () => {
          materialized += 1;
        },
      }),
    });
    expect(out).toEqual({ changed: true });
    expect(materialized).toBe(1);
  });

  it('does nothing when local already matches the remote tip', async () => {
    let materialized = 0;
    const out = await refreshBoard(TARGET, {
      deps: fakeDeps({
        refTip: async () => 'same',
        fetchRef: async () => 'same',
        materialize: async () => {
          materialized += 1;
        },
      }),
    });
    expect(out).toEqual({ changed: false });
    expect(materialized).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- boardSyncEngine`
Expected: FAIL — `releaseTaskSynced` / `refreshBoard` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/core/boardSyncEngine.ts`:

```ts
export async function releaseTaskSynced(
  target: SyncTarget,
  taskId: string,
  opts: { deps?: Partial<SyncEngineDeps> } = {}
): Promise<{ status: 'released' } | { status: 'failed'; reason: string }> {
  const d: SyncEngineDeps = { ...defaultSyncEngineDeps, ...opts.deps };
  const backlogDir = target.backlogDir ?? 'backlog';

  for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
    const base = await syncToRemoteBase(target, d);

    const file = d.findTaskFile(target.repoRoot, backlogDir, taskId);
    if (!file) return { status: 'failed', reason: `Task ${taskId} not found on the board` };

    d.clearClaimInFile(file);
    await d.snapshot({
      repoRoot: target.repoRoot,
      ref: target.ref,
      indexFile: target.indexFile,
      message: `release ${taskId}`,
      parent: base,
      backlogDir,
    });

    if (!target.remote) return { status: 'released' };
    const push = await d.pushRef(target.repoRoot, target.remote, target.ref);
    if (push.ok) return { status: 'released' };
    if (!push.rejected) return { status: 'failed', reason: push.stderr || 'push failed' };
    await d.sleep(backoffMs(attempt));
  }
  return { status: 'failed', reason: 'exhausted retries (remote kept advancing)' };
}

/** Fetch and, if the remote advanced, fast-forward the local ref and materialize. */
export async function refreshBoard(
  target: SyncTarget,
  opts: { deps?: Partial<SyncEngineDeps> } = {}
): Promise<{ changed: boolean }> {
  const d: SyncEngineDeps = { ...defaultSyncEngineDeps, ...opts.deps };
  const local = await d.refTip(target.repoRoot, target.ref);
  if (!target.remote) return { changed: false };

  const remoteTip = await d.fetchRef(target.repoRoot, target.remote, target.ref);
  if (!remoteTip || remoteTip === local) return { changed: false };

  await d.setLocalRef(target.repoRoot, target.ref, remoteTip);
  await d.materialize(target);
  return { changed: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- boardSyncEngine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/boardSyncEngine.ts src/test/unit/boardSyncEngine.test.ts
git commit -m "feat(sync): releaseTaskSynced + refreshBoard (poll fast-forward)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: End-to-end two-clone integration — the anti-double-claim proof

**Files:**

- Test: `src/test/unit/boardSyncEngine.test.ts`

**Interfaces:**

- Consumes: `claimTaskSynced` with **real** default deps; `makeTempGitRepo` (Plan 1 helper) + a bare origin.
- Produces: no new exports — the load-bearing proof that two real clones cannot both hold the same claim.

- [ ] **Step 1: Write the failing/again-passing test**

Append to `src/test/unit/boardSyncEngine.test.ts`:

```ts
import { execFile as _ef } from 'child_process';
import { promisify as _pr } from 'util';
import { makeTempGitRepo, type TempRepo } from './helpers/tempGitRepo';
import { snapshotBoardToRef, pushRef, fetchRef, setLocalRef, refTip } from '../../core/boardRef';
const efAsync = _pr(_ef);

describe('two-clone anti-double-claim (integration)', () => {
  let origin: string;
  let a: TempRepo;
  let b: TempRepo;

  beforeEach(async () => {
    origin = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-origin-'));
    await efAsync('git', ['init', '-q', '--bare', '-b', 'main', origin]);

    a = await makeTempGitRepo();
    await a.git(['remote', 'add', 'origin', origin]);
    await a.git(['push', '-q', 'origin', 'main']);
    a.addGitignore(['backlog/tasks/']);
    a.writeFile('backlog/tasks/task-1 - A.md', '---\nid: TASK-1\ntitle: A\nstatus: To Do\n---\n');

    // Seed the board ref from A and push it.
    await snapshotBoardToRef({
      repoRoot: a.root,
      ref: 'taskwright-board',
      indexFile: path.join(a.root, '.taskwright/board.index'),
      message: 'seed',
    });
    await pushRef(a.root, 'origin', 'taskwright-board');

    // B clones the same origin and syncs the board ref.
    b = await makeTempGitRepo();
    await b.git(['remote', 'add', 'origin', origin]);
    await setLocalRef(
      b.root,
      'taskwright-board',
      (await fetchRef(b.root, 'origin', 'taskwright-board'))!
    );
  });

  afterEach(() => {
    a.cleanup();
    b.cleanup();
    fs.rmSync(origin, { recursive: true, force: true });
  });

  it('the second claimant surrenders to the first', async () => {
    const target = (root: string) => ({
      repoRoot: root,
      ref: 'taskwright-board',
      remote: 'origin',
      indexFile: path.join(root, '.taskwright/board.index'),
      backlogDir: 'backlog',
    });

    const first = await claimTaskSynced(target(a.root), 'TASK-1', '@alice', {
      stalenessMs: 60 * 60 * 1000,
    });
    expect(first.status).toBe('claimed');

    const second = await claimTaskSynced(target(b.root), 'TASK-1', '@bob', {
      stalenessMs: 60 * 60 * 1000,
    });
    expect(second).toEqual({ status: 'surrendered', by: '@alice' });
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun run test -- boardSyncEngine`
Expected: PASS — B fetches A's pushed claim and surrenders. If it FAILS, the CAS is broken; fix the engine, do not weaken the test.

- [ ] **Step 3: Run the full gate**

Run: `bun run test && bun run lint && bun run typecheck`
Expected: PASS (minus the known ~22 Windows POSIX-path upstream failures — see `CLAUDE.md`).

- [ ] **Step 4: Commit**

```bash
git add src/test/unit/boardSyncEngine.test.ts
git commit -m "test(sync): two-clone integration proves no double-claim over a shared remote

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (spec §4):**

- Fetch → check → write → snapshot → push CAS loop → Task 4 `claimTaskSynced`.
- Surrender to live claim / reclaim stale claim → Task 4 (uses `isClaimStale`).
- Retry on non-ff rejection with backoff → Task 4 (`pushRef.rejected` → `sleep(backoffMs)`).
- Race winner observed on retry → Task 4 test "surrenders if the race winner claimed…".
- Release + near-real-time poll → Task 5 `releaseTaskSynced` / `refreshBoard`.
- Local-only (offline) mode → `target.remote` undefined short-circuits fetch/push in Tasks 4–5.
- Collision-proof over a real shared remote → Task 6 integration.
- Deferred to later plans (correctly out of scope): same-task edit conflict last-writer-wins UI (Plan 4), settings/mode resolution + reconcile/compact (Plan 3), MCP/ClaimService/loader wire-in (Plan 4).

**2. Placeholder scan:** none — every step has complete code.

**3. Type consistency:** `SyncTarget`, `ClaimOutcome`, `SyncEngineDeps`, `claimTaskSynced`, `releaseTaskSynced`, `refreshBoard`, `MAX_SYNC_ATTEMPTS`, `findTaskFile`, `defaultSyncEngineDeps` are named identically across tasks and tests. The `pushRef` return shape `{ ok, rejected, stderr }` matches Task 2's `PushResult`. `readClaim` return shape matches `Claim` (Task 1). `snapshot` dep signature matches Plan 1's `snapshotBoardToRef` options subset.

No issues found.

---

## Handoff

This is a planning artifact. Implementation happens after Plans 3 and 4 are drafted (per the user's "draft all specs and plans first, then implement"). Execution mode (subagent-driven vs inline) is chosen once implementation begins.
