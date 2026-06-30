import { ChecklistItem, Task } from './types';
import { substitutePlaceholders } from './templateRender';

/**
 * Subscription-safe dispatch: Taskwright never spawns `claude -p` (that risks
 * switching from a Claude subscription to metered API usage). Instead it renders
 * a paste-ready prompt the user drops into a fresh Claude Code session, so the
 * session starts with exactly one task's context and nothing else.
 *
 * This module is the pure core — flatten a task into strings and substitute them
 * into a (configurable) template. No git, no clipboard, no VS Code here.
 */

/** Render-ready, already-stringified fields available to a dispatch template. */
export interface DispatchContext {
  id: string;
  title: string;
  status: string;
  priority: string;
  description: string;
  acceptanceCriteria: string;
  plan: string;
  labels: string;
  worktree: string;
  filePath: string;
  handoffFile: string;
}

/**
 * Default dispatch prompt. Deliberately tells the session to pull its context
 * through the Taskwright MCP (`get_active_task` / `claim_task` / `release_task`)
 * rather than guessing from the file tree, and to stay scoped to the one task.
 */
export const DEFAULT_DISPATCH_TEMPLATE = `You are a fresh Claude Code session assigned exactly one task. Work only on this task — do not touch unrelated code or other tasks.

Task {{id}}: {{title}}
Status: {{status}} · Priority: {{priority}} · Labels: {{labels}}

## Description
{{description}}

## Acceptance Criteria
{{acceptanceCriteria}}

## Implementation Plan
{{plan}}

---
Before writing code, call the \`taskwright\` MCP tool \`get_active_task\` to confirm your assignment and load full context, then \`claim_task\` with id \`{{id}}\` (worktree \`{{worktree}}\`). Follow the project's TDD / superpowers workflow. Record what you learn in the task's Implementation Notes, and call \`release_task\` when you finish or hand off.`;

/** Format a checklist as markdown, or a placeholder when empty. */
export function formatChecklist(items: ChecklistItem[]): string {
  if (items.length === 0) return '_None specified._';
  return items.map((item) => `- [${item.checked ? 'x' : ' '}] ${item.text}`).join('\n');
}

/**
 * A flat, filesystem-safe branch name for a task, e.g. `task-7-add-user-login`.
 * Kept slash-free so it maps cleanly to a `.worktrees/<branch>` directory.
 */
export function dispatchBranchName(task: Pick<Task, 'id' | 'title'>): string {
  const slug = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const idSlug = slug(task.id);
  const titleSlug = slug(task.title);
  return titleSlug ? `${idSlug}-${titleSlug}` : idSlug;
}

/** Flatten a task into render-ready strings, filling empties with placeholders. */
export function dispatchContextFromTask(
  task: Task,
  opts: { worktree?: string; handoffFile?: string } = {}
): DispatchContext {
  const description = task.description?.trim();
  const plan = task.implementationPlan?.trim();
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority ?? 'none',
    description: description || '_No description._',
    acceptanceCriteria: formatChecklist(task.acceptanceCriteria),
    plan: plan || '_No implementation plan yet._',
    labels: task.labels.length ? task.labels.join(', ') : 'none',
    worktree: opts.worktree ?? '',
    filePath: task.filePath,
    handoffFile: opts.handoffFile ?? '',
  };
}

/** Substitute `{{key}}` placeholders with their dispatch-context values. */
export function renderDispatchPrompt(template: string, ctx: DispatchContext): string {
  return substitutePlaceholders(template, ctx as unknown as Record<string, string>);
}

/** A resolved decision about whether/what to run in the dispatch terminal. */
export interface TerminalLaunchDecision {
  /** True when `command` should be sent to the terminal. */
  run: boolean;
  /** The rendered command to run (present only when `run` is true). */
  command?: string;
  /** A message to surface to the user (e.g. the `-p` guard tripped). */
  warning?: string;
}

/**
 * Whether a shell command line launches `claude` in print/headless mode
 * (`-p` / `--print`) in any of its `&&`/`||`/`;`/`|`-separated segments. Dispatch
 * is subscription-safe, so such a command is refused. Best-effort (not a full
 * shell parser): it scopes the flag check to the segment that names `claude`.
 */
export function commandUsesClaudePrintMode(command: string): boolean {
  return command
    .split(/\|\||&&|[;|]/)
    .some((seg) => /\bclaude\b/.test(seg) && /(?:^|\s)(?:-p|--print)\b/.test(seg));
}

/**
 * Decide what to run in the dispatch-opened worktree terminal. An empty template
 * means "do nothing"; a `claude -p`/`--print` command is refused with a warning
 * (launch an interactive chat instead); otherwise the template is rendered against
 * the dispatch context and returned to run.
 */
export function resolveTerminalLaunch(
  commandTemplate: string,
  ctx: DispatchContext
): TerminalLaunchDecision {
  const template = commandTemplate.trim();
  if (!template) return { run: false };
  const command = renderDispatchPrompt(template, ctx);
  if (commandUsesClaudePrintMode(command)) {
    return {
      run: false,
      warning:
        "Taskwright dispatch skipped the terminal command: it runs 'claude -p' (headless/metered). Use an interactive 'claude' chat to stay on your subscription.",
    };
  }
  return { run: true, command };
}
