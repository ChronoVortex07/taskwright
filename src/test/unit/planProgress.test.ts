import { describe, it, expect } from 'vitest';
import { parsePlanProgress } from '../../core/planProgress';

describe('parsePlanProgress', () => {
  it('counts checked and unchecked checkbox steps', () => {
    const md = [
      '# Plan',
      '- [x] **Step 1: Write the failing test**',
      '- [ ] **Step 2: Implement**',
      '- [X] Step 3 done',
    ].join('\n');
    const p = parsePlanProgress(md);
    expect(p.total).toBe(3);
    expect(p.done).toBe(2);
    expect(p.percent).toBe(67);
  });

  it('returns zeroes when there are no checkbox steps', () => {
    const p = parsePlanProgress('# Plan\n\nJust prose, no steps.');
    expect(p).toEqual({ total: 0, done: 0, percent: 0, steps: [] });
  });

  it('ignores non-checkbox bullets and headings', () => {
    const md = ['## Tasks', '- a plain bullet', '- [ ] real step', 'paragraph'].join('\n');
    const p = parsePlanProgress(md);
    expect(p.total).toBe(1);
    expect(p.steps).toEqual([{ text: 'real step', checked: false }]);
  });

  it('accepts both - and * bullets and indented steps', () => {
    const md = ['* [x] star step', '  - [ ] indented step'].join('\n');
    const p = parsePlanProgress(md);
    expect(p.total).toBe(2);
    expect(p.done).toBe(1);
  });

  it('strips bold markers from step text', () => {
    const p = parsePlanProgress('- [ ] **Step 1: Do the thing**');
    expect(p.steps[0].text).toBe('Step 1: Do the thing');
  });
});
