import { describe, it, expect } from 'vitest';
import { injectConvention, TASKWRIGHT_CONVENTION } from '../../core/agentConvention';
import { TASKWRIGHT_MARKERS } from '../../core/markerBlock';

describe('injectConvention', () => {
  it('wraps the convention in Taskwright markers for a new file', () => {
    const out = injectConvention('');
    expect(out).toContain(TASKWRIGHT_MARKERS.begin);
    expect(out).toContain(TASKWRIGHT_MARKERS.end);
    expect(out).toContain('get_active_task');
    expect(out).toContain(TASKWRIGHT_CONVENTION);
  });

  it('preserves existing CLAUDE.md content and appends the block once', () => {
    const existing = '# House rules\n\nUse tabs.\n';
    const out = injectConvention(existing);
    expect(out.startsWith(existing)).toBe(true);
    expect((out.match(/TASKWRIGHT:BEGIN/g) ?? []).length).toBe(1);
  });

  it('is idempotent', () => {
    const once = injectConvention('# Doc\n');
    expect(injectConvention(once)).toBe(once);
  });
});
