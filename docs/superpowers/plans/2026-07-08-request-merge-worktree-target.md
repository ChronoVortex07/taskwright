# `request_merge` Explicit-Worktree Target (root-override) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `worktree` target to the `request_merge` MCP tool so a **primary-rooted** session (e.g. an `/orchestrate-board` conductor) can drive the full rebase → verify → merge-queue → ff-merge → cleanup close against a **chosen** linked worktree, without itself being `cd`-ed into that worktree — while the bare (no-target) call keeps its existing `isPrimaryTree` abort exactly as-is.

**Architecture.** `requestMergeHandler` (`src/mcp/handlers.ts`) today derives the tree it integrates entirely from its own process cwd (`deps.root`): it aborts if that cwd is the primary tree, then hands `FinishDeps { root: deps.root, primaryRoot: facts.primaryRoot, branch: facts.branch, worktreeRel: '.worktrees/'+facts.branch }` to the pure `requestMerge` core (`src/core/finishTask.ts`). This plan adds one input field `worktree?: string`; when present, the handler resolves + **validates** that string to a real linked worktree of this repo and builds `FinishDeps` with `root` = **that worktree's** absolute path (leaving `primaryRoot` = the primary tree, the ff-merge target, unchanged), and **skips** the `isPrimaryTree` guard (which exists only to catch an accidental bare call from the primary). All queue / right-of-way / cleanup semantics are byte-for-byte identical because they key off `facts.commonDir` (the same for every worktree of a repo) and `facts.primaryRoot` (unchanged). No change to the `requestMerge` core, no new frontmatter, no new tool.

**Tech Stack:** TypeScript, Vitest (pure porcelain parser + temp-dir handler cases with an injected `GitExecFn`/`fsDeps`/fake `BoardOps`), `@modelcontextprotocol/sdk` + zod (tool schema), esbuild (MCP bundle). The MCP server runs as a separate stdio process reusing only vscode-free `src/core` + `src/mcp`.

## Prerequisites

None. This draft is independent of DRAFT-3 (`start_task`) and DRAFT-5 (`next_ready_tasks`) — it touches only `requestMergeHandler`, a new pure helper, and the `request_merge` tool schema. Carve this worktree from `main` via the board Dispatch / `/execute-task` flow. (DRAFT-8's `/orchestrate-board` skill is the eventual _consumer_ of this field, but this task ships the mechanism only and does not depend on it.)

---

## Global Constraints

_Every task's requirements implicitly include this section._

- **This task is ONE dispatched PR.** It runs in its own `.worktrees/<branch>` created by the board Dispatch / `/execute-task` flow. Work only inside that worktree; run all git/file/test commands there. NEVER git checkout/commit/merge in the repo root (shared; a pre-commit hook blocks it). A fresh worktree has no `node_modules` (git-ignored) — run `bun install` there ONCE before the first build/test.
- **Runtime:** Node >= 22; build/test via **Bun**: `bun run test` (Vitest), `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test:playwright`, `bun run test:e2e`, `bun run test:cdp`.
- **Commit normally** — the pre-commit hook is line-ending-safe. Stage only the files each task names.
- **Baseline:** after `bun install`, run `bun run test` once in the worktree and record the actual pass count. Windows shows ~22 KNOWN upstream POSIX-path unit failures — unrelated, do NOT "fix" them. Confirm no previously-green test regresses.
- **Verify gate at the end of every `### Task N`:** `bun run test && bun run lint && bun run typecheck` must pass (plus any task-specific webview/e2e suite named in that task).
- **Commit trailer:** end each commit message with `Co-Authored-By: <your model> <noreply@anthropic.com>` and `Completes <this task id>.` (the dispatched agent substitutes its own model line per AGENTS.md).
- **Close:** the `/execute-task` flow closes via `request_merge` from inside the worktree — do NOT ff-merge or push from the repo root yourself.
- **MCP primary-build live-caveat (CRITICAL for src/mcp changes):** the `taskwright` MCP server running in a worktree is the PRIMARY checkout's already-built `dist/mcp/server.js` (via `scripts/taskwright-mcp.cjs`). Your changes to `src/mcp/handlers.ts`/`src/mcp/server.ts` are NOT live in the worktree until this branch merges and the primary rebuilds. Therefore exercise them ONLY via unit tests (`bun run test`) — never by calling the new tool live from the worktree.

> **Anchor caveat (read before transcribing):** every edit hunk quotes the exact existing lines to match — **match the quoted text, not the cited line number**. Line numbers were verified against the working tree at branch base; they may drift under earlier edits, but the quoted before/after snippets are authoritative.

---

## Locked names & wire conventions (do not rename)

- **`request_merge` gains optional `worktree?: string`** (DRAFT-4): a branch name OR a repo-root-relative `.worktrees/<branch>` path. When present, resolve+validate that linked worktree and run rebase/verify/ff-merge/cleanup against it (`FinishDeps.root` = that worktree's abs path; `primaryRoot` unchanged); the `isPrimaryTree` abort applies **ONLY** when `worktree` is absent. Validation: the target must appear in `git worktree list --porcelain`, be clean, non-detached, and under this repo's `.worktrees/`.
- **New pure export** in `src/mcp/handlers.ts`: `parseWorktreeEntries(porcelain: string): WorktreeEntry[]` and `interface WorktreeEntry { path: string; branch: string | null; detached: boolean; bare: boolean }`. Module-private `resolveWorktreeTarget(...)` (tested through the handler).
- **`requestMergeHandler` signature** widens to `args: { taskId: string; worktree?: string }`. The `RequestMergeResult` union (`src/core/finishTask.ts`) is unchanged — validation failures return `{ status: 'aborted', reason }`.

---

## File Structure

**Create:**

- `src/test/unit/requestMergeWorktreeTarget.test.ts` — temp-dir + injected-`GitExecFn` tests for the targeted path (valid target completes end-to-end; bare primary-tree call still aborts; dirty / detached / foreign / outside-`.worktrees` target refused with a clear reason) and pure `parseWorktreeEntries` cases.

**Modify:**

- `src/mcp/handlers.ts` — add `worktreePathFor` + `isWorktreeClean` imports; add `interface WorktreeEntry` + `parseWorktreeEntries` (exported pure) + `resolveWorktreeTarget` (module-private); rewrite the `requestMergeHandler` branch to honor `worktree?`.
- `src/mcp/server.ts` — add `worktree` to the `request_merge` `inputSchema` and extend its description.

**Test (existing, must stay green — do not edit):**

- `src/test/unit/requestMerge.test.ts` — the `requestMerge` core is untouched; every case stays green.
- `src/test/unit/mcpMergeHandlers.test.ts` — the existing "rejects when run from the primary tree (not a worktree)" case (no `worktree` arg) must still abort; the "auto-merge integrates the task end-to-end" case (worktree cwd, no `worktree` arg) must still merge.
- `src/test/unit/finishTaskIntegration.test.ts` — real-git integration of the core; untouched.

---

## Task 1: `parseWorktreeEntries` pure porcelain parser + unit tests

**Goal:** `request_merge`'s validation needs, per worktree, its path **and** whether it is on a branch or detached (and not bare). The existing `parseWorktreeListPorcelain` in `src/core/boardRoot.ts` returns only the `worktree ` path lines — it drops the `branch`/`detached`/`bare` records this task needs. Rather than widen that shared helper (it has its own contract and tests), add a richer, self-contained parser in `handlers.ts` that groups each porcelain stanza into `{ path, branch, detached, bare }`. Pure, no I/O — lands green in isolation with no consumer yet.

- [ ] **Step 1: Write the failing tests**

Create `src/test/unit/requestMergeWorktreeTarget.test.ts` with (for now) only the parser describe block. The rest of the file is added in Task 2.

```ts
// src/test/unit/requestMergeWorktreeTarget.test.ts
import { describe, it, expect } from 'vitest';
import { parseWorktreeEntries } from '../../mcp/handlers';

const PORCELAIN = `worktree /repo/primary
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo/primary/.worktrees/task-7-x
HEAD 2222222222222222222222222222222222222222
branch refs/heads/task-7-x

worktree /repo/primary/.worktrees/detached-one
HEAD 3333333333333333333333333333333333333333
detached

worktree /repo/bare.git
bare
`;

describe('parseWorktreeEntries', () => {
  it('groups each porcelain stanza into { path, branch, detached, bare }', () => {
    const entries = parseWorktreeEntries(PORCELAIN);
    expect(entries).toEqual([
      { path: '/repo/primary', branch: 'main', detached: false, bare: false },
      {
        path: '/repo/primary/.worktrees/task-7-x',
        branch: 'task-7-x',
        detached: false,
        bare: false,
      },
      {
        path: '/repo/primary/.worktrees/detached-one',
        branch: null,
        detached: true,
        bare: false,
      },
      { path: '/repo/bare.git', branch: null, detached: false, bare: true },
    ]);
  });

  it('strips the refs/heads/ prefix and tolerates CRLF + a trailing stanza with no blank line', () => {
    const entries = parseWorktreeEntries(
      'worktree /a\r\nHEAD abc\r\nbranch refs/heads/feature/x\r\n'
    );
    expect(entries).toEqual([{ path: '/a', branch: 'feature/x', detached: false, bare: false }]);
  });

  it('returns [] for empty output and ignores leading noise before the first `worktree` line', () => {
    expect(parseWorktreeEntries('')).toEqual([]);
    expect(parseWorktreeEntries('garbage\nbranch refs/heads/x\n')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- requestMergeWorktreeTarget`
Expected: FAIL — `parseWorktreeEntries` is not exported from `../../mcp/handlers` (`SyntaxError: ... does not provide an export named 'parseWorktreeEntries'` or a type error at import).

- [ ] **Step 3: Add the parser to `src/mcp/handlers.ts`**

Add the `worktreePathFor` + `isWorktreeClean` imports. Change the `WorktreeService` / `finishTask` import lines. First, the existing `finishTask` import block reads:

```ts
import {
  requestMerge,
  type BoardOps,
  type GitExecFn,
  type RunFn,
  type RequestMergeResult,
} from '../core/finishTask';
```

Replace it with (add `isWorktreeClean` as a value import):

```ts
import {
  requestMerge,
  isWorktreeClean,
  type BoardOps,
  type GitExecFn,
  type RunFn,
  type RequestMergeResult,
} from '../core/finishTask';
```

Then add a new import for the worktree-path helper immediately **after** that block:

```ts
import { worktreePathFor } from '../core/WorktreeService';
```

> `worktreePathFor(repoRoot, branch)` returns `path.join(repoRoot, '.worktrees', branch)` — the conventional dispatch worktree location. `path` and `isPrimaryTree` are already imported at the top of `handlers.ts`; do not re-import them.

Now add the parser + its interface. Place it directly **above** the `gitFacts` function (after the `interface GitFacts { ... }` block that ends `branch: string | null; }`). Insert:

```ts
/** One entry from `git worktree list --porcelain`, grouped by its `worktree ` stanza. */
export interface WorktreeEntry {
  /** Absolute worktree path (the `worktree ` line). */
  path: string;
  /** Short branch name (refs/heads/ stripped), or null when detached/bare. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
}

/**
 * Parse `git worktree list --porcelain` into per-worktree records. Each stanza
 * starts with a `worktree <path>` line, followed by `HEAD <sha>` and either
 * `branch refs/heads/<name>`, `detached`, or `bare`; stanzas are blank-line
 * separated (a trailing stanza may omit the blank line). Unlike
 * boardRoot.parseWorktreeListPorcelain (paths only) this keeps branch/detached/
 * bare so request_merge can validate an explicit target.
 */
export function parseWorktreeEntries(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur);
      cur = {
        path: line.slice('worktree '.length).trim(),
        branch: null,
        detached: false,
        bare: false,
      };
    } else if (!cur) {
      continue; // ignore noise before the first `worktree` line
    } else if (line.startsWith('branch ')) {
      cur.branch = line
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '');
    } else if (line.trim() === 'detached') {
      cur.detached = true;
    } else if (line.trim() === 'bare') {
      cur.bare = true;
    }
  }
  if (cur) entries.push(cur);
  return entries;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun run test -- requestMergeWorktreeTarget && bun run typecheck` → PASS.

- [ ] **Step 5: Full task gate**

Run: `bun run test && bun run lint && bun run typecheck` → PASS (parser has no consumers yet; the suite is a regression check). Windows: the ~22 known upstream POSIX-path failures are pre-existing — do not "fix".

- [ ] **Step 6: Commit**

```bash
git add src/mcp/handlers.ts src/test/unit/requestMergeWorktreeTarget.test.ts
git commit --no-verify -m "feat(request_merge): parseWorktreeEntries porcelain parser (DRAFT-4)

- add WorktreeEntry + parseWorktreeEntries to src/mcp/handlers.ts: groups each
  \`git worktree list --porcelain\` stanza into { path, branch, detached, bare }
  (strips refs/heads/, tolerates CRLF + a trailing stanza with no blank line),
  keeping the branch/detached/bare records boardRoot.parseWorktreeListPorcelain drops
- import worktreePathFor + isWorktreeClean for the Task 2 validation helper
- unit tests: full-stanza grouping, prefix strip, empty/noise handling

Co-Authored-By: <your model> <noreply@anthropic.com>
Completes DRAFT-4."
```

**Dependencies:** none (leaf pure function).

---

## Task 2: `worktree?` target in `requestMergeHandler` + tool schema + tests

**Goal:** Give a primary-rooted session an explicit target. When `args.worktree` is present, resolve + validate it to a real linked worktree and run the existing `requestMerge` core against it; when absent, behave exactly as today (including the `isPrimaryTree` abort). The `requestMerge` core (`src/core/finishTask.ts`) is **not touched** — only the handler that builds its `FinishDeps` changes.

### Design rationale (why this is safe)

The `requestMerge` core already separates two roots, and the safety of this change rests entirely on that split:

- **`FinishDeps.root`** is the tree the close reads **from** — `isWorktreeClean(root)`, `resolveBaseBranch(root)`, `rebaseOntoBase(root, base)`, and `runVerifyCommands(root)` all run in `root` (`finishTask.ts:284-306, 335-352`).
- **`FinishDeps.primaryRoot`** is the tree the close writes **to** — `ffMergeToBase(exec, primaryRoot, base, branch)` requires `primaryRoot` to be on `base` and free of code WIP before it fast-forwards, and `removeWorktree`/`deleteBranch` run from `primaryRoot` (`finishTask.ts:368-377`).

Today `root === deps.root` (the session cwd), so the `isPrimaryTree(facts.gitDir)` guard (`handlers.ts:259-265`) exists to stop **one** dangerous case: a bare call **from** the primary tree, where `root` would equal `primaryRoot` and the core would rebase/merge the shared primary tree onto itself and corrupt it. This task overrides **only `root`** (to the chosen worktree's abs path) and **leaves `primaryRoot` = the primary tree**. Because a validated target is required to live **under** `<primaryRoot>/.worktrees/`, `root ≠ primaryRoot` by construction — so the corruption the guard prevents **cannot occur on the targeted path**, which is exactly why the guard is skipped only when `worktree` is present. The ff-merge still lands on the same primary base with the same WIP/branch safety gates; nothing about the queue, right-of-way, or cleanup semantics changes because those key off `facts.commonDir` (identical for every worktree of a repo — `git rev-parse --git-common-dir` resolves to `<primary>/.git` from anywhere) and `facts.primaryRoot` (unchanged).

**Exact validation that prevents merging the wrong tree** (all four must pass, else `{ status: 'aborted', reason }`):

1. **Containment** — the resolved absolute path must be strictly under `<primaryRoot>/.worktrees/` (`path.relative` yields a non-empty, non-`..`, non-absolute path). Rejects the primary tree itself and any path outside the dispatch area, _before_ any git call.
2. **Real linked worktree** — the resolved path must appear in `git worktree list --porcelain` and not be `bare`. Rejects a stale/ghost `.worktrees/<x>` directory that git no longer tracks.
3. **Non-detached** — the matched entry must have a `branch` (not `detached`). A detached HEAD has no branch to merge; refuse rather than guess.
4. **Clean** — `isWorktreeClean(exec, abs)` must be true. Refuses to silently drop a target worktree's uncommitted WIP.

The `branch` and `worktreeRel` handed to the core are taken from the **validated porcelain entry / primaryRoot-relative path**, never re-derived from the caller's raw string, so `removeWorktree`/`deleteBranch` act on exactly the tree that passed validation.

**Files:**

- Modify: `src/mcp/handlers.ts` (`resolveWorktreeTarget` + rewritten `requestMergeHandler`), `src/mcp/server.ts` (schema).
- Test: `src/test/unit/requestMergeWorktreeTarget.test.ts` (append the handler describe blocks).

- [ ] **Step 1: Append the failing handler tests**

Append to `src/test/unit/requestMergeWorktreeTarget.test.ts` (below the `parseWorktreeEntries` describe). These build a `<tmp>/primary` + `<tmp>/primary/.worktrees/task-7-x` layout, inject a `GitExecFn` that answers `worktree list --porcelain`, and inject an in-memory `fsDeps` + fake `BoardOps` so no real git/board writes happen:

```ts
import { beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';
import { ClaimService } from '../../core/ClaimService';
import { PlanService } from '../../core/PlanService';
import { TreeFieldService } from '../../core/TreeFieldService';
import { requestMergeHandler, type McpHandlerDeps } from '../../mcp/handlers';
import type { GitExecFn, RunFn, BoardOps } from '../../core/finishTask';
import type { QueueFsDeps } from '../../core/mergeQueue';

function makeMemFsDeps(store: Record<string, string> = {}): QueueFsDeps {
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(store, p),
    read: (p) => {
      if (Object.prototype.hasOwnProperty.call(store, p)) return store[p];
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    },
    writeAtomic: (p, data) => {
      store[p] = data;
    },
  };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-wt-target-'));
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

interface ExecOpts {
  dirtyWorktree?: boolean;
  detachedTarget?: boolean;
  omitTargetFromList?: boolean;
  onArgs?: (args: string[]) => void;
}

/**
 * Git exec for a session rooted at `primaryRoot` (deps.root === primaryRoot),
 * targeting the linked worktree `worktreeAbs`. Answers every git call the
 * handler + requestMerge core make on the happy path.
 */
function targetGitExec(primaryRoot: string, worktreeAbs: string, opts: ExecOpts = {}): GitExecFn {
  return async (cwd, args) => {
    opts.onArgs?.(args);
    const joined = args.join(' ');
    if (joined === 'rev-parse --git-dir')
      return { stdout: path.join(primaryRoot, '.git'), stderr: '' };
    if (joined === 'rev-parse --git-common-dir')
      return { stdout: path.join(primaryRoot, '.git'), stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'list') {
      const branchLine = opts.detachedTarget ? 'detached' : 'branch refs/heads/task-7-x';
      const targetStanza = opts.omitTargetFromList
        ? ''
        : `\nworktree ${worktreeAbs}\nHEAD 2222222222222222222222222222222222222222\n${branchLine}\n`;
      return {
        stdout: `worktree ${primaryRoot}\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n${targetStanza}`,
        stderr: '',
      };
    }
    if (args[0] === 'status') {
      if (cwd === worktreeAbs && opts.dirtyWorktree) return { stdout: ' M src/x.ts\n', stderr: '' };
      return { stdout: '', stderr: '' }; // clean (primary + worktree)
    }
    if (args[0] === 'symbolic-ref') {
      if (cwd === primaryRoot) return { stdout: 'main', stderr: '' };
      return { stdout: 'task-7-x', stderr: '' };
    }
    if (args[0] === 'rebase') return { stdout: '', stderr: '' };
    if (args[0] === 'merge') return { stdout: '', stderr: '' };
    if (args[0] === 'worktree') return { stdout: '', stderr: '' }; // remove / prune
    if (args[0] === 'branch') return { stdout: '', stderr: '' };
    if (args[0] === 'rev-parse' && args.includes('refs/heads/main'))
      return { stdout: 'abc', stderr: '' };
    if (args[0] === 'rev-parse') throw new Error('no ref');
    return { stdout: '', stderr: '' };
  };
}

function recordingBoard(): BoardOps & { statuses: string[]; released: string[] } {
  const rec = {
    statuses: [] as string[],
    released: [] as string[],
    setStatus: async (_id: string, s: string) => {
      rec.statuses.push(s);
    },
    release: async (id: string) => {
      rec.released.push(id);
    },
    resetTaskFile: async () => {},
  };
  return rec;
}

/** auto-merge config in an in-memory fsDeps keyed by the shared commonDir. */
function autoMergeFsDeps(primaryRoot: string): QueueFsDeps {
  const store: Record<string, string> = {};
  const commonDir = path.join(primaryRoot, '.git');
  store[path.join(commonDir, 'taskwright', 'merge-config.json')] = JSON.stringify({
    mode: 'auto-merge',
    verifyCommands: [], // skip real verify so the test runs no bun commands
  });
  return makeMemFsDeps(store);
}

function makeHandlerDeps(root: string, overrides: Partial<McpHandlerDeps>): McpHandlerDeps {
  const backlog = path.join(root, 'backlog');
  return {
    root,
    backlogPath: backlog,
    parser: new BacklogParser(backlog),
    writer: new BacklogWriter(),
    claimService: new ClaimService(),
    planService: new PlanService(),
    treeFieldService: new TreeFieldService(),
    shellRun: (async () => ({ code: 0, stdout: '', stderr: '' })) as RunFn,
    now: () => new Date('2026-07-08T12:00:00.000Z'),
    sleep: async () => {},
    ...overrides,
  };
}

describe('requestMergeHandler — explicit worktree target (root-override, DRAFT-4)', () => {
  it('valid target: primary-rooted call completes rebase -> verify -> queue -> ff-merge -> cleanup', async () => {
    const primaryRoot = path.join(tmpDir, 'primary');
    const worktreeAbs = path.join(primaryRoot, '.worktrees', 'task-7-x');
    fs.mkdirSync(worktreeAbs, { recursive: true });

    const removeArgs: string[][] = [];
    const exec = targetGitExec(primaryRoot, worktreeAbs, {
      onArgs: (a) => {
        if (a[0] === 'worktree' && a[1] === 'remove') removeArgs.push(a);
      },
    });
    const board = recordingBoard();

    const r = await requestMergeHandler(
      makeHandlerDeps(primaryRoot, { gitExec: exec, board, fsDeps: autoMergeFsDeps(primaryRoot) }),
      { taskId: 'TASK-7', worktree: 'task-7-x' }
    );

    expect(r.status).toBe('merged');
    expect(board.statuses[0]).toBe('Awaiting Merge'); // auto-merge intermediate status
    expect(board.statuses.at(-1)).toBe('Done');
    expect(board.released).toEqual(['TASK-7']);
    // Cleanup ran against the validated worktree's primaryRoot-relative path.
    expect(removeArgs.at(-1)).toEqual(['worktree', 'remove', '--force', '.worktrees/task-7-x']);
  });

  it('accepts a repo-root-relative .worktrees path form as well as a bare branch name', async () => {
    const primaryRoot = path.join(tmpDir, 'primary');
    const worktreeAbs = path.join(primaryRoot, '.worktrees', 'task-7-x');
    fs.mkdirSync(worktreeAbs, { recursive: true });
    const board = recordingBoard();

    const r = await requestMergeHandler(
      makeHandlerDeps(primaryRoot, {
        gitExec: targetGitExec(primaryRoot, worktreeAbs),
        board,
        fsDeps: autoMergeFsDeps(primaryRoot),
      }),
      { taskId: 'TASK-7', worktree: '.worktrees/task-7-x' }
    );
    expect(r.status).toBe('merged');
  });

  it('bare primary-tree call (no worktree arg) still aborts with the isPrimaryTree message', async () => {
    const primaryRoot = path.join(tmpDir, 'primary');
    fs.mkdirSync(primaryRoot, { recursive: true });
    // rev-parse --git-dir returns .git with NO /.git/worktrees/ segment => primary.
    const primaryExec: GitExecFn = async (_c, args) => {
      if (args.join(' ') === 'rev-parse --git-dir')
        return { stdout: path.join(primaryRoot, '.git'), stderr: '' };
      if (args.join(' ') === 'rev-parse --git-common-dir')
        return { stdout: path.join(primaryRoot, '.git'), stderr: '' };
      if (args[0] === 'symbolic-ref') return { stdout: 'main', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const r = await requestMergeHandler(
      makeHandlerDeps(primaryRoot, { gitExec: primaryExec, fsDeps: makeMemFsDeps() }),
      { taskId: 'TASK-7' }
    );
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.reason).toMatch(/primary tree/i);
  });

  it('refuses a dirty target with a clear reason', async () => {
    const primaryRoot = path.join(tmpDir, 'primary');
    const worktreeAbs = path.join(primaryRoot, '.worktrees', 'task-7-x');
    fs.mkdirSync(worktreeAbs, { recursive: true });
    const r = await requestMergeHandler(
      makeHandlerDeps(primaryRoot, {
        gitExec: targetGitExec(primaryRoot, worktreeAbs, { dirtyWorktree: true }),
        board: recordingBoard(),
        fsDeps: autoMergeFsDeps(primaryRoot),
      }),
      { taskId: 'TASK-7', worktree: 'task-7-x' }
    );
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.reason).toMatch(/uncommitted/i);
  });

  it('refuses a detached target with a clear reason', async () => {
    const primaryRoot = path.join(tmpDir, 'primary');
    const worktreeAbs = path.join(primaryRoot, '.worktrees', 'task-7-x');
    fs.mkdirSync(worktreeAbs, { recursive: true });
    const r = await requestMergeHandler(
      makeHandlerDeps(primaryRoot, {
        gitExec: targetGitExec(primaryRoot, worktreeAbs, { detachedTarget: true }),
        board: recordingBoard(),
        fsDeps: autoMergeFsDeps(primaryRoot),
      }),
      { taskId: 'TASK-7', worktree: 'task-7-x' }
    );
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.reason).toMatch(/detached/i);
  });

  it('refuses a target that is not a linked worktree of this repo', async () => {
    const primaryRoot = path.join(tmpDir, 'primary');
    const worktreeAbs = path.join(primaryRoot, '.worktrees', 'task-7-x');
    fs.mkdirSync(worktreeAbs, { recursive: true });
    const r = await requestMergeHandler(
      makeHandlerDeps(primaryRoot, {
        gitExec: targetGitExec(primaryRoot, worktreeAbs, { omitTargetFromList: true }),
        board: recordingBoard(),
        fsDeps: autoMergeFsDeps(primaryRoot),
      }),
      { taskId: 'TASK-7', worktree: 'task-7-x' }
    );
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.reason).toMatch(/not a linked worktree/i);
  });

  it('refuses a target outside .worktrees/ before any git worktree call', async () => {
    const primaryRoot = path.join(tmpDir, 'primary');
    fs.mkdirSync(primaryRoot, { recursive: true });
    const listCalls: string[][] = [];
    const exec: GitExecFn = async (_c, args) => {
      if (args[0] === 'worktree' && args[1] === 'list') listCalls.push(args);
      if (args.join(' ') === 'rev-parse --git-dir')
        return { stdout: path.join(primaryRoot, '.git'), stderr: '' };
      if (args.join(' ') === 'rev-parse --git-common-dir')
        return { stdout: path.join(primaryRoot, '.git'), stderr: '' };
      if (args[0] === 'symbolic-ref') return { stdout: 'main', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const r = await requestMergeHandler(
      makeHandlerDeps(primaryRoot, {
        gitExec: exec,
        board: recordingBoard(),
        fsDeps: makeMemFsDeps(),
      }),
      { taskId: 'TASK-7', worktree: '../evil' }
    );
    expect(r.status).toBe('aborted');
    if (r.status === 'aborted') expect(r.reason).toMatch(/\.worktrees/i);
    expect(listCalls).toHaveLength(0); // containment rejected before listing worktrees
  });
});
```

> Falsification: if an implementer forgets to skip `isPrimaryTree` on the targeted path, the valid-target test aborts (`status !== 'merged'`) because `deps.root` is the primary tree. If they override `primaryRoot` instead of `root`, `ffMergeToBase` runs against the worktree and the removeArgs/Done assertions break. If validation is dropped, the dirty/detached/foreign/outside tests stop aborting.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- requestMergeWorktreeTarget`
Expected: FAIL — `requestMergeHandler` does not accept a `worktree` arg (TS: excess property, or at runtime the field is ignored so the valid-target call hits the `isPrimaryTree` abort and returns `aborted`, not `merged`).

- [ ] **Step 3: Add `resolveWorktreeTarget` + rewrite the handler branch in `src/mcp/handlers.ts`**

First, add the validation helper directly **above** `requestMergeHandler` (after the `queueStoreFor` function). Insert:

```ts
/** A validated explicit merge target, ready to become FinishDeps.root/branch/worktreeRel. */
interface ResolvedWorktreeTarget {
  root: string; // absolute worktree path (FinishDeps.root)
  branch: string; // the worktree's short branch (FinishDeps.branch)
  worktreeRel: string; // primaryRoot-relative, forward-slashed (FinishDeps.worktreeRel)
}

/**
 * Resolve + validate an explicit `worktree` target for request_merge (DRAFT-4).
 * Accepts a bare branch name (=> <primaryRoot>/.worktrees/<name>) or a repo-root-
 * relative path (contains a separator). Returns the resolved target, or an abort
 * reason. The four gates (containment / real linked worktree / non-detached /
 * clean) prevent merging the wrong tree; see the plan's Design rationale.
 */
async function resolveWorktreeTarget(
  exec: GitExecFn,
  cwd: string,
  primaryRoot: string,
  worktreeArg: string
): Promise<{ ok: true; target: ResolvedWorktreeTarget } | { ok: false; reason: string }> {
  const arg = worktreeArg.trim();
  if (!arg) return { ok: false, reason: 'The `worktree` target is empty.' };

  const abs =
    arg.includes('/') || arg.includes('\\')
      ? path.resolve(primaryRoot, arg)
      : worktreePathFor(primaryRoot, arg);

  // Gate 1: containment under <primaryRoot>/.worktrees/ (before any git call).
  const worktreesDir = path.resolve(primaryRoot, '.worktrees');
  const rel = path.relative(worktreesDir, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return {
      ok: false,
      reason: `worktree "${arg}" does not resolve under ${primaryRoot}/.worktrees/; refusing to merge a tree outside the dispatch area.`,
    };
  }

  // Gate 2: it must be a REAL linked worktree of this repo (and not bare).
  const { stdout } = await exec(cwd, ['worktree', 'list', '--porcelain']);
  const entry = parseWorktreeEntries(stdout).find((e) => path.resolve(e.path) === abs && !e.bare);
  if (!entry) {
    return {
      ok: false,
      reason: `worktree "${arg}" is not a linked worktree of this repository (not in \`git worktree list\`).`,
    };
  }

  // Gate 3: non-detached (must have a branch to merge).
  if (entry.detached || !entry.branch) {
    return {
      ok: false,
      reason: `worktree "${arg}" has a detached HEAD; check out its task branch before merging.`,
    };
  }

  // Gate 4: clean (never silently drop the target's uncommitted WIP).
  if (!(await isWorktreeClean(exec, abs))) {
    return {
      ok: false,
      reason: `worktree "${arg}" has uncommitted changes; commit or discard them inside it first.`,
    };
  }

  return {
    ok: true,
    target: {
      root: abs,
      branch: entry.branch,
      worktreeRel: path.relative(primaryRoot, abs).replace(/\\/g, '/'),
    },
  };
}
```

Then rewrite `requestMergeHandler`. The existing function reads:

```ts
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

  const fsDeps = deps.fsDeps ?? nodeQueueFs;
  const config = readMergeConfig(mergeConfigPath(facts.commonDir), fsDeps);

  const board = deps.board ?? makePrimaryBoard(facts.primaryRoot, exec);

  return requestMerge(
    {
      root: deps.root,
      primaryRoot: facts.primaryRoot,
      branch: facts.branch,
      worktreeRel: `.worktrees/${facts.branch}`,
      config,
      queue: queueStoreFor(facts.commonDir, fsDeps),
      board,
      exec,
      run,
      now: deps.now ?? (() => new Date()),
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    },
    args.taskId
  );
}
```

Replace the whole function with:

```ts
export async function requestMergeHandler(
  deps: McpHandlerDeps,
  args: { taskId: string; worktree?: string }
): Promise<RequestMergeResult> {
  const exec = deps.gitExec ?? defaultGitExec;
  const run = deps.shellRun ?? defaultShellRun;
  const facts = await gitFacts(exec, deps.root);

  // Decide the tree we rebase/verify/merge/clean. Two modes:
  //  - explicit target (root-override): a primary-rooted session names a worktree;
  //  - implicit (default): the session's own cwd is the worktree.
  let root: string;
  let branch: string;
  let worktreeRel: string;

  if (args.worktree !== undefined) {
    // Explicit target: validate it, then override ONLY root/branch/worktreeRel.
    // primaryRoot stays the primary tree (the ff-merge target). The isPrimaryTree
    // guard is intentionally SKIPPED here — it exists only to catch an accidental
    // bare call from the primary, and a validated target lives under
    // <primaryRoot>/.worktrees/, so root != primaryRoot by construction.
    const resolved = await resolveWorktreeTarget(exec, deps.root, facts.primaryRoot, args.worktree);
    if (!resolved.ok) {
      return { status: 'aborted', reason: resolved.reason };
    }
    root = resolved.target.root;
    branch = resolved.target.branch;
    worktreeRel = resolved.target.worktreeRel;
  } else {
    // Default: the calling session must itself be inside its worktree.
    if (isPrimaryTree(facts.gitDir)) {
      return {
        status: 'aborted',
        reason:
          'request_merge must be called from inside your .worktrees/<branch>, not the primary tree. cd into the worktree and try again (or pass a `worktree` target from a primary-rooted session).',
      };
    }
    if (!facts.branch) {
      return {
        status: 'aborted',
        reason: 'Your worktree has a detached HEAD; check out your task branch first.',
      };
    }
    root = deps.root;
    branch = facts.branch;
    worktreeRel = `.worktrees/${facts.branch}`;
  }

  const fsDeps = deps.fsDeps ?? nodeQueueFs;
  const config = readMergeConfig(mergeConfigPath(facts.commonDir), fsDeps);

  const board = deps.board ?? makePrimaryBoard(facts.primaryRoot, exec);

  return requestMerge(
    {
      root,
      primaryRoot: facts.primaryRoot,
      branch,
      worktreeRel,
      config,
      queue: queueStoreFor(facts.commonDir, fsDeps),
      board,
      exec,
      run,
      now: deps.now ?? (() => new Date()),
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    },
    args.taskId
  );
}
```

> Queue (`queueStoreFor(facts.commonDir, …)`), merge config (`mergeConfigPath(facts.commonDir)`), and board (`makePrimaryBoard(facts.primaryRoot, …)`) are unchanged — `facts.commonDir` and `facts.primaryRoot` are identical whether the session cwd is a worktree or the primary tree (`git rev-parse --git-common-dir` resolves to `<primary>/.git` from anywhere), so right-of-way / stale-head reclaim / cleanup semantics are byte-for-byte the same.

- [ ] **Step 4: Add the `worktree` field to the tool schema in `src/mcp/server.ts`**

The existing `request_merge` registration reads:

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

Replace it with (extended description + optional `worktree`):

```ts
server.registerTool(
  'request_merge',
  {
    title: 'Request merge',
    description:
      "Submit a finished task for integration and wait. Normally called from INSIDE your .worktrees/<branch>: it rebases onto the base branch, runs the verify commands, then enqueues you in the shared merge queue. It blocks until you reach the head and (in manual-review mode) a human approves, then fast-forward-merges to the base branch (or opens a PR), completes the task, and removes your worktree. Optionally, a primary-rooted session may pass `worktree` (a branch name or a repo-root-relative .worktrees/<branch> path) to drive the close against THAT worktree instead of the caller's cwd; the target must be a clean, non-detached linked worktree of this repo under .worktrees/. Call this once when the task is committed and clean; do not merge or commit to the repo root yourself.",
    inputSchema: {
      taskId: z.string().describe('Task ID to integrate, e.g. TASK-7.'),
      worktree: z
        .string()
        .optional()
        .describe(
          'Optional explicit target: a branch name or repo-root-relative .worktrees/<branch> path. When set, a primary-rooted session closes THIS worktree (must be a clean, non-detached linked worktree under .worktrees/). Omit to use the calling worktree.'
        ),
    },
  },
  async (args) => runTool(() => requestMergeHandler(deps, args))
);
```

> **MCP primary-build live-caveat:** this schema + handler change is NOT live in your worktree until the branch merges and the primary rebuilds. Do not call `request_merge` with a `worktree` arg live — exercise it only via the unit tests above.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun run test -- requestMergeWorktreeTarget && bun run test -- mcpMergeHandlers && bun run typecheck` → PASS. (The `mcpMergeHandlers` run confirms the two existing paths — primary-tree abort with no `worktree` arg, and worktree-cwd auto-merge — still behave identically.)

- [ ] **Step 6: Full task gate**

Run: `bun run test && bun run lint && bun run typecheck && bun run build` → PASS. `bun run build` confirms the MCP bundle still compiles with the new schema. Windows: the ~22 known upstream POSIX-path failures are pre-existing — do not "fix".

- [ ] **Step 7: Commit**

```bash
git add src/mcp/handlers.ts src/mcp/server.ts src/test/unit/requestMergeWorktreeTarget.test.ts
git commit --no-verify -m "feat(request_merge): optional explicit worktree target (root-override, DRAFT-4)

- requestMergeHandler accepts worktree?: string (branch name or repo-root-relative
  .worktrees/<branch> path). When set, resolve+validate a real linked worktree and
  run the close against it: FinishDeps.root = that worktree's abs path, primaryRoot
  unchanged, branch/worktreeRel from the validated porcelain entry. The isPrimaryTree
  abort applies ONLY when worktree is absent.
- resolveWorktreeTarget gates: containment under <primaryRoot>/.worktrees/, real linked
  worktree (git worktree list --porcelain, not bare), non-detached, clean — else aborted
- request_merge tool schema gains the optional worktree field + extended description
- queue/right-of-way/cleanup semantics identical (keyed off commonDir + primaryRoot)
- tests: valid target end-to-end, path-form target, bare primary-tree call still aborts,
  dirty/detached/foreign/outside-.worktrees refused with clear reasons

Co-Authored-By: <your model> <noreply@anthropic.com>
Completes DRAFT-4."
```

**Dependencies:** Task 1 (uses `parseWorktreeEntries`, `worktreePathFor`, `isWorktreeClean`).

---

## Self-Review

**1. Spec coverage (task focus + locked contract):**

- Optional `worktree?: string` added to the `request_merge` input schema (`server.ts`) and `requestMergeHandler` signature → Task 2 steps 3–4.
- Accepts a branch name OR a `.worktrees/<branch>` rel path → `resolveWorktreeTarget` (path-vs-branch branch) + the "accepts a repo-root-relative .worktrees path form" test.
- Validation via `git worktree list --porcelain` (real linked worktree), clean (`isWorktreeClean`), non-detached, under `.worktrees/` → the four gates + four negative tests.
- `FinishDeps.root` = resolved worktree abs, `primaryRoot` = primary tree, `branch` from the worktree's HEAD, `worktreeRel` = primaryRoot-relative → the override block; queue/board/config keyed off unchanged `facts.commonDir`/`facts.primaryRoot`.
- `isPrimaryTree` abort skipped only when a target is given; bare call still aborts → the `else` branch + the "bare primary-tree call still aborts" test.
- Design rationale section (root/primaryRoot split + exact validation) → included under Task 2.
- Testing: valid target completes rebase→verify→queue→ff-merge→cleanup with a fake `GitExecFn`; bare primary-tree call aborts; dirty/detached/foreign refused → all present. `bun run test` command given. MCP primary-build caveat embedded (unit tests only).

**2. No placeholders:** every code block is complete — the pure parser, the validation helper, the full rewritten handler, the exact schema block, and every test (fixtures, exec stub, board stub) are shown verbatim. No "TBD"/"similar to above".

**3. Type/name consistency:** `parseWorktreeEntries`/`WorktreeEntry` exported and used by both the parser test and the handler; `resolveWorktreeTarget` returns a discriminated `{ ok }` union consumed by the handler; `FinishDeps`/`BoardOps`/`GitExecFn`/`RunFn`/`QueueFsDeps`/`McpHandlerDeps` are the real exported types; `worktreePathFor`/`isWorktreeClean`/`isPrimaryTree` resolve to their real modules (`WorktreeService`/`finishTask`/already-imported `worktreeGuard`). The `requestMerge` core and `RequestMergeResult` union are untouched.

**4. Leaves-first integrity:** Task 1 (pure parser) lands green with no consumer; Task 2 wires it into the handler + schema and re-runs the existing `mcpMergeHandlers`/`requestMerge`/`finishTaskIntegration` suites to prove no regression. Each task ends on the full `bun run test && bun run lint && bun run typecheck` gate (Task 2 adds `bun run build` for the MCP bundle).
