import { describe, it, expect, vi } from 'vitest';
import { createTaskWithTreeFields, normalizeType } from '../../core/createTaskCore';

// Minimal fakes: only the methods the core touches. `universe` feeds the four list
// getters applyLinkTo walks for its wouldCreateCycle guard — the default has NO
// back-edge, so the happy-path linkTo tests pass the guard; the cycle test overrides it.
function makeDeps(overrides?: {
  createTaskId?: string;
  getTask?: (id: string) => Promise<{ id: string; dependencies: string[] } | undefined>;
  universe?: Array<{ id: string; dependencies: string[] }>;
}) {
  const createTask = vi.fn().mockResolvedValue({ id: overrides?.createTaskId ?? 'TASK-9', filePath: '/b/tasks/task-9.md' });
  const createDraft = vi.fn().mockResolvedValue({ id: 'DRAFT-1', filePath: '/b/drafts/draft-1.md' });
  const updateTask = vi.fn().mockResolvedValue(undefined);
  const setCategory = vi.fn().mockResolvedValue('');
  const setCausedBy = vi.fn().mockResolvedValue('');
  const getTask =
    overrides?.getTask ??
    vi.fn(async (id: string) => ({ id, dependencies: [] as string[] }));
  const universe = overrides?.universe ?? [
    { id: 'TASK-1', dependencies: [] as string[] },
    { id: 'TASK-9', dependencies: [] as string[] },
  ];
  const getTasks = vi.fn().mockResolvedValue(universe);
  const getDrafts = vi.fn().mockResolvedValue([]);
  const getCompletedTasks = vi.fn().mockResolvedValue([]);
  const getArchivedTasks = vi.fn().mockResolvedValue([]);
  const deps = {
    parser: { getTask, getTasks, getDrafts, getCompletedTasks, getArchivedTasks } as never,
    writer: { createTask, createDraft, updateTask } as never,
    backlogPath: '/b',
    treeFieldService: { setCategory, setCausedBy } as never,
  };
  return { deps, createTask, createDraft, updateTask, setCategory, setCausedBy, getTask };
}

describe('createTaskWithTreeFields — writer sequence', () => {
  it('quick create (title only): createTask, no updateTask/category/causedBy', async () => {
    const m = makeDeps();
    const res = await createTaskWithTreeFields(m.deps, { title: '  Ship it  ' });
    expect(res).toEqual({ id: 'TASK-9' });
    expect(m.createTask).toHaveBeenCalledWith('/b', { title: 'Ship it', description: undefined, status: undefined, priority: undefined, labels: undefined, assignee: undefined, milestone: undefined }, m.deps.parser);
    expect(m.updateTask).not.toHaveBeenCalled();
    expect(m.setCategory).not.toHaveBeenCalled();
    expect(m.setCausedBy).not.toHaveBeenCalled();
  });

  it('full create: passes priority/milestone/description to createTask and sets category surgically', async () => {
    const m = makeDeps();
    await createTaskWithTreeFields(m.deps, {
      title: 'Add login', description: 'desc', status: 'To Do', priority: 'high', milestone: 'v1', category: 'Features',
    });
    expect(m.createTask).toHaveBeenCalledWith('/b', expect.objectContaining({ title: 'Add login', priority: 'high', milestone: 'v1', description: 'desc', status: 'To Do' }), m.deps.parser);
    expect(m.setCategory).toHaveBeenCalledWith('TASK-9', 'Features', m.deps.parser);
  });

  it('category "" / whitespace is not written (Misc = no category)', async () => {
    const m = makeDeps();
    await createTaskWithTreeFields(m.deps, { title: 'x', category: '   ' });
    expect(m.setCategory).not.toHaveBeenCalled();
  });

  it('bug create: updateTask({type:"bug"}) then setCausedBy', async () => {
    const m = makeDeps();
    await createTaskWithTreeFields(m.deps, { title: 'Crash', type: 'bug', causedBy: 'TASK-1' });
    expect(m.updateTask).toHaveBeenCalledWith('TASK-9', { type: 'bug' }, m.deps.parser);
    expect(m.setCausedBy).toHaveBeenCalledWith('TASK-9', 'TASK-1', m.deps.parser);
  });

  it('dependencies go through updateTask', async () => {
    const m = makeDeps();
    await createTaskWithTreeFields(m.deps, { title: 'x', dependencies: ['TASK-1', 'TASK-2'] });
    expect(m.updateTask).toHaveBeenCalledWith('TASK-9', { dependencies: ['TASK-1', 'TASK-2'] }, m.deps.parser);
  });

  it('draft create routes to createDraft with title/description', async () => {
    const m = makeDeps();
    const res = await createTaskWithTreeFields(m.deps, { title: 'Spike', description: 'd', draft: true });
    expect(res).toEqual({ id: 'DRAFT-1' });
    expect(m.createDraft).toHaveBeenCalledWith('/b', m.deps.parser, { title: 'Spike', description: 'd', status: undefined });
    expect(m.createTask).not.toHaveBeenCalled();
  });

  it('validates: empty title throws; caused_by without bug throws; invalid type throws', async () => {
    const m = makeDeps();
    await expect(createTaskWithTreeFields(m.deps, { title: '   ' })).rejects.toThrow('A task title is required.');
    await expect(createTaskWithTreeFields(m.deps, { title: 'x', causedBy: 'TASK-1' })).rejects.toThrow('caused_by can only be set on a bug');
    await expect(createTaskWithTreeFields(m.deps, { title: 'x', type: 'nope' })).rejects.toThrow('Invalid type');
  });
});

describe('createTaskWithTreeFields — linkTo post-create wiring', () => {
  it("direction 'unlocks': new task depends on the origin (new.dependencies += origin)", async () => {
    const m = makeDeps({ getTask: vi.fn(async (id: string) => ({ id, dependencies: [] as string[] })) });
    await createTaskWithTreeFields(m.deps, { title: 'B', linkTo: { taskId: 'TASK-1', direction: 'unlocks' } });
    expect(m.updateTask).toHaveBeenCalledWith('TASK-9', { dependencies: ['TASK-1'] }, m.deps.parser);
  });

  it("direction 'needs': origin depends on the new task (origin.dependencies += new)", async () => {
    const m = makeDeps({ getTask: vi.fn(async (id: string) => ({ id, dependencies: id === 'TASK-1' ? ['TASK-0'] : [] })) });
    await createTaskWithTreeFields(m.deps, { title: 'A', linkTo: { taskId: 'TASK-1', direction: 'needs' } });
    expect(m.updateTask).toHaveBeenCalledWith('TASK-1', { dependencies: ['TASK-0', 'TASK-9'] }, m.deps.parser);
  });

  it('linkTo that would cycle is refused', async () => {
    // Back-edge universe: the new TASK-9 already depends on TASK-1 (via the dependencies
    // arg), so 'needs' (TASK-1.dependencies += TASK-9) would close TASK-1 → TASK-9 → TASK-1.
    const m = makeDeps({
      universe: [
        { id: 'TASK-1', dependencies: [] },
        { id: 'TASK-9', dependencies: ['TASK-1'] },
      ],
    });
    await expect(
      createTaskWithTreeFields(m.deps, { title: 'A', dependencies: ['TASK-1'], linkTo: { taskId: 'TASK-1', direction: 'needs' } })
    ).rejects.toThrow('cycle');
  });
});

describe('createTaskWithTreeFields — draft field completeness (GAP-2)', () => {
  it('draft create folds priority/milestone/labels/assignee into the same updateTask', async () => {
    const m = makeDeps();
    await createTaskWithTreeFields(m.deps, {
      title: 'Spike caching', draft: true,
      priority: 'high', milestone: 'v1', labels: ['spike'], assignee: ['@alice'],
    });
    expect(m.createDraft).toHaveBeenCalledWith('/b', m.deps.parser, { title: 'Spike caching', description: undefined, status: undefined });
    expect(m.createTask).not.toHaveBeenCalled();
    // ONE updateTask carrying the draft-only canonical fields:
    expect(m.updateTask).toHaveBeenCalledWith(
      'DRAFT-1',
      expect.objectContaining({ priority: 'high', milestone: 'v1', labels: ['spike'], assignee: ['@alice'] }),
      m.deps.parser
    );
  });

  it('draft create still applies type/dependencies through the SAME updateTask (one write)', async () => {
    const m = makeDeps();
    await createTaskWithTreeFields(m.deps, {
      title: 'Bug spike', draft: true, type: 'bug', causedBy: 'TASK-1',
      dependencies: ['TASK-2'], priority: 'medium',
    });
    // exactly one updateTask, carrying type + dependencies + priority together:
    expect(m.updateTask).toHaveBeenCalledTimes(1);
    expect(m.updateTask).toHaveBeenCalledWith(
      'DRAFT-1',
      expect.objectContaining({ type: 'bug', dependencies: ['TASK-2'], priority: 'medium' }),
      m.deps.parser
    );
    expect(m.setCausedBy).toHaveBeenCalledWith('DRAFT-1', 'TASK-1', m.deps.parser);
  });

  it('draft create accepts a valid status and passes it to createDraft (P6/D2a)', async () => {
    const m = makeDeps();
    await createTaskWithTreeFields(m.deps, { title: 'Baseline', draft: true, status: 'Done' });
    expect(m.createDraft).toHaveBeenCalledWith('/b', m.deps.parser, {
      title: 'Baseline', description: undefined, status: 'Done',
    });
    expect(m.createTask).not.toHaveBeenCalled();
  });

  it('draft create with no status passes status: undefined (writer applies the default)', async () => {
    const m = makeDeps();
    await createTaskWithTreeFields(m.deps, { title: 'Gap', draft: true });
    expect(m.createDraft).toHaveBeenCalledWith('/b', m.deps.parser, {
      title: 'Gap', description: undefined, status: undefined,
    });
  });

  it('non-draft create is unchanged: fields go to createTask, not a second updateTask', async () => {
    const m = makeDeps();
    await createTaskWithTreeFields(m.deps, { title: 'y', priority: 'high', milestone: 'v1', labels: ['f'] });
    expect(m.createTask).toHaveBeenCalledWith('/b', expect.objectContaining({ priority: 'high', milestone: 'v1', labels: ['f'] }), m.deps.parser);
    expect(m.updateTask).not.toHaveBeenCalled(); // no type/deps → no canonical updateTask
  });
});

describe('normalizeType', () => {
  it('accepts bug, blanks to undefined, rejects others', () => {
    expect(normalizeType('bug')).toBe('bug');
    expect(normalizeType('  ')).toBeUndefined();
    expect(normalizeType(undefined)).toBeUndefined();
    expect(() => normalizeType('feature')).toThrow('Invalid type');
  });
});
