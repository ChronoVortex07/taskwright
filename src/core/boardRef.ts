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

  // Pre-create leading directories (e.g. archive/tasks/) so checkout-index can
  // write nested paths regardless of git version, then write the files out.
  for (const rel of refFiles) {
    fs.mkdirSync(path.dirname(path.join(opts.repoRoot, ...rel.split('/'))), { recursive: true });
  }
  await exec(opts.repoRoot, [...NO_EOL_CONVERT, 'checkout-index', '--all', '--force'], env);

  // Prune local board files not present on the ref.
  for (const rel of listLocalBoardFiles(opts.repoRoot, backlogDir)) {
    if (!refFiles.has(rel)) {
      fs.rmSync(path.join(opts.repoRoot, ...rel.split('/')));
    }
  }

  return { files: [...refFiles].sort() };
}
