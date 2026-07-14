import { execFile, exec as childExec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { BacklogParser, computeSubtasks } from '../core/BacklogParser';
import {
  BacklogWriter,
  detectCRLF,
  normalizeToLF,
  restoreLineEndings,
} from '../core/BacklogWriter';
import { addCategoryLine, isReservedCategory } from '../core/categoriesConfig';
import { ClaimService } from '../core/ClaimService';
import { PlanService } from '../core/PlanService';
import { TreeFieldService } from '../core/TreeFieldService';
import { resolvePriorities } from '../core/priorityOrder';
import { wouldCreateCycle, resolveDoneStatus } from '../core/treeGate';
import { createTaskWithTreeFields, normalizeType } from '../core/createTaskCore';
import { searchTasks } from '../core/searchTasks';
import { promoteDrafts, type PromoteDraftsResult } from '../core/promoteDrafts';
import { readActiveTask } from '../core/activeTask';
import {
  readSessionTasks,
  recordSessionTask,
  forgetSessionTask,
  type SessionTaskEntry,
} from '../core/sessionTasks';
import { bootstrapTaskWorktree, type StartTaskResult } from '../core/startTask';
import { loadPlanProgress } from '../core/loadPlanProgress';
import { ChecklistItem, Milestone, Task } from '../core/types';
import {
  ChecklistInput,
  assertValidPriority,
  assertValidStatus,
  renderChecklist,
} from './taskWriteHelpers';
import { isPrimaryTree } from '../core/worktreeGuard';
import {
  loadTreeStateFromParser,
  loadTreeBoardFromParser,
  type TreeDerivedState,
} from '../core/treeDerived';
import { laneOf, MISC_LANE, BUGS_LANE, BACKBURNER_BAND, type TreeLayout } from '../core/treeLayout';
import {
  MergeQueueStore,
  branchMergeKey,
  mergeQueuePath,
  nodeQueueFs,
  positionOf,
  type QueueFsDeps,
} from '../core/mergeQueue';
import {
  DEFAULT_VERIFY_TIMEOUT_MS,
  mergeConfigPath,
  readMergeConfig,
  type MergeConfig,
} from '../core/mergeConfig';
import { readSyncConfig, syncConfigPath, type SyncMode } from '../core/syncConfig';
import { boardHomeFor, boardWorktreePathFor, type BoardHome } from '../core/boardRoot';
import { runBoardAutoSync } from '../core/autoSync';
import {
  pushBoard,
  pullBoard,
  type PushBoardResult,
  type PullBoardResult,
} from '../core/boardPushPull';
import type { BoardGitExec } from '../core/boardRef';
import {
  requestMerge,
  isWorktreeClean,
  resolveBaseBranch,
  NOOP_BOARD_OPS,
  type BoardOps,
  type FinishDeps,
  type GitExecFn,
  type RunFn,
  type MergeAbortCode,
  type RequestMergeResult,
  type MergeProgress,
} from '../core/finishTask';
import {
  FileVerifySlot,
  nodeVerifySlotFs,
  verifySlotLeaseMs,
  verifySlotPath,
  type VerifySlot,
  type VerifySlotFs,
} from '../core/verifySlot';
import { worktreePathFor } from '../core/WorktreeService';
import { selectReadyTasks, DEFAULT_CLAIM_STALENESS_HOURS } from '../core/readyTasks';
import { resolveClaimAction, stalenessMsFromHours } from '../core/claimResolution';
import { agentClaimIdentity, worktreeBranchFromPath } from '../core/claimIdentity';
import { extractPlanFiles, selectDisjointBatch } from '../core/planFiles';
import { runBoardDoctor, type DoctorFinding } from '../core/boardDoctor';

/**
 * Pure-ish implementations of the Taskwright MCP tools, decoupled from the MCP
 * transport so they can be unit-tested. `server.ts` wires these to stdio.
 */
export interface McpHandlerDeps {
  /** Directory holding `.taskwright/active-task.json` (session cwd / worktree). */
  root: string;
  /** Primary code checkout root. Distinct from `backlogPath` in git-auto mode. */
  primaryRoot?: string;
  /** Path to the `backlog/` directory (parent of `tasks/`); used by create tools. */
  backlogPath: string;
  parser: BacklogParser;
  writer: BacklogWriter;
  claimService: ClaimService;
  planService: PlanService;
  treeFieldService: TreeFieldService;
  /** Injectable git runner (defaults to execFile('git')). Tests override. */
  gitExec?: GitExecFn;
  /** Injectable shell runner for verify/gh (defaults to child_process.exec). */
  shellRun?: RunFn;
  /** Injectable clock/sleep for the wait loop (defaults to wall clock). */
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable board (defaults to makePrimaryBoard(primaryRoot)). Tests override. */
  board?: BoardOps;
  /** Injectable fs adapter for queue/config I/O (defaults to nodeQueueFs). Tests override. */
  fsDeps?: QueueFsDeps;
  /**
   * Injectable shared verify slot (TASK-126). Defaults to a FileVerifySlot over
   * `<commonDir>/taskwright/verify-slot.lock` — the real, cross-process one.
   */
  verifySlot?: VerifySlot;
  /** Injectable fs adapter for the verify slot's lock file (defaults to nodeVerifySlotFs). */
  verifySlotFs?: VerifySlotFs;
  /** Injectable git runner for board-ref plumbing that needs isolated-index env
   *  forwarding (defaults to boardRef's defaultBoardExec) — `gitExec` above has
   *  no env param and would silently drop `GIT_INDEX_FILE`. Tests override. */
  boardExec?: BoardGitExec;
}

export interface PlanProgressSummary {
  total: number;
  done: number;
  percent: number;
  exists: boolean;
}

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  priority?: string;
  description?: string;
  acceptanceCriteria: ChecklistItem[];
  /** Definition of Done checklist items (echoed so clients can verify writes). */
  definitionOfDone?: ChecklistItem[];
  implementationPlan?: string;
  labels: string[];
  assignee: string[];
  claimedBy?: string;
  worktree?: string;
  claimedAt?: string;
  /** Repo-root-relative path to the linked superpowers plan, if attached. */
  plan?: string;
  /** Checkbox completion of the linked plan, when one is attached. */
  planProgress?: PlanProgressSummary;
  // Tech-tree P1 fields.
  category?: string;
  type?: string;
  causedBy?: string;
  milestone?: string;
  dependencies: string[];
  /** IDs of subtask children (drives the skill's independent-subtasks execution branch). */
  subtasks?: string[];
  /** Parent task ID when this is a subtask. */
  parentTaskId?: string;
  locked?: boolean;
  blockedBy?: string[];
  bugs?: string[];
  activeBugIds?: string[];
  layout?: TreeLayout;
  filePath: string;
}

/**
 * Where `get_active_task` got its answer (TASK-129):
 * - `marker`  — the ephemeral active-task file the board popover / a dispatch wrote. Always wins.
 * - `session` — the single task THIS session started or claimed (`start_task` / `claim_task`).
 * - `none`    — nothing to work on, or the session has several tasks in flight and the server
 *               cannot tell which in-session caller is asking (see `candidates`).
 */
export type ActiveTaskSource = 'marker' | 'session' | 'none';

export interface ActiveTaskResult {
  active: boolean;
  task?: TaskSummary;
  message?: string;
  queuePosition?: number;
  /** Which source resolved the answer — so a caller can tell a dispatch from a self-bootstrap. */
  source: ActiveTaskSource;
  /**
   * The in-flight task IDs when the session has more than one and the answer is
   * therefore ambiguous. Present only with `active: false`, `source: 'none'`.
   */
  candidates?: string[];
}

export interface ClaimResult {
  claimed: boolean;
  taskId: string;
  claimedBy?: string;
  worktree?: string;
  claimedAt?: string;
  /**
   * The claimed task's full context (description, ACs, plan, board file path…), so a
   * session never has to look the board up on disk afterwards. Present on a successful
   * claim (including an idempotent re-claim); absent on surrender/locked.
   */
  task?: TaskSummary;
  /** True when the synced board shows the task is already held by someone else. */
  surrendered?: boolean;
  /** Who holds the task when `surrendered` is true. */
  heldBy?: string;
  /** True when the caller already held the claim — the re-claim was an idempotent no-op. */
  alreadyClaimed?: boolean;
  /** True when the task cannot be claimed because its dependencies are unmet. */
  locked?: boolean;
  /** The blocking dependency IDs when `locked` is true. */
  blockedBy?: string[];
}

export interface ReleaseResult {
  released: true;
  taskId: string;
}

export interface AttachPlanResult {
  attached: true;
  taskId: string;
  plan: string;
}

const execFileAsync = promisify(execFile);
const childExecAsync = promisify(childExec);

const defaultGitExec: GitExecFn = (cwd, args) =>
  execFileAsync('git', args, { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });

const defaultShellRun: RunFn = async (cwd, commandLine, timeoutMs) => {
  try {
    const { stdout, stderr } = await childExecAsync(commandLine, {
      cwd,
      timeout: timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const e = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
      killed?: boolean;
      signal?: string;
    };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? e.message ?? ''),
      // Node kills a timed-out child (killed=true + the kill signal, no numeric exit code);
      // surface that as a timeout so verify can report it distinctly from a red command.
      timedOut: e.killed === true && typeof e.code !== 'number',
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

async function gitFacts(exec: GitExecFn, cwd: string): Promise<GitFacts> {
  // Resolve git's output against `cwd` (the tree we ran in). `git rev-parse --git-dir` /
  // `--git-common-dir` return a RELATIVE path (".git") from the primary tree; a bare
  // path.resolve() would then resolve it against the MCP *process* cwd instead of `cwd`,
  // producing the wrong primaryRoot whenever the server did not launch in the primary — this
  // broke request_merge's worktree target on the primary tree. From a linked worktree git
  // returns an absolute path, which path.resolve(cwd, abs) leaves untouched — safe for both.
  const gitDir = path.resolve(cwd, (await exec(cwd, ['rev-parse', '--git-dir'])).stdout.trim());
  const commonDir = path.resolve(
    cwd,
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

/** A BoardOps bound to the ONE physical board (what the human watches). */
export function makePrimaryBoard(primaryRoot: string, exec: GitExecFn, home?: BoardHome): BoardOps {
  const backlogPath = home?.backlogPath ?? path.join(primaryRoot, 'backlog');
  const configYml = home ? path.join(home.configRoot, 'config.yml') : undefined;
  const parser = new BacklogParser(backlogPath, configYml, undefined, primaryRoot);
  const writer = new BacklogWriter();
  const claims = new ClaimService();
  // In git-auto the board worktree is a real checkout of the board branch, so
  // `git checkout --` runs there (in the primary tree board files are ignored/
  // untracked and the checkout would be a no-op).
  const checkoutCwd = home?.mode === 'git-auto' ? boardWorktreePathFor(primaryRoot) : primaryRoot;
  return {
    async setStatus(taskId, status) {
      await writer.updateTask(taskId, { status } as Partial<Task>, parser);
    },
    async release(taskId) {
      await claims.releaseTask(taskId, parser);
    },
    async resetTaskFile(taskId) {
      const task = await parser.getTask(taskId);
      if (!task) return;
      const rel = path.relative(checkoutCwd, task.filePath);
      try {
        await exec(checkoutCwd, ['checkout', '--', rel]);
      } catch {
        // best-effort: if it fails, the ff-merge will abort cleanly on the dirty file
      }
    },
  };
}

function queueStoreFor(commonDir: string, fsDeps: QueueFsDeps = nodeQueueFs): MergeQueueStore {
  return new MergeQueueStore(mergeQueuePath(commonDir), fsDeps);
}

/** A validated explicit merge target, ready to become FinishDeps.root/branch/worktreeRel. */
interface ResolvedWorktreeTarget {
  root: string; // absolute worktree path (FinishDeps.root)
  branch: string; // the worktree's short branch (FinishDeps.branch)
  worktreeRel: string; // primaryRoot-relative, forward-slashed (FinishDeps.worktreeRel)
}

const IS_WINDOWS = process.platform === 'win32';

/**
 * Compare two filesystem paths for equality after resolving them. Two things differ between what
 * `git worktree list --porcelain` prints and what `path.resolve` yields on Windows, and BOTH must
 * normalize away or request_merge rejects a perfectly good target with "not a linked worktree of
 * this repository" (the wild-type failure that derailed the TASK-80/TASK-81 closes):
 *
 *  - **separators** — git prints `C:/repo/.worktrees/x`, path.resolve yields `C:\repo\.worktrees\x`;
 *  - **drive-letter case** — git may print `c:` where the resolved path has `C:` (the FS is
 *    case-insensitive, so both name the same tree).
 *
 * `winLike` selects the path FLAVOR, not just the case rule: on a Windows-like platform a backslash
 * is a separator (so the two spellings above must collapse to one), while on POSIX a backslash is a
 * legal filename character and must NOT be treated as one. Resolving with the ambient `path.resolve`
 * would tie that decision to `process.platform` and make `winLike` a half-truth — the win32 rules
 * would be untestable on Linux CI and vice versa. Binding the flavor to the flag keeps production
 * behavior identical on both real platforms (`path.win32 === path` on Windows, `path.posix === path`
 * on POSIX) while making both rule sets assertable from either one (TASK-130).
 */
export function isSamePath(a: string, b: string, winLike: boolean = IS_WINDOWS): boolean {
  const flavor = winLike ? path.win32 : path.posix;
  const na = flavor.resolve(a);
  const nb = flavor.resolve(b);
  return winLike ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/**
 * Resolve + validate an explicit `worktree` target for request_merge
 * (`docs/superpowers/plans/2026-07-08-request-merge-worktree-target.md`).
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
  const entry = parseWorktreeEntries(stdout).find((e) => isSamePath(e.path, abs) && !e.bare);
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

/** Args every merge tool shares — the target, and the two wait/verify knobs. */
interface CommonMergeArgs {
  worktree?: string;
  verifyTimeoutMinutes?: number;
  waitMinutes?: number;
  ticket?: string;
}

/**
 * Everything both merge tools need once the target is resolved and the shared
 * config/queue/slot are bound. Building it ONCE is what keeps `request_merge` and
 * `request_branch_merge` (TASK-127) on literally the same pipeline: same target
 * gates, same abort codes, same queue, same verify slot. The two tools differ
 * only in the queue key they submit and the board they hand over.
 */
interface MergeRuntime {
  facts: GitFacts;
  /** The tree we rebase/verify/merge/clean. */
  root: string;
  branch: string;
  worktreeRel: string;
  base: string;
  config: MergeConfig;
  queue: MergeQueueStore;
  verifySlot: VerifySlot;
  exec: GitExecFn;
  run: RunFn;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  waitMinutes?: number;
  /** git-auto board home, when one exists (undefined ⇒ nothing to sync). */
  home?: BoardHome;
  /** Best-effort board sync at a merge boundary; never affects the merge result. */
  boundarySync: () => Promise<void>;
}

type MergeAbort = Extract<RequestMergeResult, { status: 'aborted' }>;

/**
 * Resolve the merge target + shared runtime for either merge tool, or abort.
 *
 * `toolName` only shapes the `wrong_root` advice: the two tools land in the same
 * misuse (a primary-rooted session with no `worktree` target), and each caller
 * must be pointed back at ITS OWN tool, not the other one.
 */
async function prepareMerge(
  deps: McpHandlerDeps,
  args: CommonMergeArgs,
  toolName: 'request_merge' | 'request_branch_merge',
  onProgress?: (progress: MergeProgress) => void
): Promise<{ ok: true; rt: MergeRuntime } | { ok: false; abort: MergeAbort }> {
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
      return { ok: false, abort: { status: 'aborted', reason: resolved.reason } };
    }
    root = resolved.target.root;
    branch = resolved.target.branch;
    worktreeRel = resolved.target.worktreeRel;
  } else {
    // Default: the calling session must itself be inside its worktree.
    if (isPrimaryTree(facts.gitDir)) {
      // TASK-122: a misuse, not a cancellation. A session that bootstrapped its
      // own worktree with start_task is STILL rooted here (the server roots at
      // launch; an in-session `cd` moves Bash, not the MCP), so it lands on this
      // branch and must retry with an explicit `worktree` target. Callers used to
      // read this abort as "worktree vanished ⇒ cancelled" and drop finished work.
      const advice =
        toolName === 'request_merge'
          ? 'If you bootstrapped this task with start_task, close with request_merge { taskId, worktree } (the repo-root-relative path start_task returned) — an in-session cd does not re-root the MCP server. Otherwise call it from inside your .worktrees/<branch>.'
          : 'Name the dev worktree you want merged: request_branch_merge { worktree } (a branch name, or the repo-root-relative .worktrees/<branch> path) — an in-session cd does not re-root the MCP server. Otherwise call it from inside that worktree.';
      return {
        ok: false,
        abort: {
          status: 'aborted',
          code: 'wrong_root',
          reason: `${toolName} was called from the primary tree with no \`worktree\` target. ${advice}`,
        },
      };
    }
    if (!facts.branch) {
      return {
        ok: false,
        abort: {
          status: 'aborted',
          reason: 'Your worktree has a detached HEAD; check out your task branch first.',
        },
      };
    }
    root = deps.root;
    branch = facts.branch;
    worktreeRel = `.worktrees/${facts.branch}`;
  }

  const fsDeps = deps.fsDeps ?? nodeQueueFs;
  const baseConfig = readMergeConfig(mergeConfigPath(facts.commonDir), fsDeps);

  // Per-call override: a caller that measured its suite may raise (or lower) the
  // verify timeout for THIS merge, bounded by the repo-level max when one is set.
  let verifyTimeoutMs = baseConfig.verifyTimeoutMs;
  if (
    typeof args.verifyTimeoutMinutes === 'number' &&
    Number.isFinite(args.verifyTimeoutMinutes) &&
    args.verifyTimeoutMinutes > 0
  ) {
    verifyTimeoutMs = Math.round(args.verifyTimeoutMinutes * 60_000);
    if (baseConfig.verifyTimeoutMaxMs !== undefined) {
      verifyTimeoutMs = Math.min(verifyTimeoutMs, baseConfig.verifyTimeoutMaxMs);
    }
  }
  const config = { ...baseConfig, verifyTimeoutMs };

  // git-auto (TASK-91): bind the board ops to the hidden-worktree home (only
  // once it actually exists — pre-bootstrap falls back to the primary shape),
  // and run a best-effort sync at both merge boundaries so headless
  // orchestration stays fresh without VS Code open. Sync NEVER affects the
  // merge result (spec §3: degrade, never block).
  const syncCfg = readSyncConfig(syncConfigPath(facts.commonDir), fsDeps);
  const homeCandidate = boardHomeFor(facts.primaryRoot, syncCfg.mode);
  const home =
    syncCfg.mode === 'git-auto' && fs.existsSync(homeCandidate.backlogPath)
      ? homeCandidate
      : undefined;

  const boundarySync = async (): Promise<void> => {
    if (!home) return;
    try {
      await runBoardAutoSync({
        primaryRoot: facts.primaryRoot,
        ref: syncCfg.ref,
        remote: syncCfg.remote,
        exec: deps.boardExec,
      });
    } catch (err) {
      console.error('[taskwright-mcp] merge-boundary board sync failed:', err);
    }
  };

  // TASK-88: a non-negative finite waitMinutes bounds the queue wait (0 = check
  // once); anything else keeps the fully-blocking default.
  const waitMinutes =
    typeof args.waitMinutes === 'number' &&
    Number.isFinite(args.waitMinutes) &&
    args.waitMinutes >= 0
      ? args.waitMinutes
      : undefined;

  const now = deps.now ?? ((): Date => new Date());
  const sleep =
    deps.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));

  // TASK-126: the shared verify slot. It lives beside the merge queue in the
  // common dir, so it serializes verify runs across every worktree AND every MCP
  // server process sharing this repo — which is exactly the concurrency
  // /orchestrate-board creates. The lease covers the worst case a legitimate
  // verify can take (every command running to its full timeout) so a slow suite
  // is never robbed of its slot.
  const verifySlot =
    deps.verifySlot ??
    new FileVerifySlot(verifySlotPath(facts.commonDir), deps.verifySlotFs ?? nodeVerifySlotFs, {
      now,
      sleep,
      leaseMs: verifySlotLeaseMs(config.verifyTimeoutMs, config.verifyCommands.length),
    });

  void onProgress; // forwarded by the callers, not needed to build the runtime

  return {
    ok: true,
    rt: {
      facts,
      root,
      branch,
      worktreeRel,
      base: await resolveBaseBranch(exec, root),
      config,
      queue: queueStoreFor(facts.commonDir, fsDeps),
      verifySlot,
      exec,
      run,
      now,
      sleep,
      ...(waitMinutes !== undefined ? { waitMinutes } : {}),
      ...(home ? { home } : {}),
      boundarySync,
    },
  };
}

/** The FinishDeps a MergeRuntime yields, once a board is chosen for it. */
function finishDepsFor(
  rt: MergeRuntime,
  board: BoardOps,
  onProgress?: (progress: MergeProgress) => void
): FinishDeps {
  return {
    root: rt.root,
    primaryRoot: rt.facts.primaryRoot,
    branch: rt.branch,
    worktreeRel: rt.worktreeRel,
    config: rt.config,
    queue: rt.queue,
    board,
    exec: rt.exec,
    run: rt.run,
    verifySlot: rt.verifySlot,
    now: rt.now,
    sleep: rt.sleep,
    onProgress,
  };
}

/**
 * `request_merge`: submit the active task for integration and block until it is
 * merged / a PR is opened / it is sent back — the single closing call an agent
 * makes from inside its worktree. TASK-88: `waitMinutes` bounds the queue wait
 * (expiry returns `{ status: 'pending' }` with a resume ticket, keeping the
 * queue entry), and `onProgress` receives liveness updates during verify and
 * the queue wait for the transport to forward as MCP progress notifications.
 */
export async function requestMergeHandler(
  deps: McpHandlerDeps,
  args: {
    taskId: string;
    worktree?: string;
    verifyTimeoutMinutes?: number;
    waitMinutes?: number;
    ticket?: string;
  },
  onProgress?: (progress: MergeProgress) => void
): Promise<RequestMergeResult> {
  const prepared = await prepareMerge(deps, args, 'request_merge', onProgress);
  if (!prepared.ok) return prepared.abort;
  const rt = prepared.rt;

  const board = deps.board ?? makePrimaryBoard(rt.facts.primaryRoot, rt.exec, rt.home);

  await rt.boundarySync();

  const result = await requestMerge(
    finishDepsFor(rt, board, onProgress),
    args.taskId,
    rt.waitMinutes !== undefined || args.ticket !== undefined
      ? { waitMinutes: rt.waitMinutes, ticket: args.ticket }
      : undefined
  );

  // The task is integrated — it is no longer in flight for this session, so it must
  // not linger in the ledger and make a NEXT task look ambiguous (TASK-129). A merge
  // releases the claim too, but that runs against the board, not this session's root.
  if (result.status === 'merged' || result.status === 'pr_opened') {
    forgetSessionTask(deps.root, args.taskId);
  }

  // Publish the Done flip (and anything else the merge wrote) to the remote.
  await rt.boundarySync();
  return result;
}

/**
 * The outcome of a task-less merge. Deliberately branch-shaped, not task-shaped:
 * there is no task ID to report and nothing on the board changed. `code` is the
 * SAME {@link MergeAbortCode} union the task path uses (TASK-127 AC3) — an
 * orchestrator branches on one set of codes, whichever tool it called.
 */
export type BranchMergeResult =
  | { status: 'merged'; branch: string; worktree: string; worktreeRemoved: boolean }
  | { status: 'pr_opened'; branch: string; url: string }
  | { status: 'sent_back'; branch: string; reason: string }
  | { status: 'aborted'; reason: string; detail?: string; code?: MergeAbortCode }
  | {
      status: 'pending';
      branch: string;
      queuePosition: number;
      ticket: string;
      message: string;
    };

/**
 * `request_branch_merge` (TASK-127): close a dev worktree that has **no board
 * task** through the same merge queue.
 *
 * Why it exists: multi-phase dev sessions (a `tech-tree-p5` branch, an
 * orchestrator's own scratch worktree) never fit claim → execute → request_merge,
 * so they fell back to a manual `git merge --ff-only` in the repo root — which
 * bypasses verify, bypasses the queue's right-of-way, and trips the
 * merge-without-review guardrail. This gives that work the queue instead.
 *
 * It is the task path with the board unplugged: same worktree gates, same
 * rebase → verify → queue → (manual-review gate) → ff-merge, same abort codes.
 * The only behavioral differences are the two the absence of a task implies —
 * no board writes, and the worktree/branch SURVIVE the merge unless
 * `removeWorktree` opts into teardown (the session usually keeps working in it).
 */
export async function requestBranchMergeHandler(
  deps: McpHandlerDeps,
  args: CommonMergeArgs & { removeWorktree?: boolean },
  onProgress?: (progress: MergeProgress) => void
): Promise<BranchMergeResult> {
  const prepared = await prepareMerge(deps, args, 'request_branch_merge', onProgress);
  if (!prepared.ok) return prepared.abort;
  const rt = prepared.rt;

  // A worktree cannot normally have the base branch checked out (git refuses the
  // same branch in two trees), but a detached primary makes it possible — and
  // "fast-forward main onto main" would be a confusing no-op merge, not a close.
  if (rt.branch === rt.base) {
    return {
      status: 'aborted',
      reason: `"${rt.branch}" IS the base branch; there is nothing to merge into it. Check out a topic branch in the worktree first.`,
    };
  }

  const removeWorktree = args.removeWorktree === true;
  const result = await requestMerge(
    // NOOP_BOARD_OPS is belt-and-braces: requestMerge already neutralizes the
    // board for a `branch:` key. Passing it makes the intent legible at the call
    // site — this merge has no board side.
    finishDepsFor(rt, NOOP_BOARD_OPS, onProgress),
    branchMergeKey(rt.branch),
    {
      removeWorktreeOnSuccess: removeWorktree,
      ...(rt.waitMinutes !== undefined ? { waitMinutes: rt.waitMinutes } : {}),
      ...(args.ticket !== undefined ? { ticket: args.ticket } : {}),
    }
  );

  switch (result.status) {
    case 'merged':
      return {
        status: 'merged',
        branch: rt.branch,
        worktree: rt.worktreeRel,
        worktreeRemoved: removeWorktree,
      };
    case 'pr_opened':
      return { status: 'pr_opened', branch: rt.branch, url: result.url };
    case 'sent_back':
      return { status: 'sent_back', branch: rt.branch, reason: result.reason };
    case 'pending':
      return {
        status: 'pending',
        branch: rt.branch,
        queuePosition: result.queuePosition,
        ticket: result.ticket,
        message: result.message,
      };
    default:
      return result;
  }
}

/** `start_task`'s result plus the task's full context (TASK-129). */
export interface StartTaskHandlerResult extends StartTaskResult {
  /**
   * The started task's full context, so the caller can begin work immediately —
   * no follow-up `get_active_task`, and no hunting for the board on disk (in
   * git-auto mode it is not even under the repo root).
   */
  task?: TaskSummary;
}

/**
 * `start_task`: from any primary-rooted session, create (or reuse) the task's isolated
 * `.worktrees/<branch>` and seed its active task — the same bootstrap the board Dispatch
 * action performs, exposed over MCP. It does NOT re-root this server (the root is fixed at
 * launch, server.ts:82), so the result's `relaunchHint` tells the caller to relaunch a
 * session with cwd = worktreeAbs to run `/execute-task` there.
 *
 * TASK-129: it also returns the task's full context and records the task in this session's
 * ledger. The marker it seeds lives in the NEW worktree, which this still-primary-rooted
 * session cannot read — the ledger is what lets a later `get_active_task` here answer at all.
 */
export async function startTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<StartTaskHandlerResult> {
  const result = await bootstrapTaskWorktree(
    {
      // The primary code checkout always owns `.worktrees/`. In git-auto mode
      // `backlogPath` lives under the hidden taskwright-board worktree, so its
      // parent must never be used as the code repository root.
      repoRoot: deps.primaryRoot ?? path.dirname(deps.backlogPath),
      getTask: (id) => deps.parser.getTask(id),
    },
    args.taskId
  );
  recordSessionTask(deps.root, {
    taskId: result.taskId,
    worktree: result.worktree,
    via: 'start_task',
  });
  return { ...result, task: await hydrateTaskSummary(deps, result.taskId) };
}

/** Board sync is off — the standard "not enabled" response shape for push/pull. */
function syncOffMessage(): string {
  return 'Board sync is off (taskwright.sync.mode). Run "Taskwright: Enable Board Sync" first.';
}

/**
 * `push_board` (Board Sync v2 Task F): snapshot the live board, union-merge
 * with the remote `taskwright-board` ref, and push. A no-op (with a
 * `message` explaining why) when `taskwright.sync.mode` is `off`.
 */
export async function pushBoardHandler(deps: McpHandlerDeps): Promise<PushBoardResult> {
  const exec = deps.gitExec ?? defaultGitExec;
  const facts = await gitFacts(exec, deps.root);
  const fsDeps = deps.fsDeps ?? nodeQueueFs;
  const syncCfg = readSyncConfig(syncConfigPath(facts.commonDir), fsDeps);
  if (syncCfg.mode === 'off') {
    return {
      pushed: false,
      ref: syncCfg.ref,
      remote: syncCfg.remote,
      commit: '',
      conflicts: [],
      message: syncOffMessage(),
    };
  }
  if (syncCfg.mode === 'git-auto') {
    // The manual escape hatch enqueues the same sync pass the events run.
    const outcome = await runBoardAutoSync({
      primaryRoot: facts.primaryRoot,
      ref: syncCfg.ref,
      remote: syncCfg.remote,
      exec: deps.boardExec,
    });
    if ('skipped' in outcome) {
      return {
        pushed: false,
        ref: syncCfg.ref,
        remote: syncCfg.remote,
        commit: '',
        conflicts: [],
        message: 'Another session is syncing the board right now — try again in a moment.',
      };
    }
    return {
      pushed: outcome.pushed,
      ref: syncCfg.ref,
      remote: syncCfg.remote,
      commit: outcome.localTip ?? '',
      rejected: outcome.rejected,
      conflicts: outcome.conflicts,
      message: outcome.pushed ? undefined : outcome.error,
    };
  }
  return pushBoard({
    cwd: deps.root,
    ref: syncCfg.ref,
    remote: syncCfg.remote,
    message: 'chore(taskwright): push board',
    exec: deps.boardExec,
  });
}

/**
 * `pull_board` (Board Sync v2 Task F): fetch the remote `taskwright-board`
 * ref, union-merge with the local board (uncommitted local edits are
 * preserved), and materialize the result. A no-op when `taskwright.sync.mode`
 * is `off`.
 */
export async function pullBoardHandler(deps: McpHandlerDeps): Promise<PullBoardResult> {
  const exec = deps.gitExec ?? defaultGitExec;
  const facts = await gitFacts(exec, deps.root);
  const fsDeps = deps.fsDeps ?? nodeQueueFs;
  const syncCfg = readSyncConfig(syncConfigPath(facts.commonDir), fsDeps);
  if (syncCfg.mode === 'off') {
    return {
      pulled: false,
      ref: syncCfg.ref,
      remote: syncCfg.remote,
      files: [],
      conflicts: [],
      message: syncOffMessage(),
    };
  }
  if (syncCfg.mode === 'git-auto') {
    // Same sync pass as push — in git-auto the board worktree IS the live
    // board, so a successful fold already materialized everything.
    const outcome = await runBoardAutoSync({
      primaryRoot: facts.primaryRoot,
      ref: syncCfg.ref,
      remote: syncCfg.remote,
      exec: deps.boardExec,
    });
    if ('skipped' in outcome) {
      return {
        pulled: false,
        ref: syncCfg.ref,
        remote: syncCfg.remote,
        files: [],
        conflicts: [],
        message: 'Another session is syncing the board right now — try again in a moment.',
      };
    }
    return {
      pulled: outcome.remoteTip !== null && outcome.error === undefined,
      ref: syncCfg.ref,
      remote: syncCfg.remote,
      files: [],
      conflicts: outcome.conflicts,
      message:
        outcome.remoteTip === null
          ? `Remote "${syncCfg.remote}" has no "${syncCfg.ref}" ref yet — push first.`
          : outcome.error,
    };
  }
  return pullBoard({
    cwd: deps.root,
    ref: syncCfg.ref,
    remote: syncCfg.remote,
    message: 'chore(taskwright): pull board',
    exec: deps.boardExec,
  });
}

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
    definitionOfDone: task.definitionOfDone,
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
    subtasks: task.subtasks,
    parentTaskId: task.parentTaskId,
    locked: derived?.locked,
    blockedBy: derived?.blockedBy,
    bugs: derived?.bugs,
    activeBugIds: derived?.activeBugIds,
    layout: derived?.layout,
    filePath: task.filePath,
  };
}

/**
 * Load a task and hydrate it into the full `TaskSummary` every context-bearing tool
 * returns (`get_active_task`, `start_task`, `claim_task`) — one shape, one code path.
 * Undefined when the id has no task file.
 */
async function hydrateTaskSummary(
  deps: McpHandlerDeps,
  taskId: string
): Promise<TaskSummary | undefined> {
  const task = await deps.parser.getTask(taskId);
  if (!task) return undefined;
  // Derive subtasks from the full task set (mirror the provider pattern). getTask
  // populates task.subtasks ONLY from the parent's frontmatter subtasks[], but
  // create_subtask writes only the CHILD's parent_task_id — and computeSubtasks (the
  // provider-side derivation) never runs on the MCP path. Without this a dispatched
  // parent returns subtasks: undefined, so /execute-task's independent-subtasks (SDD)
  // branch can never fire. Intentional fail-open: a derive/IO error must not brick
  // the caller (matches the queue/plan-progress catches here).
  try {
    const all = await deps.parser.getTasks();
    computeSubtasks(all);
    const derived = all.find((t) => t.id === task.id);
    if (derived) task.subtasks = derived.subtasks;
  } catch {
    // fail-open — leave task.subtasks as loaded from frontmatter
  }
  // Intentional fail-open: a transient derive/IO error must not brick claims — do not "fix" to fail-closed.
  const states = await loadTreeStateFromParser(deps.parser).catch(() => undefined);
  return toSummary(task, deps.root, states?.get(task.id.trim().toUpperCase()));
}

/** The task's place in the shared merge queue, when it is waiting in one. */
async function queuePositionFor(
  deps: McpHandlerDeps,
  taskId: string
): Promise<number | undefined> {
  try {
    const exec = deps.gitExec ?? defaultGitExec;
    const fsDeps = deps.fsDeps ?? nodeQueueFs;
    const commonDir = path.resolve(
      deps.root,
      (await exec(deps.root, ['rev-parse', '--git-common-dir'])).stdout.trim()
    );
    const pos = positionOf(queueStoreFor(commonDir, fsDeps).read(), taskId);
    return pos > 0 ? pos : undefined;
  } catch {
    // not a git repo / no queue — omit the field
    return undefined;
  }
}

/**
 * The subset of this session's ledger that is genuinely still in flight: the task
 * file still exists and the task has not reached the board's terminal (Done) status.
 * Stale entries (past the claim-staleness window) are ignored — a session that was
 * killed hours ago should not haunt a fresh one that reuses the root.
 */
async function liveSessionTasks(deps: McpHandlerDeps): Promise<SessionTaskEntry[]> {
  const entries = readSessionTasks(deps.root);
  if (entries.length === 0) return [];
  const staleBefore = Date.now() - stalenessMsFromHours(DEFAULT_CLAIM_STALENESS_HOURS);
  const doneStatus = await deps.parser
    .getStatuses()
    .then((s) => s[s.length - 1])
    .catch(() => undefined);

  const live: SessionTaskEntry[] = [];
  for (const entry of entries) {
    const at = Date.parse(entry.at);
    if (Number.isFinite(at) && at < staleBefore) continue;
    const task = await deps.parser.getTask(entry.taskId).catch(() => undefined);
    if (!task) continue; // archived, completed, or never existed
    if (doneStatus && task.status?.trim().toLowerCase() === doneStatus.trim().toLowerCase()) {
      continue; // finished — not something this session is still working on
    }
    live.push(entry);
  }
  return live;
}

/**
 * Resolve the task a session should work on.
 *
 * Order (TASK-129):
 *  1. The **marker** — what the board popover or a dispatch recorded in `root`. It always
 *     wins, so an externally-dispatched session behaves exactly as it always has.
 *  2. The **session ledger** — the task THIS session started (`start_task`) or claimed
 *     (`claim_task`). This closes the self-bootstrap blind spot: `start_task` seeds the
 *     marker inside the NEW worktree while this server stays rooted in the primary tree,
 *     so the session that just bootstrapped a worktree could never see its own task.
 *  3. Nothing — or, with several tasks in flight, an honest **ambiguous** answer. One
 *     orchestrator session shares one MCP server across all its in-session subagents and
 *     MCP calls carry no working directory, so the server cannot tell which subagent is
 *     asking. Guessing (e.g. "most recent") would hand N-1 of them someone else's task;
 *     `active: false` + `candidates` is the only correct answer. That is why every caller
 *     should work from the context `start_task` / `claim_task` already handed back.
 */
export async function getActiveTask(deps: McpHandlerDeps): Promise<ActiveTaskResult> {
  const active = readActiveTask(deps.root);
  if (active) {
    const task = await hydrateTaskSummary(deps, active.taskId);
    if (!task) {
      return {
        active: false,
        source: 'none',
        message: `Active task ${active.taskId} was set but no matching task file was found.`,
      };
    }
    return {
      active: true,
      source: 'marker',
      task,
      queuePosition: await queuePositionFor(deps, active.taskId),
    };
  }

  const live = await liveSessionTasks(deps);

  if (live.length === 1) {
    const entry = live[0];
    const task = await hydrateTaskSummary(deps, entry.taskId);
    if (task) {
      return {
        active: true,
        source: 'session',
        task,
        queuePosition: await queuePositionFor(deps, entry.taskId),
        message:
          `No active-task marker is set here, so this resolved to the task this session ` +
          `took on (${entry.via}): ${task.id}.`,
      };
    }
  }

  if (live.length > 1) {
    const ids = live.map((e) => e.taskId);
    return {
      active: false,
      source: 'none',
      candidates: ids,
      message:
        `This session has ${ids.length} tasks in flight (${ids.join(', ')}) and no active-task ` +
        `marker, and an MCP call carries no working directory — so the server cannot tell which ` +
        `of them is asking. Work from the task context that start_task / claim_task returned for ` +
        `YOUR task; do not re-derive it here.`,
    };
  }

  return {
    active: false,
    source: 'none',
    message:
      'No active task is set. Pick a task on the Taskwright board (or dispatch one), or run ' +
      '/execute-task naming a task (e.g. /execute-task TASK-7) to bootstrap its worktree from here.',
  };
}

/**
 * Best-effort branch/worktree of the calling session, used to derive the
 * per-session claimant identity (TASK-89). Precedence: explicit `worktree` arg
 * → `.worktrees/<branch>` segment of the session root (dispatched sessions;
 * git-free) → the root's git branch (primary-rooted sessions). Undefined when
 * nothing is derivable (detached HEAD, not a repo).
 */
async function deriveClaimantBranch(
  deps: McpHandlerDeps,
  explicit?: string
): Promise<string | undefined> {
  const arg = explicit?.trim();
  if (arg) return arg;
  const fromPath = worktreeBranchFromPath(deps.root);
  if (fromPath) return fromPath;
  try {
    const exec = deps.gitExec ?? defaultGitExec;
    const branch = (await exec(deps.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    return branch && branch !== 'HEAD' ? branch : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Place an advisory claim on a task so other sessions can see it is in progress.
 *
 * The claimant identity is per-session and worktree-derived (`@agent/<branch>`,
 * see {@link agentClaimIdentity}) unless an explicit `claimedBy` is given, so a
 * relaunched session in the same worktree recognizes its own claim. Re-claiming
 * your own task is an idempotent no-op (`claimed: true, alreadyClaimed: true`);
 * a live claim by a DIFFERENT identity surrenders (`claimed: false,
 * surrendered: true, heldBy`) instead of silently overwriting. Stale foreign
 * claims (older than the staleness window) and legacy generic '@agent' claims
 * are reclaimed/upgraded in place.
 */
export async function claimTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string; claimedBy?: string; worktree?: string }
): Promise<ClaimResult> {
  // Dependency gate: a locked task cannot be claimed by an agent.
  // Intentional fail-open: a transient derive/IO error must not brick claims — do not "fix" to fail-closed.
  const states = await loadTreeStateFromParser(deps.parser).catch(() => undefined);
  const derived = states?.get(args.taskId.trim().toUpperCase());
  if (derived?.locked) {
    return { claimed: false, taskId: args.taskId, locked: true, blockedBy: derived.blockedBy };
  }

  const task = await deps.parser.getTask(args.taskId);
  if (!task) {
    throw new Error(`Task ${args.taskId} not found`);
  }

  const branch = await deriveClaimantBranch(deps, args.worktree);
  const claimedBy = args.claimedBy?.trim() || agentClaimIdentity(branch);

  const action = resolveClaimAction(
    { claimedBy: task.claimedBy, claimedAt: task.claimedAt },
    claimedBy,
    stalenessMsFromHours(DEFAULT_CLAIM_STALENESS_HOURS)
  );
  if (action === 'conflict') {
    return { claimed: false, taskId: args.taskId, surrendered: true, heldBy: task.claimedBy };
  }
  if (action === 'self') {
    // Idempotent re-claim: the caller already holds it — echo the existing claim.
    recordSessionTask(deps.root, {
      taskId: task.id,
      worktree: task.worktree,
      via: 'claim_task',
    });
    return {
      claimed: true,
      taskId: args.taskId,
      claimedBy,
      worktree: task.worktree,
      claimedAt: task.claimedAt,
      alreadyClaimed: true,
      task: await hydrateTaskSummary(deps, task.id),
    };
  }

  const claim = await deps.claimService.claimTask(args.taskId, claimedBy, deps.parser, {
    worktree: args.worktree?.trim() || branch,
  });
  recordSessionTask(deps.root, {
    taskId: task.id,
    worktree: claim.worktree,
    via: 'claim_task',
  });
  return {
    claimed: true,
    taskId: args.taskId,
    claimedBy: claim.claimedBy,
    worktree: claim.worktree,
    claimedAt: claim.claimedAt,
    // Hydrated AFTER the claim write, so the context reflects the post-claim state
    // (claim advances To Do -> In Progress); a stale echo would mislead the caller.
    task: await hydrateTaskSummary(deps, task.id),
  };
}

/** Remove the advisory claim from a task. */
export async function releaseTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<ReleaseResult> {
  await deps.claimService.releaseTask(args.taskId, deps.parser);
  // Released == no longer in flight for this session (handed off, or done with it).
  forgetSessionTask(deps.root, args.taskId);
  return { released: true, taskId: args.taskId };
}

/** Link a task to its implementation plan/spec so the board can track progress. */
export async function attachPlanHandler(
  deps: McpHandlerDeps,
  args: { taskId: string; plan: string }
): Promise<AttachPlanResult> {
  const plan = await deps.planService.attachPlan(args.taskId, args.plan, deps.parser);
  return { attached: true, taskId: args.taskId, plan };
}

/** Resolve the board config file (config.yml preferred, then config.yaml). */
function resolveConfigPath(backlogPath: string): string | undefined {
  const yml = path.join(backlogPath, 'config.yml');
  if (fs.existsSync(yml)) return yml;
  const yaml = path.join(backlogPath, 'config.yaml');
  if (fs.existsSync(yaml)) return yaml;
  return undefined;
}

export interface CreateCategoryResult {
  created: boolean;
  category: string;
}

/** Add a tech-tree lane (category) to config.yml. Idempotent on a case-insensitive dupe
 *  (against config ∪ discovered ∪ reserved). Rejects blank and reserved names. */
export async function createCategoryHandler(
  deps: McpHandlerDeps,
  args: { category: string }
): Promise<CreateCategoryResult> {
  const category = args.category?.trim();
  if (!category) throw new Error('A category name is required.');
  if (isReservedCategory(category)) {
    throw new Error(
      `"${category}" is a reserved lane (Bugs/Misc/Backburner) and cannot be created as a category.`
    );
  }
  // getCategories() = config ∪ discovered (reserved excluded, sorted). Dupe → idempotent.
  const existing = await deps.parser.getCategories();
  const match = existing.find((c) => c.toLowerCase() === category.toLowerCase());
  if (match) return { created: false, category: match };

  const configPath = resolveConfigPath(deps.backlogPath);
  if (!configPath) throw new Error('No backlog config.yml was found to add the category to.');
  const raw = fs.readFileSync(configPath, 'utf-8');
  const hasCRLF = detectCRLF(raw);
  const updated = addCategoryLine(normalizeToLF(raw), category);
  fs.writeFileSync(configPath, restoreLineEndings(updated, hasCRLF), 'utf-8');
  deps.parser.invalidateConfigCache();
  return { created: true, category };
}

export interface CreateMilestoneResult {
  created: boolean;
  id: string;
  milestone: string;
}

/** Add a milestone band (age) to the board by wrapping BacklogWriter.createMilestone (files
 *  under backlog/milestones/). Idempotent on a case-insensitive NAME match against the existing
 *  milestones -> { created:false, id, milestone }. Rejects blank and the reserved 'Backburner'
 *  band (the virtual rightmost band for no-milestone tasks). Band order is CREATION order
 *  (monotonic m-N ids), so there is no `order` param. */
export async function createMilestoneHandler(
  deps: McpHandlerDeps,
  args: { name: string; description?: string }
): Promise<CreateMilestoneResult> {
  const name = args.name?.trim();
  if (!name) throw new Error('A milestone name is required.');
  if (name.toLowerCase() === BACKBURNER_BAND.toLowerCase()) {
    throw new Error(
      `"${name}" is the reserved virtual band (Backburner, for no-milestone tasks) and cannot be created as a milestone.`
    );
  }
  // Idempotent on a case-insensitive name match (mirror create_category's dupe contract).
  const existing = await deps.parser.getMilestones();
  const match = existing.find((m) => m.name.toLowerCase() === name.toLowerCase());
  if (match) return { created: false, id: match.id, milestone: match.name };

  const milestone = await deps.writer.createMilestone(
    deps.backlogPath,
    name,
    args.description,
    deps.parser // dedup backstop
  );
  deps.parser.invalidateMilestoneCache();
  return { created: true, id: milestone.id, milestone: milestone.name };
}

export interface CategorySummary {
  category: string;
  count: number;
  reserved: boolean;
}

/** The tech-tree lane vocabulary (canvas parity: config order + discovered + Misc + Bugs)
 *  with a task count per lane over the tasks+drafts universe. */
export async function listCategoriesHandler(deps: McpHandlerDeps): Promise<CategorySummary[]> {
  const [board, tasks, drafts] = await Promise.all([
    loadTreeBoardFromParser(deps.parser),
    deps.parser.getTasks(),
    deps.parser.getDrafts(),
  ]);
  // Key by lowercased lane so a task whose stored category casing differs from the
  // canonical laneOrder entry is still counted (mirrors the milestone bandByLower defense).
  const counts = new Map<string, number>();
  for (const t of [...tasks, ...drafts]) {
    const lane = laneOf(t).toLowerCase();
    counts.set(lane, (counts.get(lane) ?? 0) + 1);
  }
  const reserved = new Set([MISC_LANE, BUGS_LANE]);
  return board.laneOrder.map((category) => ({
    category,
    count: counts.get(category.toLowerCase()) ?? 0,
    reserved: reserved.has(category),
  }));
}

export interface MilestoneSummary {
  id?: string;
  name: string;
  order: number;
  taskCount: number;
  doneCount: number;
}

/** The milestone band order (canvas parity: declared -> discovered -> Backburner) with
 *  task/done counts per band over the tasks+drafts universe. Backburner absorbs
 *  tasks with no/unknown milestone (band semantics). */
export async function listMilestonesHandler(deps: McpHandlerDeps): Promise<MilestoneSummary[]> {
  const [board, tasks, drafts, milestones, config] = await Promise.all([
    loadTreeBoardFromParser(deps.parser),
    deps.parser.getTasks(),
    deps.parser.getDrafts(),
    deps.parser.getMilestones(),
    deps.parser.getConfig(),
  ]);
  const doneStatus = resolveDoneStatus(config.statuses);
  const idByName = new Map(milestones.map((m: Milestone) => [m.name.toLowerCase(), m.id]));
  const resolveBand = makeBandResolver(board);
  const totals = new Map<string, { taskCount: number; doneCount: number }>();
  for (const t of [...tasks, ...drafts]) {
    const band = resolveBand(t);
    const agg = totals.get(band) ?? { taskCount: 0, doneCount: 0 };
    agg.taskCount++;
    if (t.status === doneStatus) agg.doneCount++;
    totals.set(band, agg);
  }
  return board.bandOrder.map((name, order) => {
    const agg = totals.get(name) ?? { taskCount: 0, doneCount: 0 };
    const id = name === BACKBURNER_BAND ? undefined : idByName.get(name.toLowerCase());
    return {
      ...(id ? { id } : {}),
      name,
      order,
      taskCount: agg.taskCount,
      doneCount: agg.doneCount,
    };
  });
}

export interface BoardTaskSummary {
  id: string;
  title: string;
  status: string;
  priority?: string;
  category?: string;
  milestone?: string;
  type?: string;
  causedBy?: string;
  dependencies: string[];
  blockedBy: string[];
  locked: boolean;
  draft: boolean;
}

/** Build a milestone→band resolver for one board: a task's trimmed milestone mapped to
 *  its canonical band (case-insensitive), or Backburner when unset/unknown. One definition
 *  shared by list_milestones and get_board (mirrors the shared toBoardSummary). */
function makeBandResolver(
  board: Awaited<ReturnType<typeof loadTreeBoardFromParser>>
): (task: Task) => string {
  const bandByLower = new Map(board.bandOrder.map((b) => [b.toLowerCase(), b]));
  return (task: Task): string => {
    const m = task.milestone?.trim();
    if (!m) return BACKBURNER_BAND;
    return bandByLower.get(m.toLowerCase()) ?? BACKBURNER_BAND;
  };
}

/** Shape one task into the compact board summary. Unset category/milestone are OMITTED
 *  (callers read reserved lane/band names from list_categories/list_milestones — the
 *  fields themselves are never synthesized to Misc/Backburner). */
function toBoardSummary(
  task: Task,
  board: Awaited<ReturnType<typeof loadTreeBoardFromParser>>
): BoardTaskSummary {
  const st = board.states.get(task.id.trim().toUpperCase());
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    category: task.category?.trim() || undefined,
    milestone: task.milestone?.trim() || undefined,
    type: task.type,
    causedBy: task.causedBy,
    dependencies: task.dependencies,
    blockedBy: st?.blockedBy ?? [],
    locked: st?.locked ?? false,
    draft: task.folder === 'drafts',
  };
}

export interface GetBoardArgs {
  category?: string;
  milestone?: string;
  status?: string;
}

/** Compact, filterable board view over the tasks+drafts universe (completed/archived
 *  gate only, never appear). Filters use laneOf/band semantics so 'Bugs'/'Misc'/
 *  'Backburner' work. */
export async function getBoardHandler(
  deps: McpHandlerDeps,
  args: GetBoardArgs = {}
): Promise<BoardTaskSummary[]> {
  const [board, tasks, drafts] = await Promise.all([
    loadTreeBoardFromParser(deps.parser),
    deps.parser.getTasks(),
    deps.parser.getDrafts(),
  ]);
  const resolveBand = makeBandResolver(board);
  const catF = args.category?.trim().toLowerCase();
  const mileF = args.milestone?.trim().toLowerCase();
  const statF = args.status?.trim().toLowerCase();
  const out: BoardTaskSummary[] = [];
  for (const t of [...tasks, ...drafts]) {
    if (catF && laneOf(t).toLowerCase() !== catF) continue;
    if (mileF && resolveBand(t).toLowerCase() !== mileF) continue;
    if (statF && t.status.toLowerCase() !== statF) continue;
    out.push(toBoardSummary(t, board));
  }
  return out;
}

/** Ranked keyword search over the tasks+drafts universe; returns the same compact
 *  summaries as get_board. Empty query throws (use get_board for the whole board). */
export async function searchTasksHandler(
  deps: McpHandlerDeps,
  args: { query: string; limit?: number }
): Promise<BoardTaskSummary[]> {
  const [board, tasks, drafts] = await Promise.all([
    loadTreeBoardFromParser(deps.parser),
    deps.parser.getTasks(),
    deps.parser.getDrafts(),
  ]);
  const ranked = searchTasks([...tasks, ...drafts], args.query, { limit: args.limit });
  return ranked.map((t) => toBoardSummary(t, board));
}

export interface NextReadyArgs {
  limit?: number;
  category?: string;
  milestone?: string;
  /** When true, return a CONFLICT-SAFE batch: ready tasks whose attached-plan file footprints
   *  are pairwise disjoint (unknown-footprint tasks returned solo), so the batch can be
   *  dispatched in parallel without merge collisions. `limit` caps the batch (fan-out). */
  parallelSafe?: boolean;
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
      deps.root,
      (await exec(deps.root, ['rev-parse', '--git-common-dir'])).stdout.trim()
    );
    inMergeQueue = queueStoreFor(commonDir, fsDeps)
      .read()
      .entries.map((e) => e.taskId);
  } catch {
    // not a git repo / no queue — nothing to exclude
  }

  const orderedReady = selectReadyTasks(tasks, board, {
    doneStatus: resolveDoneStatus(config.statuses),
    priorities: resolvePriorities(config),
    stalenessMs: stalenessMsFromHours(DEFAULT_CLAIM_STALENESS_HOURS),
    inMergeQueue,
    category: args.category,
    milestone: args.milestone,
    // In parallelSafe mode the disjoint-batch step below applies the cap; take the full ordered
    // ready set here so a high-priority-but-overlapping task can be deferred for a lower-priority
    // disjoint one rather than truncated away by `limit`.
    limit: args.parallelSafe ? undefined : args.limit,
  });

  if (!args.parallelSafe) {
    return orderedReady.map((t) => toBoardSummary(t, board));
  }

  // Conflict-safe batch: co-dispatch only tasks whose attached-plan "File Structure" footprints
  // are pairwise disjoint, so their branches won't collide at merge time. A task with no
  // (readable) plan has an UNKNOWN footprint and is returned only as a solo batch. Any conflict
  // that still slips through (an under-declared footprint) is the dispatched agent's to resolve
  // during request_merge's rebase — this MINIMIZES conflicts, it does not replace that.
  const repoRoot = path.dirname(deps.backlogPath);
  const filesById = new Map<string, string[]>();
  for (const t of orderedReady) {
    if (!t.plan) continue; // no attached plan ⇒ unknown footprint (absent from the map)
    try {
      const content = fs.readFileSync(path.join(repoRoot, t.plan), 'utf-8');
      filesById.set(t.id, extractPlanFiles(content));
    } catch {
      // unreadable plan ⇒ leave the footprint unknown
    }
  }
  const cap = args.limit ?? orderedReady.length;
  const batchIds = selectDisjointBatch(
    orderedReady.map((t) => t.id),
    filesById,
    cap
  );
  const byId = new Map(orderedReady.map((t) => [t.id, t]));
  return batchIds.map((id) => toBoardSummary(byId.get(id)!, board));
}

export interface BoardDoctorResult {
  healthy: boolean;
  findings: DoctorFinding[];
}

/**
 * `board_doctor`: read-only health check over the board + `.taskwright/` +
 * `.worktrees/` state (dangling active-task pointer, stale handoffs, orphaned
 * worktrees, in-flight tasks with no claim, claims whose worktree vanished,
 * malformed categories, dangling frontmatter continuations). Same core the
 * extension's activation check and `taskwright.doctor` command run (parity);
 * repairs are the extension's job — this tool never mutates anything. Use it
 * to pre-flight the board before orchestrating.
 */
export async function boardDoctorHandler(deps: McpHandlerDeps): Promise<BoardDoctorResult> {
  // getPrimaryRoot, not dirname(backlogPath): in git-auto the backlog path is
  // inside .taskwright/board, whose dirname is NOT the repo root.
  const repoRoot = deps.parser.getPrimaryRoot();
  let opts: { syncMode?: SyncMode; ref?: string; commonDir?: string } = {};
  try {
    const facts = await gitFacts(deps.gitExec ?? defaultGitExec, deps.root);
    const syncCfg = readSyncConfig(syncConfigPath(facts.commonDir), deps.fsDeps ?? nodeQueueFs);
    // commonDir also enables check 12: merge-verify commands that do not fit this
    // repo — the pre-flight an agent wants BEFORE it spends a task on a gate that
    // was never going to run (TASK-132).
    opts = { syncMode: syncCfg.mode, ref: syncCfg.ref, commonDir: facts.commonDir };
  } catch {
    // Not a git repo — the base checks still run; the board-home checks stay off.
  }
  const findings = await runBoardDoctor(deps.parser, repoRoot, opts);
  return { healthy: findings.length === 0, findings };
}

/** Re-read a just-written task and shape it for return; throws if it vanished. */
async function requireSummary(deps: McpHandlerDeps, taskId: string): Promise<TaskSummary> {
  const task = await deps.parser.getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} was written but could not be read back.`);
  }
  // Intentional fail-open: a transient derive/IO error must not brick claims — do not "fix" to fail-closed.
  const states = await loadTreeStateFromParser(deps.parser).catch(() => undefined);
  return toSummary(task, deps.root, states?.get(task.id.trim().toUpperCase()));
}

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
  acceptanceCriteria?: ChecklistInput[];
  definitionOfDone?: ChecklistInput[];
  implementationPlan?: string;
  implementationNotes?: string;
  finalSummary?: string;
  references?: string[];
  draft?: boolean;
}

/** Create a task (or draft) and return its summary. A draft is minted with a real TASK-N id
 *  from the shared counter (TASK-115), so the id in the returned summary is FINAL — promotion
 *  never changes it, and callers may reference it immediately. */
export async function createTaskHandler(
  deps: McpHandlerDeps,
  args: CreateTaskArgs
): Promise<TaskSummary> {
  const config = await deps.parser.getConfig();
  if (args.status !== undefined) assertValidStatus(args.status, config.statuses ?? []);
  if (args.priority !== undefined) assertValidPriority(args.priority, resolvePriorities(config));
  await assertDependenciesValid(deps, args.dependencies ?? []); // no targetId: new task cannot form a cycle

  // Render checklist inputs to the string body form the core/writer expect (edit_task parity),
  // so an author can seed acceptance criteria / DoD at create without a follow-up edit_task.
  const created = await createTaskWithTreeFields(deps, {
    ...args,
    acceptanceCriteria: args.acceptanceCriteria
      ? renderChecklist(args.acceptanceCriteria)
      : undefined,
    definitionOfDone: args.definitionOfDone ? renderChecklist(args.definitionOfDone) : undefined,
  });
  return requireSummary(deps, created.id);
}

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

export interface MoveResult {
  taskId: string;
  outcome: 'completed' | 'archived' | 'restored';
  path: string;
}

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

/** Archive a task — into archive/tasks/, or archive/drafts/ when it lives in drafts/ (TASK-117). */
export async function archiveTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<MoveResult> {
  const dest = await deps.writer.archiveTask(args.taskId, deps.parser);
  return { taskId: args.taskId, outcome: 'archived', path: dest };
}

/** Restore an archived task to the folder it was archived FROM — archive/drafts/ → drafts/,
 *  archive/tasks/ → tasks/. Routed by folder, never by id prefix (TASK-117). */
export async function restoreTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<MoveResult> {
  const dest = await deps.writer.restoreArchivedTask(args.taskId, deps.parser);
  return { taskId: args.taskId, outcome: 'restored', path: dest };
}

/** Promote a draft to a task. Ids are stable, so this is normally a pure move that KEEPS the
 *  id (TASK-116). Still routes through the bulk core, which remaps inbound references for the
 *  legacy DRAFT-N case where the id does change (contract unchanged: returns the promoted
 *  task summary). */
export async function promoteDraftHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<TaskSummary> {
  const { promoted } = await promoteDrafts(deps, [args.taskId]);
  const to = promoted[0]?.to;
  if (!to) throw new Error(`Draft ${args.taskId} could not be promoted.`);
  return requireSummary(deps, to);
}

/** Promote a set of drafts at once, remapping inbound dependency/caused_by edges so a
 *  linked proposal set keeps its structure. Returns { promoted:[{from,to}], remapped:[] }. */
export async function promoteDraftsHandler(
  deps: McpHandlerDeps,
  args: { taskIds: string[] }
): Promise<PromoteDraftsResult> {
  const ids = args.taskIds ?? [];
  return promoteDrafts(deps, ids);
}

/** Demote a task to a draft: a pure file move (TASK-116) — the id is KEPT, so nothing that
 *  referenced the task dangles, and the status is preserved (P6/D2e). */
export async function demoteTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<TaskSummary> {
  const newId = await deps.writer.demoteTask(args.taskId, deps.parser);
  return requireSummary(deps, newId);
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

/** Create a subtask under a parent and return its summary. */
export async function createSubtaskHandler(
  deps: McpHandlerDeps,
  args: { parentTaskId: string; title?: string; description?: string }
): Promise<TaskSummary> {
  const created = await deps.writer.createSubtask(
    args.parentTaskId,
    deps.backlogPath,
    deps.parser,
    {
      title: args.title,
      description: args.description,
    }
  );
  return requireSummary(deps, created.id);
}
