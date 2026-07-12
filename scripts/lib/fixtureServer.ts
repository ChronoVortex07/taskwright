/**
 * The Vite fixture server that the Playwright webview suite drives — its port, its
 * identity, and the guards that stop a run from testing the WRONG build.
 *
 * Two failure modes, one shared cause: the suite loads `dist/webview/*` through a Vite
 * dev server, and NOTHING about that server tells you which build it is serving.
 *
 *  1. **Half-built `dist/`** (already guarded): a partial `bun run build` omits
 *     `dist/webview/styles.css`, which Chromium 404s silently — the fixture page's entire
 *     height chain collapses and unrelated `tree-canvas` assertions fail exactly like a code
 *     regression. `missingRequiredBundles` fails fast and names the file.
 *
 *  2. **Another worktree's server** (TASK-111): `playwright.config.ts` sets
 *     `reuseExistingServer: !CI` on a FIXED port, so a fixture server already running in a
 *     *different* worktree got silently reused — serving *that* tree's `dist/webview/`. The
 *     suite then tested a build that was not the one under test, with no warning at all.
 *
 * The fix for (2) is belt AND braces:
 *
 *  - **A tree-unique port** (`fixtureServerPort`) removes the collision instead of detecting
 *    it: the primary checkout keeps the documented 5173, and every linked worktree derives a
 *    stable port from its own path. Both `vite.config.ts` and `playwright.config.ts` call
 *    this, so a worktree's server and its suite always agree — and two worktrees can run the
 *    suite at the same time, which the fixed port never allowed.
 *  - **An identity endpoint** (`fixtureRootMiddleware` / `assertFixtureServerServesTree`)
 *    catches whatever slips through anyway (a hash collision, a stale server, an unrelated
 *    process on the port) and fails LOUDLY, naming both trees, instead of passing against the
 *    wrong `dist/`.
 *
 * Pure/injectable by design so all of it is unit-testable (`src/test/unit/fixtureServer.test.ts`)
 * without Playwright or Vite.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';

/** The port the PRIMARY checkout serves fixtures on (documented in AGENTS.md / visual-proof). */
export const BASE_FIXTURE_PORT = 5173;

/** Linked worktrees are spread over `BASE + 1 .. BASE + FIXTURE_PORT_RANGE`. */
export const FIXTURE_PORT_RANGE = 800;

/** Endpoint every Taskwright fixture server answers with the absolute root it serves. */
export const FIXTURE_ROOT_ENDPOINT = '/__taskwright_fixture_root';

/** Env escape hatch, honoured by both the Vite server and the Playwright config. */
export const FIXTURE_PORT_ENV = 'TASKWRIGHT_FIXTURE_PORT';

/** The `dist/webview/*` files the fixture pages cannot render correctly without. */
export const REQUIRED_BUNDLES = [
  'dist/webview/styles.css',
  'dist/webview/tasks.js',
  'dist/webview/tasks.css',
];

// ---------------------------------------------------------------------------
// Tree identity
// ---------------------------------------------------------------------------

/** Slashes normalized, trailing separator dropped — a comparable/hashable tree identity. */
function normalizeRoot(rootDir: string): string {
  const slashed = rootDir.replace(/\\/g, '/');
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
}

/**
 * Whether `rootDir` is a git *linked worktree* rather than the primary checkout.
 * In a linked worktree `.git` is a FILE (`gitdir: …`); in the primary it is a directory.
 * Cheap (one stat) and needs no subprocess.
 */
export function isLinkedWorktree(rootDir: string): boolean {
  try {
    return fs.statSync(path.join(rootDir, '.git')).isFile();
  } catch {
    return false;
  }
}

/** FNV-1a (32-bit) — small, dependency-free, stable across processes and platforms. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The fixture-server port for a checkout.
 *
 * - Primary checkout → `BASE_FIXTURE_PORT` (5173), so the documented agent-browser /
 *   visual-proof workflow is untouched.
 * - Linked worktree → a deterministic port derived from its path, so two worktrees can never
 *   consume each other's server (and can run the suite concurrently).
 * - `TASKWRIGHT_FIXTURE_PORT` overrides both.
 */
export function fixtureServerPort(
  rootDir: string,
  options: { linked?: boolean; env?: NodeJS.ProcessEnv } = {}
): number {
  const env = options.env ?? process.env;
  const override = env[FIXTURE_PORT_ENV];
  if (override) {
    const n = Number(override);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }

  const linked = options.linked ?? isLinkedWorktree(rootDir);
  if (!linked) return BASE_FIXTURE_PORT;

  return BASE_FIXTURE_PORT + 1 + (fnv1a(normalizeRoot(rootDir).toLowerCase()) % FIXTURE_PORT_RANGE);
}

/**
 * Whether two paths name the same checkout. Separator- and trailing-slash-agnostic, and
 * case-insensitive on the case-insensitive-by-default platforms (Windows, macOS).
 */
export function sameTreeRoot(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const na = normalizeRoot(a);
  const nb = normalizeRoot(b);
  if (na === nb) return true;
  const caseInsensitive = platform === 'win32' || platform === 'darwin';
  return caseInsensitive && na.toLowerCase() === nb.toLowerCase();
}

// ---------------------------------------------------------------------------
// The identity endpoint (mounted by vite.config.ts)
// ---------------------------------------------------------------------------

type NextFn = (err?: unknown) => void;

/**
 * Connect-style middleware that answers `FIXTURE_ROOT_ENDPOINT` with the absolute root of
 * the tree whose `dist/` this server is serving. Everything else falls through to `next()`.
 * This is the build stamp the fixed port never had.
 */
export function fixtureRootMiddleware(
  rootDir: string
): (req: IncomingMessage, res: ServerResponse, next: NextFn) => void {
  const root = path.resolve(rootDir);
  return (req, res, next) => {
    const url = (req.url ?? '').split('?')[0];
    if (url !== FIXTURE_ROOT_ENDPOINT) {
      next();
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ root }));
  };
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

export type FixtureServerProbe =
  | { reachable: false }
  /** `root: null` ⇒ something answered, but it is not a Taskwright fixture server. */
  | { reachable: true; root: string | null };

/** Ask whatever is listening on `port` which tree it serves. Never throws. */
export async function probeFixtureServer(
  port: number,
  fetchImpl: typeof fetch = fetch
): Promise<FixtureServerProbe> {
  let res: Response;
  try {
    res = await fetchImpl(`http://127.0.0.1:${port}${FIXTURE_ROOT_ENDPOINT}`);
  } catch {
    return { reachable: false };
  }
  if (!res.ok) return { reachable: true, root: null };
  try {
    const body = (await res.json()) as { root?: unknown };
    return { reachable: true, root: typeof body.root === 'string' ? body.root : null };
  } catch {
    return { reachable: true, root: null };
  }
}

const RULE = '=============================================================';

/** The loud, actionable message — it must name BOTH trees and the port. */
export function fixtureServerMismatchMessage(args: {
  expectedRoot: string;
  actualRoot: string | null;
  port: number;
}): string {
  const { expectedRoot, actualRoot, port } = args;
  const serving = actualRoot ?? '(not a Taskwright fixture server — no fixture-root endpoint)';
  return [
    '',
    '',
    RULE,
    `Playwright webview e2e suite aborted: the server on port ${port} is`,
    'NOT serving this worktree.',
    '',
    `  this tree serves : ${expectedRoot}`,
    `  port ${port} serves : ${serving}`,
    '',
    "Playwright's `reuseExistingServer` would have run the whole suite",
    "against THAT tree's dist/webview/ — i.e. tested a build you did not",
    'make, and passed or failed for reasons that have nothing to do with',
    'your code.',
    '',
    'Each checkout gets its own fixture port (the primary checkout keeps',
    `${BASE_FIXTURE_PORT}; a linked worktree derives one from its path), so this normally`,
    'cannot happen. Seeing it means something else is bound to the port.',
    '',
    'Fix: stop that server / process, then re-run. To pin a port yourself,',
    `set ${FIXTURE_PORT_ENV}=<port> for BOTH the server and the test run.`,
    RULE,
    '',
  ].join('\n');
}

/**
 * Fail the run if the fixture server on `port` is serving a different tree (or is not a
 * fixture server at all). A silent port with nothing listening is fine — Playwright starts
 * our own server.
 */
export async function assertFixtureServerServesTree(args: {
  rootDir: string;
  port: number;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
}): Promise<void> {
  const { rootDir, port, fetchImpl, platform } = args;
  const expectedRoot = path.resolve(rootDir);

  const probe = await probeFixtureServer(port, fetchImpl);
  if (!probe.reachable) return; // nothing to reuse — Playwright will start ours
  if (probe.root !== null && sameTreeRoot(probe.root, expectedRoot, platform)) return;

  throw new Error(
    fixtureServerMismatchMessage({ expectedRoot, actualRoot: probe.root, port })
  );
}

// ---------------------------------------------------------------------------
// The pre-existing half-built-dist guard (kept, now unit-testable)
// ---------------------------------------------------------------------------

/** Which of `REQUIRED_BUNDLES` are absent under `repoRoot`. */
export function missingRequiredBundles(
  repoRoot: string,
  exists: (absPath: string) => boolean = fs.existsSync
): string[] {
  return REQUIRED_BUNDLES.filter((rel) => !exists(path.join(repoRoot, rel)));
}

export function missingBundlesMessage(missing: string[]): string {
  return [
    '',
    '',
    RULE,
    'Playwright webview e2e suite aborted: dist/webview/ is missing',
    'required built file(s):',
    '',
    ...missing.map((f) => `  - ${f}`),
    '',
    'These are emitted by `bun run build` (compile:webview && build:css',
    '&& compile) — a partial build (e.g. only `bun run compile:webview`)',
    'silently omits some of them, and the fixture pages this suite loads',
    'depend on ALL of them for correct layout/behavior. Run:',
    '',
    '  bun run build',
    '',
    'then re-run the tests.',
    RULE,
    '',
  ].join('\n');
}
