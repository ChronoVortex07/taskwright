<script lang="ts">
  import type { Task, TaskIdDisplayMode } from '../../lib/types';
  import { vscode } from '../../stores/vscode.svelte';
  import {
    deriveGeometry,
    fitToView,
    zoomAt,
    clampViewport,
    lodTier,
    type Viewport,
    type GeometryNode,
  } from '../../lib/treeGeometry';
  import TreeNode from './TreeNode.svelte';
  import EdgeLayer from './EdgeLayer.svelte';
  import AgeBandHeader from './AgeBandHeader.svelte';
  import LaneBand from './LaneBand.svelte';
  import DetailPopover, { type PopoverActionKind } from './DetailPopover.svelte';
  import MilestonePopover from './MilestonePopover.svelte';
  import InFlightPanel from './InFlightPanel.svelte';

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
    onSelectTask: (taskId: string, meta?: Pick<Task, 'filePath' | 'source' | 'branch'>) => void;
    /** Open the unified create form (P3a: reportBug; P3b: drop-on-empty click-in-place). */
    onCreateInPlace?: (opts: {
      mode?: 'full' | 'quick';
      bugMode?: boolean;
      causedBy?: string;
      category?: string;
      milestone?: string;
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
    onSelectTask,
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
  const dimmedIds = $derived.by(() => {
    const set = new Set<string>();
    if (!navSearch.trim() && !navPriority) return set;
    for (const t of layoutNodes) if (!matchesFilter(t)) set.add(t.id);
    return set;
  });
  const fadedIds = $derived(new Set<string>([...dimmedIds, ...hiddenIds]));

  const draftNodes = $derived(
    layoutNodes.filter((t) => t.status === 'Draft' || t.folder === 'drafts')
  );
  function promoteAll() {
    for (const t of draftNodes) {
      vscode.postMessage({ type: 'promoteDraft', taskId: t.id });
    }
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

  // Jump to a band when the navigator asks (nonce lets the same band re-trigger).
  let lastJumpNonce = 0;
  $effect(() => {
    if (jumpNonce === lastJumpNonce) return;
    lastJumpNonce = jumpNonce;
    const b = geometry.bands.find((bnd) => bnd.name === jumpBand);
    if (b && viewportEl) {
      setViewport({ scale: vp.scale, tx: -b.x * vp.scale + 40, ty: vp.ty });
    }
  });

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

  // Pan by dragging empty canvas.
  let panning = $state(false);
  let panStart = { x: 0, y: 0, tx: 0, ty: 0 };
  function onPointerDown(e: PointerEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('.tree-toolbar') || target.closest('.tree-popover')) return;
    // Band headers live inside the viewport; capturing the pointer here would
    // swallow their native click (same reason `.tree-node` returns early), so
    // the milestone popover would never open. Let the header's onclick fire.
    if (target.closest('.tree-node') || target.closest('.tree-band-header')) return;
    closePopover();
    closeMilestone();
    panning = true;
    panStart = { x: e.clientX, y: e.clientY, tx: vp.tx, ty: vp.ty };
    viewportEl?.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent) {
    if (!panning) return;
    setViewport({
      scale: vp.scale,
      tx: panStart.tx + (e.clientX - panStart.x),
      ty: panStart.ty + (e.clientY - panStart.y),
    });
  }
  function onPointerUp(e: PointerEvent) {
    if (!panning) return;
    panning = false;
    viewportEl?.releasePointerCapture?.(e.pointerId);
    persistNow();
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    if (!viewportEl) return;
    if (e.ctrlKey || e.metaKey) {
      const rect = viewportEl.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015);
      setViewport(zoomAt(vp, e.clientX - rect.left, e.clientY - rect.top, factor));
    } else {
      setViewport({ scale: vp.scale, tx: vp.tx - e.deltaX, ty: vp.ty - e.deltaY });
    }
  }

  function zoomBy(factor: number) {
    if (!viewportEl) return;
    setViewport(zoomAt(vp, viewportEl.clientWidth / 2, viewportEl.clientHeight / 2, factor));
  }

  function onCanvasKeydown(e: KeyboardEvent) {
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
        onclick={() => zoomBy(1 / 1.2)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>
      </button>
      <span class="tree-zoom-label" data-testid="tree-zoom-label">{Math.round(vp.scale * 100)}%</span>
      <button
        class="tree-tool-btn"
        data-testid="tree-zoom-in"
        title="Zoom in"
        onclick={() => zoomBy(1.2)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
      </button>
      <button class="tree-tool-btn" data-testid="tree-zoom-fit" title="Fit to view" onclick={fit}>
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
      </button>
    </div>

    <InFlightPanel
      {tasks}
      onApprove={(id) => vscode.postMessage({ type: 'approveMerge', taskId: id })}
      onSendBack={(id) => vscode.postMessage({ type: 'sendBackMerge', taskId: id })}
    />

    {#if draftNodes.length > 0}
      <button class="tree-promote-all" data-testid="tree-promote-all" onclick={promoteAll}>
        Promote all proposed ({draftNodes.length})
      </button>
    {/if}

    <div
      class="tree-viewport"
      class:panning
      data-testid="tree-viewport"
      bind:this={viewportEl}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointerleave={onPointerUp}
      onwheel={onWheel}
      onkeydown={onCanvasKeydown}
      role="application"
      aria-label="Tech tree canvas"
    >
      <AgeBandHeader bands={geometry.bands} scale={vp.scale} tx={vp.tx} onOpenMilestone={openMilestone} />
      <LaneBand lanes={geometry.lanes} scale={vp.scale} ty={vp.ty} />

      <div
        class="tree-surface"
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
        />
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
  }
  .tree-viewport.panning {
    cursor: grabbing;
  }
  .tree-surface {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
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
