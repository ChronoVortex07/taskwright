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

  it('defaults to off with the canonical ref/remote/poll', () => {
    expect(DEFAULT_SYNC_CONFIG).toEqual({
      mode: 'off',
      ref: 'taskwright-board',
      remote: 'origin',
      pollSeconds: 20,
    });
  });

  it('coerces partial/invalid settings to defaults', () => {
    expect(resolveSyncConfigFromSettings({ mode: 'github', ref: 'my-board' })).toEqual({
      mode: 'github',
      ref: 'my-board',
      remote: 'origin',
      pollSeconds: 20,
    });
    expect(resolveSyncConfigFromSettings({ mode: 'bogus', pollSeconds: -3 })).toEqual(
      DEFAULT_SYNC_CONFIG
    );
  });

  it('round-trips through read/write; missing file → defaults', () => {
    const fsd = memFs();
    expect(readSyncConfig('/x/sync-config.json', fsd)).toEqual(DEFAULT_SYNC_CONFIG);
    const cfg: SyncConfig = { mode: 'local', ref: 'b', remote: 'upstream', pollSeconds: 30 };
    writeSyncConfig('/x/sync-config.json', cfg, fsd);
    expect(readSyncConfig('/x/sync-config.json', fsd)).toEqual(cfg);
  });
});
