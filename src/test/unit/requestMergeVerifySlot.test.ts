// src/test/unit/requestMergeVerifySlot.test.ts
//
// TASK-126 regression suite: concurrent `request_merge` calls must never run
// their verify suites at the same time. Before the shared verify slot, N
// /orchestrate-board subagents each launched a full `bun run test` (itself a
// CPU-saturating worker pool) simultaneously; the git-subprocess-heavy suites
// then blew their per-test timeouts and the merge aborted `verify_failed` —
// every test passing in isolation. These tests drive TWO overlapping
// requestMerge calls through ONE FileVerifySlot and assert the runs are
// serialized, and that the slot is never held across the merge-queue wait.
import { describe, it, expect } from 'vitest';
import {
  requestMerge,
  type FinishDeps,
  type BoardOps,
  type GitExecFn,
} from '../../core/finishTask';
import { MergeQueueStore, approveEntry, type QueueFsDeps } from '../../core/mergeQueue';
import { DEFAULT_MERGE_CONFIG } from '../../core/mergeConfig';
import { FileVerifySlot, type VerifySlotFs } from '../../core/verifySlot';

const LOCK = '/common/taskwright/verify-slot.lock';

/** Shared in-memory queue store (both callers see the same queue file). */
function memQueue(): MergeQueueStore {
  const files: Record<string, string> = {};
  const fsDeps: QueueFsDeps = {
    exists: (p) => p in files,
    read: (p) => files[p],
    writeAtomic: (p, d) => {
      files[p] = d;
    },
  };
  return new MergeQueueStore('/q.json', fsDeps);
}

/** In-memory slot fs with a genuinely exclusive create (the O_EXCL contract). */
function memSlotFs(): VerifySlotFs {
  const files: Record<string, string> = {};
  return {
    exists: (p) => p in files,
    read: (p) => files[p],
    createExclusive: (p, data) => {
      if (p in files) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      files[p] = data;
    },
    remove: (p) => {
      delete files[p];
    },
  };
}

function board(): BoardOps {
  return {
    setStatus: async () => {},
    release: async () => {},
    resetTaskFile: async () => {},
  };
}

/** Happy-path git: clean tree, main exists, rebase is a no-op, ff-merge succeeds. */
const okGit: GitExecFn = async (_cwd, args) => {
  if (args[0] === 'status') return { stdout: '', stderr: '' };
  if (args[0] === 'rev-parse' && args.includes('refs/heads/main'))
    return { stdout: 'abc', stderr: '' };
  if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: 'head-sha', stderr: '' };
  if (args[0] === 'rev-parse') throw new Error('no such ref');
  if (args[0] === 'symbolic-ref') return { stdout: 'main', stderr: '' };
  return { stdout: '', stderr: '' };
};

/** Yield to the microtask/timer queue so pending promises can advance. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

/** A verify slot both callers share, exactly as they share the on-disk lock file. */
function sharedSlot(): FileVerifySlot {
  return new FileVerifySlot(LOCK, memSlotFs(), {
    now: () => new Date(),
    sleep: () => tick(),
    leaseMs: 600_000,
    pollIntervalMs: 1,
    pid: process.pid,
    isProcessAlive: () => true,
  });
}

interface VerifyTrace {
  /** Every verify start/end, in the order they happened. */
  events: string[];
  /** Peak number of verify commands running at once — MUST stay 1. */
  peakConcurrency: number;
}

function makeDeps(
  taskId: string,
  slot: FileVerifySlot,
  queue: MergeQueueStore,
  trace: VerifyTrace,
  gates: Record<string, Promise<void>>,
  over: Partial<FinishDeps> = {}
): FinishDeps {
  let live = 0;
  return {
    root: `/wt/${taskId}`,
    primaryRoot: '/primary',
    branch: `task-${taskId}`,
    worktreeRel: `.worktrees/task-${taskId}`,
    // One verify command keeps the trace readable; serialization is per-run, not per-command.
    config: { ...DEFAULT_MERGE_CONFIG, mode: 'auto-merge', verifyCommands: ['bun run test'] },
    queue,
    board: board(),
    exec: okGit,
    run: async () => {
      live++;
      trace.peakConcurrency = Math.max(trace.peakConcurrency, live);
      trace.events.push(`${taskId}:verify:start`);
      await gates[taskId]; // hold the suite "running" until the test lets it finish
      trace.events.push(`${taskId}:verify:end`);
      live--;
      return { code: 0, stdout: '', stderr: '' };
    },
    verifySlot: slot,
    now: () => new Date(),
    sleep: () => tick(),
    pollIntervalMs: 1,
    ...over,
  };
}

/** A promise plus its resolver. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

describe('requestMerge — shared verify slot (TASK-126)', () => {
  it('serializes two overlapping verifies: the second waits for the first to finish', async () => {
    const slot = sharedSlot();
    const queue = memQueue();
    const trace: VerifyTrace = { events: [], peakConcurrency: 0 };
    const gateA = gate();
    const gateB = gate();
    const gates = { 'TASK-A': gateA.promise, 'TASK-B': gateB.promise };

    const a = requestMerge(makeDeps('TASK-A', slot, queue, trace, gates), 'TASK-A');
    // Let A reach (and block inside) its verify command.
    while (!trace.events.includes('TASK-A:verify:start')) await tick();

    const b = requestMerge(makeDeps('TASK-B', slot, queue, trace, gates), 'TASK-B');
    // Give B every chance to start its own verify. It must NOT: A holds the slot.
    for (let i = 0; i < 25; i++) await tick();
    expect(trace.events).toEqual(['TASK-A:verify:start']);
    expect(trace.peakConcurrency).toBe(1);

    // A finishes its suite (and merges); only then may B's verify begin.
    gateA.open();
    while (!trace.events.includes('TASK-B:verify:start')) await tick();
    gateB.open();

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe('merged');
    expect(rb.status).toBe('merged');

    // The whole point: the two suites never overlapped.
    expect(trace.peakConcurrency).toBe(1);
    expect(trace.events).toEqual([
      'TASK-A:verify:start',
      'TASK-A:verify:end',
      'TASK-B:verify:start',
      'TASK-B:verify:end',
    ]);
  });

  it('emits verify-wait progress naming the task that holds the slot', async () => {
    const slot = sharedSlot();
    const queue = memQueue();
    const trace: VerifyTrace = { events: [], peakConcurrency: 0 };
    const gateA = gate();
    const gateB = gate();
    const gates = { 'TASK-A': gateA.promise, 'TASK-B': gateB.promise };
    const messages: string[] = [];

    const a = requestMerge(makeDeps('TASK-A', slot, queue, trace, gates), 'TASK-A');
    while (!trace.events.includes('TASK-A:verify:start')) await tick();

    const b = requestMerge(
      makeDeps('TASK-B', slot, queue, trace, gates, {
        onProgress: (p) => {
          if (p.phase === 'verify-wait') messages.push(p.message);
        },
        progressIntervalMs: 1,
      }),
      'TASK-B'
    );
    for (let i = 0; i < 25; i++) await tick();

    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toContain('TASK-A');
    expect(messages[0]).toMatch(/verify slot/i);

    gateA.open();
    gateB.open();
    await Promise.all([a, b]);
  });

  it('releases the verify slot BEFORE parking in the merge queue (no deadlock)', async () => {
    // AC3. A holds the queue head unapproved (manual-review), so it is parked in
    // waitForTurn. If it were still holding the verify slot there, B's verify —
    // and every future merge in the repo — would be wedged behind a human.
    const slot = sharedSlot();
    const queue = memQueue();
    const trace: VerifyTrace = { events: [], peakConcurrency: 0 };
    const gateA = gate();
    const gateB = gate();
    const gates = { 'TASK-A': gateA.promise, 'TASK-B': gateB.promise };
    gateA.open(); // A's suite is fast; it goes straight from verify to the queue wait

    let aParked = false;
    const a = requestMerge(
      makeDeps('TASK-A', slot, queue, trace, gates, {
        config: {
          ...DEFAULT_MERGE_CONFIG,
          mode: 'manual-review',
          verifyCommands: ['bun run test'],
        },
        sleep: async () => {
          aParked = true; // only waitForTurn sleeps here
          await tick();
        },
      }),
      'TASK-A'
    );
    while (!aParked) await tick();

    // A is parked in the queue awaiting human approval. The slot must be FREE:
    // a fresh acquire resolves without A ever releasing anything.
    const probe = await slot.acquire('PROBE');
    await probe();

    // And a real second merge can run its whole verify while A stays parked.
    const b = requestMerge(makeDeps('TASK-B', slot, queue, trace, gates), 'TASK-B', {
      waitMinutes: 0,
    });
    while (!trace.events.includes('TASK-B:verify:start')) await tick();
    gateB.open();

    const rb = await b;
    // B verified fine, then parked behind A in the queue — pending, not aborted.
    expect(rb.status).toBe('pending');
    expect(trace.events).toContain('TASK-B:verify:end');
    expect(trace.peakConcurrency).toBe(1);

    // Approving A lets it drain, proving nothing was deadlocked.
    queue.mutate((q) => approveEntry(q, 'TASK-A'));
    const ra = await a;
    expect(ra.status).toBe('merged');
  });

  it('a crashed holder cannot wedge verify forever: the stale lease is stolen', async () => {
    // The slot is an availability risk if a holder dies mid-verify. Lease expiry
    // (and the dead-pid probe) must let the next merge through.
    const fsDeps = memSlotFs();
    fsDeps.createExclusive(
      LOCK,
      JSON.stringify({ owner: 'TASK-CRASHED', pid: 424242, acquiredAt: '2020-01-01T00:00:00Z' })
    );
    const slot = new FileVerifySlot(LOCK, fsDeps, {
      now: () => new Date(),
      sleep: () => tick(),
      leaseMs: 60_000,
      pollIntervalMs: 1,
      pid: process.pid,
      isProcessAlive: () => true, // even with a "live" pid, the ancient lease is stale
    });
    const queue = memQueue();
    const trace: VerifyTrace = { events: [], peakConcurrency: 0 };
    const g = gate();
    g.open();
    const r = await requestMerge(
      makeDeps('TASK-A', slot, queue, trace, { 'TASK-A': g.promise }),
      'TASK-A'
    );
    expect(r.status).toBe('merged');
    expect(trace.events).toContain('TASK-A:verify:end');
  });
});
