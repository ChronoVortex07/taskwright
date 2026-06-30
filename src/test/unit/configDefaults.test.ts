import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The manifest's contributed defaults are the source of truth users see; these
 * assertions guard against the manifest and the code fallbacks drifting apart.
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
});
