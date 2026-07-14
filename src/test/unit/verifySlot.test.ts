// src/test/unit/verifySlot.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  FileVerifySlot,
  verifySlotPath,
  verifySlotLeaseMs,
  parseSlotHolder,
  type VerifySlotFs,
  type VerifySlotHolder,
} from '../../core/verifySlot';

/**
 * In-memory VerifySlotFs whose `createExclusive` throws EEXIST when the path is
 * taken — the same atomicity contract `fs.writeFileSync(p, d, { flag: 'wx' })`
 * gives us on a real filesystem.
 */
function memSlotFs(files: Record<string, string> = {}): VerifySlotFs & {
  files: Record<string, string>;
} {
  return {
    files,
    exists: (p) => p in files,
    read: (p) => {
      if (!(p in files)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return files[p];
    },
    createExclusive: (p, data) => {
      if (p in files) throw Object.assign(new Error(`EEXIST: ${p}`), { code: 'EEXIST' });
      files[p] = data;
    },
    remove: (p) => {
      delete files[p];
    },
  };
}

const LOCK = '/common/taskwright/verify-slot.lock';

function slot(
  fsDeps: VerifySlotFs,
  over: Partial<ConstructorParameters<typeof FileVerifySlot>[2]> = {}
): FileVerifySlot {
  return new FileVerifySlot(LOCK, fsDeps, {
    now: () => new Date('2026-07-14T12:00:00.000Z'),
    sleep: async () => {},
    leaseMs: 60_000,
    pollIntervalMs: 1,
    pid: 1234,
    isProcessAlive: () => true,
    ...over,
  });
}

describe('verifySlotPath', () => {
  it('lives beside the merge queue, under the shared common dir', () => {
    expect(verifySlotPath('/repo/.git').replace(/\\/g, '/')).toBe(
      '/repo/.git/taskwright/verify-slot.lock'
    );
  });
});

describe('verifySlotLeaseMs', () => {
  it('covers the worst-case run of every verify command, plus grace', () => {
    // 3 commands × 10 min each = 30 min of worst case; the lease must not expire first.
    expect(verifySlotLeaseMs(600_000, 3)).toBeGreaterThanOrEqual(1_800_000);
  });

  it('never returns a zero/negative lease for a degenerate config', () => {
    expect(verifySlotLeaseMs(600_000, 0)).toBeGreaterThan(0);
  });
});

describe('parseSlotHolder', () => {
  it('parses a well-formed holder record', () => {
    const holder: VerifySlotHolder = {
      owner: 'TASK-7',
      pid: 42,
      acquiredAt: '2026-07-14T12:00:00.000Z',
    };
    expect(parseSlotHolder(JSON.stringify(holder))).toEqual(holder);
  });

  it('returns null for corrupt content (a torn write is a stealable slot)', () => {
    expect(parseSlotHolder('{not json')).toBeNull();
    expect(parseSlotHolder('')).toBeNull();
    expect(parseSlotHolder('null')).toBeNull();
  });
});

describe('FileVerifySlot.acquire', () => {
  it('acquires a free slot immediately and records the holder', async () => {
    const fsDeps = memSlotFs();
    const release = await slot(fsDeps).acquire('TASK-7');
    expect(parseSlotHolder(fsDeps.files[LOCK])).toMatchObject({ owner: 'TASK-7', pid: 1234 });
    await release();
    expect(fsDeps.exists(LOCK)).toBe(false);
  });

  it('serializes: a second acquire waits until the first releases', async () => {
    const fsDeps = memSlotFs();
    const order: string[] = [];
    // Injected sleep drains a queue of pending "ticks" so the test stays deterministic.
    let releaseFirst: (() => Promise<void>) | null = null;
    const sleep = async (): Promise<void> => {
      // The first time B is forced to wait, let A finish its work and release.
      if (releaseFirst) {
        const r = releaseFirst;
        releaseFirst = null;
        order.push('A releases');
        await r();
      }
    };
    const s = slot(fsDeps, { sleep });

    releaseFirst = await s.acquire('TASK-A');
    order.push('A holds');

    const bRelease = await s.acquire('TASK-B'); // must have waited for A
    order.push('B holds');
    await bRelease();

    expect(order).toEqual(['A holds', 'A releases', 'B holds']);
    expect(fsDeps.exists(LOCK)).toBe(false);
  });

  it('reports the waiting holder to onWait so callers can emit liveness', async () => {
    const fsDeps = memSlotFs();
    const waits: Array<{ heldBy: string }> = [];
    let release: (() => Promise<void>) | null = null;
    const s = slot(fsDeps, {
      sleep: async () => {
        if (release) {
          const r = release;
          release = null;
          await r();
        }
      },
    });
    release = await s.acquire('TASK-A');
    await (
      await s.acquire('TASK-B', (info) => waits.push(info))
    )();
    expect(waits.length).toBeGreaterThan(0);
    expect(waits[0].heldBy).toBe('TASK-A');
  });

  it('steals a slot whose lease has expired (a crashed holder cannot wedge verify)', async () => {
    const fsDeps = memSlotFs({
      [LOCK]: JSON.stringify({
        owner: 'TASK-CRASHED',
        pid: 999,
        acquiredAt: '2026-07-14T11:00:00.000Z', // 60 min ago, lease is 60s
      }),
    });
    const release = await slot(fsDeps).acquire('TASK-7');
    expect(parseSlotHolder(fsDeps.files[LOCK])).toMatchObject({ owner: 'TASK-7' });
    await release();
  });

  it('steals a slot whose holder process is gone, without waiting out the lease', async () => {
    const fsDeps = memSlotFs({
      [LOCK]: JSON.stringify({
        owner: 'TASK-CRASHED',
        pid: 999,
        acquiredAt: '2026-07-14T11:59:59.000Z', // 1s ago — lease is nowhere near expiry
      }),
    });
    const sleep = vi.fn(async () => {});
    const release = await slot(fsDeps, { sleep, isProcessAlive: (pid) => pid !== 999 }).acquire(
      'TASK-7'
    );
    expect(sleep).not.toHaveBeenCalled(); // stolen on the first pass, no polling
    expect(parseSlotHolder(fsDeps.files[LOCK])).toMatchObject({ owner: 'TASK-7' });
    await release();
  });

  it('steals a corrupt (torn-write) lock file rather than deadlocking on it', async () => {
    const fsDeps = memSlotFs({ [LOCK]: '{ half-writ' });
    const release = await slot(fsDeps).acquire('TASK-7');
    expect(parseSlotHolder(fsDeps.files[LOCK])).toMatchObject({ owner: 'TASK-7' });
    await release();
  });

  it('re-entrant acquire by the same live pid + owner does not deadlock against itself', async () => {
    // Two overlapping verifies for the SAME task in one process (pre-verify and
    // a re-verify can never overlap, but the lock must not be self-hostile).
    const fsDeps = memSlotFs();
    const s = slot(fsDeps);
    const first = await s.acquire('TASK-7');
    await first();
    const second = await s.acquire('TASK-7'); // free again — plain acquire
    expect(parseSlotHolder(fsDeps.files[LOCK])).toMatchObject({ owner: 'TASK-7' });
    await second();
  });

  it('release is idempotent and never removes a slot another holder now owns', async () => {
    const fsDeps = memSlotFs();
    const s = slot(fsDeps);
    const release = await s.acquire('TASK-A');
    await release();
    // B now legitimately holds the slot; A's (duplicate) release must not evict it.
    await s.acquire('TASK-B');
    await release();
    expect(parseSlotHolder(fsDeps.files[LOCK])).toMatchObject({ owner: 'TASK-B' });
  });

  it('release never throws when the lock file has already vanished', async () => {
    const fsDeps = memSlotFs();
    const release = await slot(fsDeps).acquire('TASK-7');
    fsDeps.remove(LOCK);
    await expect(release()).resolves.toBeUndefined();
  });

  it('loses the create race gracefully: an EEXIST on create re-enters the wait loop', async () => {
    const fsDeps = memSlotFs();
    let firstCall = true;
    const racing: VerifySlotFs = {
      ...fsDeps,
      createExclusive: (p, data) => {
        if (firstCall) {
          // Simulate another process winning the O_EXCL create between our
          // "is it free?" check and our own create.
          firstCall = false;
          fsDeps.files[p] = JSON.stringify({
            owner: 'TASK-OTHER',
            pid: 777,
            acquiredAt: '2026-07-14T12:00:00.000Z',
          });
          throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        }
        fsDeps.createExclusive(p, data);
      },
    };
    let waited = false;
    const s = new FileVerifySlot(LOCK, racing, {
      now: () => new Date('2026-07-14T12:00:00.000Z'),
      sleep: async () => {
        waited = true;
        fsDeps.remove(LOCK); // the racer finishes and releases
      },
      leaseMs: 60_000,
      pollIntervalMs: 1,
      pid: 1234,
      isProcessAlive: () => true,
    });
    const release = await s.acquire('TASK-7');
    expect(waited).toBe(true);
    expect(parseSlotHolder(fsDeps.files[LOCK])).toMatchObject({ owner: 'TASK-7' });
    await release();
  });
});
