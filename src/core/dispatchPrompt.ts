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
 * Default dispatch prompt. Deliberately delegates to the `/execute-task` skill
 * rather than inlining the workflow: the skill pulls the session's context via
 * `get_active_task` (not guessing from the file tree), verifies the worktree and
 * installs deps, `claim`s the task, executes with the right strategy, records
 * progress with `edit_task`, and closes with `request_merge` — all in-session and
 * subscription-safe (never `claude -p`). Stays scoped to the one task.
 */
export const DEFAULT_DISPATCH_TEMPLATE = `You are a fresh Claude Code session assigned exactly one task. Work only on this task — do not touch unrelated code or other tasks.

Launch this session INSIDE your isolated worktree .worktrees/{{worktree}} — open that folder / start the session with it as the working directory. Do NOT start at the repository root and cd in: the taskwright MCP server roots itself at the directory the session launched in, and an in-session cd does not move it. A fresh worktree has no node_modules (it is git-ignored), so run \`bun install\` there once before you build or test. Do NOT git checkout, commit, or merge in the repository root — that tree is shared with other agents and committing there corrupts their branches.

Task {{id}}: {{title}}
Status: {{status}} · Priority: {{priority}} · Labels: {{labels}}

## Description
{{description}}

## Acceptance Criteria
{{acceptanceCriteria}}

## Implementation Plan
{{plan}}

---
Run the \`/execute-task\` skill. It loads your assignment (\`get_active_task\`), verifies you are worktree-rooted and installs deps, claims the task, executes with the right strategy (attached plan → executing-plans; independent subtasks → subagent-driven-development; else test-driven-development), records progress with \`edit_task\`, checks for cancellation, and closes with \`request_merge\` from inside your worktree. It is subscription-safe (in-session; never \`claude -p\`). If \`/execute-task\` is unavailable, follow the project's TDD / superpowers workflow by hand and close with \`request_merge\` (taskwright MCP) from inside your worktree.`;

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
        "Taskwright dispatch skipped the terminal command: it runs 'claude -p'/'--print' (headless/metered). Use an interactive 'claude' chat to stay on your subscription.",
    };
  }
  return { run: true, command };
}
