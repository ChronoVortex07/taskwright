import { describe, it, expect } from 'vitest';
import {
  MERGE_MODES,
  isMergeMode,
  intermediateStatusForMode,
  IN_PROGRESS,
  DEFAULT_MERGE_CONFIG,
  DEFAULT_VERIFY_COMMANDS,
  DEFAULT_VERIFY_TIMEOUT_MS,
  mergeConfigPath,
  readMergeConfig,
  writeMergeConfig,
  resolveMergeConfigFromSettings,
  explicitSettingValue,
  publishMergeConfig,
} from '../../core/mergeConfig';

describe('IN_PROGRESS', () => {
  it('is the expected board status string', () => {
    expect(IN_PROGRESS).toBe('In Progress');
  });
});

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
    expect(cfg).toEqual({
      mode: 'auto-pr',
      verifyCommands: ['x'],
      staleMinutes: 5,
      verifyTimeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
    });
  });

  it('falls back field-by-field on partial/invalid values', () => {
    const json = JSON.stringify({ mode: 'bogus', staleMinutes: -3 });
    const cfg = readMergeConfig('/c.json', { exists: () => true, read: () => json });
    expect(cfg.mode).toBe('manual-review');
    expect(cfg.verifyCommands).toEqual(DEFAULT_VERIFY_COMMANDS);
    expect(cfg.staleMinutes).toBe(30);
  });

  it('round-trips verifyTimeoutMs and verifyTimeoutMaxMs', () => {
    const json = JSON.stringify({ verifyTimeoutMs: 1_500_000, verifyTimeoutMaxMs: 3_600_000 });
    const cfg = readMergeConfig('/c.json', { exists: () => true, read: () => json });
    expect(cfg.verifyTimeoutMs).toBe(1_500_000);
    expect(cfg.verifyTimeoutMaxMs).toBe(3_600_000);
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
    ).toEqual({
      mode: 'auto-merge',
      verifyCommands: ['a', 'b'],
      staleMinutes: 12,
      verifyTimeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
    });
    expect(resolveMergeConfigFromSettings({}).mode).toBe('manual-review');
    expect(resolveMergeConfigFromSettings({ staleMinutes: 0 }).staleMinutes).toBe(0);
    expect(resolveMergeConfigFromSettings({ verifyCommands: [] }).verifyCommands).toEqual([]);
    expect(resolveMergeConfigFromSettings({ staleMinutes: -1 }).staleMinutes).toBe(30);
  });

  it('defaults verifyTimeoutMs to 10 minutes and omits verifyTimeoutMaxMs', () => {
    expect(DEFAULT_VERIFY_TIMEOUT_MS).toBe(600_000);
    const cfg = resolveMergeConfigFromSettings({});
    expect(cfg.verifyTimeoutMs).toBe(600_000);
    expect(cfg.verifyTimeoutMaxMs).toBeUndefined();
    expect(DEFAULT_MERGE_CONFIG.verifyTimeoutMs).toBe(600_000);
  });

  it('keeps valid positive timeout values and rejects invalid ones', () => {
    expect(resolveMergeConfigFromSettings({ verifyTimeoutMs: 1_500_000 }).verifyTimeoutMs).toBe(
      1_500_000
    );
    expect(resolveMergeConfigFromSettings({ verifyTimeoutMs: 0 }).verifyTimeoutMs).toBe(600_000);
    expect(resolveMergeConfigFromSettings({ verifyTimeoutMs: -5 }).verifyTimeoutMs).toBe(600_000);
    expect(resolveMergeConfigFromSettings({ verifyTimeoutMs: 'x' }).verifyTimeoutMs).toBe(600_000);
    expect(
      resolveMergeConfigFromSettings({ verifyTimeoutMaxMs: 3_600_000 }).verifyTimeoutMaxMs
    ).toBe(3_600_000);
    expect(resolveMergeConfigFromSettings({ verifyTimeoutMaxMs: 0 }).verifyTimeoutMaxMs).toBe(
      undefined
    );
    expect(resolveMergeConfigFromSettings({ verifyTimeoutMaxMs: 'x' }).verifyTimeoutMaxMs).toBe(
      undefined
    );
  });
});

describe('explicitSettingValue', () => {
  it('returns undefined when nothing is explicitly set', () => {
    expect(explicitSettingValue(undefined)).toBeUndefined();
    expect(explicitSettingValue({})).toBeUndefined();
    // defaultValue (package.json default) is NOT an explicit user setting
    expect(explicitSettingValue({ defaultValue: 'auto-merge' } as never)).toBeUndefined();
  });

  it('prefers workspaceFolder over workspace over global', () => {
    expect(explicitSettingValue({ globalValue: 'g' })).toBe('g');
    expect(explicitSettingValue({ globalValue: 'g', workspaceValue: 'w' })).toBe('w');
    expect(
      explicitSettingValue({ globalValue: 'g', workspaceValue: 'w', workspaceFolderValue: 'wf' })
    ).toBe('wf');
  });
});

/** In-memory QueueFsDeps backed by a single-file map. */
function memFs(initial?: string) {
  let content = initial;
  return {
    fs: {
      exists: () => content !== undefined,
      read: () => {
        if (content === undefined) throw new Error('ENOENT');
        return content;
      },
      writeAtomic: (_p: string, data: string) => {
        content = data;
      },
    },
    written: () => content,
  };
}

describe('publishMergeConfig', () => {
  it('materializes full defaults when the file is missing and nothing is explicit', () => {
    const { fs, written } = memFs();
    const result = publishMergeConfig('/c.json', {}, fs);
    expect(result).toEqual(DEFAULT_MERGE_CONFIG);
    expect(JSON.parse(written()!)).toEqual(DEFAULT_MERGE_CONFIG);
  });

  it('falls back to defaults (plus explicit values) when the file is corrupt', () => {
    const { fs, written } = memFs('{not json');
    const result = publishMergeConfig('/c.json', { mode: 'auto-pr' }, fs);
    expect(result.mode).toBe('auto-pr');
    expect(result.verifyCommands).toEqual(DEFAULT_VERIFY_COMMANDS);
    expect(result.staleMinutes).toBe(30);
    expect(JSON.parse(written()!).mode).toBe('auto-pr');
  });

  it('keeps file values for keys the user did not explicitly set (file wins over defaults)', () => {
    const { fs, written } = memFs(
      JSON.stringify({
        mode: 'auto-merge',
        verifyCommands: ['pytest', 'ruff check .'],
        verifyTimeoutMs: 1_500_000,
        verifyTimeoutMaxMs: 3_600_000,
      })
    );
    const result = publishMergeConfig('/c.json', {}, fs);
    expect(result).toEqual({
      mode: 'auto-merge',
      verifyCommands: ['pytest', 'ruff check .'],
      staleMinutes: 30,
      verifyTimeoutMs: 1_500_000,
      verifyTimeoutMaxMs: 3_600_000,
    });
    expect(JSON.parse(written()!).verifyCommands).toEqual(['pytest', 'ruff check .']);
  });

  it('lets an explicit setting win over the file value', () => {
    const { fs } = memFs(
      JSON.stringify({ mode: 'auto-merge', verifyCommands: ['pytest'], staleMinutes: 5 })
    );
    const result = publishMergeConfig('/c.json', { mode: 'auto-pr', staleMinutes: 45 }, fs);
    // explicit wins…
    expect(result.mode).toBe('auto-pr');
    expect(result.staleMinutes).toBe(45);
    // …but untouched keys keep the file's (agent/CLI-adjusted) values
    expect(result.verifyCommands).toEqual(['pytest']);
  });

  it('does not clobber agent-set verify commands when only unrelated keys are explicit', () => {
    const { fs, written } = memFs(JSON.stringify({ verifyCommands: ['pytest'] }));
    publishMergeConfig('/c.json', { mode: 'manual-review' }, fs);
    expect(JSON.parse(written()!).verifyCommands).toEqual(['pytest']);
  });

  it('coerces invalid merged values through the same defaults as readMergeConfig', () => {
    const { fs } = memFs(JSON.stringify({ staleMinutes: -3, verifyTimeoutMs: 0 }));
    const result = publishMergeConfig('/c.json', {}, fs);
    expect(result.staleMinutes).toBe(30);
    expect(result.verifyTimeoutMs).toBe(DEFAULT_VERIFY_TIMEOUT_MS);
  });

  it('ignores a non-object file payload (array/scalar) as if corrupt', () => {
    const { fs } = memFs(JSON.stringify(['auto-pr']));
    const result = publishMergeConfig('/c.json', {}, fs);
    expect(result).toEqual(DEFAULT_MERGE_CONFIG);
  });

  it('writes the merged result atomically to the given path', () => {
    let atPath = '';
    const fs = {
      exists: () => false,
      read: () => '',
      writeAtomic: (p: string) => {
        atPath = p;
      },
    };
    publishMergeConfig('/repo/.git/taskwright/merge-config.json', {}, fs);
    expect(atPath).toBe('/repo/.git/taskwright/merge-config.json');
  });
});
