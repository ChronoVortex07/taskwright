<script lang="ts">
  import type { Task, MergeTaskState } from '../../lib/types';

  type FlightTask = Task & { isActiveTask?: boolean; mergeState?: MergeTaskState };
  interface Props {
    tasks: FlightTask[];
    onApprove: (taskId: string) => void;
    onSendBack: (taskId: string) => void;
  }
  let { tasks, onApprove, onSendBack }: Props = $props();

  let collapsed = $state(false);
  const active = $derived(tasks.filter((t) => t.isActiveTask));
  const queue = $derived(
    tasks
      .filter((t) => !!t.mergeState)
      .sort((a, b) => (a.mergeState!.position ?? 0) - (b.mergeState!.position ?? 0))
  );
  const isManualPending = (t: FlightTask) =>
    !!t.mergeState && !t.mergeState.approved && t.mergeState.mode === 'manual-review';
  // Nothing in flight and nothing queued: render nothing rather than an empty frame.
  const isEmpty = $derived(active.length === 0 && queue.length === 0);
</script>

{#if !isEmpty}
<div class="inflight" class:collapsed data-testid="inflight-panel">
  <button
    class="inflight-toggle"
    data-testid="inflight-toggle"
    title={collapsed ? 'Show in-flight' : 'Hide in-flight'}
    onclick={() => (collapsed = !collapsed)}
  >
    {#if collapsed}
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
    {:else}
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
    {/if}
  </button>

  {#if !collapsed}
    <div class="inflight-body">
      <div class="inflight-section">
        <div class="inflight-title">Active</div>
        {#if active.length === 0}<div class="inflight-empty">None</div>{/if}
        {#each active as t (t.id)}
          <div class="inflight-row" data-testid="inflight-active-{t.id}">
            <span class="inflight-id">{t.id}</span>
            <span class="inflight-name" title={t.title}>{t.title}</span>
          </div>
        {/each}
      </div>

      <div class="inflight-section">
        <div class="inflight-title">Merge queue</div>
        {#if queue.length === 0}<div class="inflight-empty">None</div>{/if}
        {#each queue as t (t.id)}
          <div class="inflight-row" data-testid="inflight-queue-{t.id}">
            <span class="inflight-id">{t.id}</span>
            {#if t.mergeState?.position}<span class="inflight-pos">#{t.mergeState.position}</span>{/if}
            <span class="inflight-name" title={t.title}>{t.title}</span>
            {#if isManualPending(t)}
              <div class="inflight-actions">
                <button class="inflight-btn primary" data-testid="inflight-approve-{t.id}" onclick={() => onApprove(t.id)}>Approve</button>
                <button class="inflight-btn" data-testid="inflight-sendback-{t.id}" onclick={() => onSendBack(t.id)}>Send back</button>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>
{/if}

<style>
  .inflight {
    position: absolute;
    top: 44px;
    right: 8px;
    z-index: 15;
    display: flex;
    align-items: flex-start;
    max-height: calc(100% - 60px);
  }
  .inflight-toggle {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444));
    border-radius: 6px 0 0 6px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    color: var(--vscode-foreground);
  }
  .inflight-body {
    width: 220px;
    max-height: calc(100vh - 120px);
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444));
    border-radius: 0 6px 6px 6px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  .inflight-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .inflight-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.7;
  }
  .inflight-empty {
    font-size: 11px;
    opacity: 0.5;
  }
  .inflight-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 6px;
    font-size: 11px;
  }
  .inflight-id {
    font-variant-numeric: tabular-nums;
    opacity: 0.8;
  }
  .inflight-pos {
    color: var(--vscode-charts-purple, #b180d7);
  }
  .inflight-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .inflight-actions {
    display: flex;
    gap: 4px;
    width: 100%;
  }
  .inflight-btn {
    all: unset;
    cursor: pointer;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #fff);
  }
  .inflight-btn.primary {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
  }
  .inflight-btn:hover {
    background: var(--vscode-button-hoverBackground, #1177bb);
  }
</style>
