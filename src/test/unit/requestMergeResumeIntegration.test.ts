/**
 * TASK-130 — acceptance coverage for the resumable-merge protocol (TASK-88) against a REAL repo.
 *
 * The `waitMinutes` expiry -> `{ status: 'pending', queuePosition, ticket }` -> resume-with-ticket
 * cycle had only mocked-git unit coverage: it had never been walked end to end against a real
 * repository, a real on-disk merge queue, and the real reviewer actions the board fires. These
 * tests close that gap by driving the whole park-and-resume loop with:
 *
 *   - real git (init / worktree add / commit / rebase / ff-merge / worktree remove),
 *   - the real `MergeQueueStore` writing the real queue file under `.git/taskwright/`,
 *   - the real `makePrimaryBoard` board ops (which parse + rewrite the real task markdown),
 *   - the real reviewer actions from the board UI — `approveMergeInQueue` (Approve) and
 *     `sendBackMerge` (Send back) — rather than hand-poking queue internals.
 *
 * Only `run` (the verify shell) and `sleep` are stubbed: `run` so the fixture repo need not host a
 * real test suite (it counts invocations instead, which is what lets us assert the "verify is
 * skipped when the base has not moved" resume optimization), and `sleep` so the long-poll does not
 * actually wait.
 *
 * Platform independence (AC #4): every path is built with `path.join`, no assertion depends on a
 * separator, and the tests are order-independent — each builds its own throwaway repo.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { requestMerge, type GitExecFn, type RunFn, type FinishDeps } from '../../core/finishTask';
import { MergeQueueStore, mergeQueuePath, nodeQueueFs } from '../../core/mergeQueue';
import { makePrimaryBoard } from '../../mcp/handlers';
import { approveMergeInQueue, sendBackMerge } from '../../providers/mergeActions';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';

const execFileAsync = promisify(execFile);

const realExec: GitExecFn = (cwd, args) =>
  execFileAsync('git', args, { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });

const TASK_MD = `---
id: TASK-7
title: Sample
status: In Progress
assignee: []
dependencies: []
---
## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Sample task for the resume acceptance test.

<!-- SECTION:DESCRIPTION:END -->
`;

let tmpDir: string;

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface Fixture {
  primary: string;
  worktreePath: string;
  worktreeRel: string;
  queue: MergeQueueStore;
  commonDir: string;
  parser: BacklogParser;
  writer: BacklogWriter;
  /** How many verify commands have been run so far (across every requestMerge call). */
  verifyRuns: () => number;
  deps: FinishDeps;
  taskStatus: () => string;
  mainLog: () => Promise<string>;
}

/** A real repo: `main` with a committed task file, plus a `.worktrees/task-7-x` worktree holding
 *  one finished commit — i.e. exactly the state an agent is in when it calls request_merge. */
async function makeFixture(): Promise<Fixture> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-resume-'));
  const primary = path.join(tmpDir, 'primary');
  fs.mkdirSync(primary, { recursive: true });

  const git = async (cwd: string, ...args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: 30_000 });
    return stdout.trim();
  };

  await git(primary, 'init', '-q', '-b', 'main');
  await git(primary, 'config', 'user.email', 'test@example.com');
  await git(primary, 'config', 'user.name', 'Test User');
  // The linked worktree lives under the primary tree; without this it shows up as untracked WIP
  // and the pre-merge cleanliness gates would trip on it (matches the real repo's .gitignore).
  fs.writeFileSync(path.join(primary, '.gitignore'), '.worktrees/\n', 'utf-8');

  const tasksDir = path.join(primary, 'backlog', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, 'task-7 - Sample.md'), TASK_MD, 'utf-8');
  await git(primary, 'add', '.');
  await git(primary, 'commit', '-q', '-m', 'init');

  const worktreeRel = path.join('.worktrees', 'task-7-x');
  const worktreePath = path.join(primary, worktreeRel);
  await git(primary, 'worktree', 'add', '-q', worktreePath, '-b', 'task-7-x');
  await git(worktreePath, 'config', 'user.email', 'test@example.com');
  await git(worktreePath, 'config', 'user.name', 'Test User');

  // The finished work: a commit on the task branch that does NOT touch the task file (the board
  // writes that one itself), so the ff-merge is clean.
  const srcDir = path.join(worktreePath, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'feature.ts'), 'export const feature = true;\n', 'utf-8');
  await git(worktreePath, 'add', '.');
  await git(worktreePath, 'commit', '-q', '-m', 'TASK-7: implement the feature');

  const commonDir = path.join(primary, '.git');
  const queue = new MergeQueueStore(mergeQueuePath(commonDir), nodeQueueFs);
  const board = makePrimaryBoard(primary, realExec);
  const parser = new BacklogParser(path.join(primary, 'backlog'));
  const writer = new BacklogWriter();

  // Counting verify shell: the fixture repo hosts no real suite, and the count is exactly what
  // proves the resume skipped its re-verify.
  let verifyRuns = 0;
  const countingRun: RunFn = async () => {
    verifyRuns += 1;
    return { code: 0, stdout: '', stderr: '' };
  };

  const deps: FinishDeps = {
    root: worktreePath,
    primaryRoot: primary,
    branch: 'task-7-x',
    worktreeRel: worktreeRel.replace(/\\/g, '/'),
    config: {
      // manual-review is the mode whose queue actually gates on a human, so it is the mode in
      // which a bounded wait realistically expires.
      mode: 'manual-review',
      verifyCommands: ['run-the-suite'],
      staleMinutes: 30,
      verifyTimeoutMs: 600_000,
    },
    queue,
    board,
    exec: realExec,
    run: countingRun,
    now: () => new Date('2026-07-14T12:00:00Z'),
    sleep: async () => {},
  };

  return {
    primary,
    worktreePath,
    worktreeRel,
    queue,
    commonDir,
    parser,
    writer,
    verifyRuns: () => verifyRuns,
    deps,
    taskStatus: () => {
      const file = path.join(primary, 'backlog', 'tasks', 'task-7 - Sample.md');
      return /^status:\s*(.+)$/m.exec(fs.readFileSync(file, 'utf-8'))?.[1]?.trim() ?? '';
    },
    mainLog: async () => git(primary, 'log', '--oneline', 'main'),
  };
}

describe('request_merge resumable protocol — real repo acceptance (TASK-130)', () => {
  it('AC#2: waitMinutes expiry parks as pending, and a ticketed resume reaches merged', async () => {
    const fx = await makeFixture();

    // --- Park. waitMinutes: 0 = check the queue once. In manual-review nobody has approved yet,
    // so the head cannot proceed and the bounded wait expires immediately.
    const parked = await requestMerge(fx.deps, 'TASK-7', { waitMinutes: 0 });

    expect(parked.status).toBe('pending');
    if (parked.status !== 'pending') throw new Error('unreachable');
    expect(parked.taskId).toBe('TASK-7');
    expect(parked.queuePosition).toBe(1);
    expect(parked.ticket).toMatch(/^TASK-7@/);
    expect(parked.message).toMatch(/awaiting human approval/i);

    // Pending is NOT an abort: the work is verified and the entry is KEPT for the resume.
    const parkedQueue = fx.queue.read();
    expect(parkedQueue.entries).toHaveLength(1);
    expect(parkedQueue.entries[0].taskId).toBe('TASK-7');
    // The verified HEAD is recorded — this is what lets the resume skip the re-verify.
    expect(parkedQueue.entries[0].verifiedHeadSha).toBeTruthy();

    // The board shows the parked intermediate status, and the worktree is untouched.
    expect(fx.taskStatus()).toBe('Pending Review');
    expect(fs.existsSync(fx.worktreePath)).toBe(true);
    expect(await fx.mainLog()).not.toMatch(/implement the feature/);

    // Verify ran exactly once (the pre-enqueue verify).
    expect(fx.verifyRuns()).toBe(1);

    // --- The reviewer approves on the board (the real Approve action).
    approveMergeInQueue(fx.commonDir, 'TASK-7');

    // --- Resume with the SAME taskId + the returned ticket.
    const resumed = await requestMerge(fx.deps, 'TASK-7', { ticket: parked.ticket });

    expect(resumed.status).toBe('merged');
    if (resumed.status === 'merged') expect(resumed.branch).toBe('task-7-x');

    // The resume was idempotent: it reused the parked entry rather than re-enqueueing, and it
    // skipped the redundant re-verify because the base never moved (still 1, not 2 or 3).
    expect(fx.verifyRuns()).toBe(1);

    // The merge really happened in the real repo.
    expect(await fx.mainLog()).toMatch(/implement the feature/);
    expect(fs.existsSync(path.join(fx.primary, 'src', 'feature.ts'))).toBe(true);
    expect(fx.taskStatus()).toBe('Done');
    expect(fx.queue.read().entries).toHaveLength(0); // dequeued
    expect(fs.existsSync(fx.worktreePath)).toBe(false); // worktree torn down
  }, 60_000);

  it('AC#3: a reviewer Send back while parked makes the ticketed resume return sent_back', async () => {
    const fx = await makeFixture();

    const parked = await requestMerge(fx.deps, 'TASK-7', { waitMinutes: 0 });
    expect(parked.status).toBe('pending');
    if (parked.status !== 'pending') throw new Error('unreachable');
    expect(fx.taskStatus()).toBe('Pending Review');

    // --- The reviewer sends the task back while the agent is parked (the real Send back action:
    // it drops the queue entry and resets the board status).
    await sendBackMerge(fx.commonDir, 'TASK-7', fx.parser, fx.writer);
    expect(fx.queue.read().entries).toHaveLength(0);
    expect(fx.taskStatus()).toBe('In Progress');

    // --- The resume presents the ticket. Its entry is gone, so instead of silently re-submitting
    // finished work into a queue it was just rejected from, it must surface the rejection.
    const resumed = await requestMerge(fx.deps, 'TASK-7', { ticket: parked.ticket });

    expect(resumed.status).toBe('sent_back');
    if (resumed.status === 'sent_back') {
      expect(resumed.taskId).toBe('TASK-7');
      expect(resumed.reason).toMatch(/sent this task back/i);
    }

    // Nothing was merged or destroyed — the work survives for the agent to revise.
    expect(await fx.mainLog()).not.toMatch(/implement the feature/);
    expect(fs.existsSync(fx.worktreePath)).toBe(true);
    expect(fx.queue.read().entries).toHaveLength(0); // and it did NOT re-enqueue itself
    expect(fx.taskStatus()).toBe('In Progress');
  }, 60_000);

  it('AC#3 (contrast): resuming WITHOUT the ticket cannot detect the send-back and re-submits', async () => {
    // This is precisely why the protocol hands back a ticket and asks for it on resume: the queue
    // entry's absence is ambiguous on its own (a first-ever call also has none). Only a presented
    // ticket makes "my entry vanished" mean "a reviewer sent me back".
    const fx = await makeFixture();

    const parked = await requestMerge(fx.deps, 'TASK-7', { waitMinutes: 0 });
    expect(parked.status).toBe('pending');

    await sendBackMerge(fx.commonDir, 'TASK-7', fx.parser, fx.writer);
    expect(fx.taskStatus()).toBe('In Progress');

    // No ticket => indistinguishable from a fresh submission => it re-verifies and re-queues.
    const resumed = await requestMerge(fx.deps, 'TASK-7', { waitMinutes: 0 });

    expect(resumed.status).toBe('pending'); // NOT sent_back
    expect(fx.queue.read().entries).toHaveLength(1); // silently back in the queue
    expect(fx.verifyRuns()).toBe(2); // and it paid for a full re-verify
    expect(fx.taskStatus()).toBe('Pending Review');
  }, 60_000);
});
