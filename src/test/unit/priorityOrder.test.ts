import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PRIORITIES,
  resolvePriorities,
  priorityRank,
  comparePriority,
} from '../../core/priorityOrder';
import { BacklogParser } from '../../core/BacklogParser';

describe('priorityOrder', () => {
  describe('resolvePriorities', () => {
    it('returns the default high/medium/low when config has none', () => {
      expect(resolvePriorities({})).toEqual(['high', 'medium', 'low']);
      expect(resolvePriorities({ priorities: [] })).toEqual(['high', 'medium', 'low']);
      expect([...DEFAULT_PRIORITIES]).toEqual(['high', 'medium', 'low']);
    });

    it('uses the config list (order preserved) when present, trimming blanks', () => {
      expect(resolvePriorities({ priorities: [' Critical ', 'Normal', '', 'Low'] })).toEqual([
        'Critical',
        'Normal',
        'Low',
      ]);
    });
  });

  describe('priorityRank', () => {
    const order = ['high', 'medium', 'low'];
    it('is the case-insensitive index in the order', () => {
      expect(priorityRank('high', order)).toBe(0);
      expect(priorityRank('MEDIUM', order)).toBe(1);
      expect(priorityRank('low', order)).toBe(2);
    });
    it('sorts unknown/absent last', () => {
      expect(priorityRank('nope', order)).toBe(3);
      expect(priorityRank(undefined, order)).toBe(3);
    });
  });

  describe('comparePriority', () => {
    const order = ['Critical', 'Normal', 'Low'];
    it('orders by config rank, unknown/absent last', () => {
      const sorted = ['Low', undefined, 'Critical', 'Normal'].sort((a, b) =>
        comparePriority(a, b, order)
      );
      expect(sorted).toEqual(['Critical', 'Normal', 'Low', undefined]);
    });
  });
});

describe('BacklogParser.parsePriority (exact-match, verbatim passthrough)', () => {
  const parser = new BacklogParser('/fake/path');
  const parse = (priority: string): string | undefined =>
    parser.parseTaskContent(
      `---\nid: TASK-1\ntitle: T\nstatus: To Do\nassignee: []\ndependencies: []\npriority: ${priority}\n---\n\n## Description\n\nBody.\n`,
      '/fake/path/tasks/task-1 - T.md'
    )?.priority;

  it('normalizes case for the legacy high/medium/low tokens', () => {
    expect(parse('High')).toBe('high');
  });
  it('passes custom priorities through verbatim (never substring-collapsed)', () => {
    expect(parse('critical')).toBe('critical');
    expect(parse('Highest')).toBe('Highest'); // NOT collapsed to 'high'
    expect(parse('Follow-up')).toBe('Follow-up'); // NOT collapsed to 'low'
  });
  it('treats empty / whitespace-only as undefined', () => {
    expect(parse('')).toBeUndefined();
    expect(parse('   ')).toBeUndefined();
  });
});
