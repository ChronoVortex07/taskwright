<script lang="ts">
  import { tick } from 'svelte';
  import type { Task, TaskIdDisplayMode } from '../../lib/types';
  import { vscode } from '../../stores/vscode.svelte';
  import {
    deriveGeometry,
    fitToView,
    zoomAt,
    clampViewport,
    lodTier,
    screenToWorld,
    cellAt,
    reslotTargets,
    DRAG_THRESHOLD,
    type Viewport,
    type GeometryNode,
    type Point,
  } from '../../lib/treeGeometry';
  import { wouldCreateCycle } from '../../../core/treeGate';
  import { calculateOrdinalsForDrop } from '../../../core/ordinalUtils';
  import DragLayer, { type DragState } from './DragLayer.svelte';
  import TreeNode from './TreeNode.svelte';
  import EdgeLayer from './EdgeLayer.svelte';
  import AgeBandHeader from './AgeBandHeader.svelte';
  import LaneBand from './LaneBand.svelte';
  import DetailPopover, { type PopoverActionKind } from './DetailPopover.svelte';
  import MilestonePopover from './MilestonePopover.svelte';
  import InFlightPanel from './InFlightPanel.svelte';
import ContextMenu from './ContextMenu.svelte';
  import TreeFindBar from './TreeFindBar.svelte';
  import { findMatches, cycleIndex } from '../../lib/treeFind';
  import { onCommandNonce } from '../../lib/commandNonce.svelte';

  interface Props {
    tasks: Task[];
    laneOrder: string[];
    bandOrder: string[];
    warnings: string[];
    statuses: string[];
    priorities: string[];
    taskIdDisplay: TaskIdDisplayMode;
    crossBranch?: boolean;
    milestoneData?: {
      milestone: string;
      total: number;
      done: number;
      lanes: Array<{ name: string; total: number; done: number }>;
      checklist: import('../../lib/types').ChecklistItem[];
    } | null;
    navSearch?: string;
    navPriority?: string;
    collapsedLanes?: string[];
    jumpBand?: string;
    jumpNonce?: number;
    jumpTaskId?: string;
    jumpTaskNonce?: number;
    minimapPanX?: number;
    minimapPanY?: number;
    minimapPanNonce?: number;
    /**
     * Host→canvas "open the find bar" command (same nonce convention as the navigator
     * jumps above): Tasks.svelte's window-level `/` + Ctrl/Cmd-F handler increments this,
     * and the $effect below calls openFind(). It exists because onCanvasKeydown is bound to
     * `.tree-viewport`, so a keydown whose target is a sibling of the viewport (a toolbar
     * button, the promote-all button, <body> after a popover ✕ removed the focused element)
     * never reaches the canvas handler.
     */
    findRequestNonce?: number;
    onSelectTask: (taskId: string, meta?: Pick<Task, 'filePath' | 'source' | 'branch'>) => void;
    /** Open the unified create form (P3a: reportBug; P3b: drop-on-empty click-in-place). */
    onCreateInPlace?: (opts: {
      mode?: 'full' | 'quick';
      bugMode?: boolean;
      causedBy?: string;
      category?: string;
      milestone?: string;
      /** P3b drop-on-empty pre-link (origin node + its handle direction). */
      linkTo?: { taskId: string; direction: 'needs' | 'unlocks' };
    }) => void;
  }
  let {
    tasks,
    laneOrder,
    bandOrder,
    warnings,
    statuses,
    priorities,
    taskIdDisplay,
    crossBranch = false,
    milestoneData = null,
    navSearch = '',
    navPriority = '',
    collapsedLanes = [],
    jumpBand = '',
    jumpNonce = 0,
    jumpTaskId = '',
    jumpTaskNonce = 0,
    minimapPanX = 0,
    minimapPanY = 0,
    minimapPanNonce = 0,
    findRequestNonce = 0,
    onSelectTask,
    onCreateInPlace,
  }: Props = $props();

  const layoutNodes = $derived(tasks.filter((t) => !!t.layout));
  const hasLayout = $derived(layoutNodes.length > 0 && laneOrder.length > 0);
  const geometryNodes = $derived<GeometryNode[]>(
    layoutNodes.map((t) => ({ id: t.id, layout: t.layout! }))
  );
  const geometry = $derived(deriveGeometry(geometryNodes, laneOrder, bandOrder));
  const doneStatus = $derived(statuses.length > 0 ? statuses[statuses.length - 1] : 'Done');

  let viewportEl: HTMLDivElement | undefined = $state();
  let vp = $state<Viewport>({ scale: 1, tx: 0, ty: 0 });
  let hoveredId = $state<string | null>(null);
  let selectedId = $state<string | null>(null);
  const lod = $derived(lodTier(vp.scale));

  let popoverTaskId = $state<string | null>(null);
  let popoverX = $state(0);
  let popoverY = $state(0);

  let contextMenu = $state<{ x: number; y: number; lane?: string; band?: string } | null>(null);
  const popoverTask = $derived(
    popoverTaskId ? layoutNodes.find((t) => t.id === popoverTaskId) : undefined
  );
  // Close the popover if its task vanished from the board (e.g. completed/archived).
  $effect(() => {
    if (popoverTaskId && !popoverTask) closePopover();
  });
  // Keep the popover glued to its node while panning/zooming.
  $effect(() => {
    if (popoverTaskId) {
      const a = anchorFor(popoverTaskId);
      popoverX = a.x;
      popoverY = a.y;
    }
  });

  const collapsedSet = $derived(new Set(collapsedLanes));
  function matchesFilter(t: Task): boolean {
    const s = navSearch.trim().toLowerCase();
    if (s && !`${t.id} ${t.title}`.toLowerCase().includes(s)) return false;
    if (navPriority && (t.priority ?? '') !== navPriority) return false;
    return true;
  }
  const hiddenIds = $derived.by(() => {
    const set = new Set<string>();
    if (collapsedSet.size === 0) return set;
    for (const t of layoutNodes) if (t.layout && collapsedSet.has(t.layout.lane)) set.add(t.id);
    return set;
  });
  /**
   * Ids dimmed by the navigator's own search/priority filter, independent of find. Kept
   * separate from `dimmedIds` below so find's candidate computation never depends on its
   * own output (folding find dimming into `dimmedIds` and then reading `dimmedIds` back
   * out of `findResults` would be a reactive cycle).
   */
  const navFilterDimmedIds = $derived.by(() => {
    const set = new Set<string>();
    if (!navSearch.trim() && !navPriority) return set;
    for (const t of layoutNodes) if (!matchesFilter(t)) set.add(t.id);
    return set;
  });
  const dimmedIds = $derived.by(() => {
    const set = new Set<string>(navFilterDimmedIds);
    // Find dim: with >=1 hit, every non-match fades back. A zero-result query dims
    // NOTHING — fading the whole board conveys nothing and just hides the map.
    if (findActive) {
      for (const t of layoutNodes) if (!findMatchIds.has(t.id)) set.add(t.id);
    }
    return set;
  });
  const fadedIds = $derived(new Set<string>([...dimmedIds, ...hiddenIds]));

  // --- Find (NOT filter). The navigator's navSearch filter is separate and untouched;
  // find composes with it — a node the filter dimmed is not a find candidate. Declared
  // here (below navFilterDimmedIds/hiddenIds/dimmedIds/fadedIds) so declaration order
  // matches dependency order: findResults reads only the two primitive dim sources
  // above it, never the composed dimmedIds/fadedIds — dimmedIds depends on find's
  // output, so a find→dimmedIds/fadedIds dependency would be a reactive cycle
  // (`derived_references_self`). Keep it that way.
  let findOpen = $state(false);
  let findQuery = $state('');
  let findIdx = $state(0);
  let findBar = $state<ReturnType<typeof TreeFindBar> | undefined>();

  /** The one candidate predicate for find: nodes the navigator filter left visible. */
  const findCandidates = $derived(
    layoutNodes.filter((t) => !navFilterDimmedIds.has(t.id) && !hiddenIds.has(t.id))
  );
  /** Match ids in spatial (reading) order. */
  const findResults = $derived.by(() => {
    if (!findOpen) return [] as string[];
    return findMatches(findCandidates, findQuery, geometry);
  });
  const findMatchIds = $derived(new Set(findResults));
  const findActive = $derived(findOpen && findResults.length > 0);
  /** Clamped so a shrinking result set (as the user types) can never leave findIdx past the end. */
  const currentFindIdx = $derived(
    findResults.length === 0 ? -1 : Math.min(findIdx, findResults.length - 1)
  );
  const currentFindId = $derived(currentFindIdx >= 0 ? findResults[currentFindIdx] : null);

  const draftNodes = $derived(
    layoutNodes.filter((t) => t.status === 'Draft' || t.folder === 'drafts')
  );
  // Promote-all stays find-agnostic (find is not filter, and must never gate a write):
  // it uses the navigator-filter dim/hidden sets directly, NOT fadedIds (which also
  // folds in find's non-matches). Do not re-point this at fadedIds.
  const promotableDrafts = $derived(
    draftNodes.filter((t) => !navFilterDimmedIds.has(t.id) && !hiddenIds.has(t.id))
  );
  function promoteAll() {
    vscode.postMessage({ type: 'promoteDrafts', taskIds: promotableDrafts.map((t) => t.id) });
  }

  // Q3: per-collapsed-lane summary (name + task counts) for the overlay strip. Uses the
  // existing geometry.lanes (y/height) — NO relayout; done = the last configured status.
  const laneSummaries = $derived.by(() => {
    if (collapsedSet.size === 0)
      return [] as Array<{ name: string; y: number; height: number; total: number; done: number }>;
    return geometry.lanes
      .filter((l) => collapsedSet.has(l.name))
      .map((l) => {
        const inLane = layoutNodes.filter((t) => t.layout?.lane === l.name);
        const done = inLane.filter(
          (t) => t.status === doneStatus || t.folder === 'completed' || t.folder === 'archive'
        ).length;
        return { name: l.name, y: l.y, height: l.height, total: inLane.length, done };
      });
  });

  // --- Host→canvas commands. ALL of them go through onCommandNonce (see
  // src/webview/lib/commandNonce.svelte.ts): it seeds its guard from the prop's MOUNT-TIME
  // value, so a nonce bumped during a PRIOR mount cannot replay the command when this canvas
  // is re-created on a tab switch. Never hand-roll a `let lastFooNonce = 0` guard here again —
  // that is the bug that shipped on the find bar in 1.8.0 (commit fb63630), and
  // src/test/unit/commandNonce.test.ts fails the build if one comes back.

  // Jump to a band when the navigator asks (nonce lets the same band re-trigger).
  onCommandNonce(
    () => jumpNonce,
    () => {
      const b = geometry.bands.find((bnd) => bnd.name === jumpBand);
      if (b && viewportEl) {
        setViewport({ scale: vp.scale, tx: -b.x * vp.scale + 40, ty: vp.ty });
      }
    }
  );

  /** Center the viewport on a node. Shared by the navigator jump and the find cycle. */
  function centerOn(taskId: string) {
    const box = geometry.nodes.get(taskId);
    if (!box || !viewportEl) return;
    setViewport({
      scale: vp.scale,
      tx: viewportEl.clientWidth / 2 - (box.x + box.width / 2) * vp.scale,
      ty: viewportEl.clientHeight / 2 - (box.y + box.height / 2) * vp.scale,
    });
  }

  // Jump to a specific task node when the navigator asks (nonce lets retrigger).
  onCommandNonce(
    () => jumpTaskNonce,
    () => centerOn(jumpTaskId)
  );

  // Minimap drag-to-pan: center the viewport on the normalized (x,y) world point.
  onCommandNonce(
    () => minimapPanNonce,
    () => {
      if (!viewportEl || geometry.width <= 0 || geometry.height <= 0) return;
      const worldX = minimapPanX * geometry.width;
      const worldY = minimapPanY * geometry.height;
      setViewport({
        scale: vp.scale,
        tx: viewportEl.clientWidth / 2 - worldX * vp.scale,
        ty: viewportEl.clientHeight / 2 - worldY * vp.scale,
      });
    }
  );

  // Host-requested find (`/` or Ctrl/Cmd-F handled at the window level in Tasks.svelte,
  // where the keystroke lands however the user last focused something — a toolbar button,
  // the promote-all button, <body>). Nonce lets a repeat request re-trigger.
  //
  // This is the nonce whose stale-replay bug shipped in 1.8.0 (fb63630): a `/` press followed
  // by Escape, a tab switch away and back, silently reopened the find bar and stole keyboard
  // focus. The mount-time seeding that fixed it now lives inside onCommandNonce and covers
  // every command prop above, so it cannot be reintroduced here by hand.
  //
  // REACTIVE GRAPH: this effect reads ONLY `findRequestNonce` (a prop) and writes `findOpen`.
  // It reads neither findResults/findMatchIds/dimmedIds nor any derived, so it adds no edge
  // to the find/dim derived graph — the "findResults may depend only on the primitive dim
  // sources" invariant documented above is untouched.
  onCommandNonce(
    () => findRequestNonce,
    () => void openFind()
  );

  // Feed the navigator minimap with the current normalized viewport rect (debounced).
  let minimapTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const w = geometry.width;
    const h = geometry.height;
    const s = vp.scale;
    const tx = vp.tx;
    const ty = vp.ty;
    if (!viewportEl || w <= 0 || h <= 0) return;
    const vw = viewportEl.clientWidth;
    const vh = viewportEl.clientHeight;
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    const rect = {
      x: clamp01(-tx / s / w),
      y: clamp01(-ty / s / h),
      w: clamp01(vw / s / w),
      h: clamp01(vh / s / h),
    };
    if (minimapTimer) clearTimeout(minimapTimer);
    minimapTimer = setTimeout(
      () => vscode.postMessage({ type: 'minimapViewport', ...rect }),
      100
    );
  });

  let milestoneBand = $state<string | null>(null);
  let milestoneX = $state(0);
  let milestoneY = $state(0);
  const openMilestoneData = $derived(
    milestoneBand && milestoneData && milestoneData.milestone === milestoneBand ? milestoneData : null
  );

  function openMilestone(band: string) {
    milestoneBand = band;
    const b = geometry.bands.find((bnd) => bnd.name === band);
    milestoneX = b ? Math.max(8, b.x * vp.scale + vp.tx) : 8;
    milestoneY = 28;
    vscode.postMessage({ type: 'requestMilestoneData', milestone: band });
  }
  function closeMilestone() {
    milestoneBand = null;
  }

  /**
   * Idempotent: opening an already-open bar just re-focuses (and selects) its input — it
   * never toggles. Both keyboard layers (the canvas's own onCanvasKeydown and the host's
   * window-level handler via findRequestNonce) route here, and a single keystroke can fire
   * both when focus is already inside the viewport; because this only ever sets `true`,
   * they cannot fight each other.
   */
  async function openFind() {
    findOpen = true;
    // The bar renders on the next flush; focus after it exists.
    await tick();
    findBar?.focus();
  }

  function closeFind() {
    findOpen = false;
    findQuery = '';
    findIdx = 0;
    viewportEl?.focus();
  }

  function onFindQueryChange(q: string) {
    findQuery = q;
    findIdx = 0;
    // Center the first hit as the user types, so a query lands you somewhere immediately.
    // findResults already reflects this query: Svelte 5 deriveds are lazy/pull-based,
    // so reading it here (after assigning findQuery above) yields the fresh value —
    // no separate recomputation of the candidate predicate needed (M1).
    const first = findResults[0];
    if (first) centerOn(first);
  }

  function stepFind(dir: 1 | -1) {
    if (findResults.length === 0) return;
    findIdx = cycleIndex(currentFindIdx, findResults.length, dir);
    const id = findResults[findIdx];
    // Center only — deliberately NOT handleSelect(): opening the popover posts
    // popoverActiveChanged, which would rewrite the ephemeral active task on every Enter.
    if (id) centerOn(id);
  }

  let restored = false;
  $effect(() => {
    if (restored || !hasLayout) return;
    restored = true;
    const saved = (vscode.getState() as { treeViewport?: Viewport } | undefined)?.treeViewport;
    if (saved && Number.isFinite(saved.scale)) {
      vp = saved;
    } else {
      fit();
    }
  });

  // Give the canvas keyboard focus once per mount, so arrow/j-k node navigation works
  // immediately on a "cold" Tree tab (opened but never clicked): onCanvasKeydown is attached
  // directly to `.tree-viewport`, not `window`, so it never receives a keydown whose target
  // is `<body>` (nothing has focused the viewport yet).
  //
  // NOTE: this is NOT what makes `/` and Ctrl/Cmd-F work. Those are guaranteed by the
  // window-level handler in Tasks.svelte, which bumps `findRequestNonce` → openFind() no
  // matter where focus is (a toolbar button, <body>, …). This effect is belt-and-braces for
  // find, and load-bearing only for the node-nav keys. The `focusedOnce`
  // flag keeps this from re-stealing focus on every re-render within a single mount — it is
  // NOT once-per-session: TechTreeCanvas renders inside `{:else if activeTab === 'tree'}` in
  // Tasks.svelte, so it unmounts/remounts on every tab switch and this flag resets each time.
  // Only claim focus if nothing else already wants it (e.g. the create-task form's title
  // input, which can autofocus on an empty board before a late/concurrent `tasksUpdated`
  // flips `hasLayout` and mounts `viewportEl`) — never steal focus out from under the user.
  let focusedOnce = false;
  $effect(() => {
    if (focusedOnce || !viewportEl) return;
    focusedOnce = true;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    viewportEl.focus({ preventScroll: true });
  });

  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  function persistNow() {
    const prev = (vscode.getState() as Record<string, unknown> | undefined) ?? {};
    vscode.setState({ ...prev, treeViewport: vp });
  }
  function persist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, 120);
  }

  function setViewport(next: Viewport) {
    if (viewportEl) {
      vp = clampViewport(
        next,
        geometry.width,
        geometry.height,
        viewportEl.clientWidth,
        viewportEl.clientHeight
      );
    } else {
      vp = next;
    }
    persist();
  }

  function fit() {
    requestAnimationFrame(() => {
      if (!viewportEl) return;
      vp = fitToView(
        geometry.width,
        geometry.height,
        viewportEl.clientWidth,
        viewportEl.clientHeight
      );
      persist();
    });
  }

  // P3b gesture machine. `pending` is the pre-threshold press; `drag` is the promoted gesture.
  type Pending =
    | { kind: 'pan'; startX: number; startY: number; tx: number; ty: number }
    | { kind: 'node'; id: string; startX: number; startY: number }
    | { kind: 'connect'; id: string; dir: 'needs' | 'unlocks'; startX: number; startY: number };
  let pending: Pending | null = null;
  let drag = $state<DragState | null>(null);

  const targets = $derived(reslotTargets(geometry, laneOrder, bandOrder));

  /** In-webview cycle/dupe/self gate for a candidate edge task[taskId].dependencies += dependsOn. */
  function connectValid(taskId: string, dependsOn: string): boolean {
    const a = taskId.trim().toUpperCase();
    const b = dependsOn.trim().toUpperCase();
    if (a === b) return false; // self
    const dep = layoutNodes.find((t) => t.id.trim().toUpperCase() === a);
    if (dep?.dependencies.some((d) => d.trim().toUpperCase() === b)) return false; // dupe
    return !wouldCreateCycle(layoutNodes, taskId, dependsOn);
  }

  /** World point under a client event, relative to the viewport. */
  function worldAt(e: PointerEvent): Point {
    const rect = viewportEl!.getBoundingClientRect();
    return screenToWorld(vp, e.clientX - rect.left, e.clientY - rect.top);
  }

  /** Node id under a world point (topmost box hit), else null. */
  function nodeAt(p: Point): string | null {
    for (const [id, box] of geometry.nodes) {
      if (p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height) {
        return id;
      }
    }
    return null;
  }

  // Pan by dragging empty canvas.
  let panning = $state(false);
  let panStart = { x: 0, y: 0, tx: 0, ty: 0 };

  /**
   * Gesture-scoped compositor hint (TASK-108).
   *
   * `will-change: transform` promotes `.tree-surface` to its own layer and tells
   * the compositor to expect the transform to keep animating — so Chromium
   * rasterizes the layer ONCE and scales that bitmap for later transforms rather
   * than re-rasterizing text at the new scale. Left on permanently, zooming in
   * magnifies a texture rendered at the old scale: blurry glyphs.
   *
   * So we only ask for the hint while a gesture is actually in flight (where it
   * genuinely buys smooth panning) and drop it the moment the viewport settles,
   * which is when the browser re-rasterizes the text crisply at the new scale.
   * A wheel has no "end" event, so it settles on a short idle timer.
   */
  const WHEEL_SETTLE_MS = 180;
  let wheeling = $state(false);
  let wheelSettleTimer: ReturnType<typeof setTimeout> | undefined;
  function markWheelGesture() {
    wheeling = true;
    if (wheelSettleTimer) clearTimeout(wheelSettleTimer);
    wheelSettleTimer = setTimeout(() => (wheeling = false), WHEEL_SETTLE_MS);
  }
  const gesturing = $derived(panning || wheeling);

  function onPointerDown(e: PointerEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('.tree-toolbar') || target.closest('.tree-popover')) return;
    // Without this guard a pointerdown on the find bar's input/buttons fell through to
    // case (c) below (empty viewport), which captured the pointer onto viewportEl and
    // silently swallowed the button's own click — the buttons rendered and looked
    // clickable but a real mouse click never reached their onclick handlers (found while
    // adding e2e coverage that actually clicks them, TASK-9 item 3).
    if (target.closest('.tree-find-bar')) return;
    if (target.closest('.tree-band-header')) return; // let the milestone popover open
    if (target.closest('.tree-edge-remove')) return; // edge ✕ handles its own click (Task 6)

    const handle = target.closest('.tree-connect-handle') as HTMLElement | null;
    if (handle) {
      // (a) connect-handle press — starts a connect gesture on threshold (Task 4 renders handles).
      e.stopPropagation();
      pending = {
        kind: 'connect',
        id: handle.dataset.connectId ?? '',
        dir: (handle.dataset.connectDir as 'needs' | 'unlocks') ?? 'unlocks',
        startX: e.clientX,
        startY: e.clientY,
      };
      viewportEl?.setPointerCapture(e.pointerId);
      return;
    }

    const node = target.closest('.tree-node') as HTMLElement | null;
    if (node) {
      // In-node interactive controls (e.g. the draft Promote button) handle their own
      // onclick + stopPropagation — capturing the pointer here would swallow their
      // native click and route the press to handleSelect instead (tree-promote
      // regression). Connect handles are spans, so this guard never catches them
      // (they returned above anyway).
      if (target.closest('button')) return;
      // (b) node-body press — select on click, reslot on drag.
      pending = { kind: 'node', id: node.dataset.nodeId ?? '', startX: e.clientX, startY: e.clientY };
      viewportEl?.setPointerCapture(e.pointerId);
      return;
    }

    // (c) empty viewport — pan on drag; a plain click only dismisses/focuses (Task 6).
    closePopover();
    closeMilestone();
    pending = { kind: 'pan', startX: e.clientX, startY: e.clientY, tx: vp.tx, ty: vp.ty };
    panStart = { x: e.clientX, y: e.clientY, tx: vp.tx, ty: vp.ty };
    viewportEl?.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!pending) return;
    const dist = Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY);

    if (pending.kind === 'pan') {
      if (!panning && dist < DRAG_THRESHOLD) return;
      panning = true;
      e.preventDefault(); // suppress native text-selection during pan
      setViewport({
        scale: vp.scale,
        tx: panStart.tx + (e.clientX - panStart.x),
        ty: panStart.ty + (e.clientY - panStart.y),
      });
      return;
    }

    if (dist < DRAG_THRESHOLD && !drag) return;
    const cursor = worldAt(e);

    if (pending.kind === 'node') {
      const overId = nodeAt(cursor);
      const t = layoutNodes.find((n) => n.id === pending!.id);
      // Bugs are reorder-only (M2): Task 5's reslotValid shows cross-lane red and its
      // onReslotDrop never posts reslotTask for a bug.
      const cell = cellAt(geometry, cursor.x, cursor.y);
      const laneT = laneTargetAt(cursor.y);
      const bandT = bandTargetAt(cursor.x);
      drag = {
        mode: 'reslot',
        taskId: pending.id,
        cursor,
        targetLane: laneT?.name ?? cell.lane,
        targetBand: bandT?.name ?? cell.band,
        valid: reslotValid(t, laneT?.name ?? cell.lane, bandT?.name ?? cell.band, overId),
      };
      dragLaneTarget = laneT ?? null;
      dragBandTarget = bandT ?? null;
      return;
    }

    if (pending.kind === 'connect') {
      const overId = nodeAt(cursor);
      const edge = connectEdge(pending.id, pending.dir, overId);
      drag = {
        mode: 'connect',
        fromId: pending.id,
        dir: pending.dir,
        cursor,
        targetId: overId && overId !== pending.id ? overId : null,
        valid: edge ? connectValid(edge.taskId, edge.dependsOn) : true, // empty target = create (valid)
      };
    }
  }

  function onPointerUp(e: PointerEvent) {
    const p = pending;
    pending = null;
    viewportEl?.releasePointerCapture?.(e.pointerId);
    if (!p) return;
    const wasDrag = !!drag || panning;

    if (p.kind === 'pan') {
      if (panning) {
        panning = false;
        persistNow();
      }
      // A plain left-click on empty canvas only dismisses/focuses — it deliberately does
      // NOT open the create form. Creating on click made it impossible to click the panel
      // to focus it without creating a task. Right-click (onContextMenu) is the create
      // path; it already infers lane/band from the click point via cellAt.
      else {
        closePopover();
        closeMilestone();
        contextMenu = null;
      }
      finishDrag();
      return;
    }

    if (p.kind === 'node') {
      if (!wasDrag) handleSelect(p.id); // click → open popover (replaces onclick)
      else onReslotDrop(); // Task 5 fills this
      finishDrag();
      return;
    }

    // connect
    if (wasDrag) onConnectDrop(); // Task 4 fills this
    finishDrag();
  }

  function onPointerLeave(e: PointerEvent) {
    // Abort any in-flight gesture when the pointer leaves the viewport.
    if (pending || drag) {
      if (panning) {
        panning = false;
        persistNow();
      }
      pending = null;
      finishDrag();
      viewportEl?.releasePointerCapture?.(e.pointerId);
    }
  }

  function finishDrag() {
    drag = null;
    dragLaneTarget = null;
    dragBandTarget = null;
  }

  // Reslot target strips highlighted under the cursor (band-expand visual, Task 5).
  let dragLaneTarget = $state<{ name: string; y: number; height: number } | null>(null);
  let dragBandTarget = $state<{ name: string; x: number; width: number } | null>(null);
  function laneTargetAt(worldY: number) {
    return targets.lanes.find((l) => worldY >= l.y && worldY < l.y + l.height) ?? null;
  }
  function bandTargetAt(worldX: number) {
    return targets.bands.find((b) => worldX >= b.x && worldX < b.x + b.width) ?? null;
  }

  // Filled by Task 4 (connect) / Task 5 (reslot). Stubs keep the bundle green now.
  /** Map a connect gesture (origin handle) + hovered target to an addDependency edge. */
  function connectEdge(
    fromId: string,
    dir: 'needs' | 'unlocks',
    overId: string | null
  ): { taskId: string; dependsOn: string } | null {
    if (!overId || overId === fromId) return null;
    // right/unlocks: origin unlocks target ⇒ target depends on origin.
    // left/needs:    origin needs target   ⇒ origin depends on target.
    return dir === 'unlocks'
      ? { taskId: overId, dependsOn: fromId }
      : { taskId: fromId, dependsOn: overId };
  }
  /**
   * Reslot validity (M2): bugs are reorder-only. A bug drop onto another LANE is
   * refused here (red). The band axis is enforced in onReslotDrop (bug ⇒ never
   * reslotTask) rather than by a literal band comparison: bugs have `band: ''` and
   * anchor under the FIRST populated band's x-range, so bandAtX always resolves some
   * band and a literal sameBand check would mark every bug drag invalid — forbidding
   * the in-lane ordinal reorder directive 9 requires.
   */
  function reslotValid(
    t: Task | undefined,
    lane: string | undefined,
    _band: string | undefined,
    _overId: string | null
  ): boolean {
    if (!t) return false;
    if (t.type === 'bug') {
      // A bug stays on the Bugs lane; only in-lane drops are valid (they reorder).
      return (lane ?? t.layout?.lane) === (t.layout?.lane ?? 'Bugs');
    }
    // Symmetric guard: a NON-bug must not enter the Bugs lane — it would write a
    // literal category:'Bugs' and re-home the task among bugs (branch review Minor 1).
    if (lane === 'Bugs') return false;
    return true;
  }
  function onReslotDrop() {
    if (!drag || drag.mode !== 'reslot') return;
    const t = layoutNodes.find((n) => n.id === drag!.taskId);
    if (!t || !t.layout) return;
    if (!drag.valid) return; // bug cross-lane etc. — refused (DragLayer showed red)

    // M2 (directive 9): bugs are reorder-only. NEVER post reslotTask for a bug — a
    // horizontal drag must not assign a milestone; any in-lane drop reorders ordinal.
    if (t.type === 'bug') {
      const updates = inCellReorder(t, drag.cursor.y);
      if (updates.length > 0) vscode.postMessage({ type: 'reorderTasks', updates });
      return;
    }

    const fromLane = t.layout.lane;
    const fromBand = t.layout.band || 'Backburner';
    const toLane = drag.targetLane ?? fromLane;
    const toBand = drag.targetBand ?? fromBand;
    const laneChanged = toLane !== fromLane;
    const bandChanged = toBand !== fromBand;

    if (!laneChanged && !bandChanged) {
      // Same cell → ordinal reorder among the cell's siblings (kanban path parity).
      const updates = inCellReorder(t, drag.cursor.y);
      if (updates.length > 0) vscode.postMessage({ type: 'reorderTasks', updates });
      return;
    }

    // Lane and/or band changed → reslot the changed field(s) only.
    const msg: { type: 'reslotTask'; taskId: string; category?: string; milestone?: string } = {
      type: 'reslotTask',
      taskId: t.id,
    };
    if (laneChanged) msg.category = toLane; // controller maps Misc → clearCategory
    if (bandChanged) msg.milestone = toBand; // controller maps Backburner → clear
    vscode.postMessage(msg);
  }

  /** In-cell ordinal reorder: order same-cell siblings, find the drop index by cursor Y. */
  function inCellReorder(dragged: Task, cursorWorldY: number) {
    const lane = dragged.layout!.lane;
    const band = dragged.layout!.band;
    const siblings = layoutNodes
      .filter((n) => n.layout?.lane === lane && (n.layout?.band || '') === (band || ''))
      .map((n) => ({ taskId: n.id, ordinal: n.ordinal, priority: n.priority }));
    if (siblings.length <= 1) return [];
    const sorted = sortSiblingsByBox(siblings);
    // Drop index = count of siblings whose row-center is above the cursor.
    let dropIndex = 0;
    for (const s of sorted) {
      const box = geometry.nodes.get(s.taskId);
      if (box && box.y + box.height / 2 < cursorWorldY && s.taskId !== dragged.id) dropIndex++;
    }
    return calculateOrdinalsForDrop(
      sorted,
      { taskId: dragged.id, ordinal: dragged.ordinal, priority: dragged.priority },
      dropIndex
    );
  }

  function sortSiblingsByBox(cards: Array<{ taskId: string; ordinal?: number; priority?: string }>) {
    return [...cards].sort((a, b) => {
      const ba = geometry.nodes.get(a.taskId);
      const bb = geometry.nodes.get(b.taskId);
      return (ba?.y ?? 0) - (bb?.y ?? 0);
    });
  }
  function onConnectDrop() {
    if (!drag || drag.mode !== 'connect') return;
    const overId = drag.targetId;
    if (overId) {
      const edge = connectEdge(drag.fromId, drag.dir, overId);
      if (edge && connectValid(edge.taskId, edge.dependsOn)) {
        vscode.postMessage({ type: 'addDependency', taskId: edge.taskId, dependsOn: edge.dependsOn });
      }
      return; // invalid target: no-op (DragLayer already showed red)
    }
    // Drop on empty canvas → create a new pre-linked node (reuses P3a createTask.linkTo).
    const cell = cellAt(geometry, drag.cursor.x, drag.cursor.y);
    onCreateInPlace?.({
      mode: 'full',
      category: cell.lane,
      milestone: cell.band,
      linkTo: { taskId: drag.fromId, direction: drag.dir },
    });
  }

  function onContextMenu(e: MouseEvent) {
    const target = e.target as HTMLElement;
    // The find bar is a text-entry overlay: bail BEFORE preventDefault() so a right-click in
    // its input keeps the NATIVE text-editing menu (copy/paste/undo) instead of being
    // swallowed and replaced by the canvas "create here" menu. Mirrors the `.tree-find-bar`
    // guard in onPointerDown.
    if (target.closest('.tree-find-bar')) return;
    e.preventDefault();
    // Otherwise only show the canvas menu on empty canvas — not on nodes, toolbars, headers.
    if (target.closest('.tree-node') || target.closest('.tree-toolbar') || target.closest('.tree-band-header')) {
      return;
    }
    closePopover();
    closeMilestone();
    if (!viewportEl) return;
    const rect = viewportEl.getBoundingClientRect();
    const world = screenToWorld(vp, e.clientX - rect.left, e.clientY - rect.top);
    const cell = cellAt(geometry, world.x, world.y);
    contextMenu = {
      x: e.clientX,
      y: e.clientY,
      lane: cell.lane,
      band: cell.band,
    };
  }

  /**
   * Classify a wheel event as a zoom or a pan gesture, disambiguating a MOUSE WHEEL
   * from a TRACKPAD two-finger scroll / pinch. All signals are standard browser behavior:
   *   - ctrlKey / metaKey: the browser sets ctrlKey on a trackpad PINCH (and on an
   *     explicit ctrl+scroll); metaKey covers the ⌘+scroll convention → ZOOM.
   *   - Trackpad two-finger PAN: pixel deltas (deltaMode === 0 / DOM_DELTA_PIXEL) that
   *     either carry a horizontal component (deltaX ≠ 0 — a mouse wheel almost never
   *     emits deltaX) OR arrive as fine, fractional / sub-notch deltas (momentum
   *     scrolling) → PAN.
   *   - Mouse wheel: line/page deltas (deltaMode !== 0) OR a coarse integer vertical-only
   *     pixel delta (deltaX 0, a full |deltaY| notch) → ZOOM (keeps the TASK-57 behavior).
   */
  function classifyWheel(e: WheelEvent): 'zoom' | 'pan' {
    if (e.ctrlKey || e.metaKey) return 'zoom';
    if (e.deltaMode === 0) {
      const dx = Math.abs(e.deltaX);
      const dy = Math.abs(e.deltaY);
      const fractional = !Number.isInteger(e.deltaX) || !Number.isInteger(e.deltaY);
      const smallGlide = dx === 0 && dy > 0 && dy < 40; // sub-notch vertical → trackpad
      if (dx > 0 || fractional || smallGlide) return 'pan';
    }
    return 'zoom';
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    if (!viewportEl) return;
    markWheelGesture();
    if (classifyWheel(e) === 'pan') {
      // Trackpad two-finger scroll → pan by the raw pixel deltas.
      setViewport({ scale: vp.scale, tx: vp.tx - e.deltaX, ty: vp.ty - e.deltaY });
    } else {
      // Pinch / ctrl+scroll / mouse wheel → zoom centered on the cursor.
      const rect = viewportEl.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015);
      setViewport(zoomAt(vp, e.clientX - rect.left, e.clientY - rect.top, factor));
    }
  }

  function zoomBy(factor: number) {
    if (!viewportEl) return;
    setViewport(zoomAt(vp, viewportEl.clientWidth / 2, viewportEl.clientHeight / 2, factor));
  }

  function onCanvasKeydown(e: KeyboardEvent) {
    // Bail out for keystrokes originating in a text-entry element (e.g. TreeFindBar's
    // input, which renders inside this container) — same convention as
    // Tasks.svelte's handleGlobalKeydown — so bare j/k/arrows/`/` node-nav bindings
    // below don't swallow the find box's own typing and caret movement.
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    ) {
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      openFind();
      return;
    }
    if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      openFind();
      return;
    }
    const key = e.key;
    if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'j', 'k'].includes(key)) return;
    const nodes = Array.from(viewportEl?.querySelectorAll<HTMLElement>('.tree-node') ?? []);
    if (nodes.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? nodes.indexOf(active) : -1;
    const forward = key === 'ArrowRight' || key === 'ArrowDown' || key === 'j';
    const next = idx < 0 ? 0 : (idx + (forward ? 1 : -1) + nodes.length) % nodes.length;
    e.preventDefault();
    nodes[next]?.focus();
  }

  function anchorFor(id: string): { x: number; y: number } {
    const box = geometry.nodes.get(id);
    if (!box || !viewportEl) return { x: 8, y: 8 };
    const POP_W = 300;
    const vw = viewportEl.clientWidth;
    let px = box.x * vp.scale + vp.tx + box.width * vp.scale + 8;
    if (px + POP_W > vw) px = Math.max(8, box.x * vp.scale + vp.tx - POP_W - 8);
    const py = Math.max(8, box.y * vp.scale + vp.ty);
    return { x: px, y: py };
  }

  function handleSelect(id: string) {
    selectedId = id;
    popoverTaskId = id;
    const a = anchorFor(id);
    popoverX = a.x;
    popoverY = a.y;
    vscode.postMessage({ type: 'popoverActiveChanged', taskId: id });
  }

  function closePopover() {
    if (popoverTaskId === null) return;
    popoverTaskId = null;
    vscode.postMessage({ type: 'popoverActiveChanged', taskId: null });
  }

  function closeContextMenu() {
    contextMenu = null;
  }

  function onPopoverAction(kind: PopoverActionKind, id: string) {
    switch (kind) {
      case 'claim':
        vscode.postMessage({ type: 'claimTask', taskId: id });
        break;
      case 'dispatch':
        vscode.postMessage({ type: 'dispatchTask', taskId: id });
        break;
      case 'forceClaim':
        vscode.postMessage({ type: 'forceClaimTask', taskId: id });
        break;
      case 'release':
        vscode.postMessage({ type: 'releaseTask', taskId: id });
        break;
      case 'cancelDispatch':
        vscode.postMessage({ type: 'cancelDispatch', taskId: id });
        break;
      case 'approve':
        vscode.postMessage({ type: 'approveMerge', taskId: id });
        break;
      case 'sendBack':
        vscode.postMessage({ type: 'sendBackMerge', taskId: id });
        break;
      case 'reportBug':
        closePopover();
        onCreateInPlace?.({ bugMode: true, causedBy: id });
        break;
      case 'markDone':
        vscode.postMessage({ type: 'updateTask', taskId: id, updates: { status: doneStatus } });
        break;
    }
  }

  function onPopoverExpand(id: string) {
    const t = layoutNodes.find((n) => n.id === id);
    onSelectTask(id, t ? { filePath: t.filePath, source: t.source, branch: t.branch } : undefined);
  }
</script>

{#if !hasLayout}
  <div class="tree-empty-state" data-testid="tree-empty-state">
    {#if crossBranch}
      <p class="tree-empty-title">The tech tree isn't available in cross-branch mode.</p>
      <p class="tree-empty-hint">
        The tree needs local task layout, which isn't computed when the board is scanning other
        branches. Switch to the Kanban or List tab, or turn off cross-branch mode.
      </p>
    {:else}
      <p class="tree-empty-title">No tasks to plot yet.</p>
      <p class="tree-empty-hint">
        Create a task and it will appear here as a node, positioned by its category, milestone, and
        dependencies.
      </p>
    {/if}
  </div>
{:else}
  <div class="tree-canvas" data-testid="tree-canvas">
    <div class="tree-toolbar" data-testid="tree-toolbar">
      <button
        class="tree-tool-btn"
        data-testid="tree-zoom-out"
        title="Zoom out"
        aria-label="Zoom out"
        onclick={() => zoomBy(1 / 1.2)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>
      </button>
      <span class="tree-zoom-label" data-testid="tree-zoom-label">{Math.round(vp.scale * 100)}%</span>
      <button
        class="tree-tool-btn"
        data-testid="tree-zoom-in"
        title="Zoom in"
        aria-label="Zoom in"
        onclick={() => zoomBy(1.2)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
      </button>
      <button
        class="tree-tool-btn"
        data-testid="tree-zoom-fit"
        title="Fit to view"
        aria-label="Fit to view"
        onclick={fit}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
      </button>
    </div>

    <InFlightPanel
      {tasks}
      onApprove={(id) => vscode.postMessage({ type: 'approveMerge', taskId: id })}
      onSendBack={(id) => vscode.postMessage({ type: 'sendBackMerge', taskId: id })}
    />

    {#if promotableDrafts.length > 0}
      <button class="tree-promote-all" data-testid="tree-promote-all" onclick={promoteAll}>
        Promote all proposed ({promotableDrafts.length})
      </button>
    {/if}

    <!--
      The pan/zoom canvas is legitimately an interactive `role="application"`
      region: it captures pointer gestures (pan, drag-to-connect/reslot) and
      relays keyboard node navigation (arrows/j/k in onCanvasKeydown) — keydown
      bubbles up from the focusable `.tree-node` children (each tabindex=0), so
      the region itself is intentionally not a tab stop. Svelte's aria-query
      classifies `application` as non-interactive and flags the pointer/key
      listeners; the role is intentional here.

      tabindex="-1" below keeps it OUT of the tab order (still not a tab stop —
      the comment above still holds) but makes it programmatically focusable, so
      closeFind()'s viewportEl?.focus() actually lands focus somewhere that keeps
      the canvas's own key bindings (/, Ctrl-F, j/k, arrows) alive after the find
      bar closes, instead of falling through to <body>.
    -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="tree-viewport"
      class:panning
      data-testid="tree-viewport"
      tabindex="-1"
      bind:this={viewportEl}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointerleave={onPointerLeave}
      onpointercancel={onPointerLeave}
      onwheel={onWheel}
      onkeydown={onCanvasKeydown}
      oncontextmenu={onContextMenu}
      role="application"
      aria-label="Tech tree canvas"
    >
      {#if findOpen}
        <TreeFindBar
          bind:this={findBar}
          query={findQuery}
          matchCount={findResults.length}
          currentIndex={currentFindIdx}
          onQueryChange={onFindQueryChange}
          onNext={() => stepFind(1)}
          onPrev={() => stepFind(-1)}
          onClose={closeFind}
        />
      {/if}
      <AgeBandHeader
        bands={geometry.bands}
        scale={vp.scale}
        tx={vp.tx}
        onOpenMilestone={openMilestone}
        emphasis={drag?.mode === 'reslot' ? (dragBandTarget?.name ?? null) : null}
      />
      <LaneBand
        lanes={geometry.lanes}
        scale={vp.scale}
        ty={vp.ty}
        emphasis={drag?.mode === 'reslot' ? (dragLaneTarget?.name ?? null) : null}
      />

      <div
        class="tree-surface"
        class:gesturing
        data-testid="tree-surface"
        style="width:{geometry.width}px; height:{geometry.height}px; transform: translate({vp.tx}px, {vp.ty}px) scale({vp.scale});"
      >
        <EdgeLayer
          nodes={geometry.nodes}
          tasks={layoutNodes}
          {doneStatus}
          {hoveredId}
          {selectedId}
          {fadedIds}
          width={geometry.width}
          height={geometry.height}
          onRemoveDependency={(dependentId, prereqId) =>
            vscode.postMessage({ type: 'removeDependency', taskId: dependentId, dependsOn: prereqId })}
        />
        {#if drag}
          <DragLayer
            {drag}
            nodes={geometry.nodes}
            laneTarget={dragLaneTarget}
            bandTarget={dragBandTarget}
            width={geometry.width}
            height={geometry.height}
          />
        {/if}
        {#each layoutNodes as task (task.id)}
          {@const box = geometry.nodes.get(task.id)}
          {#if box}
            <TreeNode
              {task}
              x={box.x}
              y={box.y}
              w={box.width}
              h={box.height}
              {lod}
              {statuses}
              {taskIdDisplay}
              selected={selectedId === task.id}
              hovered={hoveredId === task.id}
              dimmed={dimmedIds.has(task.id)}
              hidden={hiddenIds.has(task.id)}
              matched={findMatchIds.has(task.id)}
              currentMatch={currentFindId === task.id}
              onSelect={handleSelect}
              onHover={(id) => (hoveredId = id)}
              onPromote={(pid) => vscode.postMessage({ type: 'promoteDraft', taskId: pid })}
            />
          {/if}
        {/each}

        {#each laneSummaries as ls (ls.name)}
          <div
            class="tree-lane-collapsed"
            data-testid="tree-lane-collapsed-{ls.name}"
            style="top:{ls.y}px; left:0; width:{geometry.width}px; height:{ls.height}px;"
          >
            <span class="tree-lane-collapsed-label">{ls.name} · {ls.total} tasks · {ls.done} done</span>
          </div>
        {/each}
      </div>
    </div>

    {#if popoverTask}
      <DetailPopover
        task={popoverTask}
        {statuses}
        {priorities}
        {taskIdDisplay}
        x={popoverX}
        y={popoverY}
        onClose={closePopover}
        onExpand={onPopoverExpand}
        onQuickEdit={(u) => vscode.postMessage({ type: 'updateTask', taskId: popoverTask.id, updates: u })}
        onAction={onPopoverAction}
        onRemovePrereq={(taskId, dependsOn) =>
          vscode.postMessage({ type: 'removeDependency', taskId, dependsOn })}
      />
    {/if}

    {#if openMilestoneData}
      <MilestonePopover
        milestone={openMilestoneData.milestone}
        total={openMilestoneData.total}
        done={openMilestoneData.done}
        lanes={openMilestoneData.lanes}
        checklist={openMilestoneData.checklist}
        x={milestoneX}
        y={milestoneY}
        onClose={closeMilestone}
        onToggle={(itemId) =>
          vscode.postMessage({ type: 'toggleReleaseChecklistItem', milestone: openMilestoneData.milestone, itemId })}
      />
    {/if}

    {#if contextMenu}
      <ContextMenu
        x={contextMenu.x}
        y={contextMenu.y}
        lane={contextMenu.lane}
        band={contextMenu.band}
        onClose={closeContextMenu}
        onCreateHere={(opts) => {
          onCreateInPlace?.({ mode: 'full', category: opts.category, milestone: opts.milestone });
        }}
      />
    {/if}

    {#if warnings.length > 0}
      <div class="tree-warnings" data-testid="tree-warnings" title={warnings.join('\n')}>
        {warnings.length} layout warning{warnings.length === 1 ? '' : 's'}
      </div>
    {/if}
  </div>
{/if}

<style>
  .tree-canvas {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 400px;
    overflow: hidden;
  }
  .tree-viewport {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: var(--vscode-editor-background);
    cursor: grab;
    touch-action: none;
    user-select: none;
  }
  .tree-viewport.panning {
    cursor: grabbing;
  }
  .tree-surface {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
  }
  /* Only while the transform is genuinely animating. A standing `will-change`
     here keeps the surface on a cached raster, so a zoom scales the old bitmap
     and the node text comes out blurry (TASK-108). */
  .tree-surface.gesturing {
    will-change: transform;
  }
  .tree-lane-collapsed {
    position: absolute;
    z-index: 6;
    display: flex;
    align-items: center;
    padding: 0 12px;
    box-sizing: border-box;
    border-top: 1px solid var(--vscode-panel-border, transparent);
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-foreground));
  }
  .tree-lane-collapsed-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    white-space: nowrap;
  }
  .tree-toolbar {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444));
    border-radius: 6px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  .tree-tool-btn {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    border-radius: 4px;
    color: var(--vscode-foreground);
    opacity: 0.8;
  }
  .tree-tool-btn:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  }
  .tree-zoom-label {
    min-width: 40px;
    text-align: center;
    font-size: 11px;
    color: var(--vscode-foreground);
  }
  .tree-warnings {
    position: absolute;
    bottom: 8px;
    right: 8px;
    z-index: 20;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    background: var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.2));
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
  }
  .tree-promote-all {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 20;
    cursor: pointer;
    font-size: 12px;
    padding: 4px 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 6px;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
  }
  .tree-promote-all:hover {
    background: var(--vscode-button-hoverBackground, #1177bb);
  }
  .tree-empty-state {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 240px;
    padding: 24px;
    text-align: center;
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
  }
  .tree-empty-title {
    font-weight: 600;
  }
  .tree-empty-hint {
    max-width: 420px;
    opacity: 0.8;
    font-size: 12px;
  }
</style>
