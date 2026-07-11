<script lang="ts">
  import type { ChecklistItem } from '../../lib/types';

  interface LaneProgress {
    name: string;
    total: number;
    done: number;
  }
  interface Props {
    milestone: string;
    total: number;
    done: number;
    lanes: LaneProgress[];
    checklist: ChecklistItem[];
    x: number;
    y: number;
    onClose: () => void;
    onToggle: (itemId: number) => void;
  }
  let { milestone, total, done, lanes, checklist, x, y, onClose, onToggle }: Props = $props();

  const pct = $derived(total > 0 ? Math.round((done / total) * 100) : 0);
  const lanePct = (l: LaneProgress) => (l.total > 0 ? Math.round((l.done / l.total) * 100) : 0);

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="ms-popover"
  data-testid="milestone-popover"
  data-milestone={milestone}
  style="left:{x}px; top:{y}px;"
  role="dialog"
  aria-label="Milestone {milestone}"
>
  <div class="ms-head">
    <span class="ms-title">{milestone}</span>
    <button class="ms-close" data-testid="ms-close" title="Close" aria-label="Close" onclick={onClose}>
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
    </button>
  </div>

  <div class="ms-overall" data-testid="ms-overall">
    <div class="ms-bar"><span class="ms-bar-fill" style="width:{pct}%"></span></div>
    <span class="ms-stat">{done}/{total} tasks · {pct}%</span>
  </div>

  {#if lanes.length > 0}
    <div class="ms-lanes">
      {#each lanes as l (l.name)}
        <div class="ms-lane" data-testid="ms-lane-{l.name}">
          <span class="ms-lane-name">{l.name}</span>
          <span class="ms-lane-stat">{l.done}/{l.total} · {lanePct(l)}%</span>
        </div>
      {/each}
    </div>
  {/if}

  <div class="ms-checklist">
    <div class="ms-checklist-title">Release checklist</div>
    {#if checklist.length === 0}
      <div class="ms-empty" data-testid="ms-empty">No release checklist items yet.</div>
    {:else}
      {#each checklist as item (item.id)}
        <label class="ms-item" data-testid="rc-item-{item.id}">
          <input
            type="checkbox"
            checked={item.checked}
            data-testid="rc-toggle-{item.id}"
            onchange={() => onToggle(item.id)}
          />
          <span class:checked={item.checked}>{item.text}</span>
        </label>
      {/each}
    {/if}
  </div>

  <div class="ms-note">
    Automated checks (test · lint · typecheck) are enforced per task by request_merge — not listed
    here.
  </div>
</div>

<style>
  .ms-popover {
    position: absolute;
    z-index: 30;
    width: 300px;
    max-width: calc(100% - 16px);
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444));
    border-radius: 8px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    color: var(--vscode-foreground);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  }
  .ms-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .ms-title {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .ms-close {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    padding: 3px;
    border-radius: 4px;
    opacity: 0.8;
  }
  .ms-close:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  }
  .ms-overall {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ms-bar {
    height: 6px;
    border-radius: 3px;
    background: var(--vscode-progressBar-background, rgba(255, 255, 255, 0.1));
    overflow: hidden;
  }
  .ms-bar-fill {
    display: block;
    height: 100%;
    background: var(--vscode-charts-green, #89d185);
  }
  .ms-stat {
    font-size: 11px;
    opacity: 0.85;
  }
  .ms-lanes {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .ms-lane {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    opacity: 0.9;
  }
  .ms-checklist {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ms-checklist-title {
    font-size: 11px;
    font-weight: 600;
    opacity: 0.8;
  }
  .ms-empty {
    font-size: 11px;
    opacity: 0.6;
  }
  .ms-item {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 12px;
    cursor: pointer;
  }
  .ms-item span.checked {
    text-decoration: line-through;
    opacity: 0.6;
  }
  .ms-note {
    font-size: 10px;
    opacity: 0.6;
    line-height: 1.3;
  }
</style>
