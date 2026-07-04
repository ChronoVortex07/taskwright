import { describe, it, expect } from 'vitest';
import {
  formatBoardSyncStatusBar,
  buildBoardSyncQuickPickItems,
  formatConflictMessage,
  type BoardSyncStatusBarState,
} from '../../core/boardSyncUx';
import type { MergeConflict } from '../../core/boardMerge';

function conflict(id: string): MergeConflict {
  return { path: `backlog/tasks/${id} - X.md`, id, reason: 'edited-both', resolution: 'theirs' };
}

describe('formatBoardSyncStatusBar', () => {
  it('shows an off state when sync mode is off', () => {
    const state: BoardSyncStatusBarState = { mode: 'off' };
    const { text, tooltip } = formatBoardSyncStatusBar(state);
    expect(text).toContain('Off');
    expect(tooltip.toLowerCase()).toContain('enable');
  });

  it('shows a neutral state when sync is on but nothing has synced yet', () => {
    const state: BoardSyncStatusBarState = { mode: 'git' };
    const { text, tooltip } = formatBoardSyncStatusBar(state);
    expect(text).toContain('Board Sync');
    expect(tooltip.toLowerCase()).toContain('push or pull');
  });

  it('reflects a clean successful push with the UTC time and no conflict badge', () => {
    const state: BoardSyncStatusBarState = {
      mode: 'git',
      lastSync: { type: 'push', atIso: '2026-07-04T14:32:00.000Z', ok: true, conflictIds: [] },
    };
    const { text, tooltip } = formatBoardSyncStatusBar(state);
    expect(text).not.toContain('conflict');
    expect(tooltip).toContain('14:32');
    expect(tooltip.toLowerCase()).toContain('pushed');
    expect(tooltip.toLowerCase()).toContain('no conflicts');
  });

  it('surfaces the conflict count and ids after a pull with conflicts', () => {
    const state: BoardSyncStatusBarState = {
      mode: 'git',
      lastSync: {
        type: 'pull',
        atIso: '2026-07-04T09:05:00.000Z',
        ok: true,
        conflictIds: ['TASK-3', 'DRAFT-7'],
      },
    };
    const { text, tooltip } = formatBoardSyncStatusBar(state);
    expect(text).toContain('2');
    expect(tooltip).toContain('TASK-3');
    expect(tooltip).toContain('DRAFT-7');
    expect(tooltip.toLowerCase()).toContain('pulled');
  });

  it('reflects a failed sync distinctly from a conflicted one', () => {
    const state: BoardSyncStatusBarState = {
      mode: 'git',
      lastSync: {
        type: 'push',
        atIso: '2026-07-04T09:05:00.000Z',
        ok: false,
        conflictIds: [],
        failureReason: 'remote moved',
      },
    };
    const { text, tooltip } = formatBoardSyncStatusBar(state);
    expect(text.toLowerCase()).not.toContain('conflict');
    expect(tooltip).toContain('remote moved');
    expect(tooltip.toLowerCase()).toContain('failed');
  });
});

describe('buildBoardSyncQuickPickItems', () => {
  it('offers only "enable" when sync is off', () => {
    const items = buildBoardSyncQuickPickItems({ mode: 'off' });
    expect(items).toHaveLength(1);
    expect(items[0].action).toBe('enableSync');
  });

  it('offers push and pull when sync is on', () => {
    const items = buildBoardSyncQuickPickItems({ mode: 'git' });
    expect(items.map((i) => i.action)).toEqual(['push', 'pull']);
  });
});

describe('formatConflictMessage', () => {
  it('lists every conflicted id for a push', () => {
    const msg = formatConflictMessage('pushed', [conflict('TASK-1'), conflict('DRAFT-4')]);
    expect(msg).toContain('pushed');
    expect(msg).toContain('2 conflict');
    expect(msg).toContain('TASK-1');
    expect(msg).toContain('DRAFT-4');
  });

  it('lists a single conflicted id for a pull', () => {
    const msg = formatConflictMessage('pulled', [conflict('TASK-9')]);
    expect(msg).toContain('pulled');
    expect(msg).toContain('TASK-9');
  });
});
