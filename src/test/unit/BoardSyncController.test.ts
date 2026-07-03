import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BoardSyncController } from '../../providers/BoardSyncController';
import type { SyncConfig } from '../../core/syncConfig';
import type { SyncTarget } from '../../core/boardSyncEngine';

/**
 * The controller is orchestration (F5 / visual-proof), but its poll must SURFACE
 * a materialize failure — the board.materialized freeze failed invisibly because
 * the catch skipped the status update and spammed an ext-host console.error every
 * ~20s. These tests drive `tick` through injected seams (no git / no real poll).
 */

const LOCAL: SyncConfig = { mode: 'local', ref: 'taskwright-board', remote: 'origin', pollSeconds: 20 };

interface Item {
  text: string;
  tooltip: string;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
}

function build(over: {
  refresh?: (t: SyncTarget) => Promise<{ changed: boolean }>;
  resolveConfig?: () => Promise<{ cfg: SyncConfig; commonDir: string } | undefined>;
} = {}) {
  const onBoardChanged = vi.fn();
  const controller = new BoardSyncController('/repo', onBoardChanged, {
    resolveConfig: over.resolveConfig ?? (async () => ({ cfg: LOCAL, commonDir: '/repo/.git' })),
    refresh: over.refresh ?? (async () => ({ changed: false })),
  });
  const statusItem = (controller as unknown as { statusItem: Item }).statusItem;
  const tick = () => (controller as unknown as { tick(): Promise<void> }).tick();
  return { controller, onBoardChanged, statusItem, tick };
}

describe('BoardSyncController poll surfacing', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('surfaces a materialize failure as a degraded status-bar item', async () => {
    const { statusItem, tick } = build({
      refresh: async () => {
        throw new Error("ENOENT: prune raced a sibling materialize");
      },
    });

    await tick();

    expect(statusItem.text).toContain('degraded');
    expect(statusItem.show).toHaveBeenCalled();
  });

  it('logs a persistent failure once, not on every poll (no ~20s spam)', async () => {
    const { tick } = build({
      refresh: async () => {
        throw new Error('boom');
      },
    });

    await tick();
    await tick();
    await tick();

    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the degraded status once a poll succeeds again (recovery)', async () => {
    let failing = true;
    const { statusItem, tick } = build({
      refresh: async () => {
        if (failing) throw new Error('down');
        return { changed: false };
      },
    });

    await tick(); // degraded
    expect(statusItem.text).toContain('degraded');

    failing = false;
    await tick(); // recovered
    expect(statusItem.text).not.toContain('degraded');
    expect(statusItem.text).toContain('Board: local');

    // A fresh failure after recovery logs again (the de-dup is per degraded run).
    failing = true;
    await tick();
    expect(errSpy).toHaveBeenCalledTimes(2);
  });

  it('shows a healthy status and does not degrade on a successful poll', async () => {
    const { statusItem, onBoardChanged, tick } = build({
      refresh: async () => ({ changed: true }),
    });

    await tick();

    expect(statusItem.text).toContain('Board: local');
    expect(statusItem.text).not.toContain('degraded');
    expect(onBoardChanged).toHaveBeenCalledTimes(1);
    expect(errSpy).not.toHaveBeenCalled();
  });
});
