/**
 * Idempotent "marked block" merge for injecting Taskwright's agent convention
 * into a user's existing CLAUDE.md (or any markdown) without clobbering it.
 *
 * Only the region between the BEGIN/END markers is ever owned by Taskwright;
 * everything else in the file is preserved byte-for-byte. Mirrors how
 * Backlog.md injects its own marked guidelines block.
 */
export interface MarkerPair {
  begin: string;
  end: string;
}

export const TASKWRIGHT_MARKERS: MarkerPair = {
  begin: '<!-- TASKWRIGHT:BEGIN -->',
  end: '<!-- TASKWRIGHT:END -->',
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Insert or update Taskwright's block in `content`:
 *  - empty content        → the block alone
 *  - markers already present → replace only what is between them
 *  - markers absent        → append the block, separated by a blank line,
 *                            leaving existing content untouched
 *
 * Returns the original string unchanged when the block is already up to date,
 * so callers can detect a no-op by identity.
 */
export function upsertMarkerBlock(content: string, body: string, markers: MarkerPair): string {
  const block = `${markers.begin}\n${body}\n${markers.end}`;

  const blockRe = new RegExp(
    `${escapeRegExp(markers.begin)}[\\s\\S]*?${escapeRegExp(markers.end)}`
  );

  if (blockRe.test(content)) {
    const replaced = content.replace(blockRe, block);
    return replaced;
  }

  if (content.trim() === '') {
    return `${block}\n`;
  }

  const separator = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  return `${content}${separator}${block}\n`;
}
