<script lang="ts">
  import { vscode, onMessage } from '../../stores/vscode.svelte';
  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';

  let lanes = $state<Array<{ name: string; count: number }>>([]);
  let bands = $state<string[]>([]);
  let priorities = $state<string[]>([]);
  let search = $state('');
  let activePriority = $state('');
  let collapsedLanes = new SvelteSet<string>();
  let viewport = $state<{ x: number; y: number; w: number; h: number } | null>(null);

  onMessage((message) => {
    switch (message.type) {
      case 'navigatorData':
        lanes = message.lanes as Array<{ name: string; count: number }>;
        bands = message.bands as string[];
        priorities = message.priorities as string[];
        break;
      case 'minimapViewport':
        viewport = {
          x: message.x as number,
          y: message.y as number,
          w: message.w as number,
          h: message.h as number,
        };
        break;
    }
  });

  onMount(() => vscode.postMessage({ type: 'refresh' }));

  function emitFilter() {
    vscode.postMessage({ type: 'navigatorFilterChanged', search, priority: activePriority });
  }
  function onSearchInput(e: Event) {
    search = (e.currentTarget as HTMLInputElement).value;
    emitFilter();
  }
  function togglePriority(p: string) {
    activePriority = activePriority === p ? '' : p;
    emitFilter();
  }
  function toggleLane(name: string) {
    if (collapsedLanes.has(name)) collapsedLanes.delete(name);
    else collapsedLanes.add(name);
    vscode.postMessage({ type: 'navigatorLaneToggle', lane: name });
  }
  function jump(band: string) {
    vscode.postMessage({ type: 'navigatorJump', band });
  }
</script>

<div class="nav" data-testid="tree-navigator">
  <div class="nav-search">
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
    <input
      type="text"
      placeholder="Search tasks…"
      data-testid="nav-search"
      value={search}
      oninput={onSearchInput}
    />
  </div>

  {#if priorities.length > 0}
    <div class="nav-section">
      <div class="nav-title">Priority</div>
      <div class="nav-chips">
        {#each priorities as p (p)}
          <button
            class="nav-chip"
            class:active={activePriority === p}
            data-testid="nav-priority-{p}"
            onclick={() => togglePriority(p)}
          >
            {p}
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <div class="nav-section">
    <div class="nav-title">Lanes</div>
    {#each lanes as lane (lane.name)}
      <button
        class="nav-lane"
        class:collapsed={collapsedLanes.has(lane.name)}
        data-testid="nav-lane-{lane.name}"
        onclick={() => toggleLane(lane.name)}
        title="Toggle {lane.name}"
      >
        <span class="nav-lane-name">{lane.name}</span>
        <span class="nav-lane-count">{lane.count}</span>
      </button>
    {/each}
  </div>

  {#if bands.length > 0}
    <div class="nav-section">
      <div class="nav-title">Jump to age</div>
      <div class="nav-jumps">
        {#each bands as band (band)}
          <button class="nav-jump" data-testid="nav-jump-{band}" onclick={() => jump(band)}>{band}</button>
        {/each}
      </div>
    </div>
  {/if}

  <div class="nav-section">
    <div class="nav-title">Minimap</div>
    <div class="nav-minimap" data-testid="nav-minimap">
      <div class="nav-minimap-grid">
        {#each bands as band (band)}
          <button class="nav-minimap-col" data-testid="nav-minimap-{band}" title={band} onclick={() => jump(band)} aria-label="Jump to {band}"></button>
        {/each}
      </div>
      {#if viewport}
        <div
          class="nav-minimap-vp"
          data-testid="nav-minimap-vp"
          style="left:{viewport.x * 100}%; top:{viewport.y * 100}%; width:{viewport.w * 100}%; height:{viewport.h * 100}%;"
        ></div>
      {/if}
    </div>
  </div>
</div>

<style>
  .nav {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 8px;
    color: var(--vscode-foreground);
    font-size: 12px;
  }
  .nav-search {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #444));
    border-radius: 4px;
    background: var(--vscode-input-background, var(--vscode-editor-background));
  }
  .nav-search input {
    all: unset;
    flex: 1;
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    font-size: 12px;
  }
  .nav-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .nav-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.7;
  }
  .nav-chips,
  .nav-jumps {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .nav-chip,
  .nav-jump {
    all: unset;
    cursor: pointer;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
  }
  .nav-chip.active {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
  }
  .nav-lane {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3px 6px;
    border-radius: 4px;
  }
  .nav-lane:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .nav-lane.collapsed .nav-lane-name {
    opacity: 0.45;
    text-decoration: line-through;
  }
  .nav-lane-count {
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
  }
  .nav-minimap {
    position: relative;
    height: 80px;
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 4px;
    overflow: hidden;
    background: var(--vscode-editor-background);
  }
  .nav-minimap-grid {
    display: flex;
    height: 100%;
  }
  .nav-minimap-col {
    all: unset;
    cursor: pointer;
    flex: 1;
    border-right: 1px solid var(--vscode-panel-border, #444);
    background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
  }
  .nav-minimap-col:hover {
    background: color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
  }
  .nav-minimap-vp {
    position: absolute;
    border: 1px solid var(--vscode-focusBorder);
    background: color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent);
    pointer-events: none;
  }
</style>
