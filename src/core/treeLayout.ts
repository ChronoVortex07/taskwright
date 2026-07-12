import type { Task } from './types';
import { compareByOrdinal } from './ordinalUtils';
import { comparePriority, priorityRank } from './priorityOrder';

/** Reserved lane for all `type: bug` nodes. */
export const BUGS_LANE = 'Bugs';
/** Default lane for uncategorized non-bug tasks. */
export const MISC_LANE = 'Misc';
/** Virtual rightmost band for tasks with no milestone. */
export const BACKBURNER_BAND = 'Backburner';

export interface TreeLayout {
  lane: string;
  band: string;
  depth: number;
  subRow: number;
}

export interface DeriveLayoutOptions {
  /** Declared lane vocabulary (config order + discovered), e.g. from parser.getCategories(). */
  categories: string[];
  /** Milestone band order (config order); unknown-but-set milestones append sorted; absent -> Backburner. */
  milestoneOrder: string[];
  doneStatus: string;
  priorities: string[];
}

export interface DeriveLayoutResult {
  layout: Map<string, TreeLayout>;
  warnings: string[];
  laneOrder: string[];
  bandOrder: string[];
}

/** `type: bug` ⇒ Bugs; else non-empty `category` ⇒ that lane; else Misc. */
export function laneOf(task: Pick<Task, 'type' | 'category'>): string {
  if (task.type === 'bug') return BUGS_LANE;
  const c = task.category?.trim();
  return c ? c : MISC_LANE;
}

function isDone(task: Task, doneStatus: string): boolean {
  return task.status === doneStatus || task.folder === 'completed' || task.folder === 'archive';
}

export function deriveTreeLayout(tasks: Task[], opts: DeriveLayoutOptions): DeriveLayoutResult {
  const warnings: string[] = [];
  const byId = new Map<string, Task>(tasks.map((t) => [t.id.trim().toUpperCase(), t]));

  // --- Band order: declared milestones, then discovered (sorted), then Backburner ---
  // Backburner is RESERVED: it is the home of every milestone-less task and must
  // appear exactly once, LAST (backburnerIdx below is bandOrder.length - 1). A
  // task may still carry `milestone: Backburner` explicitly, and a config may
  // declare it — so it is marked seen up front, which keeps it out of the
  // declared/discovered sets. Without that, it was appended a second time, and
  // because the webview keys the band {#each} by name a duplicate name is a
  // duplicate key: Svelte throws `each_key_duplicate` and the whole tree canvas
  // renders nothing (TASK-124).
  const bandOrder: string[] = [];
  const seenBand = new Set<string>([BACKBURNER_BAND.toLowerCase()]);
  const pushBand = (value: string) => {
    const v = value.trim();
    if (v && !seenBand.has(v.toLowerCase())) {
      seenBand.add(v.toLowerCase());
      bandOrder.push(v);
    }
  };
  for (const m of opts.milestoneOrder) pushBand(m);
  const discoveredBands: string[] = [];
  for (const t of tasks) {
    if (t.type === 'bug') continue;
    const m = t.milestone?.trim();
    if (m && !seenBand.has(m.toLowerCase())) {
      seenBand.add(m.toLowerCase());
      discoveredBands.push(m);
    }
  }
  discoveredBands.sort((a, b) => a.localeCompare(b));
  for (const m of discoveredBands) bandOrder.push(m);
  bandOrder.push(BACKBURNER_BAND);
  const bandIndex = new Map<string, number>();
  bandOrder.forEach((b, i) => bandIndex.set(b.toLowerCase(), i));
  const backburnerIdx = bandOrder.length - 1;

  const bandOf = (t: Task): string => {
    const m = t.milestone?.trim();
    if (!m) return BACKBURNER_BAND;
    const idx = bandIndex.get(m.toLowerCase());
    return idx === undefined ? BACKBURNER_BAND : bandOrder[idx];
  };
  const bandIdxOf = (t: Task): number => bandIndex.get(bandOf(t).toLowerCase()) ?? backburnerIdx;

  // --- Lane order: declared (config order), discovered (sorted), Misc, Bugs last ---
  const laneOrder: string[] = [];
  const seenLane = new Set<string>();
  const pushLane = (value: string) => {
    const v = value.trim();
    if (v && v !== MISC_LANE && v !== BUGS_LANE && !seenLane.has(v.toLowerCase())) {
      seenLane.add(v.toLowerCase());
      laneOrder.push(v);
    }
  };
  for (const c of opts.categories) pushLane(c);
  const discoveredLanes: string[] = [];
  for (const t of tasks) {
    if (t.type === 'bug') continue;
    const lane = laneOf(t);
    if (lane !== MISC_LANE && !seenLane.has(lane.toLowerCase())) {
      seenLane.add(lane.toLowerCase());
      discoveredLanes.push(lane);
    }
  }
  discoveredLanes.sort((a, b) => a.localeCompare(b));
  for (const lane of discoveredLanes) laneOrder.push(lane);
  laneOrder.push(MISC_LANE, BUGS_LANE);

  const layout = new Map<string, TreeLayout>();

  // --- Bug lane (bandless): severity -> open-before-done -> recency desc -> id ---
  const bugs = tasks.filter((t) => t.type === 'bug');
  bugs.sort((a, b) => {
    const pr =
      priorityRank(a.priority, opts.priorities) - priorityRank(b.priority, opts.priorities);
    if (pr !== 0) return pr;
    const ad = isDone(a, opts.doneStatus) ? 1 : 0;
    const bd = isDone(b, opts.doneStatus) ? 1 : 0;
    if (ad !== bd) return ad - bd; // open (0) before done (1)
    const at = a.updatedAt ?? a.createdAt ?? '';
    const bt = b.updatedAt ?? b.createdAt ?? '';
    if (at !== bt) return bt.localeCompare(at); // recency descending
    return a.id.localeCompare(b.id);
  });
  bugs.forEach((bug, i) => layout.set(bug.id, { lane: BUGS_LANE, band: '', depth: 0, subRow: i }));

  // --- Depth: longest chain of same-band prerequisites (memoized) ---
  const depthMemo = new Map<string, number>();
  const inProgress = new Set<string>();
  const depthOf = (t: Task): number => {
    const key = t.id.trim().toUpperCase();
    const cached = depthMemo.get(key);
    if (cached !== undefined) return cached;
    if (inProgress.has(key)) return 0; // cycle guard (deps are cycle-free by invariant)
    inProgress.add(key);
    let best = 0;
    const myBand = bandOf(t);
    const myBandIdx = bandIdxOf(t);
    for (const rawDep of t.dependencies) {
      const dep = byId.get(rawDep.trim().toUpperCase());
      if (!dep || dep.type === 'bug') continue;
      if (bandOf(dep) === myBand) {
        best = Math.max(best, depthOf(dep) + 1);
      } else if (bandIdxOf(dep) > myBandIdx) {
        warnings.push(`${t.id} depends on ${dep.id} in a later band`);
      }
    }
    inProgress.delete(key);
    depthMemo.set(key, best);
    return best;
  };

  // --- Sub-row packing per lane ---
  const nonBugs = tasks.filter((t) => t.type !== 'bug');
  const laneGroups = new Map<string, Task[]>();
  for (const t of nonBugs) {
    const lane = laneOf(t);
    const group = laneGroups.get(lane);
    if (group) group.push(t);
    else laneGroups.set(lane, [t]);
  }

  for (const [lane, laneTasks] of laneGroups) {
    // Process prerequisites first: band index, then depth, then ordinal,
    // then config priority (§10 priorityRank), then id.
    const ordered = [...laneTasks].sort((a, b) => {
      const bi = bandIdxOf(a) - bandIdxOf(b);
      if (bi !== 0) return bi;
      const di = depthOf(a) - depthOf(b);
      if (di !== 0) return di;
      // Ordinal dimension only: identical taskIds neutralize compareByOrdinal's
      // embedded fixed-priority/id tiebreaks so §10 config priority below governs.
      const byOrd = compareByOrdinal(
        { taskId: '', ordinal: a.ordinal },
        { taskId: '', ordinal: b.ordinal }
      );
      if (byOrd !== 0) return byOrd;
      const byPri = comparePriority(a.priority, b.priority, opts.priorities);
      if (byPri !== 0) return byPri;
      return a.id.localeCompare(b.id);
    });

    const occupied = new Set<string>(); // `${band}|${depth}|${subRow}`
    const cell = (band: string, depth: number, sub: number) => `${band}|${depth}|${sub}`;

    for (const t of ordered) {
      const band = bandOf(t);
      const depth = depthOf(t);
      const prereqs = t.dependencies
        .map((d) => byId.get(d.trim().toUpperCase()))
        .filter(
          (d): d is Task =>
            !!d && d.type !== 'bug' && laneOf(d) === lane && bandOf(d) === band && layout.has(d.id)
        )
        .sort((a, b) => {
          const di = depthOf(a) - depthOf(b);
          return di !== 0 ? di : a.id.localeCompare(b.id);
        });

      const inherited = prereqs.length > 0 ? layout.get(prereqs[0].id)!.subRow : undefined;
      let sub = 0;
      if (inherited !== undefined && !occupied.has(cell(band, depth, inherited))) {
        sub = inherited;
      } else {
        while (occupied.has(cell(band, depth, sub))) sub++;
      }
      occupied.add(cell(band, depth, sub));
      layout.set(t.id, { lane, band, depth, subRow: sub });
    }
  }

  return { layout, warnings, laneOrder, bandOrder };
}
