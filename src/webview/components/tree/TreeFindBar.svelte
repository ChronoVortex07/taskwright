<script lang="ts">
  /**
   * Tree FIND bar (distinct from the navigator sidebar's FILTER). Highlights matches on
   * the canvas and walks them; Enter = next, Shift-Enter = previous, Escape = close.
   *
   * Enter deliberately does NOT open the node's popover — that would post
   * popoverActiveChanged and rewrite the ephemeral active task on every keypress.
   */
  interface Props {
    query: string;
    matchCount: number;
    /** 0-based index of the current cycle target; -1 when there is no match. */
    currentIndex: number;
    onQueryChange: (q: string) => void;
    onNext: () => void;
    onPrev: () => void;
    onClose: () => void;
  }
  let { query, matchCount, currentIndex, onQueryChange, onNext, onPrev, onClose }: Props =
    $props();

  let inputEl: HTMLInputElement | undefined = $state();

  /** Called by TechTreeCanvas when `/` or Ctrl/Cmd-F opens the bar. */
  export function focus() {
    inputEl?.focus();
    inputEl?.select();
  }

  const hasQuery = $derived(query.trim().length > 0);
  const counter = $derived(
    !hasQuery ? '' : matchCount === 0 ? 'No results' : `${currentIndex + 1} / ${matchCount}`
  );

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (matchCount === 0) return;
      if (e.shiftKey) onPrev();
      else onNext();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }
</script>

<div class="tree-find-bar" data-testid="tree-find-bar">
  <svg
    class="find-icon"
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
  </svg>

  <input
    bind:this={inputEl}
    class="find-input"
    data-testid="tree-search-input"
    type="text"
    placeholder="Find task…"
    aria-label="Find task on the tree"
    value={query}
    oninput={(e) => onQueryChange((e.currentTarget as HTMLInputElement).value)}
    onkeydown={onKeydown}
  />

  <span
    class="find-count"
    data-testid="tree-find-count"
    class:empty={hasQuery && matchCount === 0}
    role="status"
    aria-live="polite"
  >
    {counter}
  </span>

  <button
    class="find-btn"
    data-testid="tree-find-prev"
    title="Previous match (Shift+Enter)"
    aria-label="Previous match"
    disabled={matchCount === 0}
    onclick={onPrev}
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>
  </button>

  <button
    class="find-btn"
    data-testid="tree-find-next"
    title="Next match (Enter)"
    aria-label="Next match"
    disabled={matchCount === 0}
    onclick={onNext}
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
  </button>

  <button
    class="find-btn"
    data-testid="tree-find-close"
    title="Close (Escape)"
    aria-label="Close find"
    onclick={onClose}
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
  </button>
</div>

<style>
  .tree-find-bar {
    position: absolute;
    top: 8px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 12;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 4px;
    background: var(--vscode-editorWidget-background);
    box-shadow: 0 2px 8px var(--vscode-widget-shadow);
  }

  .find-icon {
    flex: 0 0 auto;
    color: var(--vscode-descriptionForeground);
  }

  .find-input {
    width: 200px;
    min-width: 0;
    padding: 2px 4px;
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-family: inherit;
    font-size: 12px;
  }

  .find-input:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  .find-count {
    flex: 0 0 auto;
    /* Reserve width so the bar does not jitter as the counter's digits change. */
    min-width: 62px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    white-space: nowrap;
  }

  .find-count.empty {
    color: var(--vscode-errorForeground);
  }

  .find-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    border: none;
    border-radius: 2px;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
  }

  .find-btn:hover:not(:disabled) {
    background: var(--vscode-toolbar-hoverBackground);
  }

  .find-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
