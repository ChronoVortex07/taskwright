import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { cancelDispatch } from '../../core/cancelDispatch';
import {
  writeCancellationMarker,
  cancellationMarkerPath,
  isCancelled,
} from '../../core/cancellationMarker';

describe('cancelDispatch', () => {
  it('writes the marker, releases the claim, resets status, removes the worktree, disposes the terminal — in order', async () => {
    const calls: string[] = [];
    const deps = {
      writeCancellationMarker: vi.fn((_id: string) => {
        calls.push('marker');
      }),
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
    expect(calls).toEqual(['marker', 'release', 'status', 'worktree', 'terminal']);
    expect(deps.writeCancellationMarker).toHaveBeenCalledWith('TASK-7');
    expect(deps.releaseClaim).toHaveBeenCalledWith('TASK-7');
    expect(deps.setStatus).toHaveBeenCalledWith('TASK-7', 'To Do');
    expect(deps.removeWorktree).toHaveBeenCalledWith('.worktrees/task-7-thing');
    expect(deps.disposeTerminal).toHaveBeenCalledWith('Taskwright TASK-7');
  });

  it('is best-effort: a failing step does not abort the remaining cleanup', async () => {
    const deps = {
      writeCancellationMarker: vi.fn(() => {}),
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

  it('writes the real marker into the worktree .taskwright/ BEFORE removal, and it survives a Windows-busy removal failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-cancel-'));
    const branch = 'task-7-thing';
    const worktreeRoot = path.join(root, '.worktrees', branch);
    fs.mkdirSync(worktreeRoot, { recursive: true });
    const order: string[] = [];
    try {
      await cancelDispatch(
        {
          // Wire the REAL marker core against the real worktree dir.
          writeCancellationMarker: (id) => {
            writeCancellationMarker(worktreeRoot, id);
            order.push('marker');
          },
          releaseClaim: async () => {
            order.push('release');
          },
          setStatus: async () => {
            order.push('status');
          },
          // Simulate a Windows-busy removal that FAILS — the marker must already be on disk.
          removeWorktree: async () => {
            order.push('worktree');
            throw new Error('EBUSY: worktree locked by a live process');
          },
          disposeTerminal: () => {
            order.push('terminal');
          },
        },
        { taskId: 'TASK-7', branch, toDoStatus: 'To Do', terminalName: 'Taskwright TASK-7' }
      );
      // Marker is written first (index 0) and best-effort continues past the removal failure.
      expect(order).toEqual(['marker', 'release', 'status', 'worktree', 'terminal']);
      // Marker survives the failed teardown (written before removeWorktree ran).
      expect(fs.existsSync(cancellationMarkerPath(worktreeRoot))).toBe(true);
      expect(isCancelled(worktreeRoot)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
