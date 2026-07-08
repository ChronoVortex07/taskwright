# `start_task` MCP Tool — Worktree Bootstrap From Any Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `start_task` MCP tool (+ a pure `src/core/startTask.ts` core) so any primary-rooted session can create/reuse a task's isolated `.worktrees/<branch>` worktree and seed its active task — the same bootstrap the board Dispatch action performs today, but reachable over MCP.

**Architecture.** A new vscode-free core `bootstrapTaskWorktree(deps, taskId)` reuses the exact cores `src/providers/dispatchActions.ts` already composes — `WorktreeService.createWorktree` (create-or-reuse `.worktrees/<branch>`), `activeTask.writeActiveTask` (seed the worktree's `.taskwright/active-task.json`), `cancellationMarker.clearCancellationMarker` (clear a stale stop-signal), and `dispatchPrompt.dispatchBranchName` (deterministic slug) — with a `GitBranchService.isGitRepository` guard. The MCP handler `startTaskHandler` builds the core's deps from `McpHandlerDeps` (`repoRoot = path.dirname(backlogPath)`, the primary checkout under Board Sync v2) and is registered as a stdio tool in `src/mcp/server.ts`. Because the MCP server binds its root **once at launch** (`server.ts:82`) and cannot re-root mid-session, the tool returns a `relaunchHint` telling the caller to relaunch a session with cwd = the new worktree to run `/execute-task` there.

**Tech Stack:** TypeScript, Vitest (pure core over a temp git repo + a handler unit test mirroring `mcpWriteHandlers.test.ts`), esbuild (extension + MCP bundles). MCP handlers run as a separate stdio process reusing only vscode-free `src/core`.

## Prerequisites (standalone)

DRAFT-3 is **not blocked** by any other draft — it composes only already-landed cores (`WorktreeService`, `activeTask`, `cancellationMarker`, `dispatchPrompt`, `GitBranchService`) and the existing MCP handler/registration seam. Carve this worktree from `main`. (DRAFT-4's `request_merge` `worktree?` param and DRAFT-5's `next_ready_tasks` are independent; they consume the worktrees `start_task` creates but land separately.)

## Global Constraints

_Every task's requirements implicitly include this section._

- **This task is ONE dispatched PR.** It runs in its own `.worktrees/<branch>` created by the board Dispatch / `/execute-task` flow. Work only inside that worktree; run all git/file/test commands there. NEVER git checkout/commit/merge in the repo root (shared; a pre-commit hook blocks it). A fresh worktree has no `node_modules` (git-ignored) — run `bun install` there ONCE before the first build/test.
- **Runtime:** Node >= 22; build/test via **Bun**: `bun run test` (Vitest), `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test:playwright`, `bun run test:e2e`, `bun run test:cdp`.
- **Commit with `--no-verify`** (the repo's lint-staged pre-commit hook flips the whole tree CRLF->LF on Windows). Stage only the files each task names.
- **Baseline:** after `bun install`, run `bun run test` once in the worktree and record the actual pass count. Windows shows ~22 KNOWN upstream POSIX-path unit failures — unrelated, do NOT "fix" them. Confirm no previously-green test regresses.
- **Verify gate at the end of every `### Task N`:** `bun run test && bun run lint && bun run typecheck` must pass (plus any task-specific webview/e2e suite named in that task).
- **Commit trailer:** end each commit message with `Co-Authored-By: <your model> <noreply@anthropic.com>` and `Completes <this task id>.` (the dispatched agent substitutes its own model line per AGENTS.md).
- **Close:** the `/execute-task` flow closes via `request_merge` from inside the worktree — do NOT ff-merge or push from the repo root yourself.

- **MCP primary-build live-caveat (CRITICAL for src/mcp changes):** the `taskwright` MCP server running in a worktree is the PRIMARY checkout's already-built `dist/mcp/server.js` (via `scripts/taskwright-mcp.cjs`). Your changes to `src/mcp/handlers.ts`/`src/mcp/server.ts` are NOT live in the worktree until this branch merges and the primary rebuilds. Therefore exercise them ONLY via unit tests (`bun run test`) — never by calling the new tool live from the worktree.

## Locked names & wire conventions (do not rename)

- **`start_task` MCP tool** (DRAFT-3): input `{ taskId: string }`; output
  `{ created: boolean; taskId: string; branch: string; worktree: string /* repo-root-relative, e.g. ".worktrees/task-7-add-login" */; worktreeAbs: string; relaunchHint: string }`.
- **Pure core:** `src/core/startTask.ts` exporting `bootstrapTaskWorktree(deps, taskId): Promise<StartTaskResult>` (vscode-free; reuses `WorktreeService.createWorktree` + `activeTask.writeActiveTask` + `cancellationMarker.clearCancellationMarker` + `dispatchPrompt.dispatchBranchName`), plus the exported interfaces `StartTaskDeps` and `StartTaskResult`.
- **Handler** `startTaskHandler` in `src/mcp/handlers.ts`; **registered** in `src/mcp/server.ts` adjacent to `request_merge`.
- **`relaunchHint` semantics:** the MCP server roots at its launch directory (`server.ts:82`) and cannot re-root mid-session, so the calling session cannot itself run `/execute-task` in the new worktree. The hint instructs the caller to relaunch/spawn a session with cwd = `worktreeAbs`. This is intrinsic to the fixed-root design (see `.mcp.json` / `scripts/taskwright-mcp.cjs`), not a bug.
- **Idempotent:** `createWorktree` reuses an existing dir (`created:false`, no git run); re-running for the same task re-seeds the active task and clears any stale marker without error.

---

## File Structure

**Create:**

- `src/core/startTask.ts` — vscode-free worktree-bootstrap core: create/reuse `.worktrees/<branch>`, seed the active task inside it, clear a stale cancellation marker; git-repo guard; returns `StartTaskResult`.
- `src/test/unit/startTask.test.ts` — pure-core unit tests over a temp git repo (creates `.worktrees/<branch>`, seeds `.taskwright/active-task.json`, idempotent re-run, unknown-id throws, non-git repoRoot throws).
- `src/test/unit/startTaskHandler.test.ts` — MCP handler unit test over a temp git repo (mirrors `mcpWriteHandlers.test.ts` scaffold): contract shape, idempotency, unknown-id error.

**Modify:**

- `src/mcp/handlers.ts` — import `bootstrapTaskWorktree` + `type StartTaskResult`; add `startTaskHandler` (builds `StartTaskDeps` from `McpHandlerDeps`: `repoRoot = path.dirname(deps.backlogPath)`, `getTask = deps.parser.getTask`).
- `src/mcp/server.ts` — import `startTaskHandler`; register the `start_task` tool (`inputSchema { taskId }`) immediately after the `request_merge` registration.

---

## Task 1: `src/core/startTask.ts` pure core + unit tests

**Files:**

- Create: `src/core/startTask.ts`
- Test: `src/test/unit/startTask.test.ts`

**Goal:** Build the leaf core first — it has no consumers yet, so it lands green in isolation. It mirrors the bootstrap sequence in `dispatchActions.ts` `dispatchTask` (`createWorktree` → `writeActiveTask(sessionRoot, taskId)` → `clearCancellationMarker(sessionRoot)`, `dispatchActions.ts:98-118`) but is reachable without VS Code: `bootstrapTaskWorktree({ repoRoot, getTask }, taskId)`. It resolves the task's deterministic branch via `dispatchBranchName`, guards on `GitBranchService.isGitRepository`, creates/reuses the worktree, seeds the active task **inside** the worktree, clears any stale marker, and returns the locked `StartTaskResult` including a `relaunchHint`.

- [ ] **Step 0: Worktree setup + baseline** (first task only)

In the dispatched worktree: `bun install`, then `bun run test` once. Record the actual pass count (Windows shows ~22 known upstream POSIX-path failures — unrelated; do NOT "fix"). This is the baseline every later gate is compared against.

- [ ] **Step 1: Write the failing tests**

Create `src/test/unit/startTask.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { bootstrapTaskWorktree } from '../../core/startTask';
import { activeTaskPath } from '../../core/activeTask';
import { cancellationMarkerPath } from '../../core/cancellationMarker';

let repoRoot: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-start-'));
  // A git worktree add needs at least one commit (a valid HEAD to branch from).
  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# temp\n', 'utf-8');
  git(['add', 'README.md']);
  git(['commit', '-m', 'init', '--no-verify']);
});
afterEach(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

/** Minimal deps: getTask returns the id+title needed for the branch slug. */
const stubDeps = (task?: { id: string; title: string }) => ({
  repoRoot,
  getTask: async (id: string) => (task && task.id === id ? task : undefined),
});

describe('bootstrapTaskWorktree', () => {
  it('creates .worktrees/<branch>, seeds the active task inside it, and returns the contract shape', async () => {
    const result = await bootstrapTaskWorktree(stubDeps({ id: 'TASK-7', title: 'Add login' }), 'TASK-7');

    // Deterministic branch + repo-root-relative path (locked contract).
    expect(result.branch).toBe('task-7-add-login');
    expect(result.worktree).toBe('.worktrees/task-7-add-login');
    expect(result.created).toBe(true);
    expect(result.taskId).toBe('TASK-7');
    expect(result.worktreeAbs).toBe(path.join(repoRoot, '.worktrees', 'task-7-add-login'));
    // relaunchHint names the absolute worktree and the skill to run there.
    expect(result.relaunchHint).toContain(result.worktreeAbs);
    expect(result.relaunchHint).toContain('/execute-task');

    // The worktree dir exists on disk (git worktree add actually ran).
    expect(fs.existsSync(result.worktreeAbs)).toBe(true);
    // The active task was seeded INTO the worktree's own .taskwright/.
    const activeFile = activeTaskPath(result.worktreeAbs);
    expect(fs.existsSync(activeFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(activeFile, 'utf-8')).taskId).toBe('TASK-7');
    // No stale cancellation marker on a fresh worktree.
    expect(fs.existsSync(cancellationMarkerPath(result.worktreeAbs))).toBe(false);
  });

  it('is idempotent: a second call reuses the worktree (created:false), re-seeds active, clears a stale marker', async () => {
    const deps = stubDeps({ id: 'TASK-7', title: 'Add login' });
    const first = await bootstrapTaskWorktree(deps, 'TASK-7');
    expect(first.created).toBe(true);

    // Simulate a stale marker landing between runs (e.g. a prior leaked cancel).
    fs.mkdirSync(path.join(first.worktreeAbs, '.taskwright'), { recursive: true });
    fs.writeFileSync(cancellationMarkerPath(first.worktreeAbs), '{}', 'utf-8');

    const second = await bootstrapTaskWorktree(deps, 'TASK-7');
    expect(second.created).toBe(false); // dir reused, no git worktree add
    expect(second.worktreeAbs).toBe(first.worktreeAbs);
    expect(fs.existsSync(activeTaskPath(second.worktreeAbs))).toBe(true); // still seeded
    expect(fs.existsSync(cancellationMarkerPath(second.worktreeAbs))).toBe(false); // stale marker cleared
  });

  it('throws when the task id is unknown', async () => {
    await expect(bootstrapTaskWorktree(stubDeps(), 'TASK-404')).rejects.toThrow('TASK-404');
  });

  it('throws a friendly error when repoRoot is not a git repository', async () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-nongit-'));
    try {
      const deps = {
        repoRoot: nonGit,
        getTask: async () => ({ id: 'TASK-7', title: 'Add login' }),
      };
      await expect(bootstrapTaskWorktree(deps, 'TASK-7')).rejects.toThrow(/git repository/);
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });
});
```

> Falsification: the branch slug (`task-7-add-login`), the `.worktrees/` relative path, `created:true` then `created:false`, and the seeded `active-task.json` inside the worktree all prove real behavior, not a tautology. The idempotent case plants a stale marker and asserts it is gone. The unknown-id and non-git cases prove the two guards fire.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- startTask`
Expected: FAIL — `Cannot find module '../../core/startTask'` (the core does not exist yet). Both `startTask.test.ts` and any later `startTaskHandler.test.ts` match this filter; at this step only `startTask.test.ts` exists.

- [ ] **Step 3: Write `src/core/startTask.ts`**

```ts
import { createWorktree } from './WorktreeService';
import { writeActiveTask } from './activeTask';
import { clearCancellationMarker } from './cancellationMarker';
import { dispatchBranchName } from './dispatchPrompt';
import { GitBranchService } from './GitBranchService';
import type { Task } from './types';

/**
 * Bootstrap a task's isolated worktree from any primary-rooted session.
 *
 * Today only the board Dispatch action (src/providers/dispatchActions.ts) creates a
 * `.worktrees/<branch>` and seeds its active task. `start_task` exposes that same
 * bootstrap over MCP: create (or reuse) the worktree, seed the active task INSIDE it,
 * and clear any stale cancellation marker — the identical sequence dispatchTask runs
 * (createWorktree -> writeActiveTask -> clearCancellationMarker).
 *
 * It deliberately does NOT try to re-root the running MCP server: the server binds its
 * root once at process launch (`TASKWRIGHT_ROOT || cwd`, src/mcp/server.ts) and an
 * in-session `cd` does not move it. So the returned `relaunchHint` instructs the caller
 * to launch a fresh session with cwd = the new worktree to run `/execute-task` there.
 *
 * Idempotent: createWorktree reuses an existing dir (created:false, no git run), and both
 * writeActiveTask and clearCancellationMarker are idempotent, so re-running is safe.
 */

export interface StartTaskDeps {
  /** The primary checkout root that owns `.worktrees/` (parent of the board's `backlog/`). */
  repoRoot: string;
  /** Resolve a task's id + title (for the deterministic branch slug); undefined for an unknown id. */
  getTask: (taskId: string) => Promise<Pick<Task, 'id' | 'title'> | undefined>;
}

export interface StartTaskResult {
  /** True when a new worktree was created; false when an existing one was reused (idempotent). */
  created: boolean;
  taskId: string;
  branch: string;
  /** Repo-root-relative worktree path, e.g. ".worktrees/task-7-add-login". */
  worktree: string;
  /** Absolute worktree path. */
  worktreeAbs: string;
  /** Why the caller must relaunch a session in the worktree to run /execute-task. */
  relaunchHint: string;
}

export async function bootstrapTaskWorktree(
  deps: StartTaskDeps,
  taskId: string
): Promise<StartTaskResult> {
  const task = await deps.getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} was not found.`);
  }

  const git = new GitBranchService(deps.repoRoot);
  if (!(await git.isGitRepository())) {
    throw new Error(
      `start_task needs a git repository at ${deps.repoRoot} to create an isolated worktree.`
    );
  }

  const branch = dispatchBranchName(task);
  const wt = await createWorktree(deps.repoRoot, branch);

  // Seed the active task INTO the worktree (its own .taskwright/), mirroring dispatchTask,
  // and clear any stale cancellation marker so a fresh /execute-task does not insta-abort.
  writeActiveTask(wt.path, task.id);
  clearCancellationMarker(wt.path);

  return {
    created: wt.created,
    taskId: task.id,
    branch,
    worktree: `.worktrees/${branch}`,
    worktreeAbs: wt.path,
    relaunchHint:
      `This MCP server is rooted at the directory this session launched in and cannot re-root ` +
      `mid-session, so it cannot run /execute-task in the new worktree. Open a NEW Claude Code ` +
      `session with its working directory set to ${wt.path} (open that folder, or launch the ` +
      `session from there), then run /execute-task in it.`,
  };
}
```

> Notes: `createWorktree(deps.repoRoot, branch)` returns `{ path, branch, created }` where `path === worktreePathFor(repoRoot, branch)` (`<repoRoot>/.worktrees/<branch>`), so `worktreeAbs = wt.path`. The relative `worktree` field is spelled with a forward slash to match the locked contract example, regardless of OS. `writeActiveTask` mkdir's `<worktree>/.taskwright/` recursively before writing.

- [ ] **Step 4: Run tests + typecheck**

Run: `bun run test -- startTask && bun run typecheck` → PASS (4 tests green; typecheck clean — `getTask`'s `Promise<Task | undefined>` is assignable to the dep's `Promise<Pick<Task,'id'|'title'> | undefined>`).

- [ ] **Step 5: Full task gate**

Run: `bun run test && bun run lint && bun run typecheck` → PASS (no consumers yet; the full unit suite is a regression check — no previously-green test regresses).

- [ ] **Step 6: Commit**

```bash
git add src/core/startTask.ts src/test/unit/startTask.test.ts
git commit --no-verify -m "feat(start_task): worktree-bootstrap pure core

- src/core/startTask.ts: bootstrapTaskWorktree(deps, taskId) creates/reuses
  .worktrees/<branch>, seeds the active task inside it, clears a stale cancellation
  marker, and returns { created, taskId, branch, worktree, worktreeAbs, relaunchHint }
- reuses the exact dispatchActions bootstrap cores (createWorktree, writeActiveTask,
  clearCancellationMarker, dispatchBranchName) with a GitBranchService.isGitRepository guard
- relaunchHint explains the MCP fixed-root limitation (relaunch with cwd = worktreeAbs)
- unit tests over a temp git repo: creates the worktree + active-task.json, idempotent
  re-run (created:false, stale marker cleared), unknown-id + non-git throws

Co-Authored-By: <your model> <noreply@anthropic.com>
Completes DRAFT-3."
```

**Dependencies:** none (leaf core).

---

## Task 2: `startTaskHandler` + `start_task` MCP registration + handler test

**Files:**

- Modify: `src/mcp/handlers.ts`, `src/mcp/server.ts`
- Test: `src/test/unit/startTaskHandler.test.ts`

**Goal:** Expose the core as the `start_task` MCP tool. `startTaskHandler` builds `StartTaskDeps` from `McpHandlerDeps` — `repoRoot = path.dirname(deps.backlogPath)`. Under Board Sync v2 `backlogPath` resolves to the ONE physical board (the primary worktree's `backlog/`, `server.ts:83-84`), so its parent is the **primary** checkout even when this session is itself rooted in a worktree — worktrees always land under the primary's `.worktrees/`. Register the tool in `server.ts` mirroring the `request_merge` registration (`server.ts:372-381`).

> **MCP primary-build caveat:** these `src/mcp` changes are NOT live in the dispatched worktree until this branch merges and the primary rebuilds. Verify by unit test only (`bun run test`), never by calling `start_task` live from the worktree.

- [ ] **Step 1: Write the failing handler test**

Create `src/test/unit/startTaskHandler.test.ts` (mirrors the `mcpWriteHandlers.test.ts` scaffold/`deps()` pattern, adding a real `git init` so `createWorktree` can run):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';
import { ClaimService } from '../../core/ClaimService';
import { PlanService } from '../../core/PlanService';
import { TreeFieldService } from '../../core/TreeFieldService';
import { createTaskHandler, startTaskHandler } from '../../mcp/handlers';
import type { McpHandlerDeps } from '../../mcp/handlers';
import { activeTaskPath } from '../../core/activeTask';

let root: string;
let backlogPath: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' });
}

function scaffold(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-starth-'));
  backlogPath = path.join(root, 'backlog');
  fs.mkdirSync(path.join(backlogPath, 'tasks'), { recursive: true });
  fs.writeFileSync(
    path.join(backlogPath, 'config.yml'),
    'project_name: "test"\nstatuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: "task"\n',
    'utf-8'
  );
  // A git worktree add needs a HEAD commit to branch from.
  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['add', '-A']);
  git(['commit', '-m', 'init', '--no-verify']);
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

beforeEach(scaffold);
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('startTaskHandler', () => {
  it('creates the task worktree, seeds its active task, and returns the contract shape', async () => {
    await createTaskHandler(deps(), { title: 'Add login' }); // TASK-1
    const res = await startTaskHandler(deps(), { taskId: 'TASK-1' });

    expect(res.taskId).toBe('TASK-1');
    expect(res.branch).toBe('task-1-add-login');
    expect(res.worktree).toBe('.worktrees/task-1-add-login');
    // repoRoot = path.dirname(backlogPath) = root, so the worktree lands under the primary.
    expect(res.worktreeAbs).toBe(path.join(root, '.worktrees', 'task-1-add-login'));
    expect(res.created).toBe(true);
    expect(res.relaunchHint).toContain(res.worktreeAbs);

    // Worktree exists and its active task points at TASK-1.
    expect(fs.existsSync(res.worktreeAbs)).toBe(true);
    const active = activeTaskPath(res.worktreeAbs);
    expect(fs.existsSync(active)).toBe(true);
    expect(JSON.parse(fs.readFileSync(active, 'utf-8')).taskId).toBe('TASK-1');
  });

  it('is idempotent (a second call reuses the worktree)', async () => {
    await createTaskHandler(deps(), { title: 'Add login' }); // TASK-1
    const first = await startTaskHandler(deps(), { taskId: 'TASK-1' });
    expect(first.created).toBe(true);
    const second = await startTaskHandler(deps(), { taskId: 'TASK-1' });
    expect(second.created).toBe(false);
    expect(second.worktreeAbs).toBe(first.worktreeAbs);
  });

  it('errors on an unknown task id', async () => {
    await expect(startTaskHandler(deps(), { taskId: 'TASK-404' })).rejects.toThrow('TASK-404');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- startTaskHandler`
Expected: FAIL — `startTaskHandler` is not exported from `../../mcp/handlers` (the import resolves to `undefined`, so the call throws `startTaskHandler is not a function`).

- [ ] **Step 3: Add `startTaskHandler` to `src/mcp/handlers.ts`**

Add the core import. After (`handlers.ts:21`):

```ts
import { readActiveTask } from '../core/activeTask';
```

insert:

```ts
import { bootstrapTaskWorktree, type StartTaskResult } from '../core/startTask';
```

Then add the handler. After the `requestMergeHandler` function closes and before the `syncOffMessage` helper (`handlers.ts:293-296`), i.e. between:

```ts
    args.taskId
  );
}

/** Board sync is off — the standard "not enabled" response shape for push/pull. */
```

insert the new handler so it reads:

```ts
    args.taskId
  );
}

/**
 * `start_task`: from any primary-rooted session, create (or reuse) the task's isolated
 * `.worktrees/<branch>` and seed its active task — the same bootstrap the board Dispatch
 * action performs, exposed over MCP. It does NOT re-root this server (the root is fixed at
 * launch, server.ts:82), so the result's `relaunchHint` tells the caller to relaunch a
 * session with cwd = worktreeAbs to run `/execute-task` there.
 */
export async function startTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<StartTaskResult> {
  return bootstrapTaskWorktree(
    {
      // The primary checkout owns `.worktrees/`. Under Board Sync v2 `backlogPath` is the
      // ONE physical board (the primary worktree's backlog), so its parent is the primary
      // root even when this session runs from a worktree.
      repoRoot: path.dirname(deps.backlogPath),
      getTask: (id) => deps.parser.getTask(id),
    },
    args.taskId
  );
}

/** Board sync is off — the standard "not enabled" response shape for push/pull. */
```

> `path` is already imported at `handlers.ts:3` (`import * as path from 'path';`). `deps.parser.getTask` returns `Promise<Task | undefined>`, assignable to `StartTaskDeps.getTask`.

- [ ] **Step 4: Register the tool in `src/mcp/server.ts`**

(a) Add `startTaskHandler` to the handler import block. Change (`server.ts:43-47`):

```ts
  requestMergeHandler,
  pushBoardHandler,
  pullBoardHandler,
  type McpHandlerDeps,
} from './handlers';
```

to:

```ts
  requestMergeHandler,
  startTaskHandler,
  pushBoardHandler,
  pullBoardHandler,
  type McpHandlerDeps,
} from './handlers';
```

(b) Register the tool immediately after the `request_merge` registration. After (`server.ts:378-381`):

```ts
      inputSchema: { taskId: z.string().describe('Task ID to integrate, e.g. TASK-7.') },
    },
    async (args) => runTool(() => requestMergeHandler(deps, args))
  );
```

insert:

```ts

  server.registerTool(
    'start_task',
    {
      title: 'Start task',
      description:
        "Create (or reuse) the task's isolated .worktrees/<branch> worktree and seed its active task, from any primary-rooted session — the same bootstrap the board Dispatch action performs. This server cannot re-root itself mid-session, so it returns a relaunchHint: open a NEW session with its working directory set to the returned worktreeAbs, then run /execute-task there. Idempotent — an existing worktree is reused (created:false). Returns { created, taskId, branch, worktree, worktreeAbs, relaunchHint }.",
      inputSchema: { taskId: z.string().describe('Task ID to start, e.g. TASK-7.') },
    },
    async (args) => runTool(() => startTaskHandler(deps, args))
  );
```

> `runTool` (`server.ts:56`) wraps a throw (unknown id / non-git) into the uniform `{ error: { message } }` result with `isError:true`. The registration itself is not unit-tested (primary-build caveat); it is covered by typecheck + the handler unit test, which exercises the same `startTaskHandler(deps, args)` call the registration makes.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun run test -- startTaskHandler && bun run typecheck` → PASS (3 handler tests green; typecheck clean — the import list and `StartTaskResult` return type resolve).

- [ ] **Step 6: Full task gate**

Run: `bun run test && bun run lint && bun run typecheck && bun run build` → PASS. `bun run build` re-bundles `dist/mcp/server.js` so the registration compiles cleanly (the bundle only goes live for worktrees after this branch merges and the primary rebuilds — do NOT expect the tool live in this worktree). No previously-green test regresses.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/handlers.ts src/mcp/server.ts src/test/unit/startTaskHandler.test.ts
git commit --no-verify -m "feat(start_task): MCP handler + tool registration

- startTaskHandler builds StartTaskDeps from McpHandlerDeps (repoRoot =
  path.dirname(backlogPath) -> the primary checkout under Board Sync v2) and delegates
  to bootstrapTaskWorktree
- register the start_task tool in server.ts (inputSchema { taskId }) next to request_merge
- handler unit test over a temp git repo (mirrors mcpWriteHandlers.test.ts): shape,
  idempotency (created:false on re-run), unknown-id error
- verified by unit test only (MCP primary-build caveat: not live in the worktree until merged)

Co-Authored-By: <your model> <noreply@anthropic.com>
Completes DRAFT-3."
```

**Dependencies:** Task 1 (imports `bootstrapTaskWorktree` + `StartTaskResult`).

---

## Self-Review

**1. Spec coverage (DRAFT-3, item 3a):**

- **Pure core `src/core/startTask.ts` `bootstrapTaskWorktree(deps, taskId)`** returning `{ created, taskId, branch, worktree, worktreeAbs, relaunchHint }` → Task 1. Reuses `WorktreeService.createWorktree`, `activeTask.writeActiveTask`, `cancellationMarker.clearCancellationMarker`, `dispatchPrompt.dispatchBranchName` (no duplication), plus a `GitBranchService.isGitRepository` guard — exactly the read/mirror targets named in the task focus.
- **Handler `startTaskHandler` in `handlers.ts` + registration in `server.ts`** → Task 2, mirroring the `request_merge` handler+registration end-to-end and resolving `repoRoot` from `deps.backlogPath` (the fixed launch root pattern of `server.ts:82`).
- **`relaunchHint`** explains the fixed-root-at-launch limitation and directs the caller to relaunch with cwd = `worktreeAbs` → encoded in the core string and the tool description.
- **Idempotent** when the worktree already exists (`createWorktree` reuses the dir → `created:false`; active task re-seeded; stale marker cleared) → asserted in both test files.

**2. Locked-name compliance:** `start_task` input `{ taskId }`; output `{ created, taskId, branch, worktree, worktreeAbs, relaunchHint }` with `worktree` the repo-root-relative `.worktrees/<branch>` (forward slash) and `worktreeAbs` absolute; core `bootstrapTaskWorktree(deps, taskId): Promise<StartTaskResult>` with exported `StartTaskDeps`/`StartTaskResult`; handler `startTaskHandler`. No renames.

**3. No placeholders:** every file, function, test, command, and commit message is shown in full. No "TBD" / "similar to above". `StartTaskDeps`, `StartTaskResult`, and every imported symbol (`createWorktree`, `writeActiveTask`, `clearCancellationMarker`, `dispatchBranchName`, `GitBranchService`, `Task`, `bootstrapTaskWorktree`) are defined or already exist in the cited files.

**4. Type/name consistency:** `getTask` dep typed `Promise<Pick<Task,'id'|'title'> | undefined>` matches `BacklogParser.getTask`'s `Promise<Task | undefined>` (verified at `BacklogParser.ts:313`); `dispatchBranchName` accepts `Pick<Task,'id'|'title'>` (verified at `dispatchPrompt.ts:66`); `createWorktree` returns `{ path, branch, created }` with `path === worktreePathFor(repoRoot, branch)` (verified at `WorktreeService.ts:36-38,65-80`); `path` already imported in `handlers.ts`; `z`/`runTool`/`deps` in scope at the `server.ts` registration site.

**5. TDD + build integrity:** Task 1 is a green leaf (test-fail → implement → test-pass), Task 2 wires it into MCP behind a failing handler test. Each task ends on `bun run test && bun run lint && bun run typecheck` (Task 2 also `bun run build` for the MCP bundle). MCP changes are exercised via unit tests only, honoring the primary-build live-caveat. Every test has a falsification path (deterministic branch slug, `created` flip, seeded `active-task.json`, stale-marker clear, unknown-id + non-git throws).

**6. Scope discipline:** exactly the `start_task` tool + core + tests. No `request_merge` `worktree?` param (DRAFT-4), no `next_ready_tasks` (DRAFT-5), no skill/scaffolding changes (DRAFT-8/9), no new frontmatter, no CLAUDE.md/AGENTS.md edits (the phase-level doc bullet is the orchestrator's per-phase update, not part of this tool's contract).
