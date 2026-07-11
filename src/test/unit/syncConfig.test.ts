import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  DEFAULT_SYNC_CONFIG,
  syncConfigPath,
  resolveSyncConfigFromSettings,
  readSyncConfig,
  writeSyncConfig,
  type SyncConfig,
} from '../../core/syncConfig';
import type { QueueFsDeps } from '../../core/mergeQueue';

function memFs(seed: Record<string, string> = {}): QueueFsDeps & { store: Record<string, string> } {
  const store = { ...seed };
  return {
    store,
    exists: (p) => p in store,
    read: (p) => store[p],
    writeAtomic: (p, data) => {
      store[p] = data;
    },
  };
}

describe('syncConfig', () => {
  it('path is under the common dir taskwright folder', () => {
    expect(syncConfigPath(path.join('repo', '.git'))).toBe(
      path.join('repo', '.git', 'taskwright', 'sync-config.json')
    );
  });

  it('defaults to off with the canonical ref/remote, hooks opt-out', () => {
    expect(DEFAULT_SYNC_CONFIG).toEqual({
      mode: 'off',
      ref: 'taskwright-board',
      remote: 'origin',
      installHooks: false,
    });
  });

  it('coerces partial/invalid settings to defaults', () => {
    expect(resolveSyncConfigFromSettings({ mode: 'git', ref: 'my-board' })).toEqual({
      mode: 'git',
      ref: 'my-board',
      remote: 'origin',
      installHooks: false,
    });
    expect(resolveSyncConfigFromSettings({ mode: 'bogus', installHooks: 'yes' })).toEqual(
      DEFAULT_SYNC_CONFIG
    );
  });

  it('migrates legacy v1 modes on read: local -> off, github -> git', () => {
    expect(resolveSyncConfigFromSettings({ mode: 'local' }).mode).toBe('off');
    expect(resolveSyncConfigFromSettings({ mode: 'github' }).mode).toBe('git');
    expect(resolveSyncConfigFromSettings({ mode: 'off' }).mode).toBe('off');
  });

  it('passes git-auto through coerceMode', () => {
    expect(resolveSyncConfigFromSettings({ mode: 'git-auto' }).mode).toBe('git-auto');
  });

  it('still coerces legacy values with git-auto present', () => {
    expect(resolveSyncConfigFromSettings({ mode: 'local' }).mode).toBe('off');
    expect(resolveSyncConfigFromSettings({ mode: 'github' }).mode).toBe('git');
    expect(resolveSyncConfigFromSettings({ mode: 'nonsense' }).mode).toBe('off');
  });

  it('coerces installHooks to a boolean, defaulting to false', () => {
    expect(resolveSyncConfigFromSettings({ installHooks: true }).installHooks).toBe(true);
    expect(resolveSyncConfigFromSettings({ installHooks: false }).installHooks).toBe(false);
    expect(resolveSyncConfigFromSettings({ installHooks: 'true' }).installHooks).toBe(false);
    expect(resolveSyncConfigFromSettings({}).installHooks).toBe(false);
  });

  it('round-trips through read/write; missing file -> defaults', () => {
    const fsd = memFs();
    expect(readSyncConfig('/x/sync-config.json', fsd)).toEqual(DEFAULT_SYNC_CONFIG);
    const cfg: SyncConfig = { mode: 'git', ref: 'b', remote: 'upstream', installHooks: true };
    writeSyncConfig('/x/sync-config.json', cfg, fsd);
    expect(readSyncConfig('/x/sync-config.json', fsd)).toEqual(cfg);
  });

  it('a persisted legacy config file (local/github) migrates on read', () => {
    const fsd = memFs({
      '/x/sync-config.json': JSON.stringify({
        mode: 'github',
        ref: 'taskwright-board',
        remote: 'origin',
        pollSeconds: 20,
      }),
    });
    expect(readSyncConfig('/x/sync-config.json', fsd)).toEqual({
      mode: 'git',
      ref: 'taskwright-board',
      remote: 'origin',
      installHooks: false,
    });
  });
});
