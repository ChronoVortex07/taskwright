import { describe, it, expect } from 'vitest';
import type { Task } from '../../core/types';
import { deriveTreeState, deriveTreeBoard, loadTreeBoardFromParser } from '../../core/treeDerived';

function task(partial: Partial<Task> & { id: string }): Task {
  return {
    title: partial.title ?? partial.id,
    status: partial.status ?? 'To Do',
    labels: [],
    assignee: [],
    dependencies: partial.dependencies ?? [],
    acceptanceCriteria: [],
    definitionOfDone: [],
    filePath: `/b/tasks/${partial.id}.md`,
    ...partial,
    id: partial.id,
  } as Task;
}

const opts = {
  doneStatus: 'Done',
  milestoneOrder: [] as string[],
  priorities: ['high', 'medium', 'low'],
  categories: [] as string[],
};

describe('deriveTreeState', () => {
  it('composes locked/blockedBy from the gate and layout from the layout module', () => {
    const tasks = [
      task({ id: 'TASK-1', status: 'Done' }),
      task({ id: 'TASK-2', dependencies: ['TASK-1'] }),
      task({ id: 'TASK-3', dependencies: ['TASK-2'] }),
    ];
    const states = deriveTreeState(tasks, opts);
    expect(states.get('TASK-2')!.locked).toBe(false); // dep TASK-1 is Done
    expect(states.get('TASK-3')!.locked).toBe(true); // dep TASK-2 not done
    expect(states.get('TASK-3')!.blockedBy).toEqual(['TASK-2']);
    expect(states.get('TASK-1')!.layout.lane).toBeDefined();
  });

  it('backlinks bugs to the task that caused them; activeBugIds excludes done bugs', () => {
    const tasks = [
      task({ id: 'TASK-1' }),
      task({ id: 'TASK-2', type: 'bug', causedBy: 'TASK-1', status: 'To Do' }),
      task({ id: 'TASK-3', type: 'bug', causedBy: 'TASK-1', status: 'Done' }),
      task({ id: 'TASK-4', type: 'bug', causedBy: 'TASK-1', folder: 'completed' }),
    ];
    const s = deriveTreeState(tasks, opts).get('TASK-1')!;
    expect(s.bugs.sort()).toEqual(['TASK-2', 'TASK-3', 'TASK-4']);
    expect(s.activeBugIds).toEqual(['TASK-2']); // TASK-3 (done) and TASK-4 (completed) excluded
  });

  it('a task with no bugs has empty bug arrays', () => {
    const s = deriveTreeState([task({ id: 'TASK-1' })], opts).get('TASK-1')!;
    expect(s.bugs).toEqual([]);
    expect(s.activeBugIds).toEqual([]);
  });
});

describe('deriveTreeBoard', () => {
  it('returns states plus laneOrder/bandOrder/warnings', () => {
    const tasks = [
      task({ id: 'TASK-1', category: 'Features', milestone: 'v1', status: 'Done' }),
      task({ id: 'TASK-2', category: 'Features', milestone: 'v1', dependencies: ['TASK-1'] }),
      task({ id: 'TASK-3', type: 'bug', causedBy: 'TASK-1' }),
    ];
    const board = deriveTreeBoard(tasks, {
      doneStatus: 'Done',
      milestoneOrder: ['v1'],
      priorities: ['high', 'medium', 'low'],
      categories: ['Features'],
    });
    // Misc + Bugs are always the last two lanes; declared "Features" leads.
    expect(board.laneOrder).toEqual(['Features', 'Misc', 'Bugs']);
    // Backburner is always the rightmost band.
    expect(board.bandOrder[board.bandOrder.length - 1]).toBe('Backburner');
    expect(board.bandOrder).toContain('v1');
    // states carry the same layout the legacy map exposes.
    expect(board.states.get('TASK-2')!.layout.depth).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(board.warnings)).toBe(true);
  });

  it('deriveTreeState still returns just the states map (delegation intact)', () => {
    const s = deriveTreeState([task({ id: 'TASK-1' })], opts);
    expect(s.get('TASK-1')!.layout.lane).toBeDefined();
  });
});

describe('loadTreeBoardFromParser — draft union (GAP-1a)', () => {
  function stubParser(over: { tasks?: Task[]; drafts?: Task[] }) {
    return {
      getTasks: async () => over.tasks ?? [],
      getDrafts: async () => over.drafts ?? [],
      getCompletedTasks: async () => [],
      getArchivedTasks: async () => [],
      getConfig: async () => ({ statuses: ['To Do', 'In Progress', 'Done'] }),
      getMilestones: async () => [],
      getCategories: async () => [],
    } as unknown as import('../../core/BacklogParser').BacklogParser;
  }

  it('includes drafts in the derivation universe (draft node gets a state/layout)', async () => {
    const parser = stubParser({
      tasks: [task({ id: 'TASK-1', dependencies: ['DRAFT-1'] })],
      drafts: [task({ id: 'DRAFT-1', status: 'Draft', folder: 'drafts' })],
    });
    const board = await loadTreeBoardFromParser(parser);
    expect(board.states.has('DRAFT-1')).toBe(true);
    expect(board.states.get('DRAFT-1')!.layout.lane).toBeDefined();
  });

  // Stable-regression companion, NOT the red gate: a dep on a missing id is ALREADY
  // blocking pre-change (treeGate.ts:21,:37), so this passes before AND after the union.
  // It pins the post-union semantics (draft-as-dep stays blocking). The red gate is the
  // test above (DRAFT-1 present in states).
  it('a task depending on an unpromoted draft is locked (draft is unsatisfied)', async () => {
    const parser = stubParser({
      tasks: [task({ id: 'TASK-1', dependencies: ['DRAFT-1'] })],
      drafts: [task({ id: 'DRAFT-1', status: 'Draft', folder: 'drafts' })],
    });
    const board = await loadTreeBoardFromParser(parser);
    expect(board.states.get('TASK-1')!.locked).toBe(true);
    expect(board.states.get('TASK-1')!.blockedBy).toEqual(['DRAFT-1']);
  });
});
