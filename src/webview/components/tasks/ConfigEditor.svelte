<script lang="ts">
  import type { Milestone } from '../../lib/types';
  import type { ConfigEdit } from '../../../core/types';

  interface Props {
    config: {
      project_name?: string;
      default_status?: string;
      statuses: string[];
      priorities: string[];
      labels: string[];
      milestones: Milestone[];
      definition_of_done: string[];
      auto_commit?: boolean;
      check_active_branches?: boolean;
      active_branch_days?: number;
      remote_operations?: boolean;
      bypass_git_hooks?: boolean;
    };
    onClose: () => void;
    onSave: (edits: ConfigEdit) => void;
  }

  let { config, onClose, onSave }: Props = $props();

  // Init-once: the modal is {#if}-mounted fresh per open, so capturing initial
  // prop values for working copies is intended.
  // svelte-ignore state_referenced_locally
  let workingStatuses = $state([...config.statuses]);
  // svelte-ignore state_referenced_locally
  let workingLabels = $state([...config.labels]);
  // svelte-ignore state_referenced_locally
  let workingMilestones = $state([...config.milestones.map((m) => m.name)]);
  // svelte-ignore state_referenced_locally
  let workingDod = $state([...config.definition_of_done]);
  // svelte-ignore state_referenced_locally
  let workingDefaultStatus = $state(config.default_status ?? config.statuses[0] ?? '');
  // svelte-ignore state_referenced_locally
  let workingAutoCommit = $state(config.auto_commit ?? false);
  // svelte-ignore state_referenced_locally
  let workingCheckBranches = $state(config.check_active_branches ?? false);
  // svelte-ignore state_referenced_locally
  let workingActiveDays = $state(config.active_branch_days ?? 30);
  // svelte-ignore state_referenced_locally
  let workingRemoteOps = $state(config.remote_operations ?? false);
  // svelte-ignore state_referenced_locally
  let workingBypassHooks = $state(config.bypass_git_hooks ?? false);

  type Tab = 'statuses' | 'labels' | 'milestones' | 'defaults';
  let activeTab = $state<Tab>('statuses');

  // Editing state
  let editingStatusIdx = $state<number | null>(null);
  let editStatusValue = $state('');
  let newStatus = $state('');
  let newLabel = $state('');
  let newMilestone = $state('');
  let newDodItem = $state('');

  // Move keyboard focus into the dialog when it opens (it is {#if}-mounted fresh
  // per open), so keyboard users land inside the modal rather than behind it.
  let modalEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    modalEl?.focus();
  });

  // Computed: statuses that differ from original (for detecting renames)
  function arraysEqual(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  function buildEdits(): ConfigEdit {
    const edits: ConfigEdit = {};

    if (!arraysEqual(workingStatuses, config.statuses)) {
      edits.statuses = [...workingStatuses];
    }
    if (!arraysEqual(workingLabels, config.labels)) {
      edits.labels = [...workingLabels];
    }
    if (!arraysEqual(workingMilestones, config.milestones.map((m) => m.name))) {
      // Milestones as plain string array in config.yml
    }
    if (!arraysEqual(workingDod, config.definition_of_done)) {
      edits.definition_of_done = [...workingDod];
    }
    if (workingDefaultStatus !== (config.default_status ?? '')) {
      edits.default_status = workingDefaultStatus;
    }
    if (workingAutoCommit !== (config.auto_commit ?? false)) {
      edits.auto_commit = workingAutoCommit;
    }
    if (workingCheckBranches !== (config.check_active_branches ?? false)) {
      edits.check_active_branches = workingCheckBranches;
    }
    if (workingActiveDays !== (config.active_branch_days ?? 30)) {
      edits.active_branch_days = workingActiveDays;
    }
    if (workingRemoteOps !== (config.remote_operations ?? false)) {
      edits.remote_operations = workingRemoteOps;
    }
    if (workingBypassHooks !== (config.bypass_git_hooks ?? false)) {
      edits.bypass_git_hooks = workingBypassHooks;
    }

    return edits;
  }

  function handleSave() {
    onSave(buildEdits());
  }

  // ── Statuses helpers ──
  function addStatus() {
    const s = newStatus.trim();
    if (!s || workingStatuses.includes(s)) return;
    workingStatuses = [...workingStatuses, s];
    newStatus = '';
  }

  function removeStatus(idx: number) {
    if (workingStatuses.length <= 2) return; // minimum 2
    workingStatuses = workingStatuses.filter((_, i) => i !== idx);
  }

  function moveStatus(idx: number, dir: -1 | 1) {
    const to = idx + dir;
    if (to < 0 || to >= workingStatuses.length) return;
    const next = [...workingStatuses];
    [next[idx], next[to]] = [next[to], next[idx]];
    workingStatuses = next;
  }

  function startRename(idx: number) {
    editingStatusIdx = idx;
    editStatusValue = workingStatuses[idx];
  }

  function commitRename() {
    if (editingStatusIdx === null) return;
    const val = editStatusValue.trim();
    if (val && !workingStatuses.some((s, i) => i !== editingStatusIdx && s === val)) {
      const next = [...workingStatuses];
      next[editingStatusIdx] = val;
      workingStatuses = next;
    }
    editingStatusIdx = null;
  }

  function cancelRename() {
    editingStatusIdx = null;
  }

  // ── Labels helpers ──
  function addLabel() {
    const l = newLabel.trim();
    if (!l || workingLabels.includes(l)) return;
    workingLabels = [...workingLabels, l];
    newLabel = '';
  }

  function removeLabel(idx: number) {
    workingLabels = workingLabels.filter((_, i) => i !== idx);
  }

  // ── Milestones helpers ──
  function addMilestone() {
    const m = newMilestone.trim();
    if (!m || workingMilestones.includes(m)) return;
    workingMilestones = [...workingMilestones, m];
    newMilestone = '';
  }

  function removeMilestone(idx: number) {
    workingMilestones = workingMilestones.filter((_, i) => i !== idx);
  }

  // ── DoD helpers ──
  function addDodItem() {
    const d = newDodItem.trim();
    if (!d) return;
    workingDod = [...workingDod, d];
    newDodItem = '';
  }

  function removeDodItem(idx: number) {
    workingDod = workingDod.filter((_, i) => i !== idx);
  }

  // Keyboard: escape closes, enter saves
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Overlay backdrop -->
<button
  class="config-overlay"
  onclick={onClose}
  aria-label="Close config editor"
  data-testid="config-editor-overlay"
></button>

<!-- Modal -->
<div
  class="config-modal"
  data-testid="config-editor-modal"
  role="dialog"
  aria-modal="true"
  aria-labelledby="config-modal-title"
  tabindex="-1"
  bind:this={modalEl}
>
  <div class="config-header">
    <h2 id="config-modal-title">Edit Board Config</h2>
    <button class="close-btn" onclick={onClose} aria-label="Close" data-testid="config-close">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  </div>

  <!-- Tabs -->
  <nav class="config-tabs" data-testid="config-tabs">
    <button class="tab-btn" class:active={activeTab === 'statuses'} onclick={() => (activeTab = 'statuses')}>Statuses</button>
    <button class="tab-btn" class:active={activeTab === 'labels'} onclick={() => (activeTab = 'labels')}>Labels</button>
    <button class="tab-btn" class:active={activeTab === 'milestones'} onclick={() => (activeTab = 'milestones')}>Milestones</button>
    <button class="tab-btn" class:active={activeTab === 'defaults'} onclick={() => (activeTab = 'defaults')}>Defaults &amp; Flags</button>
  </nav>

  <div class="config-body">
    <!-- Tab: Statuses -->
    {#if activeTab === 'statuses'}
      <div class="tab-content" data-testid="tab-statuses">
        <p class="tab-hint">Reorder, rename, add, or remove board statuses. Kanban columns update automatically.</p>
        <ul class="item-list" data-testid="statuses-list">
          {#each workingStatuses as status, idx (idx)}
            <li class="item-row" class:is-default={status === workingDefaultStatus}>
              <span class="drag-controls">
                <button
                  class="icon-btn-sm"
                  disabled={idx === 0}
                  onclick={() => moveStatus(idx, -1)}
                  aria-label="Move up"
                  title="Move up"
                >&#9650;</button>
                <button
                  class="icon-btn-sm"
                  disabled={idx === workingStatuses.length - 1}
                  onclick={() => moveStatus(idx, 1)}
                  aria-label="Move down"
                  title="Move down"
                >&#9660;</button>
              </span>

              {#if editingStatusIdx === idx}
                <input
                  type="text"
                  class="rename-input"
                  aria-label="Rename status"
                  bind:value={editStatusValue}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') cancelRename();
                  }}
                  onblur={commitRename}
                  data-testid="status-rename-input"
                />
              {:else}
                <span
                  class="item-name"
                  role="button"
                  tabindex="0"
                  ondblclick={() => startRename(idx)}
                  onkeydown={(e) => { if (e.key === 'Enter') startRename(idx); }}
                  data-testid="status-name-{idx}"
                >
                  {status}
                  {#if status === workingDefaultStatus}
                    <span class="default-badge">default</span>
                  {/if}
                </span>
              {/if}

              <button
                class="icon-btn-sm remove-btn"
                disabled={workingStatuses.length <= 2 || status === workingDefaultStatus}
                onclick={() => removeStatus(idx)}
                aria-label="Remove status"
                title={status === workingDefaultStatus ? 'Cannot remove the default status' : 'Remove'}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </li>
          {/each}
        </ul>
        <div class="add-row">
          <input
            type="text"
            placeholder="New status name..."
            aria-label="New status name"
            bind:value={newStatus}
            onkeydown={(e) => { if (e.key === 'Enter') addStatus(); }}
            data-testid="new-status-input"
          />
          <button class="add-btn" onclick={addStatus} disabled={!newStatus.trim()} data-testid="add-status-btn">Add</button>
        </div>
      </div>
    {/if}

    <!-- Tab: Labels -->
    {#if activeTab === 'labels'}
      <div class="tab-content" data-testid="tab-labels">
        <p class="tab-hint">Predefined labels available when creating or editing tasks.</p>
        <ul class="item-list" data-testid="labels-list">
          {#each workingLabels as label, idx (idx)}
            <li class="item-row">
              <span class="item-name">{label}</span>
              <button class="icon-btn-sm remove-btn" onclick={() => removeLabel(idx)} aria-label="Remove label">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </li>
          {/each}
        </ul>
        <div class="add-row">
          <input
            type="text"
            placeholder="New label..."
            aria-label="New label"
            bind:value={newLabel}
            onkeydown={(e) => { if (e.key === 'Enter') addLabel(); }}
            data-testid="new-label-input"
          />
          <button class="add-btn" onclick={addLabel} disabled={!newLabel.trim()} data-testid="add-label-btn">Add</button>
        </div>
      </div>
    {/if}

    <!-- Tab: Milestones -->
    {#if activeTab === 'milestones'}
      <div class="tab-content" data-testid="tab-milestones">
        <p class="tab-hint">Predefined milestones for task planning. Milestone files in <code>backlog/milestones/</code> take precedence.</p>
        <ul class="item-list" data-testid="milestones-list">
          {#each workingMilestones as milestone, idx (idx)}
            <li class="item-row">
              <span class="item-name">{milestone}</span>
              <button class="icon-btn-sm remove-btn" onclick={() => removeMilestone(idx)} aria-label="Remove milestone">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </li>
          {/each}
        </ul>
        <div class="add-row">
          <input
            type="text"
            placeholder="New milestone..."
            aria-label="New milestone"
            bind:value={newMilestone}
            onkeydown={(e) => { if (e.key === 'Enter') addMilestone(); }}
            data-testid="new-milestone-input"
          />
          <button class="add-btn" onclick={addMilestone} disabled={!newMilestone.trim()} data-testid="add-milestone-btn">Add</button>
        </div>
      </div>
    {/if}

    <!-- Tab: Defaults & Flags -->
    {#if activeTab === 'defaults'}
      <div class="tab-content defaults-tab" data-testid="tab-defaults">
        <div class="field-group">
          <label for="default-status">Default Status</label>
          <select id="default-status" bind:value={workingDefaultStatus} data-testid="default-status-select">
            {#each workingStatuses as s}
              <option value={s}>{s}</option>
            {/each}
          </select>
        </div>

        <div class="field-group" role="group" aria-labelledby="dod-group-label">
          <span class="field-label" id="dod-group-label">Definition of Done</span>
          <ul class="item-list" data-testid="dod-list">
            {#each workingDod as item, idx (idx)}
              <li class="item-row">
                <span class="item-name">{item}</span>
                <button class="icon-btn-sm remove-btn" onclick={() => removeDodItem(idx)} aria-label="Remove DoD item">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </li>
            {/each}
          </ul>
          <div class="add-row">
            <input
              type="text"
              placeholder="New DoD item..."
              aria-label="New Definition of Done item"
              bind:value={newDodItem}
              onkeydown={(e) => { if (e.key === 'Enter') addDodItem(); }}
              data-testid="new-dod-input"
            />
            <button class="add-btn" onclick={addDodItem} disabled={!newDodItem.trim()} data-testid="add-dod-btn">Add</button>
          </div>
        </div>

        <div class="field-group">
          <h3>Behavior Flags</h3>
          <label class="toggle-row">
            <input type="checkbox" bind:checked={workingAutoCommit} data-testid="flag-auto-commit" />
            <span>auto_commit — Auto-commit changes to git</span>
          </label>
          <label class="toggle-row">
            <input type="checkbox" bind:checked={workingCheckBranches} data-testid="flag-check-branches" />
            <span>check_active_branches — Monitor tasks across branches</span>
          </label>
          {#if workingCheckBranches}
            <div class="field-group indented">
              <label for="active-days">active_branch_days</label>
              <input
                id="active-days"
                type="number"
                min="1"
                max="365"
                bind:value={workingActiveDays}
                data-testid="flag-active-days"
              />
            </div>
          {/if}
          <label class="toggle-row">
            <input type="checkbox" bind:checked={workingRemoteOps} data-testid="flag-remote-ops" />
            <span>remote_operations — Enable remote branch operations</span>
          </label>
          <label class="toggle-row">
            <input type="checkbox" bind:checked={workingBypassHooks} data-testid="flag-bypass-hooks" />
            <span>bypass_git_hooks — Skip pre-commit hooks</span>
          </label>
        </div>
      </div>
    {/if}
  </div>

  <!-- Footer -->
  <div class="config-footer">
    <button class="cancel-btn" onclick={onClose} data-testid="config-cancel">Cancel</button>
    <button class="save-btn" onclick={handleSave} data-testid="config-save">Save Changes</button>
  </div>
</div>

<style>
  .config-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 100;
    border: none;
    cursor: default;
  }

  .config-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 101;
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #d4d4d4);
    border: 1px solid var(--vscode-widget-border, #3c3c3c);
    border-radius: 8px;
    width: 560px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .config-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px 12px;
    border-bottom: 1px solid var(--vscode-widget-border, #3c3c3c);
  }

  .config-header h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground, #999);
    cursor: pointer;
    padding: 2px;
    border-radius: 4px;
    display: flex;
    align-items: center;
  }

  .close-btn:hover {
    color: var(--vscode-editor-foreground, #d4d4d4);
    background: var(--vscode-toolbar-hoverBackground, #333);
  }

  .config-tabs {
    display: flex;
    border-bottom: 1px solid var(--vscode-widget-border, #3c3c3c);
    padding: 0 16px;
  }

  .tab-btn {
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground, #999);
    font-size: 13px;
    padding: 8px 14px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: color 0.15s, border-color 0.15s;
  }

  .tab-btn:hover {
    color: var(--vscode-editor-foreground, #d4d4d4);
  }

  .tab-btn.active {
    color: var(--vscode-foreground, #d4d4d4);
    border-bottom-color: var(--vscode-focusBorder, #007acc);
  }

  .config-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
  }

  .tab-content {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .tab-hint {
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #999);
    margin: 0 0 4px;
  }

  .tab-hint code {
    background: var(--vscode-textCodeBlock-background, #333);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 11px;
  }

  .item-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 260px;
    overflow-y: auto;
  }

  .item-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 4px;
    background: var(--vscode-input-background, #3c3c3c);
  }

  .item-row.is-default {
    background: var(--vscode-list-activeSelectionBackground, #094771);
  }

  .drag-controls {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .icon-btn-sm {
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground, #999);
    cursor: pointer;
    padding: 0 3px;
    font-size: 10px;
    line-height: 1.2;
    border-radius: 2px;
  }

  .icon-btn-sm:hover:not(:disabled) {
    color: var(--vscode-editor-foreground, #d4d4d4);
    background: var(--vscode-toolbar-hoverBackground, #444);
  }

  .icon-btn-sm:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .item-name {
    flex: 1;
    font-size: 13px;
    user-select: none;
  }

  .default-badge {
    display: inline-block;
    font-size: 10px;
    background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff);
    padding: 1px 6px;
    border-radius: 8px;
    margin-left: 8px;
    vertical-align: middle;
  }

  .rename-input {
    flex: 1;
    font-size: 13px;
    padding: 2px 6px;
    border: 1px solid var(--vscode-focusBorder, #007acc);
    border-radius: 3px;
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #d4d4d4);
    outline: none;
  }

  .remove-btn {
    opacity: 0.6;
  }

  .remove-btn:hover:not(:disabled) {
    opacity: 1;
    color: var(--vscode-errorForeground, #f44747);
  }

  .remove-btn:disabled {
    opacity: 0.15;
    cursor: not-allowed;
  }

  .add-row {
    display: flex;
    gap: 8px;
  }

  .add-row input {
    flex: 1;
    font-size: 13px;
    padding: 6px 10px;
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 4px;
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #d4d4d4);
    outline: none;
  }

  .add-row input:focus {
    border-color: var(--vscode-focusBorder, #007acc);
  }

  .add-btn {
    padding: 6px 14px;
    font-size: 13px;
    border: none;
    border-radius: 4px;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    cursor: pointer;
  }

  .add-btn:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground, #1177bb);
  }

  .add-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .config-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px 16px;
    border-top: 1px solid var(--vscode-widget-border, #3c3c3c);
  }

  .cancel-btn {
    padding: 6px 14px;
    font-size: 13px;
    border: 1px solid var(--vscode-button-secondaryBorder, #555);
    border-radius: 4px;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
    cursor: pointer;
  }

  .save-btn {
    padding: 6px 18px;
    font-size: 13px;
    border: none;
    border-radius: 4px;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    cursor: pointer;
    font-weight: 600;
  }

  .save-btn:hover {
    background: var(--vscode-button-hoverBackground, #1177bb);
  }

  /* Defaults tab */
  .field-group {
    margin-bottom: 16px;
  }

  .field-group label,
  .field-group .field-label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-descriptionForeground, #999);
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .field-group select,
  .field-group input[type="number"] {
    font-size: 13px;
    padding: 6px 10px;
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 4px;
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #d4d4d4);
    outline: none;
    width: 100%;
    max-width: 300px;
  }

  /* Restore a visible keyboard focus indicator (the `outline: none` above left
     these fields with none). Matches the border-focus pattern used elsewhere. */
  .field-group select:focus-visible,
  .field-group input[type='number']:focus-visible {
    border-color: var(--vscode-focusBorder, #007fd4);
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: -1px;
  }

  .toggle-row {
    display: flex !important;
    align-items: center;
    gap: 8px;
    font-size: 13px !important;
    font-weight: normal !important;
    text-transform: none !important;
    letter-spacing: normal !important;
    padding: 4px 0;
    cursor: pointer;
  }

  .toggle-row input[type="checkbox"] {
    width: 16px;
    height: 16px;
    cursor: pointer;
  }

  .indented {
    margin-left: 24px;
  }

  h3 {
    font-size: 13px;
    font-weight: 600;
    margin: 0 0 8px;
  }
</style>
