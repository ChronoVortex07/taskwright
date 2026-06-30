<script lang="ts">
  import { onMount } from 'svelte';
  import { onMessage, vscode } from '../../stores/vscode.svelte';
  import type { TaskDetailData, Task } from '../../lib/types';
  import TaskHeader from './TaskHeader.svelte';
  import MetaSection from './MetaSection.svelte';
  import SubtasksSection from './SubtasksSection.svelte';
  import Checklist from './Checklist.svelte';
  import MarkdownSection from './MarkdownSection.svelte';
  import ActionButtons from './ActionButtons.svelte';

  // View state
  type ViewState = 'loading' | 'ready' | 'error';
  let viewState: ViewState = $state('loading');
  let errorMessage = $state('');

  // Task data
  let task: Task | null = $state(null);
  let statuses: string[] = $state([]);
  let uniqueLabels: string[] = $state([]);
  let uniqueAssignees: string[] = $state([]);
  let milestones: Array<{ id: string; label: string }> = $state([]);
  let blocksTaskIds: string[] = $state([]);
  let linkableTasks: Array<{ id: string; title: string; status: string }> = $state([]);
  let isBlocked = $state(false);
  let missingDependencyIds: string[] = $state([]);
  let descriptionHtml = $state('');
  let planHtml = $state('');
  let notesHtml = $state('');
  let finalSummaryHtml = $state('');
  let isDraft = $state(false);
  let isArchived = $state(false);
  let isReadOnly = $state(false);
  let readOnlyReason = $state('');
  let parentTask: { id: string; title: string } | undefined = $state(undefined);
  let subtaskSummaries: Array<{ id: string; title: string; status: string }> | undefined = $state(undefined);
  let claimedBy: string | undefined = $state(undefined);
  let claimWorktree: string | undefined = $state(undefined);
  let claimedAt: string | undefined = $state(undefined);
  let claimIdentity: string | undefined = $state(undefined);
  let isActiveTask = $state(false);
  let planPath: string | undefined = $state(undefined);
  let planProgress:
    | { total: number; done: number; percent: number; exists: boolean }
    | undefined = $state(undefined);

  let isClaimed = $derived(!!claimedBy);
  let claimedByMe = $derived(!!claimedBy && claimedBy === claimIdentity);
  let planName = $derived(planPath ? (planPath.split('/').pop() ?? planPath) : '');

  // Handle messages from extension
  onMessage((message) => {
    switch (message.type) {
      case 'taskData':
        {
          const data = message.data as TaskDetailData;
          task = data.task;
          statuses = data.statuses;
          uniqueLabels = data.uniqueLabels;
          uniqueAssignees = data.uniqueAssignees;
          milestones = data.milestones;
          blocksTaskIds = data.blocksTaskIds;
          linkableTasks = data.linkableTasks ?? [];
          isBlocked = data.isBlocked;
          missingDependencyIds = data.missingDependencyIds ?? [];
          descriptionHtml = data.descriptionHtml;
          planHtml = data.planHtml ?? '';
          notesHtml = data.notesHtml ?? '';
          finalSummaryHtml = data.finalSummaryHtml ?? '';
          isDraft = data.isDraft ?? false;
          isArchived = data.isArchived ?? false;
          isReadOnly = data.isReadOnly ?? false;
          readOnlyReason = data.readOnlyReason ?? '';
          parentTask = data.parentTask;
          subtaskSummaries = data.subtaskSummaries;
          claimedBy = data.task.claimedBy;
          claimWorktree = data.task.worktree;
          claimedAt = data.task.claimedAt;
          claimIdentity = data.claimIdentity;
          isActiveTask = data.isActiveTask ?? false;
          planPath = data.task.plan;
          planProgress = data.planProgress;
          viewState = 'ready';
        }
        break;

      case 'error':
        errorMessage = (message as { type: 'error'; message: string }).message;
        viewState = 'error';
        break;
    }
  });

  // Request task data on mount
  onMount(() => {
    vscode.postMessage({ type: 'refresh' });
  });

  // Message handlers
  function handleUpdateTitle(title: string) {
    vscode.postMessage({ type: 'updateField', field: 'title', value: title });
  }

  function handleUpdateStatus(status: string) {
    vscode.postMessage({ type: 'updateField', field: 'status', value: status });
  }

  function handleUpdatePriority(priority: string | undefined) {
    vscode.postMessage({ type: 'updateField', field: 'priority', value: priority });
  }

  function handleUpdateLabels(labels: string[]) {
    vscode.postMessage({ type: 'updateField', field: 'labels', value: labels });
  }

  function handleUpdateAssignees(assignees: string[]) {
    vscode.postMessage({ type: 'updateField', field: 'assignee', value: assignees });
  }

  function handleUpdateMilestone(milestone: string | undefined) {
    vscode.postMessage({ type: 'updateField', field: 'milestone', value: milestone });
  }

  function handleRequestCreateMilestone() {
    vscode.postMessage({ type: 'createMilestone' });
  }

  function handleUpdateDescription(description: string) {
    vscode.postMessage({ type: 'updateField', field: 'description', value: description });
  }

  function handleToggleChecklist(listType: string, itemId: number) {
    vscode.postMessage({ type: 'toggleChecklistItem', listType, itemId });
  }

  function handleUpdateAcceptanceCriteria(text: string) {
    vscode.postMessage({ type: 'updateField', field: 'acceptanceCriteria', value: text });
  }

  function handleUpdateDefinitionOfDone(text: string) {
    vscode.postMessage({ type: 'updateField', field: 'definitionOfDone', value: text });
  }

  function handleUpdatePlan(value: string) {
    vscode.postMessage({ type: 'updateField', field: 'implementationPlan', value });
  }

  function handleUpdateImplementationNotes(value: string) {
    vscode.postMessage({ type: 'updateField', field: 'implementationNotes', value });
  }

  function handleUpdateFinalSummary(value: string) {
    vscode.postMessage({ type: 'updateField', field: 'finalSummary', value });
  }

  function handleOpenTask(taskId: string) {
    vscode.postMessage({ type: 'openTask', taskId });
  }

  function handleAddBlockedByLink(taskId: string) {
    vscode.postMessage({ type: 'addBlockedByLink', taskId });
  }

  function handleAddBlocksLink(taskId: string) {
    vscode.postMessage({ type: 'addBlocksLink', taskId });
  }

  function handleRemoveBlockedByLink(taskId: string) {
    vscode.postMessage({ type: 'removeBlockedByLink', taskId });
  }

  function handleRemoveBlocksLink(taskId: string) {
    vscode.postMessage({ type: 'removeBlocksLink', taskId });
  }

  function handleFilterByLabel(label: string) {
    vscode.postMessage({ type: 'filterByLabel', label });
  }

  function handleOpenFile() {
    vscode.postMessage({ type: 'openFile' });
  }

  function handleArchive() {
    if (task) {
      vscode.postMessage({ type: 'archiveTask', taskId: task.id });
    }
  }

  function handlePromoteDraft() {
    if (task) {
      vscode.postMessage({ type: 'promoteDraft', taskId: task.id });
    }
  }

  function handleDiscardDraft() {
    if (task) {
      vscode.postMessage({ type: 'discardDraft', taskId: task.id });
    }
  }

  function handleCreateSubtask() {
    if (task) {
      vscode.postMessage({ type: 'createSubtask', parentTaskId: task.id });
    }
  }

  function handleRestore() {
    if (task) {
      vscode.postMessage({ type: 'restoreTask', taskId: task.id });
    }
  }

  function handleDelete() {
    if (task) {
      vscode.postMessage({ type: 'deleteTask', taskId: task.id });
    }
  }

  function handleClaim() {
    if (task) {
      vscode.postMessage({ type: 'claimTask', taskId: task.id });
    }
  }

  function handleRelease() {
    if (task) {
      vscode.postMessage({ type: 'releaseTask', taskId: task.id });
    }
  }

  function handleSetActive() {
    if (task) {
      vscode.postMessage({ type: 'setActiveTask', taskId: task.id });
    }
  }

  function handleClearActive() {
    if (task) {
      vscode.postMessage({ type: 'clearActiveTask', taskId: task.id });
    }
  }

  function handleDispatch() {
    if (task) {
      vscode.postMessage({ type: 'dispatchTask', taskId: task.id });
    }
  }

  function handleAttachPlan() {
    if (task) {
      vscode.postMessage({ type: 'attachPlan', taskId: task.id });
    }
  }

  function handleDetachPlan() {
    if (task) {
      vscode.postMessage({ type: 'detachPlan', taskId: task.id });
    }
  }

  function handleOpenPlan() {
    if (task) {
      vscode.postMessage({ type: 'openPlan', taskId: task.id });
    }
  }
</script>

{#if viewState === 'loading'}
  <div class="loading-state">
    <p>Loading task...</p>
  </div>
{:else if viewState === 'error'}
  <div class="error-state">
    <p>{errorMessage}</p>
  </div>
{:else if task}
  <TaskHeader
    taskId={task.id}
    title={task.title}
    status={task.status}
    priority={task.priority}
    {statuses}
    {isBlocked}
    {isReadOnly}
    onUpdateTitle={handleUpdateTitle}
    onUpdateStatus={handleUpdateStatus}
    onUpdatePriority={handleUpdatePriority}
  />

  {#if isReadOnly}
    <div class="draft-banner readonly-banner" data-testid="readonly-banner">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v12"/><path d="M18 9a3 3 0 0 0-3-3H6"/><path d="M6 15h9a3 3 0 1 1 0 6h-3"/></svg>
      <span>{readOnlyReason || 'This task is read-only.'}</span>
    </div>
  {:else if isArchived}
    <div class="draft-banner archived-banner">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>
      <span>Archived — this task has been archived</span>
      <div class="draft-banner-actions">
        <button class="draft-promote-btn" data-testid="restore-archived-btn" onclick={handleRestore}>Restore</button>
      </div>
    </div>
  {:else if isDraft}
    <div class="draft-banner">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>
      <span>Draft — changes saved automatically</span>
      <div class="draft-banner-actions">
        <button class="draft-promote-btn" data-testid="promote-draft-btn" onclick={handlePromoteDraft}>Save as Task</button>
        <button class="draft-discard-btn" data-testid="discard-draft-btn" onclick={handleDiscardDraft}>Discard</button>
      </div>
    </div>
  {/if}

  {#if !isDraft && !isReadOnly && !isArchived}
    <div class="claim-banner" class:claimed={isClaimed} data-testid="claim-banner">
      {#if isClaimed}
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <span class="claim-info">
          Claimed by <strong>{claimedByMe ? 'you' : claimedBy}</strong>
          {#if claimWorktree}<span class="claim-worktree" title="Worktree / branch">on {claimWorktree}</span>{/if}
          {#if claimedAt}<span class="claim-time">· {claimedAt}</span>{/if}
        </span>
        <div class="claim-banner-actions">
          <button class="claim-release-btn" data-testid="release-task-btn" onclick={handleRelease}>Release</button>
        </div>
      {:else}
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
        <span class="claim-info">Unclaimed</span>
        <div class="claim-banner-actions">
          <button class="claim-btn" data-testid="claim-task-btn" onclick={handleClaim}>Claim</button>
        </div>
      {/if}
    </div>

    <div class="claim-banner" class:claimed={isActiveTask} data-testid="active-task-banner">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>
      {#if isActiveTask}
        <span class="claim-info">Active task — agents calling <code>get_active_task</code> see this one</span>
        <div class="claim-banner-actions">
          <button class="claim-release-btn" data-testid="clear-active-btn" onclick={handleClearActive}>Clear</button>
        </div>
      {:else}
        <span class="claim-info">Not the active task</span>
        <div class="claim-banner-actions">
          <button class="claim-btn" data-testid="set-active-btn" onclick={handleSetActive}>Set active</button>
        </div>
      {/if}
    </div>

    <div class="claim-banner" data-testid="dispatch-banner">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>
      <span class="claim-info">Dispatch a fresh session — copies a paste-ready prompt</span>
      <div class="claim-banner-actions">
        <button class="claim-btn" data-testid="dispatch-task-btn" onclick={handleDispatch}>Dispatch</button>
      </div>
    </div>

    <div class="claim-banner plan-banner" class:claimed={!!planPath} data-testid="plan-banner">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m9 15 2 2 4-4"/></svg>
      {#if planPath}
        <span class="claim-info plan-info">
          {#if planProgress && planProgress.exists}
            <span class="plan-name" title={planPath}>{planName}</span>
            <span class="plan-stats">{planProgress.done}/{planProgress.total} steps · {planProgress.percent}%</span>
            <span class="plan-bar" aria-hidden="true"><span class="plan-bar-fill" style="width:{planProgress.percent}%"></span></span>
          {:else}
            <span class="plan-name" title={planPath}>{planName}</span>
            <span class="plan-missing" data-testid="plan-missing">plan file not found</span>
          {/if}
        </span>
        <div class="claim-banner-actions">
          <button class="claim-btn" data-testid="open-plan-btn" onclick={handleOpenPlan}>Open</button>
          <button class="claim-release-btn" data-testid="detach-plan-btn" onclick={handleDetachPlan}>Detach</button>
        </div>
      {:else}
        <span class="claim-info">No plan attached</span>
        <div class="claim-banner-actions">
          <button class="claim-btn" data-testid="attach-plan-btn" onclick={handleAttachPlan}>Attach plan</button>
        </div>
      {/if}
    </div>
  {/if}

  {#key task.id}
    <MetaSection
      labels={task.labels}
      assignees={task.assignee}
      milestone={task.milestone}
      dependencies={task.dependencies}
      {blocksTaskIds}
      {missingDependencyIds}
      {uniqueLabels}
      {uniqueAssignees}
      {milestones}
      {linkableTasks}
      {parentTask}
      onUpdateLabels={handleUpdateLabels}
      onUpdateAssignees={handleUpdateAssignees}
      onUpdateMilestone={handleUpdateMilestone}
      onRequestCreateMilestone={handleRequestCreateMilestone}
      onOpenTask={handleOpenTask}
      onAddBlockedByLink={handleAddBlockedByLink}
      onAddBlocksLink={handleAddBlocksLink}
      onRemoveBlockedByLink={handleRemoveBlockedByLink}
      onRemoveBlocksLink={handleRemoveBlocksLink}
      onFilterByLabel={handleFilterByLabel}
      {isReadOnly}
    />
  {/key}

  {#if subtaskSummaries && subtaskSummaries.length > 0}
    <SubtasksSection
      subtasks={subtaskSummaries}
      {statuses}
      onOpenTask={handleOpenTask}
      onCreateSubtask={handleCreateSubtask}
      {isReadOnly}
    />
  {/if}

  <MarkdownSection
    taskId={task.id}
    title="Description"
    fieldName="description"
    content={task.description || ''}
    contentHtml={descriptionHtml}
    emptyLabel="No description"
    onUpdate={handleUpdateDescription}
    {isReadOnly}
  />

  <Checklist
    title="Acceptance Criteria"
    items={task.acceptanceCriteria}
    listType="acceptanceCriteria"
    taskId={task.id}
    onToggle={handleToggleChecklist}
    onUpdateText={handleUpdateAcceptanceCriteria}
    {isReadOnly}
  />

  <Checklist
    title="Definition of Done"
    items={task.definitionOfDone}
    listType="definitionOfDone"
    taskId={task.id}
    onToggle={handleToggleChecklist}
    onUpdateText={handleUpdateDefinitionOfDone}
    {isReadOnly}
  />

  <MarkdownSection
    taskId={task.id}
    title="Implementation Plan"
    fieldName="implementationPlan"
    content={task.implementationPlan || ''}
    contentHtml={planHtml}
    emptyLabel="No plan"
    onUpdate={handleUpdatePlan}
    {isReadOnly}
  />

  <MarkdownSection
    taskId={task.id}
    title="Implementation Notes"
    fieldName="implementationNotes"
    content={task.implementationNotes || ''}
    contentHtml={notesHtml}
    emptyLabel="No notes"
    onUpdate={handleUpdateImplementationNotes}
    {isReadOnly}
  />

  {#if task.finalSummary || !isReadOnly}
    <MarkdownSection
      taskId={task.id}
      title="Final Summary"
      fieldName="finalSummary"
      content={task.finalSummary || ''}
      contentHtml={finalSummaryHtml}
      emptyLabel="No summary"
      onUpdate={handleUpdateFinalSummary}
      {isReadOnly}
    />
  {/if}

  <ActionButtons
    onOpenFile={handleOpenFile}
    onArchive={handleArchive}
    onRestore={handleRestore}
    onDelete={handleDelete}
    {isDraft}
    {isArchived}
    {isReadOnly}
  />
{/if}
