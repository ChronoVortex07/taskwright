<script lang="ts">
  import type { LaneRange } from '../../lib/treeGeometry';

  interface Props {
    lanes: LaneRange[];
    scale: number;
    ty: number;
    /** Name of the lane to emphasize while a reslot drag hovers it (null = none). */
    emphasis?: string | null;
  }
  let { lanes, scale, ty, emphasis = null }: Props = $props();
</script>

<div class="tree-lane-labels" data-testid="tree-lane-labels">
  {#each lanes as lane (lane.name)}
    <div
      class="tree-lane-label"
      class:emphasized={lane.name === emphasis}
      data-testid="tree-lane-{lane.name}"
      style="top:{lane.y * scale + ty - 24}px; height:{lane.height * scale}px;"
    >
      <span>{lane.name}</span>
    </div>
  {/each}
</div>

<style>
  .tree-lane-labels {
    position: absolute;
    top: 24px;
    left: 0;
    bottom: 0;
    width: 28px;
    z-index: 10;
    pointer-events: none;
    overflow: hidden;
  }
  .tree-lane-label {
    position: absolute;
    left: 0;
    width: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-top: 1px solid var(--vscode-panel-border, transparent);
    background: color-mix(in srgb, var(--vscode-editor-background) 85%, transparent);
  }
  .tree-lane-label.emphasized {
    background: color-mix(in srgb, var(--vscode-focusBorder) 18%, var(--vscode-editor-background));
    border-top-color: var(--vscode-focusBorder);
  }
  .tree-lane-label.emphasized span {
    color: var(--vscode-foreground);
  }
  .tree-lane-label span {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-height: 100%;
  }
</style>
