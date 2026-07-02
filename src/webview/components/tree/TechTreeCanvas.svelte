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

  interface Props {
    tasks: Task[];
    laneOrder: string[];
    bandOrder: string[];
    warnings: string[];
    statuses: string[];
    taskIdDisplay: TaskIdDisplayMode;
    onSelectTask: (taskId: string, meta?: Pick<Task, 'filePath' | 'source' | 'branch'>) => void;
  }
  let { tasks, laneOrder, bandOrder, warnings, statuses, taskIdDisplay, onSelectTask }: Props =
    $props();

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

  function persist() {
    const prev = (vscode.getState() as Record<string, unknown> | undefined) ?? {};
    vscode.setState({ ...prev, treeViewport: vp });
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
    if (target.closest('.tree-node') || target.closest('.tree-toolbar')) return;
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

  function handleSelect(id: string, meta?: Pick<Task, 'filePath' | 'source' | 'branch'>) {
    selectedId = id;
    onSelectTask(id, meta);
  }
</script>

{#if !hasLayout}
  <div class="tree-empty-state" data-testid="tree-empty-state">
    <p class="tree-empty-title">The tech tree isn't available for this view.</p>
    <p class="tree-empty-hint">
      The tree needs local task layout data, which isn't computed in cross-branch mode. Switch to
      the Kanban or List tab, or turn off cross-branch mode.
    </p>
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
      role="application"
      aria-label="Tech tree canvas"
    >
      <AgeBandHeader bands={geometry.bands} scale={vp.scale} tx={vp.tx} />
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
              onSelect={handleSelect}
              onHover={(id) => (hoveredId = id)}
            />
          {/if}
        {/each}
      </div>
    </div>

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
