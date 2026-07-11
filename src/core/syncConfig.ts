import * as path from 'path';
import type { QueueFsDeps } from './mergeQueue';

/**
 * Synced-board settings, persisted to `<commonDir>/taskwright/sync-config.json`
 * (next to merge-queue.json / merge-config.json) so both the extension and the
 * out-of-process MCP server read the same source of truth. Mirrors mergeConfig.
 */

export type SyncMode = 'off' | 'git' | 'git-auto';

export interface SyncConfig {
  mode: SyncMode;
  ref: string;
  remote: string;
  installHooks: boolean;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  mode: 'off',
  ref: 'taskwright-board',
  remote: 'origin',
  installHooks: false,
};

export function syncConfigPath(commonDir: string): string {
  return path.join(commonDir, 'taskwright', 'sync-config.json');
}

/** v1 modes read from an old settings.json / sync-config.json, remapped to `off | git | git-auto`. */
function coerceMode(v: unknown): SyncMode {
  if (v === 'off' || v === 'git' || v === 'git-auto') return v;
  if (v === 'local') return 'off';
  if (v === 'github') return 'git';
  return DEFAULT_SYNC_CONFIG.mode;
}

function coerceString(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : fallback;
}

function coerceBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export function resolveSyncConfigFromSettings(raw: {
  mode?: unknown;
  ref?: unknown;
  remote?: unknown;
  installHooks?: unknown;
}): SyncConfig {
  return {
    mode: coerceMode(raw.mode),
    ref: coerceString(raw.ref, DEFAULT_SYNC_CONFIG.ref),
    remote: coerceString(raw.remote, DEFAULT_SYNC_CONFIG.remote),
    installHooks: coerceBool(raw.installHooks, DEFAULT_SYNC_CONFIG.installHooks),
  };
}

export function readSyncConfig(
  filePath: string,
  fsDeps: Pick<QueueFsDeps, 'exists' | 'read'>
): SyncConfig {
  if (!fsDeps.exists(filePath)) return resolveSyncConfigFromSettings({});
  try {
    return resolveSyncConfigFromSettings(JSON.parse(fsDeps.read(filePath)));
  } catch {
    return resolveSyncConfigFromSettings({});
  }
}

export function writeSyncConfig(
  filePath: string,
  config: SyncConfig,
  fsDeps: Pick<QueueFsDeps, 'writeAtomic'>
): void {
  fsDeps.writeAtomic(filePath, `${JSON.stringify(config, null, 2)}\n`);
}
