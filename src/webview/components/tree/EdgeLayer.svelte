<script lang="ts">
  import type { Task } from '../../lib/types';
  import { edgeAnchors, bezierPath, type NodeBox } from '../../lib/treeGeometry';

  interface Props {
    nodes: Map<string, NodeBox>;
    tasks: Task[];
    doneStatus: string;
    hoveredId: string | null;
    selectedId: string | null;
    fadedIds: Set<string>;
    width: number;
    height: number;
    /** Remove a prereq edge: dependent no longer depends on prereq. */
    onRemoveDependency?: (dependentId: string, prereqId: string) => void;
  }
  let { nodes, tasks, doneStatus, hoveredId, selectedId, fadedIds, width, height, onRemoveDependency }: Props = $props();

  interface Edge {
    id: string;
    from: string;
    to: string;
    d: string;
    mid: { x: number; y: number };
    kind: 'satisfied' | 'blocking' | 'bug';
  }

  const byId = $derived(new Map(tasks.map((t) => [t.id.trim().toUpperCase(), t])));

  const edges = $derived.by<Edge[]>(() => {
    const out: Edge[] = [];
    for (const t of tasks) {
      const targetBox = nodes.get(t.id);
      if (!targetBox) continue;

      // Prerequisite edges: dependency (source) → this task (target).
      for (const rawDep of t.dependencies) {
        const dep = byId.get(rawDep.trim().toUpperCase());
        if (!dep) continue;
        const sourceBox = nodes.get(dep.id);
        if (!sourceBox) continue;
        const done =
          dep.status === doneStatus || dep.folder === 'completed' || dep.folder === 'archive';
        const { from, to } = edgeAnchors(sourceBox, targetBox);
        out.push({
          id: `${dep.id}->${t.id}`,
          from: dep.id,
          to: t.id,
          d: bezierPath(from, to),
          mid: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
          kind: done ? 'satisfied' : 'blocking',
        });
      }

      // Bug → cause reference edge.
      if (t.type === 'bug' && t.causedBy) {
        const cause = byId.get(t.causedBy.trim().toUpperCase());
        const causeBox = cause ? nodes.get(cause.id) : undefined;
        if (cause && causeBox) {
          const { from, to } = edgeAnchors(targetBox, causeBox);
          out.push({
            id: `bug:${t.id}->${cause.id}`,
            from: t.id,
            to: cause.id,
            d: bezierPath(from, to),
            mid: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
            kind: 'bug',
          });
        }
      }
    }
    return out;
  });

  const activeId = $derived(hoveredId ?? selectedId);
  function incident(e: Edge, id: string | null): boolean {
    return id !== null && (e.from === id || e.to === id);
  }
  function visible(e: Edge): boolean {
    if (e.kind !== 'bug') return true;
    return incident(e, hoveredId) || incident(e, selectedId);
  }

  let hoveredEdge = $state<string | null>(null);
</script>

<svg
  class="edge-layer"
  data-testid="edge-layer"
  width={width}
  height={height}
  viewBox="0 0 {width} {height}"
  aria-hidden="true"
>
  <defs>
    <marker id="tw-arrow" markerWidth="9" markerHeight="9" refX="7.5" refY="4" orient="auto" markerUnits="userSpaceOnUse">
      <path class="tw-arrow-satisfied" d="M0,0 L9,4 L0,8 z" />
    </marker>
    <marker id="tw-arrow-blocking" markerWidth="9" markerHeight="9" refX="7.5" refY="4" orient="auto" markerUnits="userSpaceOnUse">
      <path class="tw-arrow-blocking" d="M0,0 L9,4 L0,8 z" />
    </marker>
  </defs>

  {#each edges as e (e.id)}
    {#if visible(e)}
      <path
        class="tree-edge tree-edge-{e.kind}"
        class:incident={activeId !== null && incident(e, activeId)}
        class:faded={activeId !== null && !incident(e, activeId)}
        class:nav-faded={fadedIds.has(e.from) || fadedIds.has(e.to)}
        data-testid="tree-edge-{e.from}-{e.to}"
        d={e.d}
        marker-end={e.kind === 'bug'
          ? undefined
          : e.kind === 'blocking'
            ? 'url(#tw-arrow-blocking)'
            : 'url(#tw-arrow)'}
      />
      {#if e.kind !== 'bug'}
        <!-- m3: enter/leave live on the GROUP (hit-path + ✕ together), so moving the
             pointer from the hit-stroke onto the ✕ never fires a leave (pointerenter/
             pointerleave treat descendants as inside) and the ✕ can't unmount mid-hover. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <g
          class="tree-edge-interactive"
          onpointerenter={() => (hoveredEdge = e.id)}
          onpointerleave={() => (hoveredEdge = null)}
        >
          <path class="tree-edge-hit" data-testid="tree-edge-hit-{e.from}-{e.to}" d={e.d} />
          {#if hoveredEdge === e.id}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <g
              class="tree-edge-remove"
              data-testid="tree-edge-remove-{e.from}-{e.to}"
              transform="translate({e.mid.x} {e.mid.y})"
              role="button"
              tabindex="-1"
              aria-label="Remove dependency"
              onpointerdown={(ev) => ev.stopPropagation()}
              onclick={(ev) => {
                ev.stopPropagation();
                onRemoveDependency?.(e.to, e.from);
              }}
            >
              <circle r="9" class="tree-edge-remove-bg" />
              <path d="M -3 -3 L 3 3 M 3 -3 L -3 3" class="tree-edge-remove-x" />
            </g>
          {/if}
        </g>
      {/if}
    {/if}
  {/each}
</svg>

<style>
  .edge-layer {
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
    overflow: visible;
  }
  .tree-edge-hit {
    fill: none;
    stroke: transparent;
    stroke-width: 14;
    pointer-events: stroke;
    cursor: pointer;
  }
  .tree-edge-remove {
    pointer-events: all;
    cursor: pointer;
  }
  .tree-edge-remove-bg {
    fill: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    stroke: var(--vscode-editorError-foreground, #f14c4c);
    stroke-width: 1.5;
  }
  .tree-edge-remove-x {
    stroke: var(--vscode-editorError-foreground, #f14c4c);
    stroke-width: 2;
    stroke-linecap: round;
  }
  .tree-edge {
    fill: none;
    stroke-width: 1.5;
    transition: opacity 0.12s ease;
  }
  .tree-edge-satisfied {
    stroke: var(--vscode-charts-lines, var(--vscode-editorIndentGuide-activeBackground, #888));
  }
  .tree-edge-blocking {
    stroke: var(--vscode-editorWarning-foreground, #cca700);
    stroke-dasharray: 6 4;
  }
  .tree-edge-bug {
    stroke: var(--vscode-editorError-foreground, #f14c4c);
    stroke-dasharray: 2 4;
    opacity: 0.8;
  }
  .tree-edge.incident {
    stroke-width: 2.5;
    opacity: 1;
  }
  .tree-edge.faded {
    opacity: 0.15;
  }
  .tree-edge.nav-faded {
    opacity: 0.1;
  }
  .tw-arrow-satisfied {
    fill: var(--vscode-charts-lines, var(--vscode-editorIndentGuide-activeBackground, #888));
  }
  .tw-arrow-blocking {
    fill: var(--vscode-editorWarning-foreground, #cca700);
  }
</style>
