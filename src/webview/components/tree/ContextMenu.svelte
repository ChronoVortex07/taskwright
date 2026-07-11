<script lang="ts">
  interface Props {
    x: number;
    y: number;
    lane?: string;
    band?: string;
    onClose: () => void;
    onCreateHere: (opts: { category?: string; milestone?: string }) => void;
  }
  let { x, y, lane, band, onClose, onCreateHere }: Props = $props();

  let menuEl: HTMLDivElement | undefined = $state();
  let firstItemEl: HTMLButtonElement | undefined = $state();

  // Move focus into the menu when it opens so keyboard users can act on it and
  // Escape works immediately (the menu is mounted fresh per open).
  $effect(() => {
    firstItemEl?.focus();
  });

  function handleCreateHere() {
    onCreateHere({ category: lane, milestone: band });
    onClose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  function handleWindowMouseDown(e: MouseEvent) {
    // Close if the click is outside the menu element.
    if (menuEl && !menuEl.contains(e.target as Node)) {
      onClose();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} onmousedown={handleWindowMouseDown} />

<!--
  The backdrop is a full-screen positioning layer (pointer-events: none). It must
  NOT be aria-hidden: doing so removes its descendant menu from the accessibility
  tree entirely, hiding the menu from assistive tech.
-->
<div class="context-menu-backdrop" data-testid="context-menu-backdrop">
  <div
    class="context-menu"
    data-testid="context-menu"
    bind:this={menuEl}
    style="left:{x}px; top:{y}px;"
    role="menu"
    aria-label="Canvas context menu"
  >
    <button
      class="context-menu-item"
      data-testid="ctx-create-here"
      role="menuitem"
      bind:this={firstItemEl}
      onclick={handleCreateHere}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="ctx-icon"
      >
        <path d="M5 12h14" />
        <path d="M12 5v14" />
      </svg>
      <span>Create task here</span>
    </button>
  </div>
</div>

<style>
  .context-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    pointer-events: none;
  }

  .context-menu {
    position: absolute;
    min-width: 180px;
    padding: 4px;
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, #444));
    border-radius: 6px;
    background: var(--vscode-menu-background, var(--vscode-editorWidget-background, #252526));
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    overflow: hidden;
    pointer-events: auto;
  }

  .context-menu-item {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    border-radius: 4px;
    box-sizing: border-box;
    font-size: 12px;
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    white-space: nowrap;
  }

  .context-menu-item:hover {
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground, #094771));
  }

  .ctx-icon {
    flex-shrink: 0;
    opacity: 0.7;
  }
</style>
