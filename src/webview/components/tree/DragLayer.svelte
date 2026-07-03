<script lang="ts">
  import type { NodeBox, Point } from '../../lib/treeGeometry';

  /** Discriminated drag state, mirrored from TechTreeCanvas. */
  export type DragState =
    | {
        mode: 'connect';
        fromId: string;
        dir: 'needs' | 'unlocks';
        cursor: Point;
        targetId: string | null;
        valid: boolean;
      }
    | {
        mode: 'reslot';
        taskId: string;
        cursor: Point;
        targetLane?: string;
        targetBand?: string;
        valid: boolean;
      };

  interface LaneRect { name: string; y: number; height: number; }
  interface BandRect { name: string; x: number; width: number; }

  interface Props {
    drag: DragState;
    /** Positioned node boxes (world coords) for anchoring the connect line + reslot ghost. */
    nodes: Map<string, NodeBox>;
    /** Highlighted reslot lane target (the hovered band-expand strip). */
    laneTarget?: LaneRect | null;
    bandTarget?: BandRect | null;
    width: number;
    height: number;
  }
  let { drag, nodes, laneTarget = null, bandTarget = null, width, height }: Props = $props();

  // Connect: line from the origin handle anchor to the cursor.
  const connectFrom = $derived.by<Point | null>(() => {
    if (drag.mode !== 'connect') return null;
    const box = nodes.get(drag.fromId);
    if (!box) return null;
    return drag.dir === 'unlocks'
      ? { x: box.x + box.width, y: box.y + box.height / 2 } // right handle
      : { x: box.x, y: box.y + box.height / 2 }; // left handle
  });
  const connectTargetBox = $derived(
    drag.mode === 'connect' && drag.targetId ? nodes.get(drag.targetId) : undefined
  );
  const reslotBox = $derived(drag.mode === 'reslot' ? nodes.get(drag.taskId) : undefined);
</script>

<svg
  class="drag-layer"
  data-testid="drag-layer"
  width={width}
  height={height}
  viewBox="0 0 {width} {height}"
  aria-hidden="true"
>
  {#if drag.mode === 'reslot'}
    {#if laneTarget}
      <rect
        class="drag-target-strip"
        data-testid="drag-lane-target"
        x="0"
        y={laneTarget.y}
        width={width}
        height={laneTarget.height}
      />
    {/if}
    {#if bandTarget}
      <rect
        class="drag-target-strip"
        data-testid="drag-band-target"
        x={bandTarget.x}
        y="0"
        width={bandTarget.width}
        height={height}
      />
    {/if}
    {#if reslotBox}
      <rect
        class="drag-ghost"
        data-testid="drag-ghost"
        x={drag.cursor.x - reslotBox.width / 2}
        y={drag.cursor.y - reslotBox.height / 2}
        width={reslotBox.width}
        height={reslotBox.height}
        rx="8"
      />
    {/if}
  {:else if connectFrom}
    <path
      class="drag-connect"
      class:valid={drag.valid}
      class:invalid={!drag.valid}
      data-testid="drag-connect-line"
      d="M {connectFrom.x} {connectFrom.y} L {drag.cursor.x} {drag.cursor.y}"
    />
    {#if connectTargetBox}
      <rect
        class="drag-connect-ring"
        class:valid={drag.valid}
        class:invalid={!drag.valid}
        data-testid="drag-connect-ring"
        x={connectTargetBox.x - 2}
        y={connectTargetBox.y - 2}
        width={connectTargetBox.width + 4}
        height={connectTargetBox.height + 4}
        rx="10"
      />
    {/if}
  {/if}
</svg>

<style>
  .drag-layer {
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
    overflow: visible;
    z-index: 8; /* above EdgeLayer (default) + nodes' shadow, below popovers (z 30) */
  }
  .drag-target-strip {
    fill: color-mix(in srgb, var(--vscode-focusBorder) 14%, transparent);
    stroke: var(--vscode-focusBorder);
    stroke-width: 1.5;
    stroke-dasharray: 6 4;
  }
  .drag-ghost {
    fill: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
    stroke: var(--vscode-focusBorder);
    stroke-width: 1.5;
    stroke-dasharray: 4 4;
  }
  .drag-connect {
    fill: none;
    stroke-width: 2;
    stroke-dasharray: 6 5;
  }
  .drag-connect.valid,
  .drag-connect-ring.valid {
    stroke: var(--vscode-charts-green, #89d185);
  }
  .drag-connect.invalid,
  .drag-connect-ring.invalid {
    stroke: var(--vscode-editorError-foreground, #f14c4c);
  }
  .drag-connect-ring {
    fill: color-mix(in srgb, var(--vscode-charts-green, #89d185) 12%, transparent);
    stroke-width: 2;
  }
  .drag-connect-ring.invalid {
    fill: color-mix(in srgb, var(--vscode-editorError-foreground, #f14c4c) 12%, transparent);
  }
</style>
