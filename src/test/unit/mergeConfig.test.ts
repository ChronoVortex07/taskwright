import { describe, it, expect } from 'vitest';
import {
  MERGE_MODES,
  isMergeMode,
  intermediateStatusForMode,
  DEFAULT_MERGE_CONFIG,
  DEFAULT_VERIFY_COMMANDS,
  mergeConfigPath,
  readMergeConfig,
  writeMergeConfig,
  resolveMergeConfigFromSettings,
} from '../../core/mergeConfig';

describe('mode helpers', () => {
  it('exposes the three modes and validates them', () => {
    expect(MERGE_MODES).toEqual(['manual-review', 'auto-merge', 'auto-pr']);
    expect(isMergeMode('auto-merge')).toBe(true);
    expect(isMergeMode('nonsense')).toBe(false);
  });

  it('maps each mode to its intermediate status name', () => {
    expect(intermediateStatusForMode('manual-review')).toBe('Pending Review');
    expect(intermediateStatusForMode('auto-merge')).toBe('Awaiting Merge');
    expect(intermediateStatusForMode('auto-pr')).toBe('Awaiting PR');
  });
});

describe('mergeConfigPath', () => {
  it('nests under <commonDir>/taskwright/merge-config.json', () => {
    expect(mergeConfigPath('/repo/.git').replace(/\\/g, '/')).toBe(
      '/repo/.git/taskwright/merge-config.json'
    );
  });
});

describe('readMergeConfig', () => {
  it('returns defaults when the file is missing', () => {
    const cfg = readMergeConfig('/nope.json', { exists: () => false, read: () => '' });
    expect(cfg).toEqual(DEFAULT_MERGE_CONFIG);
    expect(cfg.mode).toBe('manual-review');
  });

  it('returns defaults when the file is corrupt', () => {
    const cfg = readMergeConfig('/c.json', { exists: () => true, read: () => 'nope' });
    expect(cfg).toEqual(DEFAULT_MERGE_CONFIG);
  });

  it('reads a valid config', () => {
    const json = JSON.stringify({ mode: 'auto-pr', verifyCommands: ['x'], staleMinutes: 5 });
    const cfg = readMergeConfig('/c.json', { exists: () => true, read: () => json });
    expect(cfg).toEqual({ mode: 'auto-pr', verifyCommands: ['x'], staleMinutes: 5 });
  });

  it('falls back field-by-field on partial/invalid values', () => {
    const json = JSON.stringify({ mode: 'bogus', staleMinutes: -3 });
    const cfg = readMergeConfig('/c.json', { exists: () => true, read: () => json });
    expect(cfg.mode).toBe('manual-review');
    expect(cfg.verifyCommands).toEqual(DEFAULT_VERIFY_COMMANDS);
    expect(cfg.staleMinutes).toBe(30);
  });
});

describe('writeMergeConfig', () => {
  it('forwards the path and serializes the whole config through writeAtomic', () => {
    let path = '';
    let written = '';
    writeMergeConfig('/c.json', DEFAULT_MERGE_CONFIG, {
      writeAtomic: (p, d) => {
        path = p;
        written = d;
      },
    });
    expect(path).toBe('/c.json');
    expect(written).toBe(`${JSON.stringify(DEFAULT_MERGE_CONFIG, null, 2)}\n`);
    expect(JSON.parse(written)).toEqual(DEFAULT_MERGE_CONFIG);
  });
});

describe('config defaults are not shared mutable references', () => {
  it('readMergeConfig fallbacks and DEFAULT_MERGE_CONFIG do not alias DEFAULT_VERIFY_COMMANDS', () => {
    const fromMissing = readMergeConfig('/nope.json', { exists: () => false, read: () => '' });
    fromMissing.verifyCommands.push('mutated');
    expect(DEFAULT_VERIFY_COMMANDS).toEqual(['bun run test', 'bun run lint', 'bun run typecheck']);
    expect(DEFAULT_MERGE_CONFIG.verifyCommands).toEqual([
      'bun run test',
      'bun run lint',
      'bun run typecheck',
    ]);
  });
});

describe('resolveMergeConfigFromSettings', () => {
  it('coerces VS Code settings, clamping bad values to defaults', () => {
    expect(
      resolveMergeConfigFromSettings({
        mode: 'auto-merge',
        verifyCommands: ['a', 'b'],
        staleMinutes: 12,
      })
    ).toEqual({ mode: 'auto-merge', verifyCommands: ['a', 'b'], staleMinutes: 12 });
    expect(resolveMergeConfigFromSettings({}).mode).toBe('manual-review');
    expect(resolveMergeConfigFromSettings({ staleMinutes: 0 }).staleMinutes).toBe(0);
    expect(resolveMergeConfigFromSettings({ verifyCommands: [] }).verifyCommands).toEqual([]);
    expect(resolveMergeConfigFromSettings({ staleMinutes: -1 }).staleMinutes).toBe(30);
  });
});
