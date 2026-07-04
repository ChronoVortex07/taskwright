/**
 * Pure helpers for the one-time "move board off code branches" migration
 * (spec §6): the idempotent `.gitignore` fenced block for the board subdirs and
 * the list of paths to `git rm -r --cached` so they stop being tracked.
 */

const SUBDIRS = ['tasks', 'drafts', 'completed', 'archive', 'milestones'] as const;

export const BOARD_IGNORE_BEGIN = '# >>> taskwright synced board >>>';
export const BOARD_IGNORE_END = '# <<< taskwright synced board <<<';

export function boardIgnoreBlock(backlogDir = 'backlog'): string {
  const lines = [
    BOARD_IGNORE_BEGIN,
    '# Board tasks live on the taskwright-board ref, not on code branches.',
    ...SUBDIRS.map((d) => `${backlogDir}/${d}/`),
    BOARD_IGNORE_END,
  ];
  return lines.join('\n') + '\n';
}

/** Insert or replace the fenced board block idempotently. */
export function applyBoardIgnore(existing: string, backlogDir = 'backlog'): string {
  const block = boardIgnoreBlock(backlogDir);
  const begin = existing.indexOf(BOARD_IGNORE_BEGIN);
  if (begin === -1) {
    const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    return `${existing}${sep}${block}`;
  }
  const endMarker = existing.indexOf(BOARD_IGNORE_END, begin);
  const end = endMarker === -1 ? existing.length : endMarker + BOARD_IGNORE_END.length;
  const tail = existing.slice(end).replace(/^\n/, '');
  return `${existing.slice(0, begin)}${block}${tail}`;
}

export function boardTrackedPaths(backlogDir = 'backlog'): string[] {
  return SUBDIRS.map((d) => `${backlogDir}/${d}`);
}
