import * as fs from 'fs';
import * as path from 'path';
import { detectCRLF, normalizeToLF, restoreLineEndings } from './BacklogWriter';
import { parseReleaseChecklist, toggleReleaseChecklistItem } from './releaseChecklist';
import { atomicWriteFileSync } from './atomicWrite';
import type { ChecklistItem } from './types';

/** Resolve the milestone file for a milestone id ("m-1") or display name. */
export function resolveMilestoneFile(backlogPath: string, milestone: string): string | undefined {
  const dir = path.join(backlogPath, 'milestones');
  if (!fs.existsSync(dir)) return undefined;
  const target = milestone.trim().toLowerCase();
  const slug = target.replace(/\s+/g, '-');
  for (const f of fs.readdirSync(dir)) {
    if (!/^m-\d+/i.test(f) || !f.toLowerCase().endsWith('.md')) continue;
    const id = f.match(/^(m-\d+)/i)?.[1]?.toLowerCase();
    const nameSlug = f
      .replace(/^m-\d+\s*-\s*/i, '')
      .replace(/\.md$/i, '')
      .toLowerCase();
    if (id === target || nameSlug === slug || f.toLowerCase().includes(target)) {
      return path.join(dir, f);
    }
  }
  return undefined;
}

/** Read the milestone's release-checklist items (empty when no file/section). */
export function readReleaseChecklist(backlogPath: string, milestone: string): ChecklistItem[] {
  const file = resolveMilestoneFile(backlogPath, milestone);
  if (!file) return [];
  try {
    return parseReleaseChecklist(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

/** Toggle one item by id (CRLF-preserving) and return the updated items. */
export function toggleReleaseChecklist(
  backlogPath: string,
  milestone: string,
  itemId: number
): ChecklistItem[] {
  const file = resolveMilestoneFile(backlogPath, milestone);
  if (!file) return [];
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const hasCRLF = detectCRLF(raw);
    const updated = toggleReleaseChecklistItem(normalizeToLF(raw), itemId);
    atomicWriteFileSync(file, restoreLineEndings(updated, hasCRLF));
    return parseReleaseChecklist(updated);
  } catch {
    return [];
  }
}
