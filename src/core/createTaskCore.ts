/**
 * Shared create core (P3a). The single writer sequence behind both the human
 * create form (TasksController) and the agent MCP tool (createTaskHandler) —
 * human/agent parity. vscode-free: it only touches the injected parser/writer/
 * treeFieldService. Callers layer their own validation on top (the MCP handler
 * validates status/priority/dependency-existence before calling this).
 */
import type { BacklogParser } from './BacklogParser';
import type { BacklogWriter } from './BacklogWriter';
import type { TreeFieldService } from './TreeFieldService';
import type { Task } from './types';
import { wouldCreateCycle } from './treeGate';

export interface CreateTaskCoreDeps {
  parser: BacklogParser;
  writer: BacklogWriter;
  /** Path to the `backlog/` directory (parent of `tasks/`). */
  backlogPath: string;
  treeFieldService: TreeFieldService;
}

export interface CreateTaskLink {
  /** The existing task the drag started from. */
  taskId: string;
  /**
   * The origin node's connect handle (P3b maps its handles onto these):
   *  - 'unlocks' (right handle): origin unlocks the new task ⇒ new.dependencies += origin.
   *  - 'needs'   (left handle):  origin needs the new task   ⇒ origin.dependencies += new.
   */
  direction: 'needs' | 'unlocks';
}

export interface CreateTaskCoreArgs {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  labels?: string[];
  assignee?: string[];
  milestone?: string;
  category?: string;
  type?: string;
  causedBy?: string;
  dependencies?: string[];
  draft?: boolean;
  /** Post-create dependency wiring for drop-on-empty (built now for P3b; the P3a form never sets it). */
  linkTo?: CreateTaskLink;
}

/** Validate the `type` value: only 'bug' or absent is allowed. Returns the trimmed value or undefined. */
export function normalizeType(type: string | undefined): string | undefined {
  if (type === undefined) return undefined;
  const t = type.trim();
  if (t === '') return undefined;
  if (t !== 'bug') {
    throw new Error(`Invalid type "${type}". Only "bug" (or none) is allowed.`);
  }
  return 'bug';
}

/** Append `depId` to `current` without duplicates (case-insensitive), preserving order. */
function appendDep(current: string[], depId: string): string[] {
  const key = depId.trim().toUpperCase();
  if (current.some((d) => d.trim().toUpperCase() === key)) return current;
  return [...current, depId];
}

/**
 * The one create writer sequence: BacklogWriter.createTask/createDraft →
 * updateTask({type,dependencies}) → TreeFieldService.setCategory/setCausedBy →
 * optional linkTo dependency wiring. Returns the new id.
 */
export async function createTaskWithTreeFields(
  deps: CreateTaskCoreDeps,
  args: CreateTaskCoreArgs
): Promise<{ id: string }> {
  const title = args.title?.trim();
  if (!title) throw new Error('A task title is required.');
  const type = normalizeType(args.type);
  const causedBy = args.causedBy?.trim();
  if (causedBy && type !== 'bug') {
    throw new Error('caused_by can only be set on a bug (type: bug).');
  }
  const dependencies = args.dependencies ?? [];
  if (args.draft && args.status !== undefined) {
    throw new Error('drafts always have status Draft; do not set status on a draft.');
  }

  let id: string;
  if (args.draft) {
    ({ id } = await deps.writer.createDraft(deps.backlogPath, deps.parser, {
      title,
      description: args.description,
    }));
  } else {
    ({ id } = await deps.writer.createTask(
      deps.backlogPath,
      {
        title,
        description: args.description,
        status: args.status,
        priority: args.priority,
        labels: args.labels,
        assignee: args.assignee,
        milestone: args.milestone,
      },
      deps.parser
    ));
  }

  // type / dependencies go through BacklogWriter (both serialized there). On the DRAFT
  // path, createDraft accepts only title/description, so priority/milestone/labels/
  // assignee are folded into the SAME updateTask (GAP-2 — one write, not two).
  const canonical: Partial<Task> = {};
  if (type !== undefined) canonical.type = type;
  if (dependencies.length > 0) canonical.dependencies = dependencies;
  if (args.draft) {
    if (args.priority !== undefined) canonical.priority = args.priority;
    if (args.milestone !== undefined) canonical.milestone = args.milestone;
    if (args.labels !== undefined) canonical.labels = args.labels;
    if (args.assignee !== undefined) canonical.assignee = args.assignee;
  }
  if (Object.keys(canonical).length > 0) {
    await deps.writer.updateTask(id, canonical, deps.parser);
  }

  // category / caused_by are Taskwright-only: written surgically after create.
  if (args.category !== undefined && args.category.trim() !== '') {
    await deps.treeFieldService.setCategory(id, args.category, deps.parser);
  }
  if (causedBy) {
    await deps.treeFieldService.setCausedBy(id, causedBy, deps.parser);
  }

  if (args.linkTo) {
    await applyLinkTo(deps, id, args.linkTo);
  }

  return { id };
}

/**
 * Wire the drop-on-empty dependency edge, defended against cycles (belt-and-
 * suspenders; P3b also re-validates extension-side before it ever passes linkTo).
 */
async function applyLinkTo(deps: CreateTaskCoreDeps, newId: string, link: CreateTaskLink): Promise<void> {
  const [tasks, drafts, completed, archived] = await Promise.all([
    deps.parser.getTasks(),
    deps.parser.getDrafts(),
    deps.parser.getCompletedTasks(),
    deps.parser.getArchivedTasks(),
  ]);
  const all = [...tasks, ...drafts, ...completed, ...archived];

  if (link.direction === 'unlocks') {
    // origin unlocks new ⇒ new depends on origin.
    if (wouldCreateCycle(all, newId, link.taskId)) {
      throw new Error(`Linking ${newId} to ${link.taskId} would create a dependency cycle.`);
    }
    const newTask = await deps.parser.getTask(newId);
    const next = appendDep(newTask?.dependencies ?? [], link.taskId);
    await deps.writer.updateTask(newId, { dependencies: next }, deps.parser);
  } else {
    // origin needs new ⇒ origin depends on new.
    if (wouldCreateCycle(all, link.taskId, newId)) {
      throw new Error(`Linking ${link.taskId} to ${newId} would create a dependency cycle.`);
    }
    const origin = await deps.parser.getTask(link.taskId);
    if (!origin) throw new Error(`linkTo target ${link.taskId} does not exist.`);
    const next = appendDep(origin.dependencies ?? [], newId);
    await deps.writer.updateTask(link.taskId, { dependencies: next }, deps.parser);
  }
}
