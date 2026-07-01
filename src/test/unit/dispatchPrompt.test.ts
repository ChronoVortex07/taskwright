import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DISPATCH_TEMPLATE,
  commandUsesClaudePrintMode,
  dispatchBranchName,
  dispatchContextFromTask,
  formatChecklist,
  renderDispatchPrompt,
  resolveTerminalLaunch,
} from '../../core/dispatchPrompt';
import { Task } from '../../core/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'TASK-7',
    title: 'Add user login',
    status: 'To Do',
    priority: 'high',
    description: 'Let users sign in with email and password.',
    labels: ['feature', 'auth'],
    assignee: [],
    dependencies: [],
    acceptanceCriteria: [
      { id: 1, text: 'Login form validates email', checked: false },
      { id: 2, text: 'Session persists', checked: true },
    ],
    definitionOfDone: [],
    implementationPlan: '1. Build form\n2. Wire backend',
    filePath: '/repo/backlog/tasks/TASK-7 - Add-user-login.md',
    ...overrides,
  };
}

describe('formatChecklist', () => {
  it('renders checked/unchecked items as a markdown checklist', () => {
    const out = formatChecklist([
      { id: 1, text: 'First', checked: false },
      { id: 2, text: 'Second', checked: true },
    ]);
    expect(out).toBe('- [ ] First\n- [x] Second');
  });

  it('returns a placeholder when there are no items', () => {
    expect(formatChecklist([])).toBe('_None specified._');
  });
});

describe('dispatchBranchName', () => {
  it('builds a flat, slugified branch name from id and title', () => {
    expect(dispatchBranchName(makeTask())).toBe('task-7-add-user-login');
  });

  it('strips punctuation and collapses separators', () => {
    const name = dispatchBranchName(makeTask({ id: 'TASK-12', title: 'Fix: the "weird" bug!!' }));
    expect(name).toBe('task-12-fix-the-weird-bug');
  });

  it('falls back to the id when the title slugifies to nothing', () => {
    expect(dispatchBranchName(makeTask({ id: 'TASK-3', title: '***' }))).toBe('task-3');
  });
});

describe('dispatchContextFromTask', () => {
  it('flattens a task into render-ready strings', () => {
    const ctx = dispatchContextFromTask(makeTask(), { worktree: 'task-7-add-user-login' });
    expect(ctx.id).toBe('TASK-7');
    expect(ctx.title).toBe('Add user login');
    expect(ctx.priority).toBe('high');
    expect(ctx.labels).toBe('feature, auth');
    expect(ctx.worktree).toBe('task-7-add-user-login');
    expect(ctx.acceptanceCriteria).toContain('- [ ] Login form validates email');
    expect(ctx.plan).toContain('Build form');
  });

  it('fills empty optional fields with readable placeholders', () => {
    const ctx = dispatchContextFromTask(
      makeTask({
        priority: undefined,
        description: undefined,
        implementationPlan: undefined,
        labels: [],
      })
    );
    expect(ctx.priority).toBe('none');
    expect(ctx.labels).toBe('none');
    expect(ctx.description).toBe('_No description._');
    expect(ctx.plan).toBe('_No implementation plan yet._');
    expect(ctx.worktree).toBe('');
  });

  it('carries the handoff file path when provided', () => {
    const ctx = dispatchContextFromTask(makeTask(), {
      worktree: 'task-7',
      handoffFile: '/repo/.taskwright/handoff/TASK-7.md',
    });
    expect(ctx.handoffFile).toBe('/repo/.taskwright/handoff/TASK-7.md');
    expect(ctx.worktree).toBe('task-7');
  });

  it('defaults handoffFile to empty when not provided', () => {
    expect(dispatchContextFromTask(makeTask()).handoffFile).toBe('');
  });
});

describe('renderDispatchPrompt', () => {
  it('substitutes every known placeholder', () => {
    const ctx = dispatchContextFromTask(makeTask(), { worktree: 'wt-1' });
    const out = renderDispatchPrompt(DEFAULT_DISPATCH_TEMPLATE, ctx);
    expect(out).toContain('TASK-7');
    expect(out).toContain('Add user login');
    expect(out).toContain('get_active_task');
    expect(out).toContain('claim_task');
    expect(out).not.toMatch(/\{\{\w+\}\}/); // no leftover known tokens
  });

  it('replaces all occurrences of a placeholder', () => {
    const out = renderDispatchPrompt(
      '{{id}} and again {{id}}',
      dispatchContextFromTask(makeTask())
    );
    expect(out).toBe('TASK-7 and again TASK-7');
  });

  it('leaves unknown placeholders untouched so typos are visible', () => {
    const out = renderDispatchPrompt('{{id}} {{bogus}}', dispatchContextFromTask(makeTask()));
    expect(out).toBe('TASK-7 {{bogus}}');
  });
});

describe('commandUsesClaudePrintMode', () => {
  it('flags claude -p and --print invocations', () => {
    expect(commandUsesClaudePrintMode('claude -p "do it"')).toBe(true);
    expect(commandUsesClaudePrintMode('claude --print < file')).toBe(true);
  });

  it('allows an interactive claude chat seeded from a file', () => {
    expect(commandUsesClaudePrintMode('claude "$(cat handoff.md)"')).toBe(false);
    expect(commandUsesClaudePrintMode("claude (Get-Content -Raw 'handoff.md')")).toBe(false);
  });

  it('does not flag -p that belongs to a different command segment', () => {
    expect(commandUsesClaudePrintMode('grep -p foo && claude "go"')).toBe(false);
  });

  it('ignores non-claude commands', () => {
    expect(commandUsesClaudePrintMode('echo -p hello')).toBe(false);
  });
});

describe('DEFAULT_DISPATCH_TEMPLATE worktree isolation', () => {
  it('tells the session to cd into and stay in its worktree', () => {
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('.worktrees/{{worktree}}');
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('cd into it');
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('repository root');
  });
});

describe('resolveTerminalLaunch', () => {
  const ctx = dispatchContextFromTask(makeTask(), {
    worktree: 'task-7',
    handoffFile: '/repo/.taskwright/handoff/TASK-7.md',
  });

  it('does nothing for an empty or whitespace template', () => {
    expect(resolveTerminalLaunch('', ctx)).toEqual({ run: false });
    expect(resolveTerminalLaunch('   ', ctx)).toEqual({ run: false });
  });

  it('renders placeholders and runs an interactive command', () => {
    const d = resolveTerminalLaunch('claude "$(cat {{handoffFile}})"', ctx);
    expect(d.run).toBe(true);
    expect(d.command).toBe('claude "$(cat /repo/.taskwright/handoff/TASK-7.md)"');
    expect(d.warning).toBeUndefined();
  });

  it('refuses a claude -p command and returns a warning', () => {
    const d = resolveTerminalLaunch('claude -p "$(cat {{handoffFile}})"', ctx);
    expect(d.run).toBe(false);
    expect(d.command).toBeUndefined();
    expect(d.warning).toMatch(/-p/);
  });

  it('refuses a claude --print command and returns a warning', () => {
    const d = resolveTerminalLaunch('claude --print "$(cat {{handoffFile}})"', ctx);
    expect(d.run).toBe(false);
    expect(d.command).toBeUndefined();
    expect(d.warning).toMatch(/--print|-p/);
  });
});

describe('DEFAULT_DISPATCH_TEMPLATE closing step', () => {
  it('instructs the agent to close with request_merge from the worktree', () => {
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('request_merge');
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('wait for it to return');
  });
});
