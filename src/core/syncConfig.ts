import * as path from 'path';
import type { QueueFsDeps } from './mergeQueue';

/**
 * Synced-board settings, persisted to `<commonDir>/taskwright/sync-config.json`
 * (next to merge-queue.json / merge-config.json) so both the extension and the
 * out-of-process MCP server read the same source of truth. Mirrors mergeConfig.
 */

export type SyncMode = 'off' | 'local' | 'github';

export interface SyncConfig {
  mode: SyncMode;
  ref: string;
  remote: string;
  pollSeconds: number;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  mode: 'off',
  ref: 'taskwright-board',
  remote: 'origin',
  pollSeconds: 20,
};

export function syncConfigPath(commonDir: string): string {
  return path.join(commonDir, 'taskwright', 'sync-config.json');
}

function isSyncMode(v: unknown): v is SyncMode {
  return v === 'off' || v === 'local' || v === 'github';
}

function coerceString(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : fallback;
}

function coercePoll(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 5
    ? v
    : DEFAULT_SYNC_CONFIG.pollSeconds;
}

export function resolveSyncConfigFromSettings(raw: {
  mode?: unknown;
  ref?: unknown;
  remote?: unknown;
  pollSeconds?: unknown;
}): SyncConfig {
  return {
    mode: isSyncMode(raw.mode) ? raw.mode : DEFAULT_SYNC_CONFIG.mode,
    ref: coerceString(raw.ref, DEFAULT_SYNC_CONFIG.ref),
    remote: coerceString(raw.remote, DEFAULT_SYNC_CONFIG.remote),
    pollSeconds: coercePoll(raw.pollSeconds),
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
