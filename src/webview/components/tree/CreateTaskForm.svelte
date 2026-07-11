<script lang="ts" module>
  export interface CreateTaskPayload {
    title: string;
    description?: string;
    priority?: string;
    category?: string;
    milestone?: string;
    /** Q1 blessed deviation: `taskType` on the wire — never name this `type` (it would
     * collide with the createTask message envelope discriminant when posted). */
    taskType?: 'bug';
    causedBy?: string;
    openAfter?: boolean;
  }
</script>

<script lang="ts">
  import type { Task, Milestone } from '../../lib/types';

  interface Props {
    mode: 'full' | 'quick';
    bugMode?: boolean;
    prefill?: { category?: string; milestone?: string; causedBy?: string };
    /** Lane vocabulary (the category picker drops `Bugs`; `Misc` = no category). */
    laneOrder: string[];
    /** Config milestones for the milestone picker (`Backburner` = no milestone). */
    milestones: Milestone[];
    priorities: string[];
    /** In-webview tasks for the caused_by search datalist. */
    tasks: Array<Pick<Task, 'id' | 'title'>>;
    onSubmit: (payload: CreateTaskPayload) => void;
    onClose: () => void;
  }
  let {
    mode,
    bugMode = false,
    prefill,
    laneOrder,
    milestones,
    priorities,
    tasks,
    onSubmit,
    onClose,
  }: Props = $props();

  const MISC = 'Misc';
  const BACKBURNER = 'Backburner';

  // Bug is a mode of the form: type:'bug', no category/milestone, priority relabeled "Severity".
  // Init-once by design: the form is {#if}-mounted fresh per open, so capturing the initial
  // prop values is intended (state_referenced_locally is a false positive here).
  // svelte-ignore state_referenced_locally
  let isBug = $state(bugMode);
  let title = $state('');
  let description = $state('');
  let priority = $state('');
  // svelte-ignore state_referenced_locally
  let category = $state(prefill?.category ?? MISC);
  // svelte-ignore state_referenced_locally
  let milestone = $state(prefill?.milestone ?? BACKBURNER);
  // svelte-ignore state_referenced_locally
  let causedBy = $state(prefill?.causedBy ?? '');

  // Category options: keep Misc first, drop the Bugs lane, de-dupe Misc from laneOrder.
  const categoryOptions = $derived([MISC, ...laneOrder.filter((l) => l !== 'Bugs' && l !== MISC)]);
  const priorityLabel = $derived(isBug ? 'Severity' : 'Priority');

  let titleEl: HTMLInputElement | undefined = $state();
  $effect(() => {
    titleEl?.focus();
  });

  function buildPayload(openAfter: boolean): CreateTaskPayload | null {
    const t = title.trim();
    if (!t) {
      titleEl?.focus();
      return null;
    }
    if (mode === 'quick') return { title: t, openAfter };
    if (isBug) {
      const p: CreateTaskPayload = { title: t, taskType: 'bug', openAfter };
      if (description.trim()) p.description = description.trim();
      if (priority) p.priority = priority;
      if (causedBy.trim()) p.causedBy = causedBy.trim();
      return p;
    }
    const p: CreateTaskPayload = { title: t, openAfter };
    if (description.trim()) p.description = description.trim();
    if (priority) p.priority = priority;
    if (category && category !== MISC) p.category = category;
    if (milestone && milestone !== BACKBURNER) p.milestone = milestone;
    return p;
  }

  function submit(openAfter: boolean) {
    const payload = buildPayload(openAfter);
    if (payload) onSubmit(payload);
  }

  function onTitleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit(e.shiftKey); // Shift+Enter = Create & open
    }
  }

  function onRootKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onRootKeydown} />

<div class="cf-backdrop" data-testid="create-form-backdrop" onpointerdown={onClose} role="presentation"></div>

<div class="cf-panel" data-testid="create-form" role="dialog" aria-label="Create task" aria-modal="true">
  <div class="cf-head">
    <span class="cf-head-label">
      {mode === 'quick' ? 'Quick capture' : isBug ? 'Report bug' : 'New task'}
    </span>
    <button class="cf-icon" data-testid="cf-close" title="Close" onclick={onClose} aria-label="Close">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
    </button>
  </div>

  <input
    class="cf-input"
    data-testid="cf-title"
    aria-label="Task title"
    bind:this={titleEl}
    bind:value={title}
    placeholder="Task title"
    onkeydown={onTitleKeydown}
  />

  {#if mode === 'full'}
    <div class="cf-toggle-row" data-testid="cf-type-toggle">
      <button class="cf-toggle" class:active={!isBug} data-testid="cf-toggle-task" onclick={() => (isBug = false)}>Task</button>
      <button class="cf-toggle" class:active={isBug} data-testid="cf-toggle-bug" onclick={() => (isBug = true)}>Bug</button>
    </div>

    {#if !isBug}
      <label class="cf-field">
        <span>Category</span>
        <select class="cf-select" data-testid="cf-category" bind:value={category}>
          {#each categoryOptions as c (c)}<option value={c}>{c}</option>{/each}
        </select>
      </label>
    {/if}

    <label class="cf-field">
      <span>{priorityLabel}</span>
      <select class="cf-select" data-testid="cf-priority" bind:value={priority}>
        <option value="">—</option>
        {#each priorities as p (p)}<option value={p}>{p}</option>{/each}
      </select>
    </label>

    {#if !isBug}
      <label class="cf-field">
        <span>Milestone</span>
        <!-- Submitting m.id (not m.name): BacklogParser.resolveMilestoneValue resolves
             both IDs and names to the canonical milestone name on read. Submitting the
             ID keeps the create payload unambiguous; the read path normalizes it to
             the display name for band grouping (TASK-33). -->
        <select class="cf-select" data-testid="cf-milestone" bind:value={milestone}>
          <option value={BACKBURNER}>{BACKBURNER}</option>
          {#each milestones as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
        </select>
      </label>
    {/if}

    {#if isBug}
      <label class="cf-field">
        <span>Caused by</span>
        <input
          class="cf-input"
          data-testid="cf-causedby"
          list="cf-causedby-list"
          bind:value={causedBy}
          placeholder="Task ID (optional)"
        />
        <datalist id="cf-causedby-list">
          {#each tasks as t (t.id)}<option value={t.id}>{t.title}</option>{/each}
        </datalist>
      </label>
    {/if}

    <label class="cf-field">
      <span>Description</span>
      <textarea class="cf-textarea" data-testid="cf-description" bind:value={description} placeholder="Optional description (Markdown)"></textarea>
    </label>
  {/if}

  <div class="cf-actions">
    <button class="cf-btn primary" data-testid="cf-submit" onclick={() => submit(false)}>Create</button>
    <button class="cf-btn" data-testid="cf-submit-open" onclick={() => submit(true)}>Create &amp; open</button>
  </div>
</div>

<style>
  .cf-backdrop {
    position: absolute;
    inset: 0;
    z-index: 40;
    background: rgba(0, 0, 0, 0.35);
  }
  .cf-panel {
    position: absolute;
    z-index: 41;
    top: 48px;
    left: 50%;
    transform: translateX(-50%);
    width: 340px;
    max-width: calc(100% - 24px);
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444));
    border-radius: 8px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    color: var(--vscode-foreground);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
  }
  .cf-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .cf-head-label {
    font-size: 13px;
    font-weight: 600;
  }
  .cf-icon {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    padding: 3px;
    border-radius: 4px;
    color: var(--vscode-foreground);
    opacity: 0.8;
  }
  .cf-icon:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  }
  .cf-input,
  .cf-textarea,
  .cf-select {
    width: 100%;
    box-sizing: border-box;
    font-size: 13px;
    padding: 6px 8px;
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    background: var(--vscode-input-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #444));
    border-radius: 4px;
  }
  .cf-input:focus,
  .cf-textarea:focus,
  .cf-select:focus {
    outline: none;
    border-color: var(--vscode-focusBorder);
  }
  .cf-textarea {
    min-height: 72px;
    resize: vertical;
    font-family: inherit;
  }
  .cf-field {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
  }
  .cf-toggle-row {
    display: flex;
    gap: 4px;
  }
  .cf-toggle {
    all: unset;
    cursor: pointer;
    flex: 1;
    text-align: center;
    font-size: 12px;
    padding: 4px 0;
    border-radius: 4px;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #444));
    color: var(--vscode-foreground);
    opacity: 0.75;
  }
  .cf-toggle.active {
    opacity: 1;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    border-color: var(--vscode-focusBorder, transparent);
  }
  .cf-actions {
    display: flex;
    gap: 8px;
    margin-top: 2px;
  }
  .cf-btn {
    all: unset;
    cursor: pointer;
    font-size: 12px;
    padding: 5px 12px;
    border-radius: 4px;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #fff);
  }
  .cf-btn.primary {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
  }
  .cf-btn:hover {
    background: var(--vscode-button-hoverBackground, #1177bb);
  }
</style>
