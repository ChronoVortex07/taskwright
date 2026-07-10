import * as path from 'path';
import type { MergeMode, QueueFsDeps } from './mergeQueue';

/** The "In Progress" board status — the status a task returns to when a merge is
 *  aborted or the task is sent back from review. Shared by `request_merge`
 *  (finishTask.ts) and the board approval UI (mergeActions.ts). */
export const IN_PROGRESS = 'In Progress';

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
/** Default per-command verify timeout: 10 minutes (the historical hardcoded cap). */
export const DEFAULT_VERIFY_TIMEOUT_MS = 600_000;

export interface MergeConfig {
  mode: MergeMode;
  verifyCommands: string[];
  staleMinutes: number;
  /** Per-command timeout for the verify runner, in milliseconds. */
  verifyTimeoutMs: number;
  /** Optional repo-level ceiling for per-call `verifyTimeoutMinutes` overrides (ms). */
  verifyTimeoutMaxMs?: number;
}

export const DEFAULT_MERGE_CONFIG: MergeConfig = {
  mode: 'manual-review',
  verifyCommands: [...DEFAULT_VERIFY_COMMANDS],
  staleMinutes: DEFAULT_STALE_MINUTES,
  verifyTimeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
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

/** A strictly positive finite number, else undefined. */
function positiveMsOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Coerce loosely-typed input (settings object or parsed JSON) into a MergeConfig. */
export function resolveMergeConfigFromSettings(raw: {
  mode?: unknown;
  verifyCommands?: unknown;
  staleMinutes?: unknown;
  verifyTimeoutMs?: unknown;
  verifyTimeoutMaxMs?: unknown;
}): MergeConfig {
  const config: MergeConfig = {
    mode: isMergeMode(raw.mode) ? raw.mode : DEFAULT_MERGE_CONFIG.mode,
    verifyCommands: coerceCommands(raw.verifyCommands),
    staleMinutes: coerceStale(raw.staleMinutes),
    verifyTimeoutMs: positiveMsOrUndefined(raw.verifyTimeoutMs) ?? DEFAULT_VERIFY_TIMEOUT_MS,
  };
  const maxMs = positiveMsOrUndefined(raw.verifyTimeoutMaxMs);
  if (maxMs !== undefined) config.verifyTimeoutMaxMs = maxMs;
  return config;
}

/**
 * Resolve a `WorkspaceConfiguration.inspect()` result to the value the user
 * EXPLICITLY set (workspace-folder > workspace > global), or undefined when the
 * only value available is the package.json default. Used so `syncMergeConfig`
 * republishes only user-set keys instead of stamping defaults over the file.
 */
export function explicitSettingValue<T>(
  info:
    | { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T; defaultValue?: T }
    | undefined
): T | undefined {
  if (!info) return undefined;
  return info.workspaceFolderValue ?? info.workspaceValue ?? info.globalValue;
}

/** The raw (pre-coercion) shape of the explicitly-set merge settings. */
export interface ExplicitMergeSettings {
  mode?: unknown;
  verifyCommands?: unknown;
  staleMinutes?: unknown;
  verifyTimeoutMs?: unknown;
  verifyTimeoutMaxMs?: unknown;
}

/**
 * Publish the merge settings WITHOUT clobbering the shared file: read the
 * existing `merge-config.json` (missing/corrupt/non-object → `{}` so defaults
 * still materialize), overlay only the keys that are defined in `explicit`
 * (i.e. explicitly set by the user in VS Code), coerce the union through
 * `resolveMergeConfigFromSettings`, and write the result atomically.
 *
 * Semantics: explicit setting wins over file value; file value wins over the
 * package.json default; corrupt file falls back to defaults. The file remains
 * the durable store for agent/CLI-made adjustments (e.g. corrected
 * verifyCommands, verifyTimeoutMs) across extension restarts.
 */
export function publishMergeConfig(
  filePath: string,
  explicit: ExplicitMergeSettings,
  fsDeps: Pick<QueueFsDeps, 'exists' | 'read' | 'writeAtomic'>
): MergeConfig {
  let fileRaw: Record<string, unknown> = {};
  if (fsDeps.exists(filePath)) {
    try {
      const parsed: unknown = JSON.parse(fsDeps.read(filePath));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fileRaw = parsed as Record<string, unknown>;
      }
    } catch {
      // corrupt file — treat as absent so defaults materialize
    }
  }
  const overlay: Record<string, unknown> = { ...fileRaw };
  for (const [key, value] of Object.entries(explicit)) {
    if (value !== undefined) overlay[key] = value;
  }
  const merged = resolveMergeConfigFromSettings(overlay);
  writeMergeConfig(filePath, merged, fsDeps);
  return merged;
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
