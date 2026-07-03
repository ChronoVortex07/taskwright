import { describe, it, expect } from 'vitest';
import { searchTasks, type SearchableTask } from '../../core/searchTasks';

const T = (over: Partial<SearchableTask> & { id: string; title: string }): SearchableTask => ({
  description: '',
  labels: [],
  category: '',
  ...over,
});

describe('searchTasks', () => {
  const tasks = [
    T({
      id: 'TASK-1',
      title: 'Login flow',
      description: 'auth via oauth',
      labels: ['auth'],
      category: 'Features',
    }),
    T({ id: 'TASK-2', title: 'Dashboard', description: 'charts and login widget', category: 'Features' }),
    T({ id: 'TASK-3', title: 'Docs', description: 'unrelated' }),
  ];

  it('ranks a title hit above a description hit', () => {
    const res = searchTasks(tasks, 'login');
    expect(res.map((t) => t.id)).toEqual(['TASK-1', 'TASK-2']); // TASK-1 title(3) > TASK-2 desc(1)
  });

  it('requires ALL tokens to match somewhere', () => {
    expect(searchTasks(tasks, 'login oauth').map((t) => t.id)).toEqual(['TASK-1']); // only TASK-1 has both
    expect(searchTasks(tasks, 'login docs')).toEqual([]); // no single task has both
  });

  it('sums field weights per token (title+desc beats title-only)', () => {
    const two = [
      T({ id: 'TASK-A', title: 'alpha', description: 'alpha' }), // 3 + 1 = 4
      T({ id: 'TASK-B', title: 'alpha', description: 'beta' }), // 3
    ];
    expect(searchTasks(two, 'alpha').map((t) => t.id)).toEqual(['TASK-A', 'TASK-B']);
  });

  it('tie-breaks stably by id ascending', () => {
    const two = [T({ id: 'TASK-2', title: 'same' }), T({ id: 'TASK-1', title: 'same' })];
    expect(searchTasks(two, 'same').map((t) => t.id)).toEqual(['TASK-1', 'TASK-2']);
  });

  it('respects the limit (default 20)', () => {
    const many = Array.from({ length: 30 }, (_v, i) => T({ id: `TASK-${i}`, title: 'match' }));
    expect(searchTasks(many, 'match')).toHaveLength(20);
    expect(searchTasks(many, 'match', { limit: 5 })).toHaveLength(5);
  });

  it('throws on an empty/blank query', () => {
    expect(() => searchTasks(tasks, '')).toThrow(/query/i);
    expect(() => searchTasks(tasks, '   ')).toThrow(/query/i);
  });
});
