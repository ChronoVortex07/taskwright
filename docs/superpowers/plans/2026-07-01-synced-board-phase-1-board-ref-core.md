# Synced Board — Phase 1: `boardRef` core Implementation Plan

> **Superseded by Board Sync v2** — see
> [`docs/superpowers/specs/2026-07-04-board-sync-v2-single-shared-board-design.md`](../specs/2026-07-04-board-sync-v2-single-shared-board-design.md).
> The `boardRef.ts` primitives this plan built were **reused**, but the CAS engine they fed (Phase 2)
> was retired. Kept for historical context only; do not execute this plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/core/boardRef.ts` — the git-plumbing primitive that snapshots the board subdirectories onto a dedicated ref and materializes that ref back into the working copy, **without ever touching the user's HEAD, index, or working branch**.

**Architecture:** A vscode-free pure core with an injectable git-exec dependency (matching `WorktreeService` / `mergeQueue`). All git work happens through an **isolated index** (`GIT_INDEX_FILE`) so the user's real staging area and branch are never disturbed. Snapshotting uses `read-tree --empty` → `add -f` → `write-tree` → `commit-tree` → `update-ref`; materializing uses `read-tree` → `checkout-index` plus a prune of local board files absent from the ref.

**Tech Stack:** TypeScript, Node `child_process.execFile`, Vitest (integration tests against real throwaway git repos in `os.tmpdir()`).

## Where this fits (the 4-plan decomposition)

This is **Plan 1 of 4** from `docs/superpowers/specs/2026-07-01-github-synced-board-design.md`:

1. **`boardRef` core (this plan)** — isolated-index snapshot + materialize primitives.
2. `boardSyncEngine` — fetch → rebase → push compare-and-swap claim/release/edit/refresh loop, built on Plan 1.
3. `boardLifecycle` + `syncConfig` — automatic create/seed/heal/compact reconciliation + settings.
4. Wire-in + UI — route `ClaimService`/MCP through the engine, disable the cross-branch loader in sync mode, `BoardSyncController` status UI, and the one-time off-branch migration prompt.

Each plan produces working, tested software on its own. Do not start Plan 2 work here.

## Global Constraints

_Every task's requirements implicitly include this section._

- **Runtime:** Node **≥ 22**; build/test via **Bun** (`bun run test`, `bun run lint`, `bun run typecheck`).
- **Core purity:** `src/core/boardRef.ts` must be **vscode-free** and take an **injectable git-exec** dependency; no direct `child_process` calls except inside the exported default adapter.
- **Never touch user git state:** no `git checkout`, `commit`, `reset`, `add` against the real index, `branch`, or `switch` on the primary repo. Every plumbing call sets `GIT_INDEX_FILE` to the caller-supplied isolated index path.
- **Board subdirs only:** the ref must contain exactly `backlog/tasks`, `backlog/drafts`, `backlog/completed`, `backlog/archive` — never `backlog/config.yml`, `backlog/docs`, `backlog/decisions`, `backlog/milestones`.
- **Ignored files must still snapshot:** board subdirs will be git-ignored (Plan 4), so all staging uses `git add --force`.
- **Cross-platform paths:** always `path.join` / `path.posix` as appropriate; never hand-concatenate with `/` or `\`. (Note: ~22 upstream unit tests assert POSIX paths and fail on Windows by design — see `CLAUDE.md`. Do not "fix" the code to match them.)
- **TDD:** write the failing test first; run it red; implement minimally; run it green; commit.
- **Commit trailer:** end each commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (workers substitute their own model line per `AGENTS.md`).

---

## File Structure

- **Create** `src/core/boardRef.ts` — the entire Phase 1 core (exec type + default adapter, ref helpers, `snapshotBoardToRef`, `materializeRefToWorktree`).
- **Create** `src/test/unit/helpers/tempGitRepo.ts` — a reusable throwaway-git-repo builder for integration tests.
- **Create** `src/test/unit/boardRef.test.ts` — all Phase 1 tests.

No existing files are modified in Phase 1 (wire-in is Plan 4).

---

## Task 1: Ref-name and qualify helpers (pure)

**Files:**

- Create: `src/core/boardRef.ts`
- Test: `src/test/unit/boardRef.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `export const DEFAULT_BOARD_REF = 'taskwright-board'` (string)
  - `export const BOARD_SUBDIRS: readonly string[]` = `['tasks', 'drafts', 'completed', 'archive']`
  - `export function qualifyRef(ref: string): string` — a short name becomes `refs/heads/<name>`; an already-qualified `refs/...` passes through unchanged.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/boardRef.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_BOARD_REF, BOARD_SUBDIRS, qualifyRef } from '../../core/boardRef';

describe('boardRef constants + qualifyRef', () => {
  it('exposes the default ref name and board subdirs', () => {
    expect(DEFAULT_BOARD_REF).toBe('taskwright-board');
    expect([...BOARD_SUBDIRS]).toEqual(['tasks', 'drafts', 'completed', 'archive']);
  });

  it('qualifies a short ref name to refs/heads/*', () => {
    expect(qualifyRef('taskwright-board')).toBe('refs/heads/taskwright-board');
  });

  it('passes an already-qualified ref through unchanged', () => {
    expect(qualifyRef('refs/heads/taskwright-board')).toBe('refs/heads/taskwright-board');
    expect(qualifyRef('refs/taskwright/board')).toBe('refs/taskwright/board');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- boardRef`
Expected: FAIL — cannot resolve `../../core/boardRef` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/core/boardRef.ts`:

```ts
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Default orphan-branch name for the synced board (overridable via config in Plan 3). */
export const DEFAULT_BOARD_REF = 'taskwright-board';

/** The board subdirectories that live on the sync ref (relative to the backlog dir). */
export const BOARD_SUBDIRS: readonly string[] = ['tasks', 'drafts', 'completed', 'archive'];

/** A short ref name becomes `refs/heads/<name>`; a fully-qualified `refs/...` is returned as-is. */
export function qualifyRef(ref: string): string {
  return ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- boardRef`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/boardRef.ts src/test/unit/boardRef.test.ts
git commit -m "feat(boardRef): ref-name constants and qualifyRef helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Injectable git-exec + `refTip`

**Files:**

- Modify: `src/core/boardRef.ts`
- Create: `src/test/unit/helpers/tempGitRepo.ts`
- Test: `src/test/unit/boardRef.test.ts`

**Interfaces:**

- Consumes: `qualifyRef` (Task 1).
- Produces:
  - `export type BoardGitExec = (cwd: string, args: string[], env?: Record<string, string>) => Promise<{ stdout: string; stderr: string }>` — note the **third `env` param** (needed so callers can set `GIT_INDEX_FILE`); this intentionally differs from `WorktreeService.GitExecFn`, which has no env.
  - `export const defaultBoardExec: BoardGitExec` — real `git` via `execFile`, merging `env` over `process.env`.
  - `export function refTip(repoRoot: string, ref: string, exec?: BoardGitExec): Promise<string | null>` — the commit sha the (local) ref points at, or `null` when the ref does not exist.
  - Test helper `makeTempGitRepo(): Promise<TempRepo>` with `{ root, git(args, env?), writeFile(relPath, contents), addGitignore(lines), cleanup() }` and a fixed initial commit on `main`.

- [ ] **Step 1: Write the failing test helper first**

Create `src/test/unit/helpers/tempGitRepo.ts`:

```ts
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const DETERMINISTIC_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

export interface TempRepo {
  root: string;
  git(args: string[], env?: Record<string, string>): Promise<string>;
  writeFile(relPath: string, contents: string): void;
  addGitignore(lines: string[]): void;
  headSha(): Promise<string>;
  cleanup(): void;
}

/** Create a throwaway git repo in os.tmpdir() with one commit on `main`. */
export async function makeTempGitRepo(): Promise<TempRepo> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwright-boardref-'));
  const git = async (args: string[], env?: Record<string, string>): Promise<string> => {
    const res = await execFileAsync('git', args, {
      cwd: root,
      env: { ...process.env, ...DETERMINISTIC_ENV, ...env },
    });
    return res.stdout;
  };
  await git(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(root, 'README.md'), '# temp\n');
  await git(['add', 'README.md']);
  await git(['commit', '-q', '-m', 'init']);
  return {
    root,
    git,
    writeFile(relPath, contents) {
      const abs = path.join(root, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, contents);
    },
    addGitignore(lines) {
      fs.writeFileSync(path.join(root, '.gitignore'), lines.join('\n') + '\n');
    },
    async headSha() {
      return (await git(['rev-parse', 'HEAD'])).trim();
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
```

Append to `src/test/unit/boardRef.test.ts`:

```ts
import { refTip, defaultBoardExec } from '../../core/boardRef';
import { makeTempGitRepo, TempRepo } from './helpers/tempGitRepo';

describe('refTip', () => {
  let repo: TempRepo;
  beforeEach(async () => {
    repo = await makeTempGitRepo();
  });
  afterEach(() => repo.cleanup());

  it('returns null for a ref that does not exist', async () => {
    expect(await refTip(repo.root, 'taskwright-board', defaultBoardExec)).toBeNull();
  });

  it('returns the commit sha for an existing ref', async () => {
    const head = await repo.headSha();
    await repo.git(['update-ref', 'refs/heads/taskwright-board', head]);
    expect(await refTip(repo.root, 'taskwright-board', defaultBoardExec)).toBe(head);
  });
});
```

Add `beforeEach, afterEach` to the existing `vitest` import at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- boardRef`
Expected: FAIL — `refTip` / `defaultBoardExec` are not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/core/boardRef.ts`:

```ts
export type BoardGitExec = (
  cwd: string,
  args: string[],
  env?: Record<string, string>
) => Promise<{ stdout: string; stderr: string }>;

/** Real git via execFile; `env` is merged over the ambient environment. */
export const defaultBoardExec: BoardGitExec = (cwd, args, env) =>
  execFileAsync('git', args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    timeout: 15000,
  });

/** The commit sha the local ref points at, or null when it does not exist. */
export async function refTip(
  repoRoot: string,
  ref: string,
  exec: BoardGitExec = defaultBoardExec
): Promise<string | null> {
  try {
    const { stdout } = await exec(repoRoot, ['rev-parse', '--verify', '--quiet', qualifyRef(ref)]);
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- boardRef`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/core/boardRef.ts src/test/unit/boardRef.test.ts src/test/unit/helpers/tempGitRepo.ts
git commit -m "feat(boardRef): BoardGitExec adapter, refTip, temp-git test helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `snapshotBoardToRef` — isolated-index snapshot onto the ref

**Files:**

- Modify: `src/core/boardRef.ts`
- Test: `src/test/unit/boardRef.test.ts`

**Interfaces:**

- Consumes: `qualifyRef`, `BOARD_SUBDIRS`, `BoardGitExec`, `defaultBoardExec` (Tasks 1–2).
- Produces:
  - `export interface SnapshotOptions { repoRoot: string; ref: string; indexFile: string; message: string; parent?: string; backlogDir?: string; exec?: BoardGitExec }`
  - `export interface SnapshotResult { commit: string; tree: string }`
  - `export function snapshotBoardToRef(opts: SnapshotOptions): Promise<SnapshotResult>` — stages the existing board subdirs into an isolated index, writes a tree, commits it (root commit when `parent` is omitted, otherwise `-p parent`), and points `ref` at the new commit. `backlogDir` defaults to `'backlog'`. Returns the new commit + tree shas. **Leaves the user's HEAD, branch, and real index untouched.**

- [ ] **Step 1: Write the failing test**

Append to `src/test/unit/boardRef.test.ts`:

```ts
import * as path from 'path';
import { snapshotBoardToRef } from '../../core/boardRef';

describe('snapshotBoardToRef', () => {
  let repo: TempRepo;
  const indexFile = () => path.join(repo.root, '.taskwright', 'board.index');

  beforeEach(async () => {
    repo = await makeTempGitRepo();
    repo.addGitignore([
      'backlog/tasks/',
      'backlog/drafts/',
      'backlog/completed/',
      'backlog/archive/',
    ]);
    repo.writeFile('backlog/config.yml', 'project_name: "temp"\n');
    repo.writeFile('backlog/tasks/task-1 - A.md', '---\nid: TASK-1\n---\nA\n');
    repo.writeFile('backlog/tasks/task-2 - B.md', '---\nid: TASK-2\n---\nB\n');
  });
  afterEach(() => repo.cleanup());

  it('snapshots only the board subdirs onto the ref (root commit)', async () => {
    const headBefore = await repo.headSha();

    const result = await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'snapshot',
      exec: defaultBoardExec,
    });

    // ref points at the new commit
    expect(await refTip(repo.root, 'taskwright-board', defaultBoardExec)).toBe(result.commit);

    // the ref tree contains board tasks but NOT config.yml
    const files = (await repo.git(['ls-tree', '-r', '--name-only', 'refs/heads/taskwright-board']))
      .trim()
      .split('\n')
      .sort();
    expect(files).toEqual(['backlog/tasks/task-1 - A.md', 'backlog/tasks/task-2 - B.md']);

    // root commit has no parent
    const parents = (await repo.git(['rev-list', '--parents', '-n', '1', result.commit]))
      .trim()
      .split(' ');
    expect(parents).toHaveLength(1); // just the commit sha, no parents

    // user git state untouched: HEAD unchanged, working tree clean (ignored files don't count)
    expect(await repo.headSha()).toBe(headBefore);
    expect((await repo.git(['status', '--porcelain'])).trim()).toBe('');
  });

  it('chains a parented commit when parent is provided', async () => {
    const first = await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'first',
      exec: defaultBoardExec,
    });
    repo.writeFile('backlog/tasks/task-3 - C.md', '---\nid: TASK-3\n---\nC\n');
    const second = await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'second',
      parent: first.commit,
      exec: defaultBoardExec,
    });

    const parents = (await repo.git(['rev-list', '--parents', '-n', '1', second.commit]))
      .trim()
      .split(' ');
    expect(parents).toEqual([second.commit, first.commit]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- boardRef`
Expected: FAIL — `snapshotBoardToRef` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/core/boardRef.ts` (imports `fs` and `path` at the top):

```ts
import * as fs from 'fs';
import * as path from 'path';
```

```ts
export interface SnapshotOptions {
  repoRoot: string;
  ref: string;
  indexFile: string;
  message: string;
  parent?: string;
  backlogDir?: string;
  exec?: BoardGitExec;
}

export interface SnapshotResult {
  commit: string;
  tree: string;
}

/** Board subdir paths (relative to repoRoot) that currently exist on disk. */
function existingBoardPaths(repoRoot: string, backlogDir: string): string[] {
  return BOARD_SUBDIRS.map((sub) => path.posix.join(backlogDir, sub)).filter((rel) =>
    fs.existsSync(path.join(repoRoot, rel))
  );
}

/**
 * Snapshot the board subdirs onto `ref` using an isolated index, so the user's
 * real index / HEAD / branch are never touched. Root commit when `parent` is
 * omitted; otherwise chained onto `parent`.
 */
export async function snapshotBoardToRef(opts: SnapshotOptions): Promise<SnapshotResult> {
  const exec = opts.exec ?? defaultBoardExec;
  const backlogDir = opts.backlogDir ?? 'backlog';
  const env = { GIT_INDEX_FILE: opts.indexFile };
  fs.mkdirSync(path.dirname(opts.indexFile), { recursive: true });

  // Start from an empty isolated index.
  await exec(opts.repoRoot, ['read-tree', '--empty'], env);

  // Stage board files (force, because these dirs are git-ignored). Skip when none exist.
  const paths = existingBoardPaths(opts.repoRoot, backlogDir);
  if (paths.length > 0) {
    await exec(opts.repoRoot, ['add', '--force', '--all', '--', ...paths], env);
  }

  const tree = (await exec(opts.repoRoot, ['write-tree'], env)).stdout.trim();

  const commitArgs = ['commit-tree', tree, '-m', opts.message];
  if (opts.parent) commitArgs.push('-p', opts.parent);
  const commit = (await exec(opts.repoRoot, commitArgs, env)).stdout.trim();

  await exec(opts.repoRoot, ['update-ref', qualifyRef(opts.ref), commit], env);

  return { commit, tree };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- boardRef`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/core/boardRef.ts src/test/unit/boardRef.test.ts
git commit -m "feat(boardRef): snapshotBoardToRef via isolated-index plumbing

- Snapshots only board subdirs (never config.yml) onto the ref
- Uses GIT_INDEX_FILE so user HEAD/index/branch are untouched
- Force-adds so git-ignored board files are captured

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `materializeRefToWorktree` — checkout the ref + prune removed files

**Files:**

- Modify: `src/core/boardRef.ts`
- Test: `src/test/unit/boardRef.test.ts`

**Interfaces:**

- Consumes: `qualifyRef`, `BOARD_SUBDIRS`, `snapshotBoardToRef`, `BoardGitExec` (Tasks 1–3).
- Produces:
  - `export interface MaterializeOptions { repoRoot: string; ref: string; indexFile: string; backlogDir?: string; exec?: BoardGitExec }`
  - `export function materializeRefToWorktree(opts: MaterializeOptions): Promise<{ files: string[] }>` — writes every file from the ref's tree into the working copy (overwriting) and **deletes** local files under the board subdirs that are absent from the ref. Returns the sorted list of board-relative files now present. Non-board files (e.g. `config.yml`) and the user's index/HEAD are untouched.

- [ ] **Step 1: Write the failing test**

Append to `src/test/unit/boardRef.test.ts`:

```ts
import { materializeRefToWorktree } from '../../core/boardRef';

describe('materializeRefToWorktree', () => {
  let repo: TempRepo;
  const indexFile = () => path.join(repo.root, '.taskwright', 'board.index');
  const read = (rel: string) => fs.readFileSync(path.join(repo.root, rel), 'utf-8');
  const exists = (rel: string) => fs.existsSync(path.join(repo.root, rel));

  beforeEach(async () => {
    repo = await makeTempGitRepo();
    repo.addGitignore(['backlog/tasks/']);
    repo.writeFile('backlog/config.yml', 'project_name: "temp"\n');
    // Build a ref that contains tasks A and B.
    repo.writeFile('backlog/tasks/task-1 - A.md', 'A-on-ref\n');
    repo.writeFile('backlog/tasks/task-2 - B.md', 'B-on-ref\n');
    await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'ref state',
      exec: defaultBoardExec,
    });
  });
  afterEach(() => repo.cleanup());

  it('overwrites, adds, and prunes local board files to match the ref', async () => {
    // Diverge the working copy: A modified locally, B removed, C added locally.
    repo.writeFile('backlog/tasks/task-1 - A.md', 'A-local-edit\n');
    fs.rmSync(path.join(repo.root, 'backlog/tasks/task-2 - B.md'));
    repo.writeFile('backlog/tasks/task-3 - C.md', 'C-local-only\n');
    const headBefore = await repo.headSha();

    const result = await materializeRefToWorktree({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      exec: defaultBoardExec,
    });

    expect(read('backlog/tasks/task-1 - A.md')).toBe('A-on-ref\n'); // overwritten from ref
    expect(read('backlog/tasks/task-2 - B.md')).toBe('B-on-ref\n'); // restored from ref
    expect(exists('backlog/tasks/task-3 - C.md')).toBe(false); // pruned (absent from ref)
    expect(read('backlog/config.yml')).toBe('project_name: "temp"\n'); // untouched
    expect(result.files).toEqual(['backlog/tasks/task-1 - A.md', 'backlog/tasks/task-2 - B.md']);
    expect(await repo.headSha()).toBe(headBefore); // user git state untouched
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- boardRef`
Expected: FAIL — `materializeRefToWorktree` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/core/boardRef.ts`:

```ts
export interface MaterializeOptions {
  repoRoot: string;
  ref: string;
  indexFile: string;
  backlogDir?: string;
  exec?: BoardGitExec;
}

/** Recursively list board-relative file paths under one subdir on disk (posix separators). */
function listLocalBoardFiles(repoRoot: string, backlogDir: string): Set<string> {
  const out = new Set<string>();
  for (const sub of BOARD_SUBDIRS) {
    const relDir = path.posix.join(backlogDir, sub);
    const absDir = path.join(repoRoot, relDir);
    if (!fs.existsSync(absDir)) continue;
    for (const abs of walkFiles(absDir)) {
      const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
      out.add(rel);
    }
  }
  return out;
}

function walkFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(abs));
    else if (entry.isFile()) result.push(abs);
  }
  return result;
}

/**
 * Write the ref's tree into the working copy (overwriting) and delete local
 * board files absent from the ref, so the board subdirs exactly match the ref.
 * Uses an isolated index; the user's real index / HEAD are untouched.
 */
export async function materializeRefToWorktree(
  opts: MaterializeOptions
): Promise<{ files: string[] }> {
  const exec = opts.exec ?? defaultBoardExec;
  const backlogDir = opts.backlogDir ?? 'backlog';
  const env = { GIT_INDEX_FILE: opts.indexFile };
  fs.mkdirSync(path.dirname(opts.indexFile), { recursive: true });

  // Load the ref's tree into the isolated index, then write those files out.
  await exec(opts.repoRoot, ['read-tree', qualifyRef(opts.ref)], env);
  await exec(opts.repoRoot, ['checkout-index', '--all', '--force'], env);

  // The set of files the ref declares.
  const listed = (
    await exec(opts.repoRoot, ['ls-tree', '-r', '--name-only', qualifyRef(opts.ref)], env)
  ).stdout.trim();
  const refFiles = new Set(listed.length > 0 ? listed.split('\n') : []);

  // Prune local board files not present on the ref.
  for (const rel of listLocalBoardFiles(opts.repoRoot, backlogDir)) {
    if (!refFiles.has(rel)) {
      fs.rmSync(path.join(opts.repoRoot, ...rel.split('/')));
    }
  }

  return { files: [...refFiles].sort() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- boardRef`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/core/boardRef.ts src/test/unit/boardRef.test.ts
git commit -m "feat(boardRef): materializeRefToWorktree with prune of removed files

- checkout-index writes the ref tree into the board subdirs
- prunes local board files absent from the ref (handles deletions)
- non-board files and user index/HEAD untouched

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Round-trip + idempotence integration test

**Files:**

- Test: `src/test/unit/boardRef.test.ts`

**Interfaces:**

- Consumes: `snapshotBoardToRef`, `materializeRefToWorktree`, `refTip` (Tasks 2–4).
- Produces: no new exports — a guardrail test proving snapshot→materialize is a faithful, idempotent round-trip (this is the property Plan 2's sync engine will depend on).

- [ ] **Step 1: Write the failing test**

Append to `src/test/unit/boardRef.test.ts`:

```ts
describe('boardRef round-trip', () => {
  let repo: TempRepo;
  const indexFile = () => path.join(repo.root, '.taskwright', 'board.index');
  const read = (rel: string) => fs.readFileSync(path.join(repo.root, rel), 'utf-8');
  const exists = (rel: string) => fs.existsSync(path.join(repo.root, rel));

  beforeEach(async () => {
    repo = await makeTempGitRepo();
    repo.addGitignore(['backlog/tasks/']);
    repo.writeFile('backlog/tasks/task-1 - A.md', 'A\n');
    repo.writeFile('backlog/tasks/task-2 - B.md', 'B\n');
  });
  afterEach(() => repo.cleanup());

  it('materialize restores the exact snapshotted state and is idempotent', async () => {
    await snapshotBoardToRef({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      message: 'state',
      exec: defaultBoardExec,
    });

    // Wreck the working copy.
    fs.rmSync(path.join(repo.root, 'backlog/tasks/task-1 - A.md'));
    repo.writeFile('backlog/tasks/task-2 - B.md', 'B-wrecked\n');

    const first = await materializeRefToWorktree({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      exec: defaultBoardExec,
    });
    expect(read('backlog/tasks/task-1 - A.md')).toBe('A\n');
    expect(read('backlog/tasks/task-2 - B.md')).toBe('B\n');

    // Running materialize again changes nothing.
    const second = await materializeRefToWorktree({
      repoRoot: repo.root,
      ref: 'taskwright-board',
      indexFile: indexFile(),
      exec: defaultBoardExec,
    });
    expect(second.files).toEqual(first.files);
    expect(read('backlog/tasks/task-1 - A.md')).toBe('A\n');
    expect(exists('backlog/tasks/task-2 - B.md')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `bun run test -- boardRef`
Expected: PASS if Tasks 3–4 are correct. If it FAILS, the round-trip has a real bug (e.g. prune deleting restored files) — fix `materializeRefToWorktree` before continuing; do not weaken the test.

- [ ] **Step 3: Run the full gate**

Run: `bun run test && bun run lint && bun run typecheck`
Expected: PASS. (Reminder: ~22 upstream POSIX-path unit tests fail on Windows by design — see `CLAUDE.md`. On Windows, confirm only the `boardRef` suite and previously-passing suites are green; the known upstream failures are unrelated.)

- [ ] **Step 4: Commit**

```bash
git add src/test/unit/boardRef.test.ts
git commit -m "test(boardRef): snapshot/materialize round-trip is faithful and idempotent

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (Phase 1 slice of the spec §3.3):**

- Isolated-index plumbing that never touches HEAD/index/branch → Tasks 3–4 (`GIT_INDEX_FILE`; tests assert `headSha` unchanged + clean `status`).
- Snapshot only board subdirs, never `config.yml` → Task 3 (`existingBoardPaths` over `BOARD_SUBDIRS`; test asserts `ls-tree` excludes `config.yml`).
- Git-ignored board files still captured → Task 3 (`add --force`; `.gitignore` set in the test fixture).
- Materialize handles deletions (the ghost-equivalent of stale files) → Task 4 prune; Task 5 round-trip.
- Orphan (root) vs. parented commits → Task 3 both cases (Plan 3 lifecycle decides which parent to pass).
- Deferred to later plans (correctly out of scope here): fetch/rebase/push CAS (Plan 2), reconciliation/compaction/settings (Plan 3), loader/MCP/UI/migration wire-in (Plan 4).

**2. Placeholder scan:** No TBD/TODO; every code and test step contains complete, runnable content.

**3. Type consistency:** `BoardGitExec` (3-arg with `env`) is defined in Task 2 and used unchanged in Tasks 3–4. `SnapshotOptions`/`SnapshotResult`/`MaterializeOptions` names and fields are referenced identically across tasks and tests. `qualifyRef`, `BOARD_SUBDIRS`, `refTip`, `snapshotBoardToRef`, `materializeRefToWorktree` names match every call site. `makeTempGitRepo`/`TempRepo` shape is consistent across all test blocks.

No issues found.

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
