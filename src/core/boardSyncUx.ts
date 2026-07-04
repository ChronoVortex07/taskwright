import type { SyncMode } from './syncConfig';
import type { MergeConflict } from './boardMerge';

/**
 * Board Sync v2 (spec §2.2, Task G) — pure formatting for the push/pull
 * status-bar item, its quick-pick, and conflict notifications. Deliberately
 * dependency-free (no `vscode` import) so it's unit-testable without mocking
 * the status-bar API; `extension.ts` is the thin glue that applies these
 * strings to the real UI.
 */

export interface LastBoardSync {
  type: 'push' | 'pull';
  /** ISO timestamp of the sync attempt. */
  atIso: string;
  ok: boolean;
  conflictIds: string[];
  /** Present when `ok` is false — the underlying failure reason. */
  failureReason?: string;
}

export interface BoardSyncStatusBarState {
  mode: SyncMode;
  lastSync?: LastBoardSync;
}

export interface StatusBarPresentation {
  text: string;
  tooltip: string;
}

/** `HH:mm` in UTC — deterministic regardless of the host machine's timezone. */
function formatTimeUtc(atIso: string): string {
  return atIso.slice(11, 16);
}

export function formatBoardSyncStatusBar(state: BoardSyncStatusBarState): StatusBarPresentation {
  if (state.mode === 'off') {
    return {
      text: '$(circle-slash) Board Sync: Off',
      tooltip: 'Board sync is off. Click to enable it ("Taskwright: Enable Board Sync").',
    };
  }

  const { lastSync } = state;
  if (!lastSync) {
    return {
      text: '$(sync) Board Sync',
      tooltip: 'Board sync is on. Click to push or pull the board.',
    };
  }

  const verb = lastSync.type === 'push' ? 'pushed' : 'pulled';
  const time = formatTimeUtc(lastSync.atIso);

  if (!lastSync.ok) {
    return {
      text: '$(error) Board Sync',
      tooltip: `Last ${verb} at ${time} UTC failed: ${lastSync.failureReason ?? 'unknown error'}. Click to retry.`,
    };
  }

  if (lastSync.conflictIds.length > 0) {
    return {
      text: `$(warning) Board Sync (${lastSync.conflictIds.length})`,
      tooltip: `Last ${verb} at ${time} UTC with ${lastSync.conflictIds.length} conflict(s) resolved by the newer edit: ${lastSync.conflictIds.join(', ')}. Click to push or pull.`,
    };
  }

  return {
    text: '$(check) Board Sync',
    tooltip: `Last ${verb} at ${time} UTC. No conflicts. Click to push or pull.`,
  };
}

export type BoardSyncQuickPickAction = 'push' | 'pull' | 'enableSync';

export interface BoardSyncQuickPickItem {
  label: string;
  description: string;
  action: BoardSyncQuickPickAction;
}

/** Sync-off only offers enabling it; sync-on offers the two backbone actions. */
export function buildBoardSyncQuickPickItems(
  state: BoardSyncStatusBarState
): BoardSyncQuickPickItem[] {
  if (state.mode === 'off') {
    return [
      {
        label: '$(sync) Enable Board Sync',
        description: 'Move the board off code branches and turn on push/pull',
        action: 'enableSync',
      },
    ];
  }
  return [
    { label: '$(arrow-up) Push Board', description: 'Share local board changes', action: 'push' },
    {
      label: '$(arrow-down) Pull Board',
      description: 'Fetch shared board changes',
      action: 'pull',
    },
  ];
}

/** Shared by the push and pull commands — one wording for "never silent" conflict surfacing. */
export function formatConflictMessage(
  verb: 'pushed' | 'pulled',
  conflicts: MergeConflict[]
): string {
  return `Board ${verb} with ${conflicts.length} conflict(s) resolved by the newer edit: ${conflicts
    .map((c) => c.id)
    .join(', ')}`;
}
