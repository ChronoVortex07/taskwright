import { describe, it, expect } from 'vitest';
import {
  renderChecklist,
  assertValidStatus,
  assertValidPriority,
} from '../../mcp/taskWriteHelpers';

describe('renderChecklist', () => {
  it('renders 1-based numbered checkbox items', () => {
    expect(renderChecklist([{ text: 'first' }, { text: 'second', checked: true }])).toBe(
      '- [ ] #1 first\n- [x] #2 second'
    );
  });

  it('returns an empty string for no items', () => {
    expect(renderChecklist([])).toBe('');
  });
});

describe('assertValidStatus', () => {
  it('accepts a configured status case-insensitively', () => {
    expect(() => assertValidStatus('in progress', ['To Do', 'In Progress'])).not.toThrow();
  });
  it('throws on an unknown status', () => {
    expect(() => assertValidStatus('Nope', ['To Do', 'Done'])).toThrow('Invalid status');
  });
});

describe('assertValidPriority', () => {
  it('accepts high/medium/low', () => {
    expect(() => assertValidPriority('medium')).not.toThrow();
  });
  it('throws otherwise', () => {
    expect(() => assertValidPriority('urgent')).toThrow('Invalid priority');
  });
});
