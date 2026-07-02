import { describe, it, expect } from 'vitest';
import {
  parseReleaseChecklist,
  toggleReleaseChecklistItem,
  serializeReleaseChecklist,
  upsertReleaseChecklist,
  RC_BEGIN,
  RC_END,
} from '../../core/releaseChecklist';

const WITH_MARKERS = `# m-1 - Launch

## Description

Ship it.

## Release Checklist

<!-- RC:BEGIN -->
- [x] #1 Update changelog
- [ ] #2 Smoke test the build
- [ ] #3 Tag the release
<!-- RC:END -->
`;

describe('releaseChecklist — parse', () => {
  it('reads items between the RC markers', () => {
    const items = parseReleaseChecklist(WITH_MARKERS);
    expect(items).toEqual([
      { id: 1, text: 'Update changelog', checked: true },
      { id: 2, text: 'Smoke test the build', checked: false },
      { id: 3, text: 'Tag the release', checked: false },
    ]);
  });

  it('returns [] when there is no Release Checklist section', () => {
    expect(parseReleaseChecklist('# m-2 - Nothing\n\n## Description\n\nx\n')).toEqual([]);
  });

  it('parses a marker-less "## Release Checklist" section (fallback)', () => {
    const md = '## Release Checklist\n\n- [ ] #1 A\n- [x] #2 B\n';
    expect(parseReleaseChecklist(md)).toEqual([
      { id: 1, text: 'A', checked: false },
      { id: 2, text: 'B', checked: true },
    ]);
  });
});

describe('releaseChecklist — toggle', () => {
  it('flips only the targeted item and preserves the rest of the file', () => {
    const out = toggleReleaseChecklistItem(WITH_MARKERS, 2);
    const items = parseReleaseChecklist(out);
    expect(items[1]).toEqual({ id: 2, text: 'Smoke test the build', checked: true });
    expect(items[0].checked).toBe(true); // #1 untouched
    expect(items[2].checked).toBe(false); // #3 untouched
    expect(out).toContain('## Description'); // body preserved
  });

  it('is a no-op when the id is absent', () => {
    expect(toggleReleaseChecklistItem(WITH_MARKERS, 99)).toBe(WITH_MARKERS);
  });
});

describe('releaseChecklist — serialize + upsert', () => {
  it('serializes items to numbered checkbox lines', () => {
    expect(
      serializeReleaseChecklist([
        { id: 1, text: 'A', checked: false },
        { id: 2, text: 'B', checked: true },
      ])
    ).toBe('- [ ] #1 A\n- [x] #2 B');
  });

  it('inserts a Release Checklist section when none exists', () => {
    const base = '# m-3 - Fresh\n\n## Description\n\nx\n';
    const out = upsertReleaseChecklist(base, [{ id: 1, text: 'New item', checked: false }]);
    expect(out).toContain('## Release Checklist');
    expect(out).toContain(RC_BEGIN);
    expect(out).toContain(RC_END);
    expect(parseReleaseChecklist(out)).toEqual([{ id: 1, text: 'New item', checked: false }]);
  });

  it('replaces the section content when one already exists', () => {
    const out = upsertReleaseChecklist(WITH_MARKERS, [{ id: 1, text: 'Only one', checked: true }]);
    expect(parseReleaseChecklist(out)).toEqual([{ id: 1, text: 'Only one', checked: true }]);
    expect(out).toContain('## Description');
  });
});
