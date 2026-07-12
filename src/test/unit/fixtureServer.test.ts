import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import type { AddressInfo } from 'net';

import {
  BASE_FIXTURE_PORT,
  FIXTURE_ROOT_ENDPOINT,
  fixtureRootMiddleware,
  fixtureServerPort,
  isLinkedWorktree,
  missingRequiredBundles,
  missingBundlesMessage,
  probeFixtureServer,
  assertFixtureServerServesTree,
  sameTreeRoot,
} from '../../../scripts/lib/fixtureServer';

/** Start a bare http server around a connect-style middleware; resolve its port. */
async function listen(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** A real fixture server for `rootDir` — the same middleware vite.config.ts mounts. */
async function startFixtureServer(rootDir: string) {
  const mw = fixtureRootMiddleware(rootDir);
  return listen((req, res) =>
    mw(req, res, () => {
      res.statusCode = 404;
      res.end('not found');
    })
  );
}

/** A server that is NOT a Taskwright fixture server (404s everything). */
async function startForeignServer() {
  return listen((_req, res) => {
    res.statusCode = 404;
    res.end('nope');
  });
}

/** A free port with nothing listening on it. */
async function freePort(): Promise<number> {
  const s = await listen((_req, res) => res.end('x'));
  await s.close();
  return s.port;
}

describe('scripts/lib/fixtureServer — isLinkedWorktree', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-fixture-'));
  });
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('is false for a primary checkout (.git is a directory)', () => {
    const root = path.join(tmp, 'primary');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    expect(isLinkedWorktree(root)).toBe(false);
  });

  it('is true for a linked worktree (.git is a file: "gitdir: ...")', () => {
    const root = path.join(tmp, 'wt');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: /repo/.git/worktrees/wt\n');
    expect(isLinkedWorktree(root)).toBe(true);
  });

  it('is false when there is no .git at all (not a repo)', () => {
    const root = path.join(tmp, 'bare');
    fs.mkdirSync(root, { recursive: true });
    expect(isLinkedWorktree(root)).toBe(false);
  });
});

describe('scripts/lib/fixtureServer — fixtureServerPort', () => {
  it('keeps the documented port for the primary checkout', () => {
    expect(fixtureServerPort('/repo/taskwright', { linked: false, env: {} })).toBe(
      BASE_FIXTURE_PORT
    );
    expect(BASE_FIXTURE_PORT).toBe(5173);
  });

  it('gives a linked worktree its own port — never the primary one', () => {
    const port = fixtureServerPort('/repo/taskwright/.worktrees/task-111-foo', {
      linked: true,
      env: {},
    });
    expect(port).not.toBe(BASE_FIXTURE_PORT);
    expect(port).toBeGreaterThan(BASE_FIXTURE_PORT);
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeLessThan(65536);
  });

  it('is deterministic — the same worktree always gets the same port', () => {
    const a = fixtureServerPort('/repo/tw/.worktrees/task-7', { linked: true, env: {} });
    const b = fixtureServerPort('/repo/tw/.worktrees/task-7', { linked: true, env: {} });
    expect(a).toBe(b);
  });

  it('separates worktrees — two trees do not share a port (the TASK-111 collision)', () => {
    const a = fixtureServerPort('/repo/tw/.worktrees/task-111-playwright', {
      linked: true,
      env: {},
    });
    const b = fixtureServerPort('/repo/tw/.worktrees/task-113-something-else', {
      linked: true,
      env: {},
    });
    expect(a).not.toBe(b);
  });

  it('normalizes path separators so a Windows path is stable across shells', () => {
    const win = fixtureServerPort('C:\\repo\\tw\\.worktrees\\task-7', { linked: true, env: {} });
    const posixish = fixtureServerPort('C:/repo/tw/.worktrees/task-7/', {
      linked: true,
      env: {},
    });
    expect(win).toBe(posixish);
  });

  it('honours an explicit TASKWRIGHT_FIXTURE_PORT override (escape hatch)', () => {
    expect(
      fixtureServerPort('/repo/tw/.worktrees/task-7', {
        linked: true,
        env: { TASKWRIGHT_FIXTURE_PORT: '6000' },
      })
    ).toBe(6000);
    expect(
      fixtureServerPort('/repo/tw', { linked: false, env: { TASKWRIGHT_FIXTURE_PORT: '6000' } })
    ).toBe(6000);
  });

  it('ignores a nonsense override rather than binding an invalid port', () => {
    expect(
      fixtureServerPort('/repo/tw', { linked: false, env: { TASKWRIGHT_FIXTURE_PORT: 'banana' } })
    ).toBe(BASE_FIXTURE_PORT);
    expect(
      fixtureServerPort('/repo/tw', { linked: false, env: { TASKWRIGHT_FIXTURE_PORT: '99999' } })
    ).toBe(BASE_FIXTURE_PORT);
  });
});

describe('scripts/lib/fixtureServer — sameTreeRoot', () => {
  it('matches identical roots regardless of separators / trailing slash', () => {
    expect(sameTreeRoot('C:\\repo\\tw', 'C:/repo/tw/', 'win32')).toBe(true);
    expect(sameTreeRoot('/repo/tw', '/repo/tw', 'linux')).toBe(true);
  });

  it('is case-insensitive on Windows, case-sensitive on Linux', () => {
    expect(sameTreeRoot('C:\\Repo\\TW', 'c:/repo/tw', 'win32')).toBe(true);
    expect(sameTreeRoot('/repo/TW', '/repo/tw', 'linux')).toBe(false);
  });

  it('does not match two different trees', () => {
    expect(sameTreeRoot('/repo/tw', '/repo/tw/.worktrees/task-7', 'linux')).toBe(false);
  });
});

describe('scripts/lib/fixtureServer — probe / assert against a REAL server', () => {
  // The exact TASK-111 scenario: a fixture server started from worktree A, a
  // Playwright run in worktree B. Before this guard, Playwright's
  // `reuseExistingServer` consumed A's server (and therefore A's dist/webview/)
  // in silence.
  const TREE_A = path.resolve('/repo/taskwright/.worktrees/task-999-other');
  const TREE_B = path.resolve('/repo/taskwright/.worktrees/task-111-playwright');

  it('probes a fixture server and reports the tree it serves', async () => {
    const srv = await startFixtureServer(TREE_A);
    try {
      const probe = await probeFixtureServer(srv.port);
      expect(probe.reachable).toBe(true);
      expect(probe.reachable && probe.root).toBeTruthy();
      expect(sameTreeRoot(probe.reachable ? (probe.root as string) : '', TREE_A)).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it('passes when the running server serves THIS tree', async () => {
    const srv = await startFixtureServer(TREE_B);
    try {
      await expect(
        assertFixtureServerServesTree({ rootDir: TREE_B, port: srv.port })
      ).resolves.toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it("FAILS LOUDLY when the running server serves a DIFFERENT worktree's dist/", async () => {
    const srv = await startFixtureServer(TREE_A);
    try {
      const err = await assertFixtureServerServesTree({
        rootDir: TREE_B,
        port: srv.port,
      }).then(
        () => null,
        (e: Error) => e
      );
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      // Names the mismatch on BOTH sides, and the port, so it is actionable.
      expect(msg).toContain(TREE_B);
      expect(msg).toContain(TREE_A);
      expect(msg).toContain(String(srv.port));
      expect(msg).toMatch(/not serving this worktree/i);
    } finally {
      await srv.close();
    }
  });

  it('fails loudly when something else is bound to the port (no fixture endpoint)', async () => {
    const srv = await startForeignServer();
    try {
      const err = await assertFixtureServerServesTree({ rootDir: TREE_B, port: srv.port }).then(
        () => null,
        (e: Error) => e
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/not a Taskwright fixture server/i);
      expect((err as Error).message).toContain(String(srv.port));
    } finally {
      await srv.close();
    }
  });

  it('is a no-op when nothing is listening (Playwright will start our own server)', async () => {
    const port = await freePort();
    await expect(
      assertFixtureServerServesTree({ rootDir: TREE_B, port })
    ).resolves.toBeUndefined();
  });

  it('serves the root only on the fixture endpoint, and delegates everything else', async () => {
    const srv = await startFixtureServer(TREE_A);
    try {
      const hit = await fetch(`http://127.0.0.1:${srv.port}${FIXTURE_ROOT_ENDPOINT}`);
      expect(hit.status).toBe(200);
      expect(await hit.json()).toEqual({ root: TREE_A });

      const miss = await fetch(`http://127.0.0.1:${srv.port}/tasks.html`);
      expect(miss.status).toBe(404); // fell through to next()
    } finally {
      await srv.close();
    }
  });
});

describe('scripts/lib/fixtureServer — required-bundle guard (existing behavior)', () => {
  it('reports every missing dist/webview bundle', () => {
    const present = new Set(['dist/webview/tasks.js']);
    const missing = missingRequiredBundles('/repo', (abs: string) =>
      present.has(abs.replace(/\\/g, '/').replace('/repo/', ''))
    );
    expect(missing).toContain('dist/webview/styles.css');
    expect(missing).toContain('dist/webview/tasks.css');
    expect(missing).not.toContain('dist/webview/tasks.js');
  });

  it('reports nothing when the build is complete', () => {
    expect(missingRequiredBundles('/repo', () => true)).toEqual([]);
  });

  it('names the missing files and the fix in its message', () => {
    const msg = missingBundlesMessage(['dist/webview/styles.css']);
    expect(msg).toContain('dist/webview/styles.css');
    expect(msg).toContain('bun run build');
  });
});
