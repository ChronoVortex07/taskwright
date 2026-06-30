import { describe, it, expect, vi } from 'vitest';
import {
  buildAddArgs,
  buildRemoveArgs,
  isClaudeCliAvailable,
  isTaskwrightMcpRegistered,
  registerTaskwrightMcp,
  type ExecFn,
} from '../../core/claudeMcp';

const ok = (stdout = ''): ReturnType<ExecFn> => Promise.resolve({ stdout, stderr: '' });
const fail = (): ReturnType<ExecFn> => Promise.reject(new Error('boom'));

describe('claudeMcp', () => {
  describe('arg builders', () => {
    it('builds a user-scope add command targeting node + the server path', () => {
      expect(buildAddArgs('/ext/dist/mcp/server.js')).toEqual([
        'mcp',
        'add',
        'taskwright',
        '-s',
        'user',
        '--',
        'node',
        '/ext/dist/mcp/server.js',
      ]);
    });

    it('builds a user-scope remove command', () => {
      expect(buildRemoveArgs()).toEqual(['mcp', 'remove', 'taskwright', '-s', 'user']);
    });
  });

  describe('isClaudeCliAvailable', () => {
    it('is true when `claude --version` succeeds', async () => {
      const exec = vi.fn(() => ok('1.2.3'));
      await expect(isClaudeCliAvailable(exec)).resolves.toBe(true);
      expect(exec).toHaveBeenCalledWith('claude', ['--version']);
    });

    it('is false when the CLI is absent', async () => {
      await expect(isClaudeCliAvailable(() => fail())).resolves.toBe(false);
    });
  });

  describe('isTaskwrightMcpRegistered', () => {
    it('is true when `claude mcp get taskwright` returns the server', async () => {
      await expect(isTaskwrightMcpRegistered(() => ok('taskwright: node ...'))).resolves.toBe(true);
    });

    it('is false when the get command errors (not registered)', async () => {
      await expect(isTaskwrightMcpRegistered(() => fail())).resolves.toBe(false);
    });
  });

  describe('registerTaskwrightMcp', () => {
    it('removes any stale registration then adds the current path', async () => {
      const calls: string[][] = [];
      const exec: ExecFn = (_cmd, args) => {
        calls.push(args);
        return ok();
      };
      await registerTaskwrightMcp('/ext/dist/mcp/server.js', exec);
      expect(calls[0]).toEqual(buildRemoveArgs());
      expect(calls[1]).toEqual(buildAddArgs('/ext/dist/mcp/server.js'));
    });

    it('still adds when the pre-emptive remove fails (nothing to remove)', async () => {
      const calls: string[][] = [];
      const exec: ExecFn = (_cmd, args) => {
        calls.push(args);
        if (args[1] === 'remove') return fail();
        return ok();
      };
      await registerTaskwrightMcp('/ext/dist/mcp/server.js', exec);
      expect(calls.some((a) => a[1] === 'add')).toBe(true);
    });
  });
});
