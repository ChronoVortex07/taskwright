import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import * as path from 'path';

// The launcher is committed plain CommonJS (it must run when dist/ and
// node_modules are absent), so we require the .cjs directly. Its `require.main`
// guard keeps this import side-effect-free — no server is spawned. process.cwd()
// is the repo root under Vitest (see configDefaults.test.ts), which keeps this
// free of import.meta/__dirname so it typechecks as CommonJS too.
const requireCjs = createRequire(path.join(process.cwd(), 'package.json'));
const launcher = requireCjs(path.join(process.cwd(), 'scripts', 'taskwright-mcp.cjs')) as {
  resolveMainServerPath: (commonDirOutput: string, cwd: string) => string;
};

const norm = (p: string): string => p.replace(/\\/g, '/');

describe('resolveMainServerPath', () => {
  it('resolves the primary build from the primary checkout', () => {
    const server = launcher.resolveMainServerPath('/repo/.git', '/repo');
    expect(norm(server)).toBe('/repo/dist/mcp/server.js');
  });

  it('resolves the *primary* build even when launched from a linked worktree', () => {
    // --git-common-dir returns the primary .git (absolute) from any worktree,
    // so the server binary always comes from the primary checkout, not the cwd.
    const server = launcher.resolveMainServerPath('/repo/.git', '/repo/.worktrees/task-7-login');
    expect(norm(server)).toBe('/repo/dist/mcp/server.js');
  });

  it('resolves a relative --git-common-dir against cwd (older git fallback)', () => {
    // A relative common dir is resolved against cwd; on Windows path.resolve
    // prepends the current drive (e.g. C:/repo/...), so assert the tail.
    const server = launcher.resolveMainServerPath('.git', '/repo');
    expect(norm(server).endsWith('/repo/dist/mcp/server.js')).toBe(true);
  });

  it('trims surrounding whitespace/newline from the git output', () => {
    const server = launcher.resolveMainServerPath('  /repo/.git\n', '/repo');
    expect(norm(server)).toBe('/repo/dist/mcp/server.js');
  });
});
