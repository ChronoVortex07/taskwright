import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  writeCancellationMarker,
  cancellationMarkerPath,
  isCancelled,
} from '../../core/cancellationMarker';
import { activeTaskPath } from '../../core/activeTask';
import type { BacklogParser } from '../../core/BacklogParser';
import type { Task } from '../../core/types';

// Force worktree creation OFF so dispatch seeds into the repo root (the temp dir) with no git.
vi.mock('../../config', () => ({
  getTaskwrightConfig: (key: string, dflt: unknown) =>
    key === 'dispatchCreateWorktree' ? false : dflt,
}));

// Imported AFTER the mock so dispatchActions picks up the mocked config.
import { dispatchTask } from '../../providers/dispatchActions';

let root: string, backlogPath: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-dispatch-'));
  backlogPath = path.join(root, 'backlog');
  fs.mkdirSync(backlogPath, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Minimal parser: getTask returns the task; getBacklogPath sets the session root.
 *  loadTreeStateFromParser calls other getters and THROWS on this stub — dispatchTask's
 *  gate is wrapped in a fail-open try/catch, so dispatch proceeds regardless. */
function stubParser(task: Task): BacklogParser {
  return {
    getTask: async () => task,
    getBacklogPath: () => backlogPath,
  } as unknown as BacklogParser;
}
const makeTask = (): Task =>
  ({
    id: 'TASK-7',
    title: 'Thing',
    status: 'To Do',
    labels: [],
    assignee: [],
    dependencies: [],
    acceptanceCriteria: [],
    definitionOfDone: [],
    filePath: path.join(backlogPath, 'tasks', 'task-7 - Thing.md'),
  }) as Task;

describe('dispatchTask — clears a stale cancellation marker on seed (GAP-3)', () => {
  it('removes a pre-existing .taskwright/cancelled and seeds the active task', async () => {
    // A leftover marker from a prior (leaked) cancel at the session root.
    writeCancellationMarker(root, 'TASK-7');
    expect(isCancelled(root)).toBe(true);

    const result = await dispatchTask('TASK-7', stubParser(makeTask()));
    expect(result).toBeDefined();
    expect(result!.sessionRoot).toBe(root); // no worktree → repo root

    expect(fs.existsSync(cancellationMarkerPath(root))).toBe(false); // stale marker cleared
    expect(fs.existsSync(activeTaskPath(root))).toBe(true); // active task seeded
  });

  it('positive control: a dispatch with no prior marker leaves none', async () => {
    const result = await dispatchTask('TASK-7', stubParser(makeTask()));
    expect(result).toBeDefined();
    expect(isCancelled(root)).toBe(false);
  });
});
