import { describe, it, expect } from 'vitest';
import { findMatches, cycleIndex } from '../../webview/lib/treeFind';
import type { TreeGeometry, NodeBox } from '../../webview/lib/treeGeometry';
import type { Task } from '../../webview/lib/types';

function task(id: string, title: string, description?: string): Task {
  return {
    id,
    title,
    status: 'To Do',
    labels: [],
    assignee: [],
    dependencies: [],
    description,
    filePath: `/backlog/tasks/${id}.md`,
  } as unknown as Task;
}

/** Build a geometry whose node boxes place each id at the given (x, y). */
function geom(boxes: Record<string, { x: number; y: number }>): TreeGeometry {
  const nodes = new Map<string, NodeBox>();
  for (const [id, p] of Object.entries(boxes)) {
    nodes.set(id, { x: p.x, y: p.y, width: 208, height: 92 });
  }
  return { nodes, lanes: [], bands: [], width: 1000, height: 1000 };
}

describe('findMatches', () => {
  const g = geom({ 'TASK-1': { x: 0, y: 0 }, 'TASK-2': { x: 0, y: 200 }, 'TASK-3': { x: 300, y: 0 } });

  it('matches on title, case-insensitively', () => {
    const tasks = [task('TASK-1', 'Add Login Form'), task('TASK-2', 'Fix parser')];
    expect(findMatches(tasks, 'login', g)).toEqual(['TASK-1']);
    expect(findMatches(tasks, 'LOGIN', g)).toEqual(['TASK-1']);
  });

  it('matches on description', () => {
    const tasks = [task('TASK-1', 'Alpha', 'uses a redis cache'), task('TASK-2', 'Beta')];
    expect(findMatches(tasks, 'redis', g)).toEqual(['TASK-1']);
  });

  it('matches on id', () => {
    const tasks = [task('TASK-1', 'Alpha'), task('TASK-2', 'Beta')];
    expect(findMatches(tasks, 'task-2', g)).toEqual(['TASK-2']);
  });

  it('returns no matches for an empty or whitespace query', () => {
    const tasks = [task('TASK-1', 'Alpha')];
    expect(findMatches(tasks, '', g)).toEqual([]);
    expect(findMatches(tasks, '   ', g)).toEqual([]);
  });

  it('orders results spatially — band (x) first, then lane (y) — not by input order', () => {
    // Input order is deliberately reversed relative to layout position.
    const tasks = [task('TASK-3', 'hit c'), task('TASK-2', 'hit b'), task('TASK-1', 'hit a')];
    // TASK-1 (0,0) then TASK-2 (0,200) then TASK-3 (300,0)
    expect(findMatches(tasks, 'hit', g)).toEqual(['TASK-1', 'TASK-2', 'TASK-3']);
  });

  it('excludes tasks with no geometry box (not laid out)', () => {
    const tasks = [task('TASK-1', 'hit'), task('TASK-99', 'hit')];
    expect(findMatches(tasks, 'hit', g)).toEqual(['TASK-1']);
  });
});

describe('cycleIndex', () => {
  it('advances forward', () => {
    expect(cycleIndex(0, 3, 1)).toBe(1);
  });

  it('wraps forward past the last', () => {
    expect(cycleIndex(2, 3, 1)).toBe(0);
  });

  it('wraps backward past the first', () => {
    expect(cycleIndex(0, 3, -1)).toBe(2);
  });

  it('cycles a single match to itself', () => {
    expect(cycleIndex(0, 1, 1)).toBe(0);
    expect(cycleIndex(0, 1, -1)).toBe(0);
  });
});
