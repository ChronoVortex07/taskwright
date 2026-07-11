# Hidden-Worktree Board Home (sync.mode `git-auto`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `sync.mode: 'git-auto'` that moves the board's one physical home into a linked git worktree at `<primaryRoot>/.taskwright/board/` (branch `taskwright-board`) with event-driven auto-commit/auto-sync, plus a migration-safe path from every prior board state (v1 CAS leftovers, v2 `git`, tracked board files, fresh repos/clones).

**Architecture:** `resolveBoardRoot()` becomes mode-aware (the single choke point); a new `boardWorktree.ts` owns the worktree lifecycle; a new `autoSync.ts` owns debounced commit + event-driven fetch/union-merge/push (reusing `boardRef.ts` primitives and `mergeBoards()`); `enableSync` becomes a mode picker driving an idempotent S0–S6 migration; the board doctor gains three new findings. Spec: `docs/superpowers/specs/2026-07-10-hidden-worktree-board-home-design.md`.

**Tech Stack:** TypeScript, VS Code extension API, Vitest, Bun, git plumbing via injectable `BoardGitExec`.

## Global Constraints

- Modes `off` and `git` keep their exact v2 semantics — byte-identical behavior (spec header).
- The board branch tree only ever contains `backlog/{tasks,drafts,completed,archive,milestones}` paths — old clients' `materializeRefToWorktree` non-board-path guard throws otherwise (spec §2.1).
- Never `reset --hard`; only `reset --keep` after commit-if-dirty under the same lock (spec §3).
- No background interval polling — events only (spec §3, v1 postmortem binding).
- Sync failure never fails a board write or a git operation (spec §3.4).
- Migration mode flip happens ONLY after the verified move (spec §5.2 step 5).
- Windows-safe: byte-exact blobs (`core.autocrlf=false` per-worktree), EBUSY-tolerant deletes, paths with spaces.
- All commits from the task worktree; run `bun run test && bun run lint && bun run typecheck` before Done.
- Commit messages end with `Completes TASK-91.` context + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

- Create: `src/core/boardWorktree.ts` — board-worktree lifecycle (path, state, ensure/bootstrap/repair)
- Create: `src/core/autoSync.ts` — auto-commit, event-driven sync, debounce scheduler, cross-process lock
- Create: `src/core/boardHomeMigration.ts` — migration-state classifier + verified-move helpers + move executor
- Create: `src/test/unit/boardWorktree.test.ts`, `src/test/unit/autoSync.test.ts`, `src/test/unit/boardHomeMigration.test.ts`, `src/test/unit/gitAutoIntegration.test.ts`
- Modify: `src/core/syncConfig.ts` — `SyncMode` gains `'git-auto'`
- Modify: `package.json` — `taskwright.sync.mode` enum + `git-auto` description
- Modify: `src/core/boardRoot.ts` — `boardHomeFor()` pure helper + `resolveBoardHome()` + mode-aware `resolveWorkspaceBacklogRoot`
- Modify: `src/core/BacklogParser.ts` — `primaryRoot` ctor param + `getPrimaryRoot()`; docs/decisions read from the config root
- Modify: `src/core/boardDoctor.ts` — 3 new findings (`board-worktree-missing`, `board-strays-in-primary`, `board-mode-mismatch`) + facts
- Modify: `src/providers/doctorActions.ts` — repair labels + apply switch + `parser.getPrimaryRoot()`
- Modify: `src/providers/claimActions.ts`, `src/providers/intakeActions.ts`, `src/providers/planActions.ts`, `src/providers/dispatchActions.ts`, `src/providers/TaskDetailProvider.ts`, `src/providers/TasksController.ts` — `getPrimaryRoot()` threading
- Modify: `src/core/BacklogWorkspaceManager.ts` — `BacklogRoot.primaryRoot`
- Modify: `src/extension.ts` — enableSync mode picker + git-auto migration/reverse + activation bootstrap/heal + FileWatcher repoint + scheduler wiring + status bar + `activeRootDir()`
- Modify: `src/core/boardSyncUx.ts` — `git-auto` status-bar states + quick-pick items
- Modify: `src/mcp/server.ts` — mode-aware root at launch; `board_doctor` description
- Modify: `src/mcp/handlers.ts` — `makePrimaryBoard` board-home aware; `resetTaskFile` via board worktree; request_merge pre/post sync; push/pull routing in git-auto
- Modify: `src/language/documentSelector.ts` — add `milestones/` glob
- Modify: `CLAUDE.md`, `AGENTS.md` — sync sections
- Test (existing helpers): `src/test/unit/helpers/tempGitRepo.ts`

---

### Task 1: `git-auto` in the sync-config core + package.json

**Files:**
- Modify: `src/core/syncConfig.ts:10` (`SyncMode`), `:31-36` (`coerceMode`)
- Modify: `package.json` (`taskwright.sync.mode` enum, ~line 74)
- Test: `src/test/unit/syncConfig.test.ts` (existing file — add cases)

**Interfaces:**
- Produces: `type SyncMode = 'off' | 'git' | 'git-auto'` — every later task imports this.
- Legacy coercions unchanged: `'local'→'off'`, `'github'→'git'`, unknown→`'off'`.

- [ ] **Step 1: Write the failing tests** — in the existing `syncConfig.test.ts` describe block:

```ts
it('passes git-auto through coerceMode', () => {
  expect(resolveSyncConfigFromSettings({ mode: 'git-auto' }).mode).toBe('git-auto');
});
it('still coerces legacy values with git-auto present', () => {
  expect(resolveSyncConfigFromSettings({ mode: 'local' }).mode).toBe('off');
  expect(resolveSyncConfigFromSettings({ mode: 'github' }).mode).toBe('git');
  expect(resolveSyncConfigFromSettings({ mode: 'nonsense' }).mode).toBe('off');
});
```

- [ ] **Step 2: Run** `bun run test -- syncConfig` — expect FAIL (git-auto coerced to 'off').
- [ ] **Step 3: Implement** — `SyncMode = 'off' | 'git' | 'git-auto'`; in `coerceMode` add `if (v === 'git-auto') return v;` alongside the existing pass-throughs. In `package.json` add `"git-auto"` to the `taskwright.sync.mode` enum with enumDescription "Board lives in a hidden worktree (.taskwright/board) with automatic event-driven commit/sync".
- [ ] **Step 4: Run** `bun run test -- syncConfig` — expect PASS.
- [ ] **Step 5: Commit** `feat(sync): add git-auto mode to sync config (TASK-91)`.

---

### Task 2: mode-aware board home in `boardRoot.ts`

**Files:**
- Modify: `src/core/boardRoot.ts`
- Test: `src/test/unit/boardRoot.test.ts` (existing — add cases)

**Interfaces:**
- Produces (all exported from `boardRoot.ts`):

```ts
export interface BoardHome {
  primaryRoot: string;
  mode: SyncMode;
  /** Where tasks/drafts/completed/archive/milestones live. */
  backlogPath: string;   // git-auto: <primary>/.taskwright/board/backlog ; else <primary>/backlog
  /** Where config.yml + docs/ + decisions/ live — always the repo backlog. */
  configRoot: string;    // <primary>/backlog
}
export function boardWorktreePathFor(primaryRoot: string): string; // <primary>/.taskwright/board
export function boardHomeFor(primaryRoot: string, mode: SyncMode): BoardHome; // pure
export async function resolveBoardHome(cwd: string, deps?: ResolveBoardRootDeps & { readMode?: () => SyncMode }): Promise<BoardHome>;
```

- `resolveBoardHome` composes: `resolvePrimaryWorktreeRoot(cwd)` → resolve common dir (`git rev-parse --git-common-dir` via the same exec, `path.resolve(primaryRoot, out)`) → `readSyncConfig(syncConfigPath(commonDir), nodeFs)` → `boardHomeFor`. `readMode` injectable for tests. On any git failure → mode `'off'`, primary-local shape (existing fallback behavior).
- `resolveWorkspaceBacklogRoot` change: after resolving the primary root, resolve the board home; when mode is `git-auto` AND the board worktree's `backlog/` exists, return `{ backlogPath: home.backlogPath, backlogDir: 'backlog', configPath: <configRoot>/config.yml when present }`. When the worktree is missing (not yet bootstrapped) fall back to the v2 primary resolution — activation bootstrap (Task 10) will fix it and reload consumers.
- Consumes: `SyncMode`, `readSyncConfig`, `syncConfigPath` from Task 1 / existing.

- [ ] **Step 1: Failing tests** (pure part):

```ts
import { boardHomeFor, boardWorktreePathFor } from '../../core/boardRoot';
it('git-auto board home points into .taskwright/board', () => {
  const h = boardHomeFor('/repo', 'git-auto');
  expect(h.backlogPath).toBe(path.join('/repo', '.taskwright', 'board', 'backlog'));
  expect(h.configRoot).toBe(path.join('/repo', 'backlog'));
});
it('off and git keep the v2 primary backlog', () => {
  for (const mode of ['off', 'git'] as const) {
    const h = boardHomeFor('/repo', mode);
    expect(h.backlogPath).toBe(path.join('/repo', 'backlog'));
    expect(h.configRoot).toBe(path.join('/repo', 'backlog'));
  }
});
```

Plus a `resolveBoardHome` test with a fake exec returning porcelain + common-dir and an injected `readMode`.

- [ ] **Step 2: Run** `bun run test -- boardRoot` — FAIL (not exported).
- [ ] **Step 3: Implement** as specified above. `resolveBoardHome` uses `fs.existsSync` only in `resolveWorkspaceBacklogRoot`'s worktree-exists check (injectable not needed; integration-covered).
- [ ] **Step 4: Run** `bun run test -- boardRoot` — PASS (including all pre-existing cases: off/git untouched).
- [ ] **Step 5: Commit** `feat(sync): mode-aware board home resolution (TASK-91)`.

---

### Task 3: `boardWorktree.ts` — lifecycle of the hidden worktree

**Files:**
- Create: `src/core/boardWorktree.ts`
- Test: `src/test/unit/boardWorktree.test.ts`

**Interfaces (produced):**

```ts
export type BoardWorktreeStatus = 'ok' | 'dir-missing' | 'unregistered' | 'no-branch';
export interface EnsureBoardWorktreeResult {
  path: string;            // <primary>/.taskwright/board
  created: boolean;        // false when already ok
  seeded: 'existing' | 'from-local-ref' | 'from-remote' | 'none';
}
export async function boardWorktreeStatusOf(primaryRoot: string, ref: string, deps?): Promise<BoardWorktreeStatus>;
export async function ensureBoardWorktree(opts: {
  primaryRoot: string; ref: string; remote: string; exec?: BoardGitExec; pathExists?: (p: string) => boolean;
}): Promise<EnsureBoardWorktreeResult>;
```

Behavior of `ensureBoardWorktree` (mirrors `WorktreeService.createWorktree`, fixed path):
1. If dir exists and `git -C <dir> rev-parse --git-dir` succeeds → `{ created: false, seeded: 'existing' }`.
2. `git worktree prune` (clears stale registrations, e.g. after `git clean -dfx`).
3. Branch resolution: local `refs/heads/<ref>` exists → use it (`seeded: 'from-local-ref'`); else `fetchRef(primaryRoot, remote, ref)` non-null → `git branch <ref> <fetchedSha>` (`seeded: 'from-remote'`); else create an empty root: `snapshotBoardToRef` is NOT called here — a truly fresh seed is enableSync's job (Task 6); instead commit an empty tree root (`git commit-tree $(git hash-object -t tree /dev/null …)`) — concretely: `read-tree --empty` + `write-tree` + `commit-tree <tree> -m "chore(taskwright): board branch root"` with the isolated index `<primary>/.taskwright/board.index`, then `git branch <ref> <sha>` (`seeded: 'none'`).
4. `git worktree add <dir> <ref>` (never `-b` a second branch; the branch always exists by now).
5. Line-ending safety: `git -C <primary> config extensions.worktreeConfig true`, then `git -C <dir> config --worktree core.autocrlf false` and `--worktree core.eol lf`.

**Consumes:** `fetchRef`, `qualifyRef`, `refTip`, `BoardGitExec`, `defaultBoardExec` from `boardRef.ts`; `boardWorktreePathFor` from Task 2.

- [ ] **Step 1: Failing unit tests** with a scripted fake exec (pattern: `boardRoot.test.ts`'s fake): assert the exact git arg sequences for (a) already-ok short-circuit, (b) local-branch path, (c) remote path, (d) empty-root path; and that worktree-config args are issued.
- [ ] **Step 2: Run** `bun run test -- boardWorktree` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Integration test** (same file, `describe('integration')`, using `tempGitRepo` helper): real repo → `ensureBoardWorktree` → expect `.taskwright/board/.git` file exists, branch checked out, second call `created: false`. Delete the dir with `fs.rmSync(recursive)` → `boardWorktreeStatusOf` = `'unregistered'` → `ensureBoardWorktree` repairs. Run + PASS.
- [ ] **Step 6: Commit** `feat(sync): board worktree lifecycle core (TASK-91)`.

---

### Task 4: `autoSync.ts` — commit, sync, scheduler

**Files:**
- Create: `src/core/autoSync.ts`
- Test: `src/test/unit/autoSync.test.ts`

**Interfaces (produced):**

```ts
export interface AutoCommitResult { committed: boolean; sha?: string }
export async function autoCommitBoard(boardWorktree: string, opts?: { exec?: BoardGitExec; messagePrefix?: string }): Promise<AutoCommitResult>;
// add -A -- backlog/tasks backlog/drafts backlog/completed backlog/archive backlog/milestones
// then commit with ['-c','user.name=Taskwright','-c','user.email=taskwright@local','commit','-m',msg]
// 'nothing to commit' (git exits 1) → { committed: false }

export interface AutoSyncOutcome {
  committed: boolean; remoteTip: string | null; merged: boolean;
  pushed: boolean; rejected: boolean; conflicts: MergeConflict[]; error?: string;
}
export async function runBoardAutoSync(opts: {
  primaryRoot: string; ref: string; remote: string;
  lockDir?: string;               // default <commonDir>/taskwright resolved by caller — pass explicitly
  exec?: BoardGitExec;
}): Promise<AutoSyncOutcome | { skipped: 'locked' }>;
// under acquireSyncLock(): autoCommitBoard → localTip=refTip → fetchRef → remote null or isAncestor(remote, local) → push best-effort, done.
// else: baseSha=mergeBaseOf(local, remote); maps via readRefFileMap; mergeBoards(base, ours, theirs);
// commitMergedTree(parents:[localTip, remoteTip]) → git -C <board> reset --keep <merged> (moves the checked-out branch AND working tree, preserves uncommitted) → pushRef best-effort.
// Every step failure → { ..., error } — NEVER throws.

export function acquireSyncLock(lockDir: string, staleMs = 60_000): (() => void) | null;
// mkdirSync(<lockDir>/board-sync.lock) atomic; on EEXIST check mtime, steal if older than staleMs; returns release fn or null.

export class BoardSyncScheduler {
  constructor(private opts: { debounceMs?: number; run: () => Promise<void>; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout });
  noteWrite(): void;      // (re)arm debounce; fires run() once quiet
  requestSync(): void;    // immediate run; coalesces if one is in flight (single-flight; a request during a run queues exactly one follow-up)
  dispose(): void;
}
```

**Consumes:** `refTip`, `fetchRef`, `pushRef`, `isAncestor`, `mergeBaseOf`, `readRefFileMap`, `commitMergedTree`, `defaultBoardExec` (boardRef.ts); `mergeBoards` (boardMerge.ts); `boardWorktreePathFor` (Task 2); `boardTrackedPaths` (boardMigration.ts) for the pathspec.

- [ ] **Step 1: Failing tests**: (a) `autoCommitBoard` fake-exec: exact `add -A --` pathspec args (the five dirs), commit args include identity `-c` flags; clean tree → committed:false. (b) `acquireSyncLock`: second acquire returns null; stale lock stolen (write lock dir, backdate mtime with `fs.utimesSync`). (c) `BoardSyncScheduler` with fake timers: three `noteWrite()` → one `run`; `requestSync` during a run → exactly one queued follow-up. (d) `runBoardAutoSync` fake-exec: remote-ahead path issues merge + `reset --keep` and never `reset --hard`; fetch failure returns outcome with error, no throw.
- [ ] **Step 2: Run** `bun run test -- autoSync` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Integration** (in `gitAutoIntegration.test.ts`, Task 11 file, may stub now): two clones round-trip. Defer to Task 11 if the harness pieces aren't ready; unit coverage suffices here.
- [ ] **Step 6: Commit** `feat(sync): event-driven auto-sync engine (TASK-91)`.

---

### Task 5: migration cores (`boardHomeMigration.ts`)

**Files:**
- Create: `src/core/boardHomeMigration.ts`
- Test: `src/test/unit/boardHomeMigration.test.ts`

**Interfaces (produced):**

```ts
export interface MigrationFacts {
  hasStateDirs: boolean;           // any of the five under <primary>/backlog
  trackedBoardFiles: string[];     // git ls-files -- <boardTrackedPaths>
  localRefTip: string | null;
  boardWorktreeOk: boolean;
  hasMaterializedMarker: boolean;  // .taskwright/board.materialized
}
export type MigrationStep = 'untrack' | 'seed-fresh' | 'seed-fold-ref' | 'add-worktree' | 'verified-move' | 'clean-marker' | 'noop';
export function planMigrationSteps(facts: MigrationFacts): MigrationStep[];
// already migrated (boardWorktreeOk && !hasStateDirs) → ['clean-marker'?...,'noop']
// tracked files → 'untrack' first; ref exists → 'seed-fold-ref' else 'seed-fresh'; always 'add-worktree' then 'verified-move' when hasStateDirs.

export function verifyMove(primary: BoardFileMap, board: BoardFileMap, conflictPaths: ReadonlySet<string>): { ok: boolean; missing: string[] };
// every primary path must be byte-equal in board OR listed in conflictPaths (the fold chose the other side, surfaced).

export async function gatherMigrationFacts(primaryRoot: string, ref: string, deps?): Promise<MigrationFacts>;
export async function executeVerifiedMove(opts: { primaryRoot: string; boardWorktree: string; exec?: BoardGitExec }): Promise<{ moved: number; lockedLeftBehind: string[] }>;
// per-file: byte-compare (or conflict-listed) then fs.rmSync(primary file, {force:true}) with one EBUSY/EPERM retry;
// locked files are left + reported, never fatal. Empty state dirs removed afterwards (fs.rmdirSync, ignore failures).
export function readBoardDirFileMap(root: string): BoardFileMap; // walk five state dirs under <root>/backlog → posix-rel map (reuses walk pattern from boardRef.listLocalBoardFiles, exported here for reuse)
```

- [ ] **Step 1: Failing tests** — pure parts: `planMigrationSteps` for each S0–S6 fact combination (fresh, ignored-only, tracked, ref, ref+tracked, migrated, marker); `verifyMove` (identical maps ok, differing file not in conflicts → missing, differing file in conflicts → ok).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement. Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(sync): migration state classifier + verified move core (TASK-91)`.

---

### Task 6: `enableSync` rework — mode picker + git-auto migration + reverse

**Files:**
- Modify: `src/extension.ts:324-380` (`runEnableSync`), `:570-583` (command handler)
- Test: covered by Task 5 unit cores + Task 11 integration (extension glue is thin; VS Code APIs mocked-out already in existing extension tests only where feasible)

**Behavior (replaces the current single-mode flow):**
1. QuickPick: `git-auto` ("Hidden worktree + automatic sync — recommended") / `git` (current v2 behavior, unchanged path) / `off` (only offered when currently git-auto → reverse migration; from off/git it just sets the mode).
2. `git` chosen → existing code path verbatim (gitignore + untrack + seed ref).
3. `git-auto` chosen → `migrateToGitAuto(primaryRoot)`:

```ts
async function migrateToGitAuto(primaryRoot: string): Promise<void> {
  const ref = cfgRef(); const remote = cfgRemote();
  // (a) hygiene shared with v2: applyBoardIgnore + git rm -r --cached --ignore-unmatch + commit (reuse lines 335-348 verbatim; commit message 'chore(taskwright): move board off code branches (git-auto)')
  // (b) pre-move safety snapshot: snapshotBoardToRef({parent: refTip ?? undefined, message: 'chore(taskwright): pre-git-auto safety snapshot'})
  // (c) fold: if refTip existed OR fetchRef(remote) → runBoardAutoSync is NOT used here; instead the snapshot in (b) already parented on the old tip (ours = live board, history continues); remote fold happens on first sync.
  // (d) dispose the FileWatcher (set module-level fileWatcher?.dispose()).
  // (e) ensureBoardWorktree({primaryRoot, ref, remote}) → worktree materializes the branch (= live board content from (b)).
  // (f) verify: verifyMove(readBoardDirFileMap(primaryRoot), readBoardDirFileMap(<worktree>), new Set()) — must be ok (the branch tip IS the live snapshot, so byte-equality is expected); abort with an error notification when not.
  // (g) executeVerifiedMove — delete primary copies (locked files surfaced).
  // (h) delete .taskwright/board.materialized if present (fs.rmSync force).
  // (i) mode flip: settings update 'sync.mode'='git-auto' + publishSyncConfig — ONLY here.
  // (j) prompt: 'Board moved to its hidden worktree. Reload the window to restart the board services?' [Reload] → workbench.action.reloadWindow.
}
```

4. Reverse (`off`/`git` chosen while current mode is `git-auto`) → `migrateFromGitAuto(primaryRoot)`: `autoCommitBoard(worktree)` → `snapshotBoardToRef` from the worktree tree is unnecessary — the branch tip already has it; `materializeRefToWorktree({repoRoot: primaryRoot, ref, indexFile})` into the primary `backlog/` → `git worktree remove --force .taskwright/board` + `git worktree prune` (branch kept) → mode flip + publish + reload prompt.

Key detail: step (b)+(e) ordering means the worktree add IS the move-in; the only copy step is git's own checkout. The verified move (f–g) compares live dirs against the checkout before deleting anything, satisfying spec §5.2.

- [ ] **Step 1:** Write `migrateToGitAuto` / `migrateFromGitAuto` in `extension.ts` (private, next to `runEnableSync`), rework `runEnableSync` to the picker; keep the `git` path byte-identical.
- [ ] **Step 2:** `bun run typecheck && bun run lint` — PASS.
- [ ] **Step 3:** Manual-order sanity: re-read the function against spec §5.2's numbered ordering (snapshot → watcher → worktree → verify → delete → flip → reload). Fix discrepancies.
- [ ] **Step 4: Commit** `feat(sync): enableSync mode picker + git-auto verified migration (TASK-91)`.

---

### Task 7: primary-root accessor threading

**Files:**
- Modify: `src/core/BacklogParser.ts:150-161` — ctor gains `primaryRoot?: string`; add:

```ts
/** The primary checkout root. In git-auto the board lives under .taskwright/board,
 *  so dirname(backlogPath) is NOT the repo root — use this accessor instead. */
getPrimaryRoot(): string {
  return this.primaryRoot ?? path.dirname(this.backlogPath);
}
/** Root for config.yml + docs/ + decisions/ (the repo backlog/, not the board worktree). */
private contentRoot(): string {
  if (this.resolvedConfigPath) return path.dirname(this.resolvedConfigPath);
  return this.backlogPath;
}
```

  and switch `getDocuments()` (`:1012`) / `getDecisions()` (`:1042`) to `path.join(this.contentRoot(), 'docs' | 'decisions')`.
- Modify every `path.dirname(parser.getBacklogPath())` → `parser.getPrimaryRoot()`: `src/providers/doctorActions.ts:75,154`, `claimActions.ts:41`, `intakeActions.ts:53`, `planActions.ts:16`, `dispatchActions.ts:40`, `TaskDetailProvider.ts:505,872,890`, `TasksController.ts:318,329,1006`; `extension.ts:1665-1668` (`activeRootDir()` uses the manager's `primaryRoot`, next bullet). Review `TaskDetailProvider.ts:1337` (`basename === 'backlog'` walk-up): it resolves a task file's repo — task files now live under `.taskwright/board/backlog/`, the walk-up still finds a `backlog` dir; change it to prefer `parser.getPrimaryRoot()` when the file is under the parser's `getBacklogPath()`.
- Modify: `src/core/BacklogWorkspaceManager.ts:4-10` — `BacklogRoot` gains `primaryRoot: string`; `discover()` fills it from a new return of `resolveWorkspaceBacklogRoot` (extend `BacklogDirectoryResolution` with optional `primaryRoot`) falling back to `path.dirname(backlogPath)`.
- Modify parser construction sites to pass `primaryRoot` + config path: `extension.ts` (parser creation), `src/mcp/server.ts:93`, `src/mcp/handlers.ts:292-296` (Task 9 finishes the MCP side).
- Test: `src/test/unit/BacklogParser.test.ts` — add `getPrimaryRoot()` fallback + override cases; docs/decisions from `contentRoot` (fixture: config at a different root than backlogPath).

- [ ] **Step 1: Failing parser tests** (accessor + contentRoot docs read).
- [ ] **Step 2: Run** `bun run test -- BacklogParser` — FAIL. **Step 3: Implement parser changes.** **Step 4:** PASS.
- [ ] **Step 5:** Mechanical threading across the provider files (grep `dirname(.*getBacklogPath` to find every site; also `dirname\((await |)parser`). `bun run test && bun run typecheck` — full suite PASS (behavior identical in off/git because the fallback is the old dirname).
- [ ] **Step 6: Commit** `refactor: thread primary-root accessor through providers and parser (TASK-91)`.

---

### Task 8: board doctor — three new findings + repairs

**Files:**
- Modify: `src/core/boardDoctor.ts:26-43` (types), `:70-94` (input/facts), `diagnoseBoard`, `gatherDoctorFacts`, `runBoardDoctor`
- Modify: `src/providers/doctorActions.ts:53-138` (labels + applyRepair)
- Modify: `src/mcp/server.ts:246` (`board_doctor` description — append the three new types)
- Test: `src/test/unit/boardDoctor.test.ts` (existing — add cases)

**Interfaces:**
- `DoctorFindingType` += `'board-worktree-missing' | 'board-strays-in-primary' | 'board-mode-mismatch'`
- `DoctorRepair` += `'repair-board-worktree' | 'fold-primary-strays' | 'restore-board-to-primary'`
- `BoardDoctorInput` += `{ syncMode?: SyncMode; boardWorktreeOk?: boolean; primaryStateDirs?: string[]; primaryTasksPresent?: boolean; boardBranchExists?: boolean }`
- New checks (pure, in `diagnoseBoard`, after check 7):
  - 8: `syncMode === 'git-auto' && boardWorktreeOk === false` → `board-worktree-missing` / `repair-board-worktree`.
  - 9: `syncMode === 'git-auto' && primaryStateDirs.length > 0` → `board-strays-in-primary` / `fold-primary-strays` (detail: dir list).
  - 10: `syncMode !== 'git-auto' && primaryTasksPresent === false && boardBranchExists === true` → `board-mode-mismatch` / `restore-board-to-primary`.
- `gatherDoctorFacts(repoRoot, opts?: { syncMode?: SyncMode; ref?: string })` gathers the new facts (fs + `refTip`); `runBoardDoctor(parser, repoRoot, opts?)` passes them through. Both extension (`extension.ts:1639-1660`) and MCP (`handlers.ts:1160-1174`) call sites pass the current mode.
- Repairs in `doctorActions.applyRepair`:
  - `repair-board-worktree` → `await ensureBoardWorktree({ primaryRoot: parser.getPrimaryRoot(), ref, remote })`.
  - `fold-primary-strays` → read primary + board maps (`readBoardDirFileMap`), `mergeBoards(undefined, boardMap, primaryMap)`, write merged files into the board worktree (plain `fs.writeFileSync` per file + `autoCommitBoard`), then `executeVerifiedMove` to clear the strays; surface conflicts via the existing conflict notification.
  - `restore-board-to-primary` → `materializeRefToWorktree({ repoRoot: primaryRoot, ref, indexFile })`.

- [ ] **Step 1: Failing doctor unit tests** — one per new check (positive + a git-auto-off negative each), asserting type/repair/message shape.
- [ ] **Step 2:** FAIL. **Step 3: Implement** (types, checks, facts, labels `'Repair the board worktree' / 'Fold stray board files into the board' / 'Restore the board into backlog/'`, applyRepair cases, MCP description). **Step 4:** PASS (`bun run test -- boardDoctor`).
- [ ] **Step 5: Commit** `feat(doctor): board-worktree health findings + repairs (TASK-91)`.

---

### Task 9: MCP server + handlers wiring

**Files:**
- Modify: `src/mcp/server.ts:86-98` — root resolution + parser construction:

```ts
const root = process.env.TASKWRIGHT_ROOT?.trim() || process.cwd();
const home = await resolveBoardHomeSafe(root); // wraps resolveBoardHome; falls back to the current resolveWorkspaceBacklogRoot result on any error
const backlogPath = home?.backlogPath ?? ((await resolveWorkspaceBacklogRoot(root)).backlogPath || path.join(root, 'backlog'));
const parser = new BacklogParser(backlogPath, home ? path.join(home.configRoot, 'config.yml') : undefined, undefined, home?.primaryRoot);
```

  (Note: in git-auto with the worktree missing — fresh clone, no extension yet — `resolveBoardHome`'s worktree-exists guard falls back to primary; the extension bootstraps on next activation. Document in a comment.)
- Modify: `src/mcp/handlers.ts:291-315` — `makePrimaryBoard(primaryRoot, exec)` becomes board-home aware:

```ts
export function makePrimaryBoard(primaryRoot: string, exec: GitExecFn, home?: BoardHome): BoardOps {
  const backlogPath = home?.backlogPath ?? path.join(primaryRoot, 'backlog');
  const configPath = home ? path.join(home.configRoot, 'config.yml') : undefined;
  const parser = new BacklogParser(backlogPath, configPath, undefined, primaryRoot);
  // resetTaskFile: checkout runs in the tree that owns the file —
  const checkoutCwd = home?.mode === 'git-auto' ? boardWorktreePathFor(primaryRoot) : primaryRoot;
  // rel computed against checkoutCwd
}
```

  Call sites of `makePrimaryBoard` read the sync config once via `gitFacts` (`readSyncConfig(syncConfigPath(facts.commonDir))` — same pattern as `handlers.ts:561`).
- Modify request_merge flow (`requestMergeHandler` in `handlers.ts`): when mode is `git-auto`, best-effort `await runBoardAutoSync({...})` BEFORE the finish (fold latest remote board) and AFTER a successful merge (publish the Done flip). Both wrapped in try/catch → console.error only; never affects the merge result.
- Modify push/pull handlers (`handlers.ts:561,591`): when mode is `git-auto`, route to `runBoardAutoSync` (push → outcome mapped `{ pushed, commit?, rejected, conflicts }`; pull → same call, mapped to the pull result with `files: []` and a note the board worktree IS the live board); v2 `git` path untouched.
- Test: `src/test/unit/mcpWriteHandlers.test.ts` / `mcpReadHandlers.test.ts` — extend `makePrimaryBoard` test (exists per TASK-82 coverage) for the git-auto checkout cwd; handler-routing unit tests with injected sync config.

- [ ] **Step 1: Failing tests** for `makePrimaryBoard` git-auto cwd + push handler routing.
- [ ] **Step 2:** FAIL. **Step 3: Implement.** **Step 4:** PASS (`bun run test -- mcp`).
- [ ] **Step 5: Commit** `feat(mcp): git-auto board home in server root, primary board ops, merge-boundary sync (TASK-91)`.

---

### Task 10: extension activation wiring + status bar + selector

**Files:**
- Modify: `src/extension.ts`:
  - After manager discovery (where `backlogFolder` is computed): resolve the board home for `workspaceRootPath`; if mode `git-auto`: `await ensureBoardWorktree(...)` (S5 bootstrap — first activation after a clone), then stray-heal: if `readBoardDirFileMap(primaryRoot)` non-empty → run the `fold-primary-strays` repair silently + one info notification.
  - `FileWatcher` (`:531-535`): construct with the resolved board home `backlogPath` (git-auto → the worktree backlog) — it already receives `backlogFolder`; make `backlogFolder` the home-resolved path so every downstream consumer follows.
  - Scheduler: in git-auto, `new BoardSyncScheduler({ debounceMs: 7000, run: () => autoCommit + refreshStatusBar })` fed by `fileWatcher.onDidChange`; sync events: activation (post-bootstrap), after each debounce commit, and the manual commands — each `requestSync()` → `runBoardAutoSync` with status-bar state updates.
  - `activeRootDir()` (`:1665-1668`): `manager.getActiveRoot()?.primaryRoot ?? path.dirname(backlogPath)`.
  - Doctor call sites (`:1639-1660`): pass `{ syncMode, ref }` through to `runBoardDoctor`.
- Modify: `src/core/boardSyncUx.ts` — `formatBoardSyncStatusBar`: `git-auto` states: idle `$(sync) Board Sync: Auto`, pending-push `$(cloud-upload) Board Sync: Auto (n ahead)` (state gains `aheadCount?: number`), error/conflict states reuse the existing shapes; `buildBoardSyncQuickPickItems('git-auto')` → `[Sync Now, Push Board, Pull Board, Switch Mode…]` (`action: 'sync' | 'push' | 'pull' | 'enableSync'`).
- Modify: `src/language/documentSelector.ts` — add `{ language: 'markdown', pattern: `**/${backlogDir}/milestones/**/*.md` }`.
- Test: `src/test/unit/boardSyncUx.test.ts` (existing — add git-auto presentation cases); `src/test/unit/documentSelector.test.ts` if present, else covered by typecheck.

- [ ] **Step 1: Failing boardSyncUx tests** (git-auto text/tooltip/quick-pick items).
- [ ] **Step 2:** FAIL. **Step 3: Implement** ux + extension wiring + selector. **Step 4:** PASS + `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(sync): git-auto activation bootstrap, watcher repoint, status bar (TASK-91)`.

---

### Task 11: integration test suite — migration matrix + round-trips

**Files:**
- Create: `src/test/unit/gitAutoIntegration.test.ts` (Vitest, real temp git repos via `src/test/unit/helpers/tempGitRepo.ts`; follow `boardRef.test.ts`'s integration patterns — real `defaultBoardExec`, no VS Code)

Scenarios (each its own `it`, sequential, generous timeouts like the Board Sync suites — 30s file-level per the deflake baseline):
1. **S1 migrate**: repo with ignored board → simulate `migrateToGitAuto`'s core steps (hygiene/snapshot/ensure/verify/move via the exported cores — the extension glue is not imported) → board files present in worktree, absent in primary, `verifyMove` ok.
2. **S2 migrate**: board files TRACKED + stale 4-dir gitignore block + one uncommitted board edit → untrack keeps working-tree content; fenced block upgraded to 5 dirs; edit survives into the worktree.
3. **S3 migrate**: pre-existing `taskwright-board` ref with divergent content + a bare "remote" clone ahead → snapshot parents on old tip; first `runBoardAutoSync` folds remote (two-parent merge, conflicts surfaced when same task edited); push fast-forwards.
4. **S4**: `.taskwright/board.materialized` present → migration deletes it.
5. **S5 bootstrap**: clone of a migrated repo (bare remote with the board ref) → `ensureBoardWorktree` seeds `from-remote`.
6. **S6 idempotence**: run the migration cores twice → second run no-ops (`planMigrationSteps` → noop; no duplicate commits).
7. **Round-trip**: two clones, A writes task + `autoCommitBoard` + `runBoardAutoSync` (push), B `runBoardAutoSync` → B's worktree has the task.
8. **Offline**: sync with unreachable remote → outcome has `error`/`pushed:false`, local commit retained; later sync pushes.
9. **Worktree loss**: `fs.rmSync(.taskwright/board)` → `boardWorktreeStatusOf`='unregistered' → `ensureBoardWorktree` repairs; committed history intact.
10. **Reverse**: materialize back to primary + worktree remove → board readable at primary `backlog/`.
11. **Dirty board never blocks a merge**: in a git-auto repo, dirty board worktree + `hasCodeWip(porcelain of primary)` — primary porcelain contains no `backlog/` entries by construction; assert `git status --porcelain` in primary is empty after board writes.

- [ ] **Step 1:** Write scenarios 1–6 (migration matrix) → run `ch run "bun run test -- gitAutoIntegration"` — iterate to PASS.
- [ ] **Step 2:** Write scenarios 7–11 → PASS.
- [ ] **Step 3: Full gates:** `ch run "bun run test"` && `bun run lint` && `bun run typecheck` — all PASS (0 failures baseline on Windows).
- [ ] **Step 4: Commit** `test(sync): git-auto migration matrix + round-trip integration suite (TASK-91)`.

---

### Task 12: docs

**Files:**
- Modify: `CLAUDE.md` — Board Sync v2 bullet: add the `git-auto` third mode paragraph (one physical board in the hidden worktree; event-driven auto-sync; migration via enableSync; Backlog.md-CLI root-layout divergence documented as git-auto-only).
- Modify: `AGENTS.md` — Board Sync section: same, agent-facing (mode set `off | git | git-auto`; in git-auto push/pull still exist as manual escape hatches; never edit board files by hand — unchanged).

- [ ] **Step 1:** Write both edits, referencing the spec path.
- [ ] **Step 2:** `bun run lint` (markdown untouched by eslint — sanity only) and re-read for accuracy against the implemented behavior.
- [ ] **Step 3: Commit** `docs: git-auto board home mode (TASK-91)`.

---

## Self-review (spec coverage)

- §2.1 location/layout → Tasks 2, 3 (autocrlf via worktree config; pathspec-limited commit in Task 4 protects the ref layout).
- §2.2 root resolution + dirname hazard → Tasks 2, 7, 9 (accessor + makePrimaryBoard + selector fix in 10).
- §2.3 carve-out stays → no code change; asserted inert in Task 11 scenario 11.
- §3 engine invariants → Task 4 (events only, reset --keep, lock, identity fallback, degrade-not-block), wiring in 9 (MCP events) + 10 (extension events).
- §4 config surface → Tasks 1, 10 (status bar), 9 (push/pull escape hatch).
- §5 migration matrix S0–S6 → Tasks 5, 6, 9 (S5 note), 10 (S5 bootstrap + stray heal), 11 (proof).
- §5.4 reverse → Tasks 6, 8 (doctor repair), 11 scenario 10.
- §6 doctor findings → Task 8.
- §8 testing → Tasks per-core + 11; Windows notes covered by EBUSY tolerance (Task 5) + byte-exact config (Task 3).
