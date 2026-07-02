/**
 * Release Checklist — the milestone's manual Definition-of-Done home (P2 spec §9).
 *
 * A `## Release Checklist` section inside a milestone file (`backlog/milestones/
 * m-N - *.md`), delimited by `<!-- RC:BEGIN -->` / `<!-- RC:END -->` and made of
 * `- [ ] #N text` lines (the AC/DoD line format). This module is a pure, DOM-free,
 * LF-normalized string core (mirrors `claims.ts` / `markerBlock.ts`); the file-backed
 * caller applies the CRLF detect/restore wrapper.
 */
import type { ChecklistItem } from './types';

export const RC_BEGIN = '<!-- RC:BEGIN -->';
export const RC_END = '<!-- RC:END -->';
export const RC_HEADER = '## Release Checklist';

/** `- [ ] #1 text` / `- [x] text` — group1 check, group2 optional id, group3 text. */
const ITEM_RE = /^-\s*\[([ xX])\]\s*(?:#(\d+)\s+)?(.+)$/;

/** Locate the content range of the RC section: markers first, else header→next `## `. */
function sectionRange(content: string): { start: number; end: number } | null {
  const b = content.indexOf(RC_BEGIN);
  const e = content.indexOf(RC_END);
  if (b !== -1 && e !== -1 && e > b) {
    return { start: b + RC_BEGIN.length, end: e };
  }
  const headerRe = new RegExp(`^${RC_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const m = content.match(headerRe);
  if (m && m.index !== undefined) {
    const start = m.index + m[0].length;
    const after = content.slice(start);
    const next = after.match(/^## /m);
    return { start, end: start + (next?.index ?? after.length) };
  }
  return null;
}

/** Parse the RC items (empty array when there is no section). */
export function parseReleaseChecklist(content: string): ChecklistItem[] {
  const range = sectionRange(content);
  if (!range) return [];
  const items: ChecklistItem[] = [];
  for (const line of content.slice(range.start, range.end).split('\n')) {
    const match = line.trim().match(ITEM_RE);
    if (!match) continue;
    items.push({
      id: match[2] ? parseInt(match[2], 10) : items.length + 1,
      checked: match[1].toLowerCase() === 'x',
      text: match[3].trim(),
    });
  }
  return items;
}

/** Flip a single item by `#id`, scoped to the RC section; no-op when absent. */
export function toggleReleaseChecklistItem(content: string, itemId: number): string {
  const range = sectionRange(content);
  if (!range) return content;
  const regex = new RegExp(`^(- \\[)([ xX])(\\]\\s*#${itemId}\\s+.*)$`, 'gm');
  const before = content.slice(0, range.start);
  const section = content.slice(range.start, range.end);
  const after = content.slice(range.end);
  const replaced = section.replace(
    regex,
    (_m, p, check, s) => `${p}${check === ' ' ? 'x' : ' '}${s}`
  );
  return before + replaced + after;
}

/** Items → numbered checkbox lines (no trailing newline). */
export function serializeReleaseChecklist(items: ChecklistItem[]): string {
  return items
    .map((it, i) => `- [${it.checked ? 'x' : ' '}] #${it.id ?? i + 1} ${it.text}`)
    .join('\n');
}

/** Replace the RC section body (markers preserved), or append a new section. */
export function upsertReleaseChecklist(content: string, items: ChecklistItem[]): string {
  const body = serializeReleaseChecklist(items);
  const b = content.indexOf(RC_BEGIN);
  const e = content.indexOf(RC_END);
  if (b !== -1 && e !== -1 && e > b) {
    return `${content.slice(0, b + RC_BEGIN.length)}\n${body}\n${content.slice(e)}`;
  }
  const headerRe = new RegExp(`^${RC_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const m = content.match(headerRe);
  if (m && m.index !== undefined) {
    const start = m.index + m[0].length;
    const after = content.slice(start);
    const next = after.match(/^## /m);
    const cut = start + (next?.index ?? after.length);
    return `${content.slice(0, start)}\n${RC_BEGIN}\n${body}\n${RC_END}\n${content.slice(cut)}`;
  }
  const sep = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  return `${content}${sep}${RC_HEADER}\n\n${RC_BEGIN}\n${body}\n${RC_END}\n`;
}
