import * as path from 'path';

/**
 * Board Sync v2 (spec §2.3) — pure union-merge core. Given the board's file
 * tree at a common ancestor and its state on two diverged sides, produces a
 * merged tree at file granularity plus a surfaced conflict list. No git, no
 * disk I/O, no `Date.now()` — deterministic given its three inputs, so
 * {@link mergeBoards} is unit-tested directly without a real repo.
 *
 * `push_board`/`pull_board` (Task F) supply `base`/`ours`/`theirs` from
 * `boardRef.ts` snapshot/materialize file maps (board-relative path → file
 * content); this module has no dependency on that shape beyond "a plain
 * string-keyed map".
 */

/** Board-relative file path (e.g. `backlog/tasks/TASK-1 - Foo.md`) → file content. */
export type BoardFileMap = Record<string, string>;

export type MergeConflictReason = 'edited-both' | 'delete-vs-edit' | 'tie' | 'unparseable';

export interface MergeConflict {
  /** Board-relative path of the conflicting file. */
  path: string;
  /** Best-effort task/draft/milestone id parsed from the filename, else the path. */
  id: string;
  reason: MergeConflictReason;
  /** Which side's content was kept in `merged`. */
  resolution: 'ours' | 'theirs';
}

export interface MergeBoardsResult {
  merged: BoardFileMap;
  conflicts: MergeConflict[];
}

/** Same id convention as `BacklogParser`'s filename-based id extraction (see AGENTS.md's File Naming Conventions table). */
function idFromPath(relPath: string): string {
  const filename = path.posix.basename(relPath, '.md');
  const match = filename.match(/^([a-zA-Z]+-\d+(?:\.\d+)*)/i);
  return match ? match[1].toUpperCase() : filename;
}

/**
 * Extract a single top-level frontmatter field's raw scalar value by regex —
 * deliberately not a full YAML parse: unrelated fields (e.g. an unquoted
 * `@`-prefixed `assignee`) can make `yaml.load` throw on an otherwise-valid
 * document, and this core only ever needs `updated_date`.
 */
function extractFrontmatterField(content: string, field: string): string | undefined {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return undefined;
  const lineMatch = fmMatch[1].match(new RegExp(`^${field}:\\s*(.*)$`, 'm'));
  if (!lineMatch) return undefined;
  let value = lineMatch[1].trim();
  if (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"')))
  ) {
    value = value.slice(1, -1);
  }
  return value.length > 0 ? value : undefined;
}

/** `updated_date` as epoch millis, or null when absent/unparseable. */
function parseUpdatedDate(content: string): number | null {
  const raw = extractFrontmatterField(content, 'updated_date');
  if (!raw) return null;
  const t = Date.parse(raw.replace(' ', 'T'));
  return Number.isNaN(t) ? null : t;
}

interface Resolution {
  value: string;
  side: 'ours' | 'theirs';
  reason: 'edited-both' | 'tie' | 'unparseable';
}

/** Newer `updated_date` wins; tie or either side unparseable → keep "theirs". */
function resolveByUpdatedDate(ours: string, theirs: string): Resolution {
  const oursDate = parseUpdatedDate(ours);
  const theirsDate = parseUpdatedDate(theirs);
  if (oursDate === null || theirsDate === null) {
    return { value: theirs, side: 'theirs', reason: 'unparseable' };
  }
  if (oursDate === theirsDate) {
    return { value: theirs, side: 'theirs', reason: 'tie' };
  }
  return oursDate > theirsDate
    ? { value: ours, side: 'ours', reason: 'edited-both' }
    : { value: theirs, side: 'theirs', reason: 'edited-both' };
}

/**
 * Three-way union-merge of the board's file tree (spec §2.3). `base` is the
 * common-ancestor snapshot (omit for a first sync with no prior common
 * state — every present file is then treated as an independent add).
 *
 * Rules: file present on only one side → keep it (disjoint add/add unions
 * cleanly); edited on exactly one side → keep that edit; edited on **both**
 * sides → newer `updated_date` wins, conflict recorded; tie or an
 * unparseable date → keep "theirs", conflict recorded; deleted on one side
 * but edited on the other → keep the edit, conflict recorded (a deletion
 * never silently wins over a live edit). Deleted on both sides → dropped,
 * no conflict.
 */
export function mergeBoards(
  base: BoardFileMap | undefined,
  ours: BoardFileMap,
  theirs: BoardFileMap
): MergeBoardsResult {
  const paths = new Set<string>([
    ...Object.keys(base ?? {}),
    ...Object.keys(ours),
    ...Object.keys(theirs),
  ]);

  const merged: BoardFileMap = {};
  const conflicts: MergeConflict[] = [];

  for (const p of paths) {
    const inBase = base !== undefined && Object.prototype.hasOwnProperty.call(base, p);
    const inOurs = Object.prototype.hasOwnProperty.call(ours, p);
    const inTheirs = Object.prototype.hasOwnProperty.call(theirs, p);

    const baseContent = inBase ? base![p] : undefined;
    const oursContent = inOurs ? ours[p] : undefined;
    const theirsContent = inTheirs ? theirs[p] : undefined;

    // Deleted on both sides (or never present on either) — nothing to do.
    if (!inOurs && !inTheirs) continue;

    // Identical live content on both sides — no conflict regardless of base.
    if (inOurs && inTheirs && oursContent === theirsContent) {
      merged[p] = oursContent as string;
      continue;
    }

    // Present on ours only.
    if (inOurs && !inTheirs) {
      if (!inBase) {
        merged[p] = oursContent as string; // pure add on ours
      } else if (oursContent === baseContent) {
        // ours unchanged, theirs deleted — clean delete, no conflict.
      } else {
        // ours edited, theirs deleted — delete-vs-edit, keep the edit.
        merged[p] = oursContent as string;
        conflicts.push({
          path: p,
          id: idFromPath(p),
          reason: 'delete-vs-edit',
          resolution: 'ours',
        });
      }
      continue;
    }

    // Present on theirs only.
    if (!inOurs && inTheirs) {
      if (!inBase) {
        merged[p] = theirsContent as string; // pure add on theirs
      } else if (theirsContent === baseContent) {
        // theirs unchanged, ours deleted — clean delete, no conflict.
      } else {
        merged[p] = theirsContent as string;
        conflicts.push({
          path: p,
          id: idFromPath(p),
          reason: 'delete-vs-edit',
          resolution: 'theirs',
        });
      }
      continue;
    }

    // Present on both sides with different content.
    if (inBase && oursContent === baseContent) {
      merged[p] = theirsContent as string; // ours unchanged — take theirs' edit
      continue;
    }
    if (inBase && theirsContent === baseContent) {
      merged[p] = oursContent as string; // theirs unchanged — take ours' edit
      continue;
    }

    // Edited (or independently added) on both sides — resolve by newer `updated_date`.
    const resolution = resolveByUpdatedDate(oursContent as string, theirsContent as string);
    merged[p] = resolution.value;
    conflicts.push({
      path: p,
      id: idFromPath(p),
      reason: resolution.reason,
      resolution: resolution.side,
    });
  }

  return { merged, conflicts };
}
