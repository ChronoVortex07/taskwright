import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  diagnoseBoard,
  findDanglingContinuations,
  stripDanglingContinuations,
  gatherDoctorFacts,
  runBoardDoctor,
  type BoardDoctorInput,
  type DoctorTask,
} from '../../core/boardDoctor';
import { BacklogParser } from '../../core/BacklogParser';

const STATUSES = ['To Do', 'In Progress', 'Done'];

function makeInput(overrides: Partial<BoardDoctorInput> = {}): BoardDoctorInput {
  return {
    tasks: [],
    statuses: STATUSES,
    categories: ['Core Board', 'Orchestration'],
    handoffTaskIds: [],
    worktreeDirs: [],
    ...overrides,
  };
}

function makeTask(overrides: Partial<DoctorTask> & { id: string }): DoctorTask {
  return {
    title: 'Some task',
    status: 'To Do',
    ...overrides,
  };
}

describe('diagnoseBoard', () => {
  it('returns no findings for a healthy board', () => {
    const input = makeInput({
      tasks: [
        makeTask({ id: 'TASK-1', status: 'Done' }),
        makeTask({
          id: 'TASK-2',
          title: 'Add login',
          status: 'In Progress',
          claimedBy: '@agent/task-2-add-login',
          worktree: 'task-2-add-login',
        }),
        makeTask({ id: 'TASK-3', status: 'To Do', category: 'Core Board' }),
      ],
      activeTaskId: 'TASK-2',
      worktreeDirs: ['task-2-add-login'],
    });
    expect(diagnoseBoard(input)).toEqual([]);
  });

  it('flags a dangling active-task pointer at a nonexistent task', () => {
    const input = makeInput({
      tasks: [makeTask({ id: 'TASK-1' })],
      activeTaskId: 'TASK-99',
    });
    const findings = diagnoseBoard(input);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('dangling-active-task');
    expect(findings[0].repair).toBe('clear-active-task');
    expect(findings[0].taskId).toBe('TASK-99');
  });

  it('accepts an active-task pointer at a known extra task (completed/draft)', () => {
    const input = makeInput({
      tasks: [makeTask({ id: 'TASK-1' })],
      activeTaskId: 'TASK-50',
      extraKnownTaskIds: ['TASK-50'],
    });
    expect(diagnoseBoard(input)).toEqual([]);
  });

  it('flags stale handoff files for Done and missing tasks, not in-flight ones', () => {
    const input = makeInput({
      tasks: [
        makeTask({ id: 'TASK-1', status: 'Done' }),
        makeTask({ id: 'TASK-2', status: 'In Progress', claimedBy: '@x' }),
      ],
      handoffTaskIds: ['TASK-1', 'TASK-2', 'TASK-13'],
    });
    const findings = diagnoseBoard(input);
    expect(findings.map((f) => [f.type, f.taskId])).toEqual([
      ['stale-handoff', 'TASK-1'],
      ['stale-handoff', 'TASK-13'],
    ]);
    expect(findings.every((f) => f.repair === 'delete-handoff')).toBe(true);
  });

  it('flags a worktree dir no live task accounts for (mapping a Done task back by branch name)', () => {
    const input = makeInput({
      tasks: [
        makeTask({ id: 'TASK-5', title: 'Fix login', status: 'Done' }),
        makeTask({
          id: 'TASK-6',
          title: 'Live one',
          status: 'In Progress',
          claimedBy: '@a',
          worktree: 'task-6-live-one',
        }),
      ],
      worktreeDirs: ['task-5-fix-login', 'task-6-live-one', 'task-61-mystery'],
    });
    const findings = diagnoseBoard(input);
    expect(findings.map((f) => [f.type, f.taskId, f.detail])).toEqual([
      ['orphaned-worktree', 'TASK-5', 'task-5-fix-login'],
      ['orphaned-worktree', undefined, 'task-61-mystery'],
    ]);
    expect(findings.every((f) => f.repair === 'teardown-worktree')).toBe(true);
  });

  it('does not flag the worktree of a dispatched-but-unclaimed (To Do) task', () => {
    const input = makeInput({
      tasks: [makeTask({ id: 'TASK-7', title: 'Fresh dispatch', status: 'To Do' })],
      worktreeDirs: ['task-7-fresh-dispatch'],
    });
    expect(diagnoseBoard(input)).toEqual([]);
  });

  it('flags an in-flight task with no claim and no worktree', () => {
    const input = makeInput({
      tasks: [makeTask({ id: 'TASK-32', title: 'Stuck', status: 'In Progress' })],
    });
    const findings = diagnoseBoard(input);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('in-flight-no-claim');
    expect(findings[0].repair).toBe('reset-status');
    expect(findings[0].taskId).toBe('TASK-32');
  });

  it('does not flag an in-flight unclaimed task whose dispatch worktree exists', () => {
    const input = makeInput({
      tasks: [makeTask({ id: 'TASK-8', title: 'Being set up', status: 'In Progress' })],
      worktreeDirs: ['task-8-being-set-up'],
    });
    expect(diagnoseBoard(input)).toEqual([]);
  });

  it('flags a claim whose managed worktree vanished', () => {
    const input = makeInput({
      tasks: [
        makeTask({
          id: 'TASK-9',
          title: 'Ghost',
          status: 'In Progress',
          claimedBy: '@agent/task-9-ghost',
          worktree: 'task-9-ghost',
        }),
      ],
      worktreeDirs: [],
    });
    const findings = diagnoseBoard(input);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('claim-worktree-vanished');
    expect(findings[0].repair).toBe('release-claim');
    expect(findings[0].taskId).toBe('TASK-9');
  });

  it('does not flag a claim whose worktree value is not a managed .worktrees name (e.g. main)', () => {
    const input = makeInput({
      tasks: [
        makeTask({
          id: 'TASK-10',
          status: 'In Progress',
          claimedBy: '@alice',
          worktree: 'main',
        }),
      ],
    });
    expect(diagnoseBoard(input)).toEqual([]);
  });

  it('flags a mangled category that swallowed a branch name, suggesting the configured prefix', () => {
    const input = makeInput({
      tasks: [
        makeTask({
          id: 'TASK-80',
          category: 'Orchestration task-80-conflict-safe-parallel-batching',
        }),
      ],
    });
    const findings = diagnoseBoard(input);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('malformed-category');
    expect(findings[0].repair).toBe('fix-category');
    expect(findings[0].taskId).toBe('TASK-80');
    expect(findings[0].suggestion).toBe('Orchestration');
  });

  it('suggests clearing a mangled category with no configured prefix', () => {
    const input = makeInput({
      tasks: [makeTask({ id: 'TASK-81', category: 'weird task-81-something-else' })],
    });
    const findings = diagnoseBoard(input);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('malformed-category');
    expect(findings[0].suggestion).toBe('');
  });

  it('accepts free-form discovered categories that are not in the configured list', () => {
    const input = makeInput({
      tasks: [makeTask({ id: 'TASK-11', category: 'Discovered Lane' })],
    });
    expect(diagnoseBoard(input)).toEqual([]);
  });

  it('flags dangling folded continuation lines in a task file frontmatter', () => {
    const raw = [
      '---',
      'id: TASK-12',
      'title: Corrupted',
      'status: To Do',
      'category: Orchestration',
      '  task-80-conflict-safe-parallel-batching-pulls-the',
      'assignee: []',
      'dependencies: []',
      '---',
      '',
      'Body',
      '',
    ].join('\n');
    const input = makeInput({
      tasks: [makeTask({ id: 'TASK-12', rawContent: raw })],
    });
    const findings = diagnoseBoard(input);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('dangling-continuation');
    expect(findings[0].repair).toBe('strip-continuations');
    expect(findings[0].taskId).toBe('TASK-12');
  });

  it('does not flag block sequences (arrays) as dangling continuations', () => {
    const raw = [
      '---',
      'id: TASK-13',
      'title: Fine',
      'status: To Do',
      'assignee:',
      "  - '@alice'",
      'labels:',
      '  - feature',
      'dependencies: []',
      '---',
      '',
    ].join('\n');
    const input = makeInput({
      tasks: [makeTask({ id: 'TASK-13', rawContent: raw })],
    });
    expect(diagnoseBoard(input)).toEqual([]);
  });

  describe('git-auto board home checks (TASK-91)', () => {
    it('flags a missing/broken board worktree in git-auto', () => {
      const findings = diagnoseBoard(
        makeInput({ syncMode: 'git-auto', boardWorktreeOk: false, boardWorktreePresent: false })
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].type).toBe('board-worktree-missing');
      expect(findings[0].repair).toBe('repair-board-worktree');
    });

    it('does not flag the worktree outside git-auto, or when healthy', () => {
      expect(diagnoseBoard(makeInput({ syncMode: 'git', boardWorktreeOk: false }))).toEqual([]);
      expect(diagnoseBoard(makeInput({ syncMode: 'git-auto', boardWorktreeOk: true }))).toEqual([]);
    });

    it('flags stray state dirs in the primary backlog/ under git-auto', () => {
      const findings = diagnoseBoard(
        makeInput({
          syncMode: 'git-auto',
          boardWorktreeOk: true,
          primaryStateDirs: ['tasks', 'drafts'],
        })
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].type).toBe('board-strays-in-primary');
      expect(findings[0].repair).toBe('fold-primary-strays');
      expect(findings[0].detail).toBe('tasks, drafts');
    });

    it('does not flag strays outside git-auto', () => {
      expect(diagnoseBoard(makeInput({ syncMode: 'off', primaryStateDirs: ['tasks'] }))).toEqual(
        []
      );
    });

    it('flags a hand-flipped mode: off/git with no tasks dir but a leftover board worktree', () => {
      const findings = diagnoseBoard(
        makeInput({ syncMode: 'off', primaryTasksPresent: false, boardWorktreePresent: true })
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].type).toBe('board-mode-mismatch');
      expect(findings[0].repair).toBe('restore-board-to-primary');
    });

    it('does not flag mode-mismatch when tasks exist or no board worktree lingers', () => {
      expect(
        diagnoseBoard(
          makeInput({ syncMode: 'git', primaryTasksPresent: true, boardWorktreePresent: true })
        )
      ).toEqual([]);
      expect(
        diagnoseBoard(
          makeInput({ syncMode: 'off', primaryTasksPresent: false, boardWorktreePresent: false })
        )
      ).toEqual([]);
    });
  });
});

describe('findDanglingContinuations / stripDanglingContinuations', () => {
  const corrupted = [
    '---',
    'id: TASK-12',
    'category: Orchestration',
    '  task-80-conflict-safe',
    '  second-continuation-line',
    'assignee: []',
    '---',
    '',
    'Body',
  ].join('\n');

  it('finds the dangling indented lines after a completed scalar', () => {
    expect(findDanglingContinuations(corrupted)).toEqual([
      '  task-80-conflict-safe',
      '  second-continuation-line',
    ]);
  });

  it('finds nothing in canonical frontmatter', () => {
    const clean = ['---', 'id: TASK-1', 'assignee:', "  - '@a'", '---', ''].join('\n');
    expect(findDanglingContinuations(clean)).toEqual([]);
  });

  it('strips only the dangling lines, preserving everything else byte-for-byte', () => {
    expect(stripDanglingContinuations(corrupted)).toBe(
      ['---', 'id: TASK-12', 'category: Orchestration', 'assignee: []', '---', '', 'Body'].join(
        '\n'
      )
    );
  });

  it('strip is idempotent and a no-op on clean content', () => {
    const cleaned = stripDanglingContinuations(corrupted);
    expect(stripDanglingContinuations(cleaned)).toBe(cleaned);
  });

  it('returns content without frontmatter unchanged', () => {
    expect(stripDanglingContinuations('no frontmatter here')).toBe('no frontmatter here');
  });
});

describe('gatherDoctorFacts', () => {
  it('reads the active-task pointer, handoff ids, and worktree dirs from a repo root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-facts-'));
    try {
      fs.mkdirSync(path.join(root, '.taskwright', 'handoff'), { recursive: true });
      fs.writeFileSync(
        path.join(root, '.taskwright', 'active-task.json'),
        JSON.stringify({ taskId: 'TASK-4', setAt: '2026-07-01T00:00:00Z' })
      );
      fs.writeFileSync(path.join(root, '.taskwright', 'handoff', 'TASK-1.md'), 'prompt');
      fs.writeFileSync(path.join(root, '.taskwright', 'handoff', 'TASK-13.md'), 'prompt');
      fs.mkdirSync(path.join(root, '.worktrees', 'task-2-add-login'), { recursive: true });
      // A stray file under .worktrees must not be reported as a worktree dir.
      fs.writeFileSync(path.join(root, '.worktrees', 'README.txt'), 'stray');

      const facts = gatherDoctorFacts(root);
      expect(facts.activeTaskId).toBe('TASK-4');
      expect(facts.handoffTaskIds.sort()).toEqual(['TASK-1', 'TASK-13']);
      expect(facts.worktreeDirs).toEqual(['task-2-add-login']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns empty facts for a root with no .taskwright or .worktrees', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-empty-'));
    try {
      expect(gatherDoctorFacts(root)).toEqual({
        activeTaskId: undefined,
        handoffTaskIds: [],
        worktreeDirs: [],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runBoardDoctor', () => {
  it('diagnoses a real backlog directory end-to-end via BacklogParser', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-e2e-'));
    try {
      const backlog = path.join(root, 'backlog');
      fs.mkdirSync(path.join(backlog, 'tasks'), { recursive: true });
      fs.writeFileSync(
        path.join(backlog, 'config.yml'),
        [
          'project_name: "Doctor Test"',
          'statuses: ["To Do", "In Progress", "Done"]',
          'categories: ["Orchestration"]',
          '',
        ].join('\n')
      );
      fs.writeFileSync(
        path.join(backlog, 'tasks', 'TASK-1 - Done-thing.md'),
        [
          '---',
          'id: TASK-1',
          'title: Done thing',
          'status: Done',
          'assignee: []',
          "created_date: '2026-07-01'",
          'labels: []',
          'dependencies: []',
          '---',
          '',
          'Body',
          '',
        ].join('\n')
      );
      fs.writeFileSync(
        path.join(backlog, 'tasks', 'TASK-2 - Corrupted.md'),
        [
          '---',
          'id: TASK-2',
          'title: Corrupted',
          'status: To Do',
          'assignee: []',
          "created_date: '2026-07-02'",
          'labels: []',
          'dependencies: []',
          'category: Orchestration',
          '  task-80-conflict-safe-parallel-batching',
          '---',
          '',
          'Body',
          '',
        ].join('\n')
      );
      // Stale handoff for the Done task + a dangling active-task pointer.
      fs.mkdirSync(path.join(root, '.taskwright', 'handoff'), { recursive: true });
      fs.writeFileSync(path.join(root, '.taskwright', 'handoff', 'TASK-1.md'), 'prompt');
      fs.writeFileSync(
        path.join(root, '.taskwright', 'active-task.json'),
        JSON.stringify({ taskId: 'TASK-99', setAt: '2026-07-01T00:00:00Z' })
      );

      const parser = new BacklogParser(backlog);
      const findings = await runBoardDoctor(parser, root);
      const byType = findings.map((f) => [f.type, f.taskId]).sort();
      expect(byType).toEqual(
        [
          ['dangling-active-task', 'TASK-99'],
          ['stale-handoff', 'TASK-1'],
          ['malformed-category', 'TASK-2'],
          ['dangling-continuation', 'TASK-2'],
        ].sort()
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
