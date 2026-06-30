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
