/**
 * Board doctor (TASK-90) — a pure health check over the board + `.taskwright/`
 * + `.worktrees/` state that accumulates drift across dispatched sessions:
 * dangling active-task pointers, leftover handoff files, orphaned worktrees,
 * in-flight tasks nobody is working on, claims whose worktree vanished,
 * mangled category values, and the historical folded-continuation frontmatter
 * corruption (TASK-89's writer-level fix stops NEW corruption; old board data
 * may still carry it).
 *
 * `diagnoseBoard` is pure — every fact is injected — so it is unit-testable and
 * shared verbatim by the extension (activation check + `taskwright.doctor`) and
 * the MCP `board_doctor` read tool (orchestration pre-flight). Repairs are NOT
 * performed here: each finding carries a declared repair kind the caller routes
 * through the existing writers (activeTask.ts, claimActions/ClaimService,
 * cancelDispatch/removeWorktree, TreeFieldService) after user confirmation.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { BacklogParser } from './BacklogParser';
import { normalizeToLF } from './BacklogWriter';
import { dispatchBranchName } from './dispatchPrompt';
import { readActiveTask } from './activeTask';
import { splitFrontmatter } from './frontmatterEdit';
import type { SyncMode } from './syncConfig';
import { BOARD_SUBDIRS } from './boardRef';
import { boardWorktreePathFor } from './boardRoot';
import { boardWorktreeStatusOf } from './boardWorktree';

export type DoctorFindingType =
  | 'dangling-active-task'
  | 'stale-handoff'
  | 'orphaned-worktree'
  | 'in-flight-no-claim'
  | 'claim-worktree-vanished'
  | 'malformed-category'
  | 'dangling-continuation'
  | 'board-worktree-missing'
  | 'board-strays-in-primary'
  | 'board-mode-mismatch';

/** The one-click repair a finding calls for; the caller confirms + executes. */
export type DoctorRepair =
  | 'clear-active-task'
  | 'delete-handoff'
  | 'teardown-worktree'
  | 'reset-status'
  | 'release-claim'
  | 'fix-category'
  | 'strip-continuations'
  | 'repair-board-worktree'
  | 'fold-primary-strays'
  | 'restore-board-to-primary';

export interface DoctorFinding {
  type: DoctorFindingType;
  repair: DoctorRepair;
  /** Human-readable, one-line description of the problem. */
  message: string;
  /** The task the finding is about, when one can be identified. */
  taskId?: string;
  /** The offending artifact: a worktree dir name, category value, etc. */
  detail?: string;
  /** For `fix-category`: the replacement value ('' means clear the field). */
  suggestion?: string;
}

/** The slice of a task the doctor needs; mirrors Task but stays decoupled. */
export interface DoctorTask {
  id: string;
  title: string;
  status: string;
  claimedBy?: string;
  worktree?: string;
  category?: string;
  /** Raw task-file content, enabling the frontmatter-continuation check. */
  rawContent?: string;
}

export interface BoardDoctorInput {
  /** Active board tasks (the `tasks/` folder). */
  tasks: DoctorTask[];
  /** Configured statuses in board order; first = ready, `Done` (or last) = terminal. */
  statuses: string[];
  /** CONFIGURED category vocabulary (config.yml only — never discovered values,
   *  which would include the very corruption being checked for). */
  categories: string[];
  /** Task ID recorded in the primary root's `.taskwright/active-task.json`. */
  activeTaskId?: string;
  /** Task IDs that have a `.taskwright/handoff/<id>.md` file. */
  handoffTaskIds: string[];
  /** Directory names present under `.worktrees/`. */
  worktreeDirs: string[];
  /** Additional known task IDs (drafts/completed/archived) that keep an
   *  active-task pointer valid even though they are not on the active board. */
  extraKnownTaskIds?: string[];
  /** Current sync mode; the board-home checks (8–10) only run when provided. */
  syncMode?: SyncMode;
  /** git-auto: the hidden board worktree is healthy (`boardWorktreeStatusOf` === 'ok'). */
  boardWorktreeOk?: boolean;
  /** The `.taskwright/board` directory exists at all (registered or not). */
  boardWorktreePresent?: boolean;
  /** git-auto: state-dir names found straying under the primary `backlog/`. */
  primaryStateDirs?: string[];
  /** off/git: the primary `backlog/tasks` directory exists. */
  primaryTasksPresent?: boolean;
}

/** Facts gathered from the filesystem for {@link diagnoseBoard}. */
export interface DoctorFacts {
  activeTaskId?: string;
  handoffTaskIds: string[];
  worktreeDirs: string[];
}

const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function doneStatusOf(statuses: string[]): string | undefined {
  return (
    statuses.find((s) => s.toLowerCase() === 'done') ??
    (statuses.length > 0 ? statuses[statuses.length - 1] : undefined)
  );
}

/** True when `worktree` names a Taskwright-managed `.worktrees/<branch>` dir for `task`. */
function isManagedWorktreeName(task: DoctorTask, worktree: string): boolean {
  const idSlug = task.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return worktree === dispatchBranchName(task) || worktree.toLowerCase().startsWith(`${idSlug}-`);
}

/**
 * A category value is malformed when it shows corruption signals — a swallowed
 * branch-name token (`task-NN-…`), an embedded `key: value` fragment, or an
 * implausible length — while not being an exact configured category. Free-form
 * *discovered* categories are legal and never flagged on membership alone.
 */
function isMalformedCategory(value: string, configured: string[]): boolean {
  if (configured.some((c) => c === value)) return false;
  if (/\btask-\d+[a-z0-9-]*/i.test(value) && !/^task-\d+$/i.test(value.trim())) return true;
  if (/\S:\s/.test(value)) return true;
  if (/[\r\n]/.test(value)) return true;
  return value.length > 64;
}

/** The longest configured category that prefixes the mangled value, or ''. */
function suggestedCategory(value: string, configured: string[]): string {
  let best = '';
  for (const c of configured) {
    if (c.length > best.length && (value === c || value.startsWith(`${c} `))) best = c;
  }
  return best;
}

/** True when a frontmatter line continues the previous field's value (indented). */
const isIndented = (line: string): boolean => /^[ \t]/.test(line);
/** True for a legit block-sequence item (`  - value`). */
const isSequenceItem = (line: string): boolean => /^[ \t]+-(\s|$)/.test(line);
/** True when a field line's value is a block-scalar indicator (`>-`, `|`, …). */
const isBlockScalarValue = (value: string): boolean => /^[>|][+-]?\s*$/.test(value.trim());

/**
 * The dangling folded-continuation lines in a task file's frontmatter: indented
 * lines that are NOT block-sequence items and follow a field whose scalar value
 * is already complete on the key line — the residue of a folded (`>-`) value
 * whose key line was removed or rewritten by a pre-TASK-89 surgical edit.
 * Returns the offending lines verbatim; [] for clean or frontmatter-less files.
 */
export function findDanglingContinuations(content: string): string[] {
  const split = splitFrontmatter(content);
  if (!split) return [];
  const dangling: string[] = [];
  // Whether indented lines under the current key are legitimate: block
  // sequences (`key:` + `  - v`) and explicit block scalars (`key: >-`) are.
  let continuationLegit = true;
  for (const line of split.fields) {
    const keyMatch = line.match(/^(\S[^:]*):(.*)$/);
    if (keyMatch) {
      const value = keyMatch[2];
      continuationLegit = value.trim() === '' || isBlockScalarValue(value);
      continue;
    }
    if (isIndented(line) && line.trim() !== '') {
      if (!continuationLegit && !isSequenceItem(line)) dangling.push(line);
    }
  }
  return dangling;
}

/**
 * Remove the dangling continuation lines {@link findDanglingContinuations}
 * identifies, preserving every other line byte-for-byte. Idempotent; returns
 * the exact input when there is nothing to strip.
 */
export function stripDanglingContinuations(content: string): string {
  const dangling = findDanglingContinuations(content);
  if (dangling.length === 0) return content;
  const split = splitFrontmatter(content);
  if (!split) return content;
  const remaining = [...dangling];
  const fields = split.fields.filter((line) => {
    const idx = remaining.indexOf(line);
    if (idx !== -1) {
      remaining.splice(idx, 1);
      return false;
    }
    return true;
  });
  return [...split.before, ...fields, ...split.after].join('\n');
}

/**
 * Diagnose a board snapshot into a typed findings list. Pure — no I/O — and
 * stable: findings are grouped by check in a fixed order, so repeated runs on
 * unchanged state return identical output (idempotent activation checks).
 */
export function diagnoseBoard(input: BoardDoctorInput): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const { tasks, statuses } = input;
  const firstStatus = statuses[0];
  const doneStatus = doneStatusOf(statuses);
  const isDone = (t: DoctorTask): boolean =>
    doneStatus !== undefined && t.status.toLowerCase() === doneStatus.toLowerCase();
  const isInFlight = (t: DoctorTask): boolean =>
    !isDone(t) &&
    (firstStatus === undefined || t.status.toLowerCase() !== firstStatus.toLowerCase());
  const findTask = (id: string): DoctorTask | undefined => tasks.find((t) => sameId(t.id, id));
  const worktreeDirSet = new Set(input.worktreeDirs);

  // 1. Dangling active-task pointer.
  if (input.activeTaskId) {
    const known =
      findTask(input.activeTaskId) !== undefined ||
      (input.extraKnownTaskIds ?? []).some((id) => sameId(id, input.activeTaskId!));
    if (!known) {
      findings.push({
        type: 'dangling-active-task',
        repair: 'clear-active-task',
        taskId: input.activeTaskId,
        message: `.taskwright/active-task.json points at ${input.activeTaskId}, which does not exist on the board`,
      });
    }
  }

  // 2. Stale handoff files: the task is Done or gone.
  for (const handoffId of input.handoffTaskIds) {
    const task = findTask(handoffId);
    if (task && !isDone(task)) continue;
    findings.push({
      type: 'stale-handoff',
      repair: 'delete-handoff',
      taskId: handoffId,
      message: task
        ? `Handoff file .taskwright/handoff/${handoffId}.md is left over from a Done task`
        : `Handoff file .taskwright/handoff/${handoffId}.md points at a task that no longer exists`,
    });
  }

  // 3. Claims whose managed worktree vanished.
  for (const task of tasks) {
    if (isDone(task) || !task.claimedBy || !task.worktree) continue;
    if (!isManagedWorktreeName(task, task.worktree)) continue;
    if (worktreeDirSet.has(task.worktree)) continue;
    findings.push({
      type: 'claim-worktree-vanished',
      repair: 'release-claim',
      taskId: task.id,
      detail: task.worktree,
      message: `${task.id} is claimed by ${task.claimedBy} in .worktrees/${task.worktree}, but that worktree no longer exists`,
    });
  }

  // 4. In-flight tasks with no claim and no dispatch worktree on disk.
  for (const task of tasks) {
    if (!isInFlight(task) || task.claimedBy) continue;
    const branch = dispatchBranchName(task);
    if (worktreeDirSet.has(branch) || (task.worktree && worktreeDirSet.has(task.worktree))) {
      continue; // dispatched-but-unclaimed: the worktree accounts for the status
    }
    findings.push({
      type: 'in-flight-no-claim',
      repair: 'reset-status',
      taskId: task.id,
      message: `${task.id} is "${task.status}" but has no claim and no worktree — nobody is working on it`,
    });
  }

  // 5. Orphaned worktree dirs: no live (non-Done) task accounts for them.
  for (const dir of input.worktreeDirs) {
    const owner = tasks.find(
      (t) => !isDone(t) && (t.worktree === dir || dispatchBranchName(t) === dir)
    );
    if (owner) continue;
    const doneOwner = tasks.find(
      (t) => isDone(t) && (t.worktree === dir || dispatchBranchName(t) === dir)
    );
    findings.push({
      type: 'orphaned-worktree',
      repair: 'teardown-worktree',
      taskId: doneOwner?.id,
      detail: dir,
      message: doneOwner
        ? `.worktrees/${dir} is left over from ${doneOwner.id}, which is already Done`
        : `.worktrees/${dir} exists but no task on the board accounts for it`,
    });
  }

  // 6. Malformed category values.
  for (const task of tasks) {
    if (!task.category || !isMalformedCategory(task.category, input.categories)) continue;
    findings.push({
      type: 'malformed-category',
      repair: 'fix-category',
      taskId: task.id,
      detail: task.category,
      suggestion: suggestedCategory(task.category, input.categories),
      message: `${task.id} has a mangled category value: "${task.category}"`,
    });
  }

  // 7. Dangling folded frontmatter continuations (historical corruption class).
  for (const task of tasks) {
    if (!task.rawContent) continue;
    const dangling = findDanglingContinuations(task.rawContent);
    if (dangling.length === 0) continue;
    findings.push({
      type: 'dangling-continuation',
      repair: 'strip-continuations',
      taskId: task.id,
      detail: dangling.map((l) => l.trim()).join(' | '),
      message: `${task.id}'s frontmatter has ${dangling.length} dangling folded continuation line(s)`,
    });
  }

  // 8. git-auto: the hidden board worktree is missing/broken (e.g. git clean
  // -dfx). The branch — the durable store — still holds the data; repair is
  // a prune + re-add, with loss bounded by the debounce window.
  if (input.syncMode === 'git-auto' && input.boardWorktreeOk === false) {
    findings.push({
      type: 'board-worktree-missing',
      repair: 'repair-board-worktree',
      message:
        'sync.mode is git-auto but the hidden board worktree (.taskwright/board) is missing or broken — the taskwright-board branch still holds the data',
    });
  }

  // 9. git-auto: stray state dirs under the primary backlog/ — a stale
  // pre-reload writer recreated them (the split-brain window, spec §5.3).
  if (input.syncMode === 'git-auto' && (input.primaryStateDirs?.length ?? 0) > 0) {
    findings.push({
      type: 'board-strays-in-primary',
      repair: 'fold-primary-strays',
      detail: input.primaryStateDirs!.join(', '),
      message: `Stray board files found under the repo backlog/ (${input.primaryStateDirs!.join(', ')}) while the board lives in its hidden worktree — fold them in`,
    });
  }

  // 10. off/git: the board looks empty because sync.mode was flipped away
  // from git-auto by hand — the leftover .taskwright/board dir is the residue.
  if (
    input.syncMode !== undefined &&
    input.syncMode !== 'git-auto' &&
    input.primaryTasksPresent === false &&
    input.boardWorktreePresent === true
  ) {
    findings.push({
      type: 'board-mode-mismatch',
      repair: 'restore-board-to-primary',
      message: `sync.mode is "${input.syncMode}" but backlog/tasks is missing while a hidden board worktree exists — the board looks empty because the mode was switched without migrating back`,
    });
  }

  return findings;
}

/** Facts for the board-home checks (8–10). Never throws — failures mean "unknown", which disables the checks. */
export async function gatherBoardHomeFacts(
  repoRoot: string,
  syncMode: SyncMode,
  ref: string
): Promise<
  Pick<
    BoardDoctorInput,
    'syncMode' | 'boardWorktreeOk' | 'boardWorktreePresent' | 'primaryStateDirs' | 'primaryTasksPresent'
  >
> {
  try {
    const boardDir = boardWorktreePathFor(repoRoot);
    const primaryStateDirs = BOARD_SUBDIRS.filter((sub) => {
      try {
        const abs = path.join(repoRoot, 'backlog', sub);
        return fs.existsSync(abs) && fs.readdirSync(abs).length > 0;
      } catch {
        return false;
      }
    });
    return {
      syncMode,
      boardWorktreeOk: (await boardWorktreeStatusOf(repoRoot, ref)) === 'ok',
      boardWorktreePresent: fs.existsSync(boardDir),
      primaryStateDirs,
      primaryTasksPresent: fs.existsSync(path.join(repoRoot, 'backlog', 'tasks')),
    };
  } catch {
    return {};
  }
}

/**
 * Gather the filesystem facts {@link diagnoseBoard} needs from the PRIMARY
 * repo root: the active-task pointer, the handoff-file task IDs, and the
 * `.worktrees/` directory names. Never throws — missing dirs mean empty facts.
 */
export function gatherDoctorFacts(repoRoot: string): DoctorFacts {
  const handoffTaskIds: string[] = [];
  const worktreeDirs: string[] = [];
  try {
    for (const entry of fs.readdirSync(path.join(repoRoot, '.taskwright', 'handoff'), {
      withFileTypes: true,
    })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        handoffTaskIds.push(entry.name.slice(0, -'.md'.length));
      }
    }
  } catch {
    // no handoff dir — nothing dispatched yet
  }
  try {
    for (const entry of fs.readdirSync(path.join(repoRoot, '.worktrees'), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) worktreeDirs.push(entry.name);
    }
  } catch {
    // no .worktrees dir
  }
  return {
    activeTaskId: readActiveTask(repoRoot)?.taskId,
    handoffTaskIds,
    worktreeDirs,
  };
}

/**
 * Load the board through a {@link BacklogParser}, gather the filesystem facts
 * for `repoRoot` (the PRIMARY checkout), and diagnose. This is the one shared
 * assembly behind the extension's activation check / `taskwright.doctor`
 * command and the MCP `board_doctor` read tool (parity). Read-only.
 */
export async function runBoardDoctor(
  parser: BacklogParser,
  repoRoot: string,
  opts: { syncMode?: SyncMode; ref?: string } = {}
): Promise<DoctorFinding[]> {
  const [tasks, statuses, config, drafts, completed] = await Promise.all([
    parser.getTasks(),
    parser.getStatuses(),
    parser.getConfig(),
    parser.getDrafts().catch(() => []),
    parser.getCompletedTasks().catch(() => []),
  ]);
  const doctorTasks: DoctorTask[] = tasks.map((t) => {
    let rawContent: string | undefined;
    try {
      rawContent = normalizeToLF(fs.readFileSync(t.filePath, 'utf-8'));
    } catch {
      // unreadable file — skip the continuation check for it
    }
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      claimedBy: t.claimedBy,
      worktree: t.worktree,
      category: t.category,
      rawContent,
    };
  });
  return diagnoseBoard({
    tasks: doctorTasks,
    statuses,
    categories: config.categories ?? [],
    extraKnownTaskIds: [...drafts, ...completed].map((t) => t.id),
    ...gatherDoctorFacts(repoRoot),
    ...(opts.syncMode
      ? await gatherBoardHomeFacts(repoRoot, opts.syncMode, opts.ref ?? 'taskwright-board')
      : {}),
  });
}
