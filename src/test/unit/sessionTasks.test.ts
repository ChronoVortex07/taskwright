import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  readSessionTasks,
  recordSessionTask,
  forgetSessionTask,
  sessionTasksPath,
} from '../../core/sessionTasks';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-sesstasks-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('session-task ledger (TASK-129)', () => {
  it('reads an empty list when no ledger exists', () => {
    expect(readSessionTasks(root)).toEqual([]);
  });

  it('records a task and reads it back', () => {
    recordSessionTask(root, { taskId: 'TASK-7', worktree: '.worktrees/task-7', via: 'start_task' });
    const entries = readSessionTasks(root);
    expect(entries).toHaveLength(1);
    expect(entries[0].taskId).toBe('TASK-7');
    expect(entries[0].worktree).toBe('.worktrees/task-7');
    expect(entries[0].via).toBe('start_task');
    expect(Date.parse(entries[0].at)).not.toBeNaN();
  });

  it('lives under the git-ignored .taskwright state dir', () => {
    expect(sessionTasksPath(root)).toBe(path.join(root, '.taskwright', 'session-tasks.json'));
  });

  it('upserts by task id — re-recording the same task does not duplicate it', () => {
    recordSessionTask(root, { taskId: 'TASK-7', via: 'start_task' });
    recordSessionTask(root, { taskId: 'TASK-7', worktree: '.worktrees/task-7', via: 'claim_task' });
    const entries = readSessionTasks(root);
    expect(entries).toHaveLength(1);
    // The newer record wins.
    expect(entries[0].via).toBe('claim_task');
    expect(entries[0].worktree).toBe('.worktrees/task-7');
  });

  it('keeps several in-flight tasks (an orchestrator bootstraps many worktrees)', () => {
    recordSessionTask(root, { taskId: 'TASK-1', via: 'start_task' });
    recordSessionTask(root, { taskId: 'TASK-2', via: 'start_task' });
    recordSessionTask(root, { taskId: 'TASK-3', via: 'start_task' });
    expect(readSessionTasks(root).map((e) => e.taskId)).toEqual(['TASK-1', 'TASK-2', 'TASK-3']);
  });

  it('forgets a task (release / merge cleanup) and is idempotent', () => {
    recordSessionTask(root, { taskId: 'TASK-1', via: 'start_task' });
    recordSessionTask(root, { taskId: 'TASK-2', via: 'claim_task' });
    forgetSessionTask(root, 'TASK-1');
    expect(readSessionTasks(root).map((e) => e.taskId)).toEqual(['TASK-2']);
    forgetSessionTask(root, 'TASK-1'); // no-op, does not throw
    forgetSessionTask(root, 'TASK-404'); // unknown id, does not throw
    expect(readSessionTasks(root).map((e) => e.taskId)).toEqual(['TASK-2']);
  });

  it('forgetting on an absent ledger does not throw', () => {
    expect(() => forgetSessionTask(root, 'TASK-1')).not.toThrow();
  });

  it('treats a corrupt ledger as empty rather than throwing', () => {
    fs.mkdirSync(path.join(root, '.taskwright'), { recursive: true });
    fs.writeFileSync(sessionTasksPath(root), '{ not json', 'utf-8');
    expect(readSessionTasks(root)).toEqual([]);
    // ...and a later record repairs it.
    recordSessionTask(root, { taskId: 'TASK-9', via: 'claim_task' });
    expect(readSessionTasks(root).map((e) => e.taskId)).toEqual(['TASK-9']);
  });

  it('drops malformed entries', () => {
    fs.mkdirSync(path.join(root, '.taskwright'), { recursive: true });
    fs.writeFileSync(
      sessionTasksPath(root),
      JSON.stringify([{ taskId: 'TASK-1', at: 'x', via: 'start_task' }, { nope: true }, 42]),
      'utf-8'
    );
    expect(readSessionTasks(root).map((e) => e.taskId)).toEqual(['TASK-1']);
  });

  it('is case-insensitive on the task id (upsert and forget)', () => {
    recordSessionTask(root, { taskId: 'TASK-7', via: 'start_task' });
    recordSessionTask(root, { taskId: 'task-7', via: 'claim_task' });
    expect(readSessionTasks(root)).toHaveLength(1);
    forgetSessionTask(root, 'task-7');
    expect(readSessionTasks(root)).toEqual([]);
  });
});
