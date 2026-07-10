import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  EMPTY_QUEUE,
  enqueueEntry,
  headEntry,
  approveEntry,
  removeEntry,
  markEntryActive,
  positionOf,
  isHeadStale,
  recordVerifiedHead,
  mergeQueuePath,
  MergeQueueStore,
  nodeQueueFs,
  type QueueEntry,
  type MergeQueue,
  type QueueFsDeps,
} from '../../core/mergeQueue';

function entry(taskId: string, over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    taskId,
    branch: `${taskId.toLowerCase()}-x`,
    worktree: `.worktrees/${taskId.toLowerCase()}-x`,
    mode: 'manual-review',
    submittedAt: '2026-07-01T12:00:00.000Z',
    approved: false,
    active: false,
    activeAt: null,
    ...over,
  };
}

describe('pure queue transforms', () => {
  it('enqueues in FIFO order and is idempotent per taskId', () => {
    let q: MergeQueue = EMPTY_QUEUE;
    q = enqueueEntry(q, entry('TASK-1'));
    q = enqueueEntry(q, entry('TASK-2'));
    q = enqueueEntry(q, entry('TASK-1')); // duplicate → no-op
    expect(q.entries.map((e) => e.taskId)).toEqual(['TASK-1', 'TASK-2']);
    expect(headEntry(q)?.taskId).toBe('TASK-1');
  });

  it('does not mutate the input queue', () => {
    const q0 = EMPTY_QUEUE;
    enqueueEntry(q0, entry('TASK-1'));
    expect(q0.entries).toHaveLength(0);
  });

  it('approve, remove, markActive, position', () => {
    let q: MergeQueue = EMPTY_QUEUE;
    q = enqueueEntry(q, entry('TASK-1'));
    q = enqueueEntry(q, entry('TASK-2'));
    expect(positionOf(q, 'TASK-2')).toBe(2);
    expect(positionOf(q, 'TASK-9')).toBe(0);
    q = approveEntry(q, 'TASK-1');
    expect(q.entries[0].approved).toBe(true);
    q = markEntryActive(q, 'TASK-1', '2026-07-01T12:05:00.000Z');
    expect(q.entries[0].active).toBe(true);
    expect(q.entries[0].activeAt).toBe('2026-07-01T12:05:00.000Z');
    q = removeEntry(q, 'TASK-1');
    expect(q.entries.map((e) => e.taskId)).toEqual(['TASK-2']);
  });

  it('recordVerifiedHead stamps the sha on the matching entry only (TASK-88)', () => {
    let q: MergeQueue = EMPTY_QUEUE;
    q = enqueueEntry(q, entry('TASK-1'));
    q = enqueueEntry(q, entry('TASK-2'));
    q = recordVerifiedHead(q, 'TASK-2', 'sha-2');
    expect(q.entries.find((e) => e.taskId === 'TASK-2')?.verifiedHeadSha).toBe('sha-2');
    expect(q.entries.find((e) => e.taskId === 'TASK-1')?.verifiedHeadSha).toBeUndefined();
    // absent task ⇒ no-op, no throw
    expect(recordVerifiedHead(q, 'TASK-9', 'x').entries).toHaveLength(2);
  });

  it('verifiedHeadSha round-trips through the store (TASK-88)', () => {
    const files: Record<string, string> = {};
    const store = new MergeQueueStore('/q.json', memFs(files));
    store.mutate((q) => enqueueEntry(q, entry('TASK-1', { verifiedHeadSha: 'abc123' })));
    expect(store.read().entries[0].verifiedHeadSha).toBe('abc123');
  });

  it('isHeadStale is true only when the head is active beyond the timeout', () => {
    const now = new Date('2026-07-01T13:00:00.000Z');
    const idle = enqueueEntry(EMPTY_QUEUE, entry('TASK-1')); // not active
    expect(isHeadStale(idle, 30, now)).toBe(false);
    const fresh = markEntryActive(idle, 'TASK-1', '2026-07-01T12:45:00.000Z'); // 15m
    expect(isHeadStale(fresh, 30, now)).toBe(false);
    const stale = markEntryActive(idle, 'TASK-1', '2026-07-01T12:20:00.000Z'); // 40m
    expect(isHeadStale(stale, 30, now)).toBe(true);
    expect(isHeadStale(EMPTY_QUEUE, 30, now)).toBe(false);
  });
});

describe('mergeQueuePath', () => {
  it('nests under <commonDir>/taskwright/merge-queue.json', () => {
    expect(mergeQueuePath('/repo/.git').replace(/\\/g, '/')).toBe(
      '/repo/.git/taskwright/merge-queue.json'
    );
  });
});

describe('MergeQueueStore', () => {
  it('reads a missing file as the empty queue', () => {
    const store = new MergeQueueStore('/nope/merge-queue.json', memFs({}));
    expect(store.read()).toEqual(EMPTY_QUEUE);
  });

  it('reads a corrupt file as the empty queue', () => {
    const store = new MergeQueueStore('/q.json', memFs({ '/q.json': '{ not json' }));
    expect(store.read()).toEqual(EMPTY_QUEUE);
  });

  it('mutate does a read-modify-write and returns the new queue', () => {
    const files: Record<string, string> = {};
    const store = new MergeQueueStore('/q.json', memFs(files));
    const result = store.mutate((q) => enqueueEntry(q, entry('TASK-1')));
    expect(result.entries[0].taskId).toBe('TASK-1');
    expect(store.read().entries[0].taskId).toBe('TASK-1');
  });

  it('round-trips through the real node fs adapter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twq-'));
    const p = mergeQueuePath(dir);
    const store = new MergeQueueStore(p, nodeQueueFs);
    store.mutate((q) => enqueueEntry(q, entry('TASK-7')));
    expect(store.read().entries[0].taskId).toBe('TASK-7');
    expect(fs.existsSync(p)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('read() returns an independent object, not the shared EMPTY_QUEUE', () => {
    const store = new MergeQueueStore('/nope.json', {
      exists: () => false,
      read: () => '',
      writeAtomic: () => {},
    });
    const a = store.read();
    expect(a).not.toBe(EMPTY_QUEUE);
    a.entries.push(entry('X')); // must not throw and must not affect EMPTY_QUEUE
    expect(EMPTY_QUEUE.entries).toHaveLength(0);
  });

  it('EMPTY_QUEUE cannot be mutated', () => {
    expect(() => (EMPTY_QUEUE.entries as QueueEntry[]).push(entry('X'))).toThrow();
  });

  it('reads a file with an unexpected version as the empty queue', () => {
    const store = new MergeQueueStore(
      '/q.json',
      memFs({ '/q.json': JSON.stringify({ version: 2, entries: [entry('Z')] }) })
    );
    expect(store.read().entries).toHaveLength(0);
  });
});

function memFs(files: Record<string, string>): QueueFsDeps {
  return {
    exists: (p) => p in files,
    read: (p) => {
      if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[p];
    },
    writeAtomic: (p, data) => {
      files[p] = data;
    },
  };
}
