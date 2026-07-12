/**
 * Tab modes for the unified Tasks view
 */
export type TabMode =
  | 'tree'
  | 'kanban'
  | 'list'
  | 'drafts'
  | 'archived'
  | 'dashboard'
  | 'docs'
  | 'decisions';

/**
 * Sort mode for the kanban board within each status column.
 * Session-scoped UI preference; does not persist to disk.
 */
export type SortMode = 'default' | 'priority' | 'task-number';

/**
 * Re-export core types for use in webview components
 *
 * This provides a clean import path for webview code to access
 * the shared type definitions without reaching into src/core.
 */
export type {
  Task,
  TaskStatus,
  TaskPriority,
  TaskIdDisplayMode,
  TaskSource,
  TaskFolder,
  TasksViewSettings,
  ChecklistItem,
  Milestone,
  BacklogConfig,
  BacklogDocument,
  BacklogDecision,
  DecisionStatus,
  DocumentType,
  WebviewMessage,
  ExtensionMessage,
  DataSourceMode,
  MergeTaskState,
  NavigatorTask,
} from '../../core/types';
export { isReadOnlyTask, getReadOnlyTaskContext } from '../../core/types';
export type { MergeMode } from '../../core/mergeQueue';
export type { TreeLayout } from '../../core/treeLayout';

// `export type { … } from` re-exports a name without binding it locally, so the two types
// used in this file's own interfaces below must also be imported.
import type { MergeTaskState } from '../../core/types';
import type { MergeMode } from '../../core/mergeQueue';

/**
 * Dashboard statistics data structure
 */
export interface DashboardStats {
  totalTasks: number;
  completedCount: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  milestones: MilestoneStats[];
}

export interface MilestoneStats {
  name: string;
  total: number;
  done: number;
}

/**
 * Task detail view data sent from extension
 */
export interface TaskDetailData {
  task: import('../../core/types').Task;
  statuses: string[];
  priorities: string[];
  uniqueLabels: string[];
  uniqueAssignees: string[];
  milestones: Array<{ id: string; label: string }>;
  blocksTaskIds: string[];
  linkableTasks: Array<{ id: string; title: string; status: string }>;
  isBlocked: boolean;
  missingDependencyIds?: string[];
  descriptionHtml: string;
  planHtml: string;
  notesHtml: string;
  finalSummaryHtml: string;
  isDraft?: boolean;
  isArchived?: boolean;
  isReadOnly?: boolean;
  readOnlyReason?: string;
  parentTask?: { id: string; title: string };
  subtaskSummaries?: Array<{ id: string; title: string; status: string }>;
  claimIdentity?: string;
  isActiveTask?: boolean;
  planProgress?: { total: number; done: number; percent: number; exists: boolean };
  /** Merge-queue state for this task, when it is awaiting integration. */
  mergeState?: MergeTaskState;
  /** Active merge mode (drives which review controls show). */
  mergeMode?: MergeMode;
}
