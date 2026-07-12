import { describe, it, expect } from 'vitest';
import type { Task } from '../../core/types';
import {
  BUGS_LANE,
  MISC_LANE,
  BACKBURNER_BAND,
  laneOf,
  deriveTreeLayout,
  type DeriveLayoutOptions,
} from '../../core/treeLayout';

function task(partial: Partial<Task> & { id: string }): Task {
  return {
    title: partial.id,
    status: 'To Do',
    labels: [],
    assignee: [],
    dependencies: [],
    acceptanceCriteria: [],
    definitionOfDone: [],
    filePath: `/b/tasks/${partial.id}.md`,
    ...partial,
    id: partial.id,
  } as Task;
}

const opts = (over: Partial<DeriveLayoutOptions> = {}): DeriveLayoutOptions => ({
  categories: [],
  milestoneOrder: [],
  doneStatus: 'Done',
  priorities: ['high', 'medium', 'low'],
  ...over,
});

describe('laneOf', () => {
  it('bug -> Bugs; category -> that lane; absent -> Misc', () => {
    expect(laneOf({ type: 'bug', category: 'Backend' })).toBe(BUGS_LANE);
    expect(laneOf({ category: 'Backend' })).toBe('Backend');
    expect(laneOf({ category: '   ' })).toBe(MISC_LANE);
    expect(laneOf({})).toBe(MISC_LANE);
  });
});

describe('deriveTreeLayout — lanes and bands', () => {
  it('lane order: declared (config order), discovered (sorted), Misc, Bugs last', () => {
    const { laneOrder } = deriveTreeLayout(
      [
        task({ id: 'TASK-1', category: 'Zeta' }), // discovered
        task({ id: 'TASK-2', category: 'Alpha' }), // discovered
        task({ id: 'TASK-3' }), // Misc
        task({ id: 'TASK-4', type: 'bug' }), // Bugs
      ],
      opts({ categories: ['Platform', 'Backend'] })
    );
    expect(laneOrder).toEqual(['Platform', 'Backend', 'Alpha', 'Zeta', MISC_LANE, BUGS_LANE]);
  });

  it('band order follows config milestones, then unknown sorted, then Backburner; absent milestone -> Backburner', () => {
    const { layout, bandOrder } = deriveTreeLayout(
      [
        task({ id: 'TASK-1', milestone: 'v1.0' }),
        task({ id: 'TASK-2', milestone: 'v2.0' }),
        task({ id: 'TASK-3', milestone: 'Later' }), // unknown
        task({ id: 'TASK-4' }), // no milestone -> Backburner
      ],
      opts({ milestoneOrder: ['v1.0', 'v2.0'] })
    );
    expect(bandOrder).toEqual(['v1.0', 'v2.0', 'Later', BACKBURNER_BAND]);
    expect(layout.get('TASK-1')!.band).toBe('v1.0');
    expect(layout.get('TASK-3')!.band).toBe('Later');
    expect(layout.get('TASK-4')!.band).toBe(BACKBURNER_BAND);
  });

  // TASK-124. Backburner is a RESERVED band: it is appended last, for tasks with
  // no milestone. A task may nevertheless carry `milestone: Backburner`
  // explicitly, and the raw final push used to emit the band a SECOND time. The
  // webview keys the band {#each} by name, so the duplicate key made Svelte throw
  // `each_key_duplicate` and the entire tree canvas rendered nothing.
  it('emits Backburner exactly once, and last, when a task explicitly uses it', () => {
    const { layout, bandOrder } = deriveTreeLayout(
      [
        task({ id: 'TASK-1', milestone: 'v1.0' }),
        task({ id: 'TASK-2', milestone: BACKBURNER_BAND }), // explicit reserved band
        task({ id: 'TASK-3' }), // implicit -> Backburner
      ],
      opts({ milestoneOrder: ['v1.0'] })
    );
    expect(bandOrder.filter((b) => b === BACKBURNER_BAND)).toHaveLength(1);
    expect(bandOrder).toEqual(['v1.0', BACKBURNER_BAND]);
    expect(bandOrder[bandOrder.length - 1]).toBe(BACKBURNER_BAND);
    expect(layout.get('TASK-2')!.band).toBe(BACKBURNER_BAND);
    expect(layout.get('TASK-3')!.band).toBe(BACKBURNER_BAND);
    // Same band ⇒ same column: an explicit Backburner task must not land in a
    // phantom band of its own.
    expect(layout.get('TASK-2')!.depth).toBe(layout.get('TASK-3')!.depth);
  });

  it('does not duplicate Backburner when it is a declared milestone (any casing)', () => {
    const { bandOrder } = deriveTreeLayout([task({ id: 'TASK-1', milestone: 'backburner' })], {
      ...opts({ milestoneOrder: ['v1.0', 'BACKBURNER'] }),
    });
    expect(bandOrder.filter((b) => b.toLowerCase() === 'backburner')).toHaveLength(1);
    expect(bandOrder[bandOrder.length - 1]).toBe(BACKBURNER_BAND);
  });
});

describe('deriveTreeLayout — depth and cross-band warnings', () => {
  it('depth = longest same-band prerequisite chain', () => {
    const { layout } = deriveTreeLayout(
      [
        task({ id: 'TASK-1', category: 'Backend', milestone: 'v1.0' }),
        task({ id: 'TASK-2', category: 'Backend', milestone: 'v1.0', dependencies: ['TASK-1'] }),
        task({ id: 'TASK-3', category: 'Backend', milestone: 'v1.0', dependencies: ['TASK-2'] }),
      ],
      opts({ milestoneOrder: ['v1.0'] })
    );
    expect(layout.get('TASK-1')!.depth).toBe(0);
    expect(layout.get('TASK-2')!.depth).toBe(1);
    expect(layout.get('TASK-3')!.depth).toBe(2);
  });

  it('a dependency in a later band is a soft warning (not a depth contribution)', () => {
    const { layout, warnings } = deriveTreeLayout(
      [
        task({ id: 'TASK-1', category: 'Backend', milestone: 'v1.0' }),
        // TASK-1 depends on TASK-2 which is in the LATER band v2.0.
        task({
          id: 'TASK-1b',
          category: 'Backend',
          milestone: 'v1.0',
          dependencies: ['TASK-2'],
        }),
        task({ id: 'TASK-2', category: 'Backend', milestone: 'v2.0' }),
      ],
      opts({ milestoneOrder: ['v1.0', 'v2.0'] })
    );
    expect(layout.get('TASK-1b')!.depth).toBe(0); // cross-band dep does not add depth
    expect(warnings.some((w) => w.includes('TASK-1b') && w.includes('TASK-2'))).toBe(true);
  });
});

describe('deriveTreeLayout — sub-row packing (diamond)', () => {
  it('parallel branches get distinct sub-rows; a linear chain inherits its prereq row', () => {
    const { layout } = deriveTreeLayout(
      [
        task({ id: 'TASK-1', category: 'Backend', milestone: 'v1.0' }),
        task({ id: 'TASK-2', category: 'Backend', milestone: 'v1.0', dependencies: ['TASK-1'] }),
        task({ id: 'TASK-3', category: 'Backend', milestone: 'v1.0', dependencies: ['TASK-1'] }),
      ],
      opts({ milestoneOrder: ['v1.0'] })
    );
    // TASK-2 inherits TASK-1's row (0); TASK-3 (same depth as TASK-2) takes the next free row.
    expect(layout.get('TASK-1')!.subRow).toBe(0);
    const rows = [layout.get('TASK-2')!.subRow, layout.get('TASK-3')!.subRow].sort();
    expect(rows).toEqual([0, 1]);
  });
});

describe('deriveTreeLayout — in-cell tie-break honors config priorityRank', () => {
  it('same cell, no ordinals: higher config priority packs first even when id order disagrees', () => {
    const { layout } = deriveTreeLayout(
      [
        task({ id: 'TASK-A', category: 'Backend', milestone: 'v1.0', priority: 'low' }),
        task({ id: 'TASK-B', category: 'Backend', milestone: 'v1.0', priority: 'high' }),
      ],
      opts({ milestoneOrder: ['v1.0'] })
    );
    // id order alone would put TASK-A (low) first; §10 config priorityRank must win.
    expect(layout.get('TASK-B')!.subRow).toBe(0);
    expect(layout.get('TASK-A')!.subRow).toBe(1);
  });
});

describe('deriveTreeLayout — bug lane', () => {
  it('bugs are bandless, sorted by severity then open-before-done then recency', () => {
    const { layout } = deriveTreeLayout(
      [
        task({
          id: 'TASK-1',
          type: 'bug',
          priority: 'low',
          status: 'To Do',
          updatedAt: '2026-01-01 00:00',
        }),
        task({ id: 'TASK-2', type: 'bug', priority: 'high', status: 'Done' }),
        task({ id: 'TASK-3', type: 'bug', priority: 'high', status: 'To Do' }),
      ],
      opts()
    );
    // high+open (TASK-3) first, then high+done (TASK-2), then low (TASK-1).
    expect(layout.get('TASK-3')!.subRow).toBe(0);
    expect(layout.get('TASK-2')!.subRow).toBe(1);
    expect(layout.get('TASK-1')!.subRow).toBe(2);
    expect(layout.get('TASK-1')!.band).toBe('');
    expect(layout.get('TASK-1')!.lane).toBe(BUGS_LANE);
  });
});
