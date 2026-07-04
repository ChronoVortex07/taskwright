import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import * as path from 'path';

// The launcher is committed plain CommonJS (it must run when dist/ and
// node_modules are absent), so we require the .cjs directly — mirrors
// taskwrightMcpLauncher.test.ts. Its `require.main` guard keeps this import
// side-effect-free — no push/pull is attempted.
const requireCjs = createRequire(path.join(process.cwd(), 'package.json'));
const launcher = requireCjs(path.join(process.cwd(), 'scripts', 'board-sync-hook.cjs')) as {
  resolveBundlePath: (
    commonDirOutput: string,
    cwd: string
  ) => { bundlePath: string; commonDir: string };
};

const norm = (p: string): string => p.replace(/\\/g, '/');

describe('resolveBundlePath', () => {
  it('resolves the primary build from the primary checkout', () => {
    const { bundlePath, commonDir } = launcher.resolveBundlePath('/repo/.git', '/repo');
    expect(norm(bundlePath)).toBe('/repo/dist/hooks/board-sync-hook.js');
    expect(norm(commonDir)).toBe('/repo/.git');
  });

  it('resolves the *primary* build even when launched from a linked worktree', () => {
    const { bundlePath, commonDir } = launcher.resolveBundlePath(
      '/repo/.git',
      '/repo/.worktrees/task-7-login'
    );
    expect(norm(bundlePath)).toBe('/repo/dist/hooks/board-sync-hook.js');
    expect(norm(commonDir)).toBe('/repo/.git');
  });

  it('resolves a relative --git-common-dir against cwd (older git fallback)', () => {
    const { bundlePath } = launcher.resolveBundlePath('.git', '/repo');
    expect(norm(bundlePath).endsWith('/repo/dist/hooks/board-sync-hook.js')).toBe(true);
  });

  it('trims surrounding whitespace/newline from the git output', () => {
    const { bundlePath, commonDir } = launcher.resolveBundlePath('  /repo/.git\n', '/repo');
    expect(norm(bundlePath)).toBe('/repo/dist/hooks/board-sync-hook.js');
    expect(norm(commonDir)).toBe('/repo/.git');
  });
});
