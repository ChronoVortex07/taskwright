import * as path from 'path';
import type { MergeMode, QueueFsDeps } from './mergeQueue';

export const MERGE_MODES: MergeMode[] = ['manual-review', 'auto-merge', 'auto-pr'];

export function isMergeMode(value: unknown): value is MergeMode {
  return typeof value === 'string' && (MERGE_MODES as string[]).includes(value);
}

const STATUS_BY_MODE: Record<MergeMode, string> = {
  'manual-review': 'Pending Review',
  'auto-merge': 'Awaiting Merge',
  'auto-pr': 'Awaiting PR',
};

/** The intermediate board status a mode parks tasks in while they await integration. */
export function intermediateStatusForMode(mode: MergeMode): string {
  return STATUS_BY_MODE[mode];
}

/** All three mode-named intermediate statuses (order follows MERGE_MODES). */
export const INTERMEDIATE_STATUSES: string[] = MERGE_MODES.map(intermediateStatusForMode);

export const DEFAULT_VERIFY_COMMANDS = ['bun run test', 'bun run lint', 'bun run typecheck'];
export const DEFAULT_STALE_MINUTES = 30;

export interface MergeConfig {
  mode: MergeMode;
  verifyCommands: string[];
  staleMinutes: number;
}

export const DEFAULT_MERGE_CONFIG: MergeConfig = {
  mode: 'manual-review',
  verifyCommands: [...DEFAULT_VERIFY_COMMANDS],
  staleMinutes: DEFAULT_STALE_MINUTES,
};

/** `<commonDir>/taskwright/merge-config.json` — shared, written by the extension. */
export function mergeConfigPath(commonDir: string): string {
  return path.join(commonDir, 'taskwright', 'merge-config.json');
}

function coerceCommands(value: unknown): string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : [...DEFAULT_VERIFY_COMMANDS];
}

function coerceStale(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_STALE_MINUTES;
}

/** Coerce loosely-typed input (settings object or parsed JSON) into a MergeConfig. */
export function resolveMergeConfigFromSettings(raw: {
  mode?: unknown;
  verifyCommands?: unknown;
  staleMinutes?: unknown;
}): MergeConfig {
  return {
    mode: isMergeMode(raw.mode) ? raw.mode : DEFAULT_MERGE_CONFIG.mode,
    verifyCommands: coerceCommands(raw.verifyCommands),
    staleMinutes: coerceStale(raw.staleMinutes),
  };
}

/** Read the shared config, tolerating missing/corrupt files as defaults. Never throws. */
export function readMergeConfig(
  filePath: string,
  fsDeps: Pick<QueueFsDeps, 'exists' | 'read'>
): MergeConfig {
  if (!fsDeps.exists(filePath)) return resolveMergeConfigFromSettings({});
  try {
    return resolveMergeConfigFromSettings(JSON.parse(fsDeps.read(filePath)));
  } catch {
    return resolveMergeConfigFromSettings({});
  }
}

/** Persist the shared config atomically. */
export function writeMergeConfig(
  filePath: string,
  config: MergeConfig,
  fsDeps: Pick<QueueFsDeps, 'writeAtomic'>
): void {
  fsDeps.writeAtomic(filePath, `${JSON.stringify(config, null, 2)}\n`);
}
