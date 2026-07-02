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

describe('assertValidPriority (config-driven)', () => {
  it('accepts a case-insensitive match against the allowed list', () => {
    expect(() => assertValidPriority('HIGH', ['high', 'medium', 'low'])).not.toThrow();
    expect(() => assertValidPriority('Critical', ['Critical', 'Normal'])).not.toThrow();
  });
  it('throws for a value outside the allowed list', () => {
    expect(() => assertValidPriority('urgent', ['high', 'medium', 'low'])).toThrow('Invalid priority');
  });
});
