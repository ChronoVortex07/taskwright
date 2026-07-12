import * as fs from 'fs';
import * as path from 'path';
import { defaultBoardExec, refTip, BOARD_SUBDIRS, type BoardGitExec } from './boardRef';
import { boardTrackedPaths } from './boardMigration';
import { boardWorktreePathFor } from './boardRoot';
import { boardWorktreeStatusOf } from './boardWorktree';
import { autoCommitBoard } from './autoSync';
import { mergeBoards, type BoardFileMap, type MergeConflict } from './boardMerge';

/**
 * Migration cores for the git-auto board home (TASK-91, spec §5). The prior-
 * state matrix S0–S6 is classified from injectable facts (pure, testable), and
 * the move itself is *verified per file before anything is deleted* — the
 * ordering IS the safety argument (spec §5.2): any abort leaves every board
 * file in at least one complete home, plus the pre-move ref snapshot.
 */

export interface MigrationFacts {
  /** Any of the five state dirs exists under the primary `backlog/`. */
  hasStateDirs: boolean;
  /** Board paths tracked on the CURRENT code branch (`git ls-files`). */
  trackedBoardFiles: string[];
  localRefTip: string | null;
  boardWorktreeOk: boolean;
  /** v1 CAS leftover: `.taskwright/board.materialized`. */
  hasMaterializedMarker: boolean;
}

export type MigrationStep =
  | 'untrack'
  | 'seed-fresh'
  | 'seed-fold-ref'
  | 'add-worktree'
  | 'verified-move'
  | 'clean-marker'
  | 'noop';

/**
 * The ordered steps a repo needs to reach the git-auto home, from any prior
 * state. Idempotent by construction: an already-migrated repo plans `noop`.
 */
export function planMigrationSteps(facts: MigrationFacts): MigrationStep[] {
  if (facts.boardWorktreeOk && !facts.hasStateDirs) {
    return facts.hasMaterializedMarker ? ['clean-marker', 'noop'] : ['noop'];
  }
  const steps: MigrationStep[] = [];
  if (facts.trackedBoardFiles.length > 0) steps.push('untrack');
  if (facts.hasStateDirs) steps.push(facts.localRefTip ? 'seed-fold-ref' : 'seed-fresh');
  steps.push('add-worktree');
  if (facts.hasStateDirs) steps.push('verified-move');
  if (facts.hasMaterializedMarker) steps.push('clean-marker');
  return steps;
}

/** Why a primary board file did not verify against the board worktree copy. */
export type MoveFailureReason =
  /** No counterpart in the board worktree at all. */
  | 'absent'
  /** Same content, different line endings — see {@link verifyMove}. */
  | 'eol-only'
  /** Genuinely different bytes: the board copy is stale, or diverged. */
  | 'content-drift';

export interface MoveFailure {
  path: string;
  reason: MoveFailureReason;
}

export interface MoveVerification {
  /** True when nothing BLOCKS the move (eol-only differences do not). */
  ok: boolean;
  /** Differences that block: `absent` | `content-drift`. */
  blocking: MoveFailure[];
  /** Verified-but-noteworthy: git's own EOL policy rewrote these. */
  eolOnly: MoveFailure[];
}

const normalizeEol = (s: string): string => s.replace(/\r\n/g, '\n');

/**
 * Verify-before-delete (spec §5.2 step 4): classify every primary board file
 * against its board-worktree copy, so an abort can say WHY, not just which
 * (TASK-123 — the old version returned bare paths and the notification printed
 * one of them with no reason, which is undebuggable).
 *
 * An **EOL-only** difference verifies OK. A repo with `.gitattributes: * text=auto`
 * normalizes CRLF→LF into the blob on `git add` — in-tree attributes override
 * `NO_EOL_CONVERT`'s config flags, which can only silence `core.autocrlf` — so a
 * CRLF task file on disk comes back out of the board worktree as LF. That is the
 * repo's own declared policy applied to the file, not lost content; treating it
 * as a failure made migration permanently impossible in such a repo. The board
 * (LF) becomes canonical and the primary copy is safe to delete. Pure.
 */
export function verifyMove(
  primary: BoardFileMap,
  board: BoardFileMap,
  conflictPaths: ReadonlySet<string>
): MoveVerification {
  const blocking: MoveFailure[] = [];
  const eolOnly: MoveFailure[] = [];
  for (const [rel, content] of Object.entries(primary)) {
    if (conflictPaths.has(rel)) continue; // the merge deliberately chose the other side
    const other = board[rel];
    if (other === content) continue;
    if (other === undefined) blocking.push({ path: rel, reason: 'absent' });
    else if (normalizeEol(other) === normalizeEol(content))
      eolOnly.push({ path: rel, reason: 'eol-only' });
    else blocking.push({ path: rel, reason: 'content-drift' });
  }
  const byPath = (a: MoveFailure, b: MoveFailure): number => a.path.localeCompare(b.path);
  return {
    ok: blocking.length === 0,
    blocking: blocking.sort(byPath),
    eolOnly: eolOnly.sort(byPath),
  };
}

/** True when the two contents differ only by line endings (or not at all). */
function sameModuloEol(a: string | undefined, b: string): boolean {
  return a !== undefined && normalizeEol(a) === normalizeEol(b);
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
 * The five state dirs under `<root>/backlog` as a posix-relative → content
 * map (the same shape `mergeBoards`/`readRefFileMap` speak).
 */
export function readBoardDirFileMap(root: string): BoardFileMap {
  const map: BoardFileMap = {};
  for (const sub of BOARD_SUBDIRS) {
    const absDir = path.join(root, 'backlog', sub);
    if (!fs.existsSync(absDir)) continue;
    for (const abs of walkFiles(absDir)) {
      const rel = path.relative(root, abs).split(path.sep).join('/');
      map[rel] = fs.readFileSync(abs, 'utf-8');
    }
  }
  return map;
}

/** Facts for {@link planMigrationSteps}, gathered from a real repo. */
export async function gatherMigrationFacts(
  primaryRoot: string,
  ref: string,
  deps: { exec?: BoardGitExec; pathExists?: (p: string) => boolean } = {}
): Promise<MigrationFacts> {
  const exec = deps.exec ?? defaultBoardExec;
  const pathExists = deps.pathExists ?? fs.existsSync;

  let trackedBoardFiles: string[] = [];
  try {
    const { stdout } = await exec(primaryRoot, ['ls-files', '--', ...boardTrackedPaths()]);
    trackedBoardFiles = stdout.split('\n').filter((l) => l.trim().length > 0);
  } catch {
    // not a git repo / git unavailable — treat as untracked
  }

  return {
    hasStateDirs: BOARD_SUBDIRS.some((sub) => pathExists(path.join(primaryRoot, 'backlog', sub))),
    trackedBoardFiles,
    localRefTip: await refTip(primaryRoot, ref, exec),
    boardWorktreeOk: (await boardWorktreeStatusOf(primaryRoot, ref, { exec, pathExists })) === 'ok',
    hasMaterializedMarker: pathExists(path.join(primaryRoot, '.taskwright', 'board.materialized')),
  };
}

export interface VerifiedMoveResult {
  /** Files deleted from the primary after byte-verification. */
  moved: number;
  /** Files left in place because a delete kept failing (EBUSY etc.) — surfaced, never fatal. */
  lockedLeftBehind: string[];
  /** Files left in place because the board copy differs and no conflict covers them. */
  notInBoard: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Delete the primary's board state files — per-file, and only after verifying
 * the board worktree holds identical bytes (or the fold surfaced the file as
 * a conflict). Windows-tolerant: one retry on a locked delete, then the file
 * is left behind and reported (the stray-fold heal picks it up later). Empty
 * state dirs are pruned afterwards.
 */
export async function executeVerifiedMove(opts: {
  primaryRoot: string;
  boardWorktree: string;
  conflictPaths?: ReadonlySet<string>;
}): Promise<VerifiedMoveResult> {
  const conflictPaths = opts.conflictPaths ?? new Set<string>();
  const primaryMap = readBoardDirFileMap(opts.primaryRoot);
  const boardMap = readBoardDirFileMap(opts.boardWorktree);

  const result: VerifiedMoveResult = { moved: 0, lockedLeftBehind: [], notInBoard: [] };
  for (const [rel, content] of Object.entries(primaryMap)) {
    // Verified = identical bytes, identical-modulo-EOL (git's own text=auto
    // normalization — see verifyMove), or covered by a surfaced conflict.
    const verified = sameModuloEol(boardMap[rel], content) || conflictPaths.has(rel);
    if (!verified) {
      result.notInBoard.push(rel);
      continue;
    }
    const abs = path.join(opts.primaryRoot, ...rel.split('/'));
    try {
      fs.rmSync(abs, { force: true });
      result.moved++;
    } catch {
      await sleep(150);
      try {
        fs.rmSync(abs, { force: true });
        result.moved++;
      } catch {
        result.lockedLeftBehind.push(rel);
      }
    }
  }
  result.notInBoard.sort();
  result.lockedLeftBehind.sort();

  // Prune now-empty state dirs (deepest-first so nested archive/ subdirs go too).
  for (const sub of BOARD_SUBDIRS) {
    const absDir = path.join(opts.primaryRoot, 'backlog', sub);
    if (!fs.existsSync(absDir)) continue;
    const dirs = [absDir, ...collectDirs(absDir)].sort((a, b) => b.length - a.length);
    for (const dir of dirs) {
      try {
        fs.rmdirSync(dir); // only succeeds when empty — exactly the intent
      } catch {
        // non-empty or locked — leave it
      }
    }
  }
  return result;
}

function collectDirs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const abs = path.join(dir, entry.name);
      out.push(abs, ...collectDirs(abs));
    }
  }
  return out;
}

export interface MoveBoardResult extends MoveVerification {
  /** Files deleted from the primary after verification. */
  moved: number;
  /** True when drift forced a union-merge fold before the move. */
  folded: boolean;
  /** Conflicts the fold surfaced (both sides edited; newer `updated_date` won). */
  conflicts: MergeConflict[];
  /** Files a locked delete left behind (Windows) — reported, never fatal. */
  lockedLeftBehind: string[];
}

/**
 * Move the primary's board state into the board worktree, healing drift instead
 * of wedging on it (TASK-123 AC#3).
 *
 * The naive "compare, and abort if anything differs" is a trap: `ensureBoardWorktree`
 * REUSES an existing board worktree without resetting its working tree to the
 * freshly-seeded ref tip, and a failed migration leaves such a worktree behind.
 * So every retry compared the live board against stale working files — any task
 * edited since (e.g. one an agent claimed mid-migration) failed forever, and the
 * repo could never be migrated again. When drift is found we now union-merge it
 * forward (the same `mergeBoards` the sync engine uses: newer `updated_date` wins,
 * conflicts surfaced, never silently dropped), commit, and move.
 *
 * Ordering is still the safety argument: nothing is deleted from the primary
 * until its bytes are verified present in the board worktree.
 */
export async function moveBoardIntoWorktree(opts: {
  primaryRoot: string;
  boardWorktree: string;
  /** Commit the board worktree after a fold. Defaults to the real autoCommit. */
  commit?: (boardWorktree: string) => Promise<unknown>;
}): Promise<MoveBoardResult> {
  const commit = opts.commit ?? autoCommitBoard;
  const primaryMap = readBoardDirFileMap(opts.primaryRoot);
  let boardMap = readBoardDirFileMap(opts.boardWorktree);

  let verification = verifyMove(primaryMap, boardMap, new Set());
  let conflicts: MergeConflict[] = [];
  let folded = false;

  if (!verification.ok) {
    // Drift: fold the primary's state forward. Only the files that actually
    // differ beyond EOL are offered as "theirs" — an EOL-only difference is
    // already verified, and feeding it to the merge would surface a phantom
    // conflict on a file whose content is identical.
    const strays: BoardFileMap = {};
    for (const [rel, content] of Object.entries(primaryMap)) {
      if (!sameModuloEol(boardMap[rel], content)) strays[rel] = content;
    }
    const merged = mergeBoards(undefined, boardMap, strays);
    conflicts = merged.conflicts;
    for (const [rel, content] of Object.entries(merged.merged)) {
      const abs = path.join(opts.boardWorktree, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    await commit(opts.boardWorktree);
    folded = true;

    boardMap = readBoardDirFileMap(opts.boardWorktree);
    verification = verifyMove(primaryMap, boardMap, new Set(conflicts.map((c) => c.path)));
  }

  const move = await executeVerifiedMove({
    primaryRoot: opts.primaryRoot,
    boardWorktree: opts.boardWorktree,
    conflictPaths: new Set(conflicts.map((c) => c.path)),
  });

  return {
    ...verification,
    moved: move.moved,
    folded,
    conflicts,
    lockedLeftBehind: move.lockedLeftBehind,
  };
}

/** `<primary>/.taskwright/board.materialized` — delete the v1 CAS leftover. */
export function cleanMaterializedMarker(primaryRoot: string): void {
  fs.rmSync(path.join(primaryRoot, '.taskwright', 'board.materialized'), { force: true });
}

/**
 * Split-brain heal (spec §5.3): fold stray board files a stale pre-reload
 * writer left under the primary `backlog/` into the board worktree — union-
 * merge (board = ours, strays = theirs; newer `updated_date` wins, conflicts
 * surfaced), commit, then clear the verified strays. Returns null when there
 * was nothing to fold. Shared by the activation heal and the doctor repair.
 */
export async function foldPrimaryStrays(
  primaryRoot: string
): Promise<{ folded: number; conflicts: MergeConflict[] } | null> {
  const primaryMap = readBoardDirFileMap(primaryRoot);
  if (Object.keys(primaryMap).length === 0) return null;
  const result = await moveBoardIntoWorktree({
    primaryRoot,
    boardWorktree: boardWorktreePathFor(primaryRoot),
  });
  return { folded: Object.keys(primaryMap).length, conflicts: result.conflicts };
}
