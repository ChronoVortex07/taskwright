import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Guards the contributed MANIFEST defaults (package.json contributes.configuration).
 * The `readSettings` code fallbacks in `dispatchActions.ts` must be kept in sync
 * manually — this test only reads package.json, not the TypeScript fallbacks.
 */
const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'));
const props = pkg.contributes.configuration.properties as Record<
  string,
  { type: string; default: unknown }
>;

describe('contributed dispatch config defaults', () => {
  it('defaults dispatchCreateWorktree to true (worktrees by default)', () => {
    expect(props['taskwright.dispatchCreateWorktree'].default).toBe(true);
  });

  it('keeps dispatchOpenTerminal opt-in (default false)', () => {
    expect(props['taskwright.dispatchOpenTerminal'].default).toBe(false);
  });

  it('contributes dispatchTerminalCommand defaulting to empty string', () => {
    const setting = props['taskwright.dispatchTerminalCommand'];
    expect(setting.type).toBe('string');
    expect(setting.default).toBe('');
  });
});

describe('taskwright.sync.* manifest defaults', () => {
  it('sync.mode defaults to off with the three modes', () => {
    const setting = props['taskwright.sync.mode'] as { default: unknown; enum?: unknown };
    expect(setting.default).toBe('off');
    expect(setting.enum).toEqual(['off', 'local', 'github']);
  });

  it('sync.ref / sync.remote / sync.pollIntervalSeconds match DEFAULT_SYNC_CONFIG', () => {
    expect(props['taskwright.sync.ref'].default).toBe('taskwright-board');
    expect(props['taskwright.sync.remote'].default).toBe('origin');
    expect(props['taskwright.sync.pollIntervalSeconds'].default).toBe(20);
  });
});
