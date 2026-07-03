import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Git-plumbing primitive for the synced board (spec §3.3). Snapshots the board
 * subdirectories onto a dedicated ref and materializes that ref back into the
 * working copy — all through an **isolated index** (`GIT_INDEX_FILE`), so the
 * user's real HEAD, index, and working branch are never touched.
 */

const execFileAsync = promisify(execFile);

/** Default orphan-branch name for the synced board (overridable via config). */
export const DEFAULT_BOARD_REF = 'taskwright-board';

/** The board subdirectories that live on the sync ref (relative to the backlog dir). */
export const BOARD_SUBDIRS: readonly string[] = ['tasks', 'drafts', 'completed', 'archive'];

/** A short ref name becomes `refs/heads/<name>`; a fully-qualified `refs/...` is returned as-is. */
export function qualifyRef(ref: string): string {
  return ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
}

/**
 * Config flags that disable EOL conversion so board blobs and working-copy files
 * round-trip **byte-for-byte** — without this, git's `core.autocrlf` rewrites
 * task-file line endings on checkout (breaking Backlog.md's exact-bytes contract).
 */
const NO_EOL_CONVERT = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf'];

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
    await exec(opts.repoRoot, [...NO_EOL_CONVERT, 'add', '--force', '--all', '--', ...paths], env);
  }

  const tree = (await exec(opts.repoRoot, ['write-tree'], env)).stdout.trim();

  const commitArgs = ['commit-tree', tree, '-m', opts.message];
  if (opts.parent) commitArgs.push('-p', opts.parent);
  const commit = (await exec(opts.repoRoot, commitArgs, env)).stdout.trim();

  await exec(opts.repoRoot, ['update-ref', qualifyRef(opts.ref), commit], env);

  return { commit, tree };
}

export interface MaterializeOptions {
  repoRoot: string;
  ref: string;
  indexFile: string;
  backlogDir?: string;
  exec?: BoardGitExec;
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

/** Recursively list board-relative file paths under the board subdirs on disk (posix separators). */
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

/**
 * Delete each `listed` local board file that is absent from `keep`, so the board
 * subdirs match the ref. `listed` is the *snapshot* of local files taken before
 * this call — it is deliberately decoupled from live disk state, because between
 * listing and unlinking a sibling materialize on the same shared working tree
 * (another poll, an MCP session, or `reconcileBoardRef`/`compactBoardRef`) can
 * unlink one of these paths first. Pruning is an idempotent *ensure-absent*
 * operation, so `{ force: true }` makes an already-removed target a no-op rather
 * than an ENOENT that would abort the whole materialize (freezing the
 * `board.materialized` marker). No `recursive`: `listed` only ever contains
 * files (see `walkFiles`), never directories.
 */
export function pruneStaleBoardFiles(
  repoRoot: string,
  listed: Iterable<string>,
  keep: ReadonlySet<string>
): void {
  for (const rel of listed) {
    if (!keep.has(rel)) {
      fs.rmSync(path.join(repoRoot, ...rel.split('/')), { force: true });
    }
  }
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

  // Load the ref's tree into the isolated index.
  await exec(opts.repoRoot, ['read-tree', qualifyRef(opts.ref)], env);

  // The set of files the ref declares.
  const listed = (
    await exec(opts.repoRoot, ['ls-tree', '-r', '--name-only', qualifyRef(opts.ref)], env)
  ).stdout.trim();
  const refFiles = new Set(listed.length > 0 ? listed.split('\n') : []);

  // Refuse to write anything outside the board subdirs. A board commit only
  // ever contains backlog/{tasks,drafts,completed,archive} paths; anything else
  // means the ref points at the wrong commit (e.g. a code branch), and
  // `checkout-index --all --force` below would overwrite the user's repo root
  // with it — which is exactly how a poisoned ref once mass-reverted the root.
  const allowedPrefixes = BOARD_SUBDIRS.map((sub) => `${backlogDir}/${sub}/`);
  for (const rel of refFiles) {
    if (!allowedPrefixes.some((prefix) => rel.startsWith(prefix))) {
      throw new Error(
        `materialize refused: ref "${opts.ref}" contains non-board path "${rel}" — ` +
          `a board commit must only touch ${backlogDir}/{${BOARD_SUBDIRS.join(',')}}`
      );
    }
  }

  // Pre-create leading directories (e.g. archive/tasks/) so checkout-index can
  // write nested paths regardless of git version, then write the files out.
  for (const rel of refFiles) {
    fs.mkdirSync(path.dirname(path.join(opts.repoRoot, ...rel.split('/'))), { recursive: true });
  }
  await exec(opts.repoRoot, [...NO_EOL_CONVERT, 'checkout-index', '--all', '--force'], env);

  // Prune local board files not present on the ref. The listing is snapshotted
  // first and pruned with force, so a file a concurrent sibling materialize
  // removes between listing and unlinking cannot abort this materialize.
  pruneStaleBoardFiles(opts.repoRoot, listLocalBoardFiles(opts.repoRoot, backlogDir), refFiles);

  return { files: [...refFiles].sort() };
}

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
 * Private ref where `fetchRef` stages the fetched tip. FETCH_HEAD is never
 * read: it is a single unlocked file shared by every fetch in the repo, so a
 * concurrent full `git fetch` (VS Code autofetch, GitKraken, another session)
 * can overwrite it between our fetch and our read. That race once resolved the
 * board ref to a stale `origin/main` and materialized that entire code tree
 * over the repo root. A ref update is atomic, and at worst a concurrent
 * `fetchRef` of the same ref stages a *fresher* tip of the same remote ref.
 */
function fetchStagingRef(ref: string): string {
  const short = ref.startsWith('refs/') ? ref.slice('refs/'.length).replace(/\//g, '-') : ref;
  return `refs/taskwright/fetch/${short}`;
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
  const staging = fetchStagingRef(ref);
  try {
    // `+` forces the staging update: board compaction rewrites the ref history
    // (lease-guarded force-push), so the fetch must accept non-fast-forward moves.
    await exec(repoRoot, ['fetch', '--quiet', remote, `+${qualifyRef(ref)}:${staging}`]);
  } catch {
    return null; // remote has no such ref (or unreachable)
  }
  try {
    const { stdout } = await exec(repoRoot, ['rev-parse', '--verify', '--quiet', staging]);
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
