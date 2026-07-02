import { describe, it, expect, vi } from 'vitest';
import { cancelDispatch } from '../../core/cancelDispatch';

describe('cancelDispatch', () => {
  it('releases the claim, resets status, removes the worktree, and disposes the terminal — in order', async () => {
    const calls: string[] = [];
    const deps = {
      releaseClaim: vi.fn(async () => {
        calls.push('release');
      }),
      setStatus: vi.fn(async (_id: string, _status: string) => {
        calls.push('status');
      }),
      removeWorktree: vi.fn(async (_rel: string) => {
        calls.push('worktree');
      }),
      disposeTerminal: vi.fn((_name: string) => {
        calls.push('terminal');
      }),
    };
    await cancelDispatch(deps, {
      taskId: 'TASK-7',
      branch: 'task-7-thing',
      toDoStatus: 'To Do',
      terminalName: 'Taskwright TASK-7',
    });
    expect(calls).toEqual(['release', 'status', 'worktree', 'terminal']);
    expect(deps.releaseClaim).toHaveBeenCalledWith('TASK-7');
    expect(deps.setStatus).toHaveBeenCalledWith('TASK-7', 'To Do');
    expect(deps.removeWorktree).toHaveBeenCalledWith('.worktrees/task-7-thing');
    expect(deps.disposeTerminal).toHaveBeenCalledWith('Taskwright TASK-7');
  });

  it('is best-effort: a failing step does not abort the remaining cleanup', async () => {
    const deps = {
      releaseClaim: vi.fn(async () => {
        throw new Error('release boom');
      }),
      setStatus: vi.fn(async () => {}),
      removeWorktree: vi.fn(async () => {}),
      disposeTerminal: vi.fn(() => {}),
    };
    await expect(
      cancelDispatch(deps, {
        taskId: 'TASK-1',
        branch: 'b',
        toDoStatus: 'To Do',
        terminalName: 'Taskwright TASK-1',
      })
    ).resolves.toBeUndefined();
    expect(deps.setStatus).toHaveBeenCalled();
    expect(deps.removeWorktree).toHaveBeenCalled();
    expect(deps.disposeTerminal).toHaveBeenCalled();
  });
});
