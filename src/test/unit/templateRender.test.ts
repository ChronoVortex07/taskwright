import { describe, it, expect } from 'vitest';
import { substitutePlaceholders } from '../../core/templateRender';

describe('substitutePlaceholders', () => {
  it('replaces every occurrence of a known placeholder', () => {
    expect(substitutePlaceholders('{{a}} {{b}} {{a}}', { a: '1', b: '2' })).toBe('1 2 1');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(substitutePlaceholders('{{a}} {{x}}', { a: '1' })).toBe('1 {{x}}');
  });

  it('returns the template unchanged when it has no placeholders', () => {
    expect(substitutePlaceholders('plain text', { a: '1' })).toBe('plain text');
  });
});
