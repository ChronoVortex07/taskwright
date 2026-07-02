<script lang="ts">
  import type { BandRange } from '../../lib/treeGeometry';

  interface Props {
    bands: BandRange[];
    scale: number;
    tx: number;
  }
  let { bands, scale, tx }: Props = $props();
</script>

<div class="tree-band-headers" data-testid="tree-band-headers">
  {#each bands as band (band.name)}
    <div
      class="tree-band-header"
      data-testid="tree-band-{band.name}"
      style="left:{band.x * scale + tx}px; width:{band.width * scale}px;"
    >
      <span class="tree-band-label">{band.name}</span>
    </div>
  {/each}
</div>

<style>
  .tree-band-headers {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 24px;
    z-index: 10;
    pointer-events: none;
    overflow: hidden;
  }
  .tree-band-header {
    position: absolute;
    top: 0;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-left: 1px solid var(--vscode-panel-border, transparent);
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: color-mix(in srgb, var(--vscode-editor-background) 85%, transparent);
  }
  .tree-band-label {
    padding: 0 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
