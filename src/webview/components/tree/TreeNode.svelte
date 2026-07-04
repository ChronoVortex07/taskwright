<script lang="ts">
  import type { Task, TaskIdDisplayMode, MergeTaskState } from '../../lib/types';
  import { statusToClass } from '../../lib/statusColors';
  import { formatTaskIdForDisplay } from '../../lib/taskIdDisplay';
  import type { LodTier } from '../../lib/treeGeometry';

  interface Props {
    task: Task & {
      mergeState?: MergeTaskState;
      planProgress?: { done: number; total: number };
    };
    x: number;
    y: number;
    w: number;
    h: number;
    lod: LodTier;
    statuses: string[];
    taskIdDisplay: TaskIdDisplayMode;
    selected: boolean;
    hovered: boolean;
    dimmed?: boolean;
    hidden?: boolean;
    onSelect: (id: string, meta?: Pick<Task, 'filePath' | 'source' | 'branch'>) => void;
    onHover: (id: string | null) => void;
    onPromote?: (id: string) => void;
  }
  let {
    task, x, y, w, h, lod, statuses, taskIdDisplay, selected, hovered,
    dimmed = false, hidden = false, onSelect, onHover, onPromote,
  }: Props = $props();

  const doneStatus = $derived(statuses.length > 0 ? statuses[statuses.length - 1] : 'Done');
  const isDone = $derived(
    task.status === doneStatus || task.folder === 'completed' || task.folder === 'archive'
  );
  const isLocked = $derived(task.locked === true);
  const isBug = $derived(task.type === 'bug');
  const isDraft = $derived(task.status === 'Draft' || task.folder === 'drafts');
  const activeBugCount = $derived(task.activeBugIds?.length ?? 0);
  const hasActiveBug = $derived(activeBugCount > 0);
  const queuePosition = $derived(
    task.mergeState && !task.mergeState.approved && task.mergeState.mode === 'manual-review'
      ? task.mergeState.position
      : undefined
  );
  const isPendingReview = $derived(queuePosition !== undefined);
  const statusClass = $derived(`status-${statusToClass(task.status)}`);
  const displayId = $derived(formatTaskIdForDisplay(task.id, taskIdDisplay));
  const showId = $derived(taskIdDisplay !== 'hidden');
  const labels = $derived(task.labels?.slice(0, 3) ?? []);
  const iconKind = $derived(
    isBug
      ? 'bug'
      : isDraft
        ? 'draft'
        : isDone
          ? 'done'
          : isLocked
            ? 'locked'
            : task.status.toLowerCase().includes('progress')
              ? 'progress'
              : 'todo'
  );

  function select() {
    onSelect(task.id, { filePath: task.filePath, source: task.source, branch: task.branch });
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select();
    }
  }
</script>

{#snippet statusGlyph()}
  {#if iconKind === 'bug'}
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>
  {:else if iconKind === 'draft'}
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
  {:else if iconKind === 'done'}
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>
  {:else if iconKind === 'locked'}
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
  {:else if iconKind === 'progress'}
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/></svg>
  {:else}
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/></svg>
  {/if}
{/snippet}

<div
  class="tree-node {statusClass}"
  class:done={isDone}
  class:locked={isLocked}
  class:bug-node={isBug}
  class:proposed={isDraft}
  class:has-active-bug={hasActiveBug}
  class:pending-review={isPendingReview}
  class:selected
  class:hovered
  class:nav-dimmed={dimmed}
  class:nav-hidden={hidden}
  class:lod-near={lod === 'near'}
  class:lod-mid={lod === 'mid'}
  class:lod-far={lod === 'far'}
  data-testid="tree-node-{task.id}"
  data-node-id={task.id}
  data-node-x={x}
  data-node-y={y}
  data-lod={lod}
  style="left:{x}px; top:{y}px; width:{w}px; min-height:{h}px;"
  role="button"
  tabindex="0"
  onkeydown={onKey}
  onpointerenter={() => onHover(task.id)}
  onpointerleave={() => onHover(null)}
>
  <span class="tree-node-bar" aria-hidden="true"></span>

  {#if hovered && !isDone}
    <span
      class="tree-connect-handle tree-connect-left"
      data-testid="tree-connect-needs-{task.id}"
      data-connect-id={task.id}
      data-connect-dir="needs"
      title="Drag to make this task depend on another"
      aria-hidden="true"
    ></span>
    <span
      class="tree-connect-handle tree-connect-right"
      data-testid="tree-connect-unlocks-{task.id}"
      data-connect-id={task.id}
      data-connect-dir="unlocks"
      title="Drag to make another task depend on this"
      aria-hidden="true"
    ></span>
  {/if}

  {#if lod === 'far'}
    <span class="tree-node-pill" data-testid="tree-node-pill-{task.id}" title={task.title}>
      {@render statusGlyph()}
      <span class="tree-node-far-title">{task.title}</span>
    </span>
  {:else if lod === 'mid'}
    <div class="tree-node-mid">
      <span class="tree-node-status-icon">{@render statusGlyph()}</span>
      <span class="tree-node-title" title={task.title}>{task.title}</span>
      {#if isLocked}<span class="tree-node-lock" data-testid="tree-node-lock-{task.id}">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </span>{/if}
      {#if hasActiveBug}<span class="tree-node-bugbadge" data-testid="tree-node-bugbadge-{task.id}">{activeBugCount}</span>{/if}
    </div>
  {:else}
    <div class="tree-node-header">
      <span class="tree-node-status-icon">{@render statusGlyph()}</span>
      {#if showId}<span class="tree-node-id" data-testid="tree-node-id-{task.id}">{displayId}</span>{/if}
      {#if task.priority}<span class="tree-node-priority" data-testid="tree-node-priority-{task.id}">{task.priority}</span>{/if}
    </div>
    <div class="tree-node-title" title={task.title}>{task.title}</div>
    {#if labels.length > 0}
      <div class="tree-node-labels">
        {#each labels as label (label)}
          <span class="tree-node-label">{label}</span>
        {/each}
      </div>
    {/if}
    {#if task.planProgress && task.planProgress.total > 0}
      <div class="tree-node-plan" data-testid="tree-node-plan-{task.id}">
        <span
          class="tree-node-plan-fill"
          style="width:{(task.planProgress.done / task.planProgress.total) * 100}%"
        ></span>
      </div>
    {/if}
    <div class="tree-node-badges">
      {#if isDraft}
        <button
          class="tree-node-promote"
          data-testid="tree-node-promote-{task.id}"
          title="Promote to task"
          onclick={(e) => {
            e.stopPropagation();
            onPromote?.(task.id);
          }}
        >
          Promote
        </button>
      {/if}
      {#if task.claimedBy}
        <span class="tree-node-worker" data-testid="tree-node-worker-{task.id}" title="Claimed by {task.claimedBy}">
          {#if task.worktree}
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>
          {:else}
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          {/if}
        </span>
      {/if}
      {#if isLocked}
        <span class="tree-node-lock" data-testid="tree-node-lock-{task.id}" title="Locked by prerequisites">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </span>
      {/if}
      {#if hasActiveBug}
        <span class="tree-node-bugbadge" data-testid="tree-node-bugbadge-{task.id}" title="{activeBugCount} active bug(s)">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/></svg>
          {activeBugCount}
        </span>
      {/if}
      {#if isPendingReview}
        <span class="tree-node-queue" data-testid="tree-node-queue-{task.id}" title="Pending review">#{queuePosition}</span>
      {/if}
      {#if isDone}
        <span class="tree-node-check" data-testid="tree-node-check-{task.id}" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
        </span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tree-node {
    position: absolute;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 10px 8px 14px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444));
    border-radius: 8px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    color: var(--vscode-foreground);
    overflow: hidden;
    cursor: pointer;
    /* faint status tint via the status class below */
  }
  .tree-node:focus-visible,
  .tree-node.selected {
    outline: 2px solid var(--vscode-focusBorder);
    outline-offset: 0;
  }
  .tree-node.hovered {
    border-color: var(--vscode-focusBorder);
  }
  /* Left status color bar. */
  .tree-node-bar {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    background: var(--tw-status-color, var(--vscode-foreground));
  }
  .tree-connect-handle {
    position: absolute;
    top: 50%;
    width: 14px;
    height: 14px;
    margin-top: -7px;
    border-radius: 50%;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 2px solid var(--vscode-focusBorder);
    cursor: crosshair;
    z-index: 5;
  }
  .tree-connect-handle:hover {
    background: var(--vscode-focusBorder);
  }
  /* Seated fully inside the node: .tree-node clips overflow (rounded corners, long
     titles), so an edge-straddling -7px offset would halve the grabbable hitbox
     (branch review Minor 2). */
  .tree-connect-left {
    left: 0;
  }
  .tree-connect-right {
    right: 0;
  }
  /* Handles are meaningless at far LOD (nodes are pills). */
  .tree-node.lod-far .tree-connect-handle {
    display: none;
  }
  /* Known-status colors + faint tints (theme tokens). */
  .tree-node.status-to-do,
  .tree-node.status-todo {
    --tw-status-color: var(--vscode-charts-blue, #3794ff);
  }
  .tree-node.status-in-progress {
    --tw-status-color: var(--vscode-charts-yellow, #cca700);
  }
  .tree-node.status-done {
    --tw-status-color: var(--vscode-charts-green, #89d185);
  }
  .tree-node.status-draft {
    --tw-status-color: var(--vscode-descriptionForeground, #999);
  }
  .tree-node {
    background: color-mix(in srgb, var(--tw-status-color, transparent) 8%, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
  }
  .tree-node-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    opacity: 0.9;
  }
  .tree-node-id {
    font-variant-numeric: tabular-nums;
    opacity: 0.8;
  }
  .tree-node-priority {
    margin-left: auto;
    text-transform: capitalize;
    font-size: 10px;
    padding: 0 6px;
    border-radius: 8px;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
  }
  .tree-node-status-icon {
    display: inline-flex;
    color: var(--tw-status-color, var(--vscode-foreground));
  }
  .tree-node-title {
    font-size: 12px;
    font-weight: 500;
    line-height: 1.25;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .tree-node-labels {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .tree-node-label {
    font-size: 10px;
    padding: 0 6px;
    border-radius: 8px;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
    opacity: 0.85;
  }
  .tree-node-plan {
    height: 4px;
    border-radius: 2px;
    background: var(--vscode-progressBar-background, rgba(255, 255, 255, 0.1));
    overflow: hidden;
  }
  .tree-node-plan-fill {
    display: block;
    height: 100%;
    background: var(--vscode-charts-green, #89d185);
  }
  .tree-node-badges {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    opacity: 0.9;
  }
  .tree-node-bugbadge {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    color: var(--vscode-editorError-foreground, #f14c4c);
  }
  .tree-node-queue {
    font-variant-numeric: tabular-nums;
    color: var(--vscode-charts-purple, #b180d7);
  }
  .tree-node-check {
    color: var(--vscode-charts-green, #89d185);
  }
  .tree-node-promote {
    all: unset;
    cursor: pointer;
    font-size: 10px;
    padding: 1px 8px;
    border-radius: 8px;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
  }
  .tree-node-promote:hover {
    background: var(--vscode-button-hoverBackground, #1177bb);
  }

  /* --- State styles --- */
  .tree-node.done {
    opacity: 0.55;
  }
  .tree-node.locked {
    border-style: dashed;
  }
  .tree-node.proposed {
    border-style: dashed;
    opacity: 0.7;
    background: repeating-linear-gradient(
      45deg,
      transparent,
      transparent 6px,
      var(--vscode-editorWidget-background, rgba(255, 255, 255, 0.02)) 6px,
      var(--vscode-editorWidget-background, rgba(255, 255, 255, 0.02)) 12px
    );
  }
  .tree-node.bug-node {
    --tw-status-color: var(--vscode-editorError-foreground, #f14c4c);
  }
  .tree-node.has-active-bug {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-editorError-foreground, #f14c4c) 40%, transparent);
  }
  .tree-node.nav-dimmed {
    opacity: 0.16;
  }
  .tree-node.nav-hidden {
    display: none;
  }

  /* --- LOD tiers --- */
  .tree-node.lod-far {
    min-height: 0 !important;
    height: 24px;
    width: auto !important;
    padding: 2px 8px 2px 12px;
    flex-direction: row;
    align-items: center;
  }
  .tree-node-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .tree-node-far-title {
    font-size: 11px;
    line-height: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 140px;
  }
  .tree-node-mid {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .tree-node.lod-mid {
    padding-top: 6px;
    padding-bottom: 6px;
  }
</style>
