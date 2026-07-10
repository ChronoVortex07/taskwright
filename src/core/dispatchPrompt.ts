import { ChecklistItem, Task } from './types';
import { substitutePlaceholders } from './templateRender';
import { CLAUDE_DISPATCH_TEMPLATE } from './dispatchProfiles';

/**
 * Subscription-safe dispatch: Taskwright never spawns an agent in headless
 * print mode (`claude -p`, `codex exec`, … — that risks switching from a
 * subscription to metered API usage). Instead it renders a paste-ready prompt
 * the user drops into a fresh interactive agent session, so the session starts
 * with exactly one task's context and nothing else.
 *
 * This module is the pure, agent-neutral core — flatten a task into strings and
 * substitute them into a (configurable) template. The agent-specific parts
 * (templates, suggested launch commands) are data in `dispatchProfiles.ts`.
 * No git, no clipboard, no VS Code here.
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
 * Default dispatch prompt — the Claude Code profile's template (Claude is the
 * default `taskwright.dispatchAgent`). Kept as a named export for back-compat;
 * per-agent templates live in `dispatchProfiles.ts`.
 */
export const DEFAULT_DISPATCH_TEMPLATE = CLAUDE_DISPATCH_TEMPLATE;

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
 * Headless/non-interactive launch deny-list — agent-agnostic. Each entry pairs
 * a `tool` pattern (which command the segment invokes; match-all for generic
 * flags) with a `mode` pattern (the headless invocation of that tool). A shell
 * command line is refused when any `&&`/`||`/`;`/`|`-separated segment matches
 * both patterns of any entry. Subscription safety is a principle, not a Claude
 * feature: the full deny-list applies regardless of the selected dispatch
 * agent. Best-effort (not a full shell parser).
 */
const HEADLESS_LAUNCH_DENYLIST: ReadonlyArray<{ tool: RegExp; mode: RegExp }> = [
  // Claude Code print mode: `claude -p` / `claude --print`.
  { tool: /\bclaude\b/, mode: /(?:^|\s)(?:-p|--print)(?:\s|$)/ },
  // Codex non-interactive mode: `codex exec` (and its `e` alias).
  { tool: /\bcodex\b/, mode: /(?:^|\s)(?:exec|e)(?:\s|$)/ },
  // Generic non-interactive flags, whatever the agent binary is called.
  { tool: /./, mode: /(?:^|\s)--(?:headless|non-interactive)(?:\s|$)/ },
];

/**
 * Whether a shell command line launches an agent in headless/non-interactive
 * mode (`claude -p`/`--print`, `codex exec`, a generic `--headless`/
 * `--non-interactive` flag) in any of its `&&`/`||`/`;`/`|`-separated segments.
 * Dispatch is subscription-safe, so such a command is refused.
 */
export function commandUsesHeadlessMode(command: string): boolean {
  return command
    .split(/\|\||&&|[;|]/)
    .some((seg) => HEADLESS_LAUNCH_DENYLIST.some((d) => d.tool.test(seg) && d.mode.test(seg)));
}

/**
 * Legacy Claude-only guard, kept for back-compat.
 * @deprecated Use {@link commandUsesHeadlessMode} — the agent-agnostic deny-list.
 */
export function commandUsesClaudePrintMode(command: string): boolean {
  return command
    .split(/\|\||&&|[;|]/)
    .some((seg) => /\bclaude\b/.test(seg) && /(?:^|\s)(?:-p|--print)\b/.test(seg));
}

/**
 * Decide what to run in the dispatch-opened worktree terminal. An empty template
 * means "do nothing"; a headless/non-interactive agent command (`claude -p`/
 * `--print`, `codex exec`, …) is refused with a warning (launch an interactive
 * session instead); otherwise the template is rendered against the dispatch
 * context and returned to run.
 */
export function resolveTerminalLaunch(
  commandTemplate: string,
  ctx: DispatchContext
): TerminalLaunchDecision {
  const template = commandTemplate.trim();
  if (!template) return { run: false };
  const command = renderDispatchPrompt(template, ctx);
  if (commandUsesHeadlessMode(command)) {
    return {
      run: false,
      warning:
        "Taskwright dispatch skipped the terminal command: it launches the agent in headless mode ('claude -p'/'--print', 'codex exec', or a --headless/--non-interactive flag), which is metered. Use an interactive session to stay on your subscription.",
    };
  }
  return { run: true, command };
}
