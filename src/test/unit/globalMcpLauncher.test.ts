import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import {
  LAUNCHER_FILENAME,
  POINTER_FILENAME,
  LAUNCHER_SCRIPT,
  launcherPathFor,
  pointerPathFor,
  renderPointer,
  readPointerServerPath,
  installGlobalMcpLauncher,
  type LauncherFsDeps,
} from '../../core/globalMcpLauncher';

/** In-memory fs double: records every write so churn is assertable. */
function fakeFs(seed: Record<string, string> = {}): LauncherFsDeps & {
  files: Record<string, string>;
  writes: string[];
} {
  const files: Record<string, string> = { ...seed };
  const writes: string[] = [];
  return {
    files,
    writes,
    mkdirSync: vi.fn(),
    existsSync: (p: string) => p in files,
    readFileSync: (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    writeFileSync: (p: string, data: string) => {
      files[p] = data;
      writes.push(p);
    },
  };
}

const STORAGE = path.join('/global', 'storage', 'chronovortex07.taskwright');
const V1 = path.join('/ext', 'chronovortex07.taskwright-1.6.0', 'dist', 'mcp', 'server.js');
const V2 = path.join('/ext', 'chronovortex07.taskwright-1.7.0', 'dist', 'mcp', 'server.js');

describe('globalMcpLauncher', () => {
  describe('pointer', () => {
    it('round-trips the server path', () => {
      expect(readPointerServerPath(renderPointer(V1))).toBe(V1);
    });

    it('returns null for a missing/corrupt pointer instead of throwing', () => {
      expect(readPointerServerPath('not json')).toBeNull();
      expect(readPointerServerPath('{}')).toBeNull();
    });
  });

  describe('installGlobalMcpLauncher', () => {
    it('writes the launcher + pointer and returns the launcher path', () => {
      const fs = fakeFs();
      const launcher = installGlobalMcpLauncher(STORAGE, V1, fs);

      expect(launcher).toBe(launcherPathFor(STORAGE));
      expect(fs.files[launcherPathFor(STORAGE)]).toBe(LAUNCHER_SCRIPT);
      expect(readPointerServerPath(fs.files[pointerPathFor(STORAGE)])).toBe(V1);
    });

    it('keeps the launcher path STABLE across extension versions (the registered command never rots)', () => {
      const fs = fakeFs();
      const first = installGlobalMcpLauncher(STORAGE, V1, fs);
      const second = installGlobalMcpLauncher(STORAGE, V2, fs);

      // Same registered command — only the pointer moves to the new build.
      expect(second).toBe(first);
      expect(readPointerServerPath(fs.files[pointerPathFor(STORAGE)])).toBe(V2);
    });

    it('is idempotent: a re-install with identical content rewrites nothing', () => {
      const fs = fakeFs();
      installGlobalMcpLauncher(STORAGE, V1, fs);
      const writesAfterFirst = fs.writes.length;

      installGlobalMcpLauncher(STORAGE, V1, fs);
      expect(fs.writes.length).toBe(writesAfterFirst);
    });
  });

  describe('LAUNCHER_SCRIPT', () => {
    it('resolves its server from the sibling pointer file, not a pinned version path', () => {
      expect(LAUNCHER_SCRIPT).toContain(POINTER_FILENAME);
      expect(LAUNCHER_SCRIPT).not.toMatch(/taskwright-\d+\.\d+\.\d+/);
    });

    it('is dependency-free CommonJS (runs with no node_modules)', () => {
      expect(LAUNCHER_SCRIPT).not.toMatch(/^\s*import\s/m);
      const requires = [...LAUNCHER_SCRIPT.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(
        (m) => m[1]
      );
      expect(requires.every((r) => r === 'fs' || r === 'path')).toBe(true);
    });

    it('names the launcher file it is written as', () => {
      expect(LAUNCHER_FILENAME).toMatch(/\.cjs$/);
    });
  });
});
