<script lang="ts">
  import type { Task, TaskIdDisplayMode } from '../../lib/types';
  import { formatTaskIdForDisplay } from '../../lib/taskIdDisplay';

  type PopoverTask = Task & {
    claimedByMe?: boolean;
    planProgress?: { done: number; total: number };
  };

  export type PopoverActionKind =
    | 'claim'
    | 'dispatch'
    | 'forceClaim'
    | 'release'
    | 'markDone'
    | 'cancelDispatch'
    | 'approve'
    | 'sendBack';

  interface Props {
    task: PopoverTask;
    statuses: string[];
    priorities: string[];
    taskIdDisplay: TaskIdDisplayMode;
    x: number;
    y: number;
    onClose: () => void;
    onExpand: (taskId: string) => void;
    onQuickEdit: (updates: { status?: string; priority?: string }) => void;
    onAction: (kind: PopoverActionKind, taskId: string) => void;
  }
  let { task, statuses, priorities, taskIdDisplay, x, y, onClose, onExpand, onQuickEdit, onAction }: Props =
    $props();

  const doneStatus = $derived(statuses.length > 0 ? statuses[statuses.length - 1] : 'Done');
  const firstStatus = $derived(statuses.length > 0 ? statuses[0] : 'To Do');
  const isDone = $derived(
    task.status === doneStatus || task.folder === 'completed' || task.folder === 'archive'
  );
  const isDraft = $derived(task.status === 'Draft' || task.folder === 'drafts');
  const isLocked = $derived(task.locked === true);
  const isTodo = $derived(task.status === firstStatus);
  const pendingReview = $derived(
    !!task.mergeState && !task.mergeState.approved && task.mergeState.mode === 'manual-review'
  );
  const inProgress = $derived(!isDone && !isDraft && !isTodo && !pendingReview);
  const claimedByMe = $derived(task.claimedByMe === true);
  const hasWorktree = $derived(!!task.worktree);
  const displayId = $derived(formatTaskIdForDisplay(task.id, taskIdDisplay));
  const lane = $derived(task.layout?.lane ?? '');
  const age = $derived(task.milestone ?? 'Backburner');
  const prereqs = $derived(task.dependencies ?? []);
  const unlocks = $derived(task.blocksTaskIds ?? []);
  const blockedBy = $derived(task.blockedBy ?? []);

  interface ActionBtn {
    key: string;
    label: string;
    kind: PopoverActionKind;
    primary?: boolean;
  }
  const actions = $derived.by<ActionBtn[]>(() => {
    if (pendingReview)
      return [
        { key: 'approve', label: 'Approve & merge', kind: 'approve', primary: true },
        { key: 'sendBack', label: 'Send back', kind: 'sendBack' },
      ];
    if (isDone || isDraft) return [];
    if (isTodo && isLocked) return [{ key: 'force', label: 'Force claim', kind: 'forceClaim' }];
    if (isTodo)
      return [
        { key: 'claim', label: 'Claim', kind: 'claim', primary: true },
        { key: 'dispatch', label: 'Dispatch', kind: 'dispatch' },
      ];
    if (inProgress && hasWorktree)
      return [{ key: 'cancel', label: 'Cancel dispatch', kind: 'cancelDispatch' }];
    if (inProgress && claimedByMe)
      return [
        { key: 'done', label: 'Mark done', kind: 'markDone', primary: true },
        { key: 'release', label: 'Release claim', kind: 'release' },
      ];
    if (task.claimedBy) return [{ key: 'release', label: 'Release claim', kind: 'release' }];
    return [
      { key: 'claim', label: 'Claim', kind: 'claim', primary: true },
      { key: 'dispatch', label: 'Dispatch', kind: 'dispatch' },
    ];
  });

  let showDescription = $state(false);
  const planPct = $derived(
    task.planProgress && task.planProgress.total > 0
      ? Math.round((task.planProgress.done / task.planProgress.total) * 100)
      : undefined
  );

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="tree-popover"
  data-testid="tree-popover"
  data-popover-task={task.id}
  style="left:{x}px; top:{y}px;"
  role="dialog"
  aria-label="Task {displayId}"
>
  <div class="tp-head">
    <div class="tp-chips">
      <span class="tp-chip" data-testid="tp-id">{displayId}</span>
      {#if lane}<span class="tp-chip">{lane}</span>{/if}
      <span class="tp-chip">{age}</span>
    </div>
    <div class="tp-head-actions">
      <button class="tp-icon" data-testid="tp-expand" title="Open full details" onclick={() => onExpand(task.id)}>
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>
      </button>
      <button class="tp-icon" data-testid="tp-close" title="Close" onclick={onClose}>
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
  </div>

  <div class="tp-title" title={task.title}>{task.title}</div>

  <div class="tp-edits">
    <label class="tp-field">
      <span>Status</span>
      <select
        data-testid="tp-status"
        value={task.status}
        onchange={(e) => onQuickEdit({ status: (e.currentTarget as HTMLSelectElement).value })}
      >
        {#each statuses as s (s)}<option value={s}>{s}</option>{/each}
      </select>
    </label>
    <label class="tp-field">
      <span>Priority</span>
      <select
        data-testid="tp-priority"
        value={task.priority ?? ''}
        onchange={(e) =>
          onQuickEdit({ priority: (e.currentTarget as HTMLSelectElement).value || undefined })}
      >
        <option value="">—</option>
        {#each priorities as p (p)}<option value={p}>{p}</option>{/each}
      </select>
    </label>
  </div>

  {#if task.description}
    <button class="tp-desc-toggle" data-testid="tp-desc-toggle" onclick={() => (showDescription = !showDescription)}>
      {showDescription ? 'Hide description' : 'Show description'}
    </button>
    {#if showDescription}<div class="tp-desc" data-testid="tp-desc">{task.description}</div>{/if}
  {/if}

  {#if planPct !== undefined}
    <div class="tp-plan" data-testid="tp-plan" title="{task.planProgress!.done}/{task.planProgress!.total} steps">
      <span class="tp-plan-fill" style="width:{planPct}%"></span>
    </div>
  {/if}

  {#if prereqs.length > 0}
    <div class="tp-rel">
      <span class="tp-rel-label">Prereqs</span>
      {#each prereqs as d (d)}<span class="tp-rel-chip" class:unmet={blockedBy.includes(d)}>{d}</span>{/each}
    </div>
  {/if}
  {#if unlocks.length > 0}
    <div class="tp-rel">
      <span class="tp-rel-label">Unlocks</span>
      {#each unlocks as u (u)}<span class="tp-rel-chip">{u}</span>{/each}
    </div>
  {/if}

  {#if task.claimedBy}
    <div class="tp-worker" data-testid="tp-worker">
      Claimed by {claimedByMe ? 'you' : task.claimedBy}{#if task.worktree} · {task.worktree}{/if}
    </div>
  {/if}

  {#if actions.length > 0}
    <div class="tp-actions" data-testid="tp-actions">
      {#each actions as a (a.key)}
        <button class="tp-btn" class:primary={a.primary} data-testid="tp-action-{a.kind}" onclick={() => onAction(a.kind, task.id)}>
          {a.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .tree-popover {
    position: absolute;
    z-index: 30;
    width: 300px;
    max-width: calc(100% - 16px);
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444));
    border-radius: 8px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    color: var(--vscode-foreground);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  }
  .tp-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .tp-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .tp-chip {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 8px;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
  }
  .tp-head-actions {
    display: flex;
    gap: 2px;
  }
  .tp-icon {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    padding: 3px;
    border-radius: 4px;
    color: var(--vscode-foreground);
    opacity: 0.8;
  }
  .tp-icon:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  }
  .tp-title {
    font-size: 13px;
    font-weight: 600;
    line-height: 1.3;
  }
  .tp-edits {
    display: flex;
    gap: 8px;
  }
  .tp-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    font-size: 10px;
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
  }
  .tp-field select {
    font-size: 12px;
    padding: 2px 4px;
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    background: var(--vscode-input-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #444));
    border-radius: 4px;
  }
  .tp-desc-toggle {
    all: unset;
    cursor: pointer;
    font-size: 11px;
    color: var(--vscode-textLink-foreground, #3794ff);
  }
  .tp-desc {
    font-size: 12px;
    max-height: 120px;
    overflow: auto;
    white-space: pre-wrap;
    opacity: 0.9;
  }
  .tp-plan {
    height: 5px;
    border-radius: 3px;
    background: var(--vscode-progressBar-background, rgba(255, 255, 255, 0.1));
    overflow: hidden;
  }
  .tp-plan-fill {
    display: block;
    height: 100%;
    background: var(--vscode-charts-green, #89d185);
  }
  .tp-rel {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    font-size: 11px;
  }
  .tp-rel-label {
    opacity: 0.7;
    margin-right: 2px;
  }
  .tp-rel-chip {
    font-size: 10px;
    padding: 0 6px;
    border-radius: 8px;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
  }
  .tp-rel-chip.unmet {
    background: var(--vscode-editorWarning-foreground, #cca700);
    color: var(--vscode-editor-background, #1e1e1e);
  }
  .tp-worker {
    font-size: 11px;
    opacity: 0.85;
  }
  .tp-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .tp-btn {
    all: unset;
    cursor: pointer;
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #fff);
  }
  .tp-btn.primary {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
  }
  .tp-btn:hover {
    background: var(--vscode-button-hoverBackground, #1177bb);
  }
</style>
