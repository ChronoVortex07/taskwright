/**
 * Per-agent dispatch profiles (TASK-93). Dispatch is agent-agnostic: the
 * {{placeholder}} substitution core (`dispatchPrompt.ts`) never branches on the
 * target agent — the agent-specific parts (prompt phrasing, the skill/prompt
 * entry-point wording, the suggested interactive terminal command) live here as
 * DATA. Every profile carries the same non-negotiable workflow contract (launch
 * inside `.worktrees/<branch>`, `bun install` once, never touch the shared
 * repository root, run `/execute-task`, close with `request_merge` from inside
 * the worktree) — profiles vary the phrasing, never the workflow.
 *
 * Subscription safety is a principle, not a Claude feature: no profile may
 * suggest a headless/metered invocation (`claude -p`, `codex exec`, …) — see
 * the deny-list in `dispatchPrompt.ts` (`commandUsesHeadlessMode`).
 */

/** Agents Taskwright can phrase a dispatch for. */
export type DispatchAgentId = 'claude' | 'codex';

/** All known agent ids, in declaration order ('claude' first = the default). */
export const DISPATCH_AGENT_IDS: readonly DispatchAgentId[] = ['claude', 'codex'];

/** One agent's dispatch profile — data, not a fork of the pipeline. */
export interface DispatchProfile {
  /** Stable id, the value of the `taskwright.dispatchAgent` setting. */
  agent: DispatchAgentId;
  /** Human-readable agent name, e.g. for messages ("Claude Code", "Codex"). */
  label: string;
  /** Default dispatch prompt template ({{placeholder}} substitution applies). */
  template: string;
  /**
   * Suggested INTERACTIVE terminal launch command (templated on
   * `{{handoffFile}}`), e.g. for the `taskwright.dispatchTerminalCommand`
   * setting. Must pass the headless-mode guardrail — it seeds an interactive
   * session, never a metered headless run.
   */
  suggestedTerminalCommand: string;
}

/**
 * Default dispatch prompt for a Claude Code session. Deliberately delegates to
 * the `/execute-task` skill rather than inlining the workflow: the skill pulls
 * the session's context via `get_active_task` (not guessing from the file
 * tree), verifies the worktree and installs deps, `claim`s the task, executes
 * with the right strategy, records progress with `edit_task`, and closes with
 * `request_merge` — all in-session and subscription-safe (never `claude -p`).
 * Stays scoped to the one task.
 */
export const CLAUDE_DISPATCH_TEMPLATE = `You are a fresh Claude Code session assigned exactly one task. Work only on this task — do not touch unrelated code or other tasks.

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

/**
 * Default dispatch prompt for a Codex session. Same workflow contract as the
 * Claude Code template — only the phrasing differs: `/execute-task` is the
 * Codex custom prompt Taskwright installs into \`$CODEX_HOME/prompts\`, and the
 * headless mode to avoid is \`codex exec\` (subscription safety is a principle,
 * not tied to any one agent).
 */
export const CODEX_DISPATCH_TEMPLATE = `You are a fresh Codex session assigned exactly one task. Work only on this task — do not touch unrelated code or other tasks.

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
Run the \`/execute-task\` custom prompt (installed by Taskwright into your Codex prompts directory). It loads your assignment (\`get_active_task\` on the taskwright MCP server), verifies you are worktree-rooted and installs deps, claims the task, executes it test-first, records progress with \`edit_task\`, checks for cancellation, and closes with \`request_merge\` from inside your worktree. Stay interactive and subscription-safe: never relaunch yourself through \`codex exec\` or any other headless/non-interactive mode. If \`/execute-task\` is unavailable, do the same by hand — \`get_active_task\` → \`claim_task\` → test-driven implementation → \`edit_task\` notes → \`request_merge\` (taskwright MCP) from inside your worktree.`;

/** The registered dispatch profiles, keyed by agent id. */
export const DISPATCH_PROFILES: Readonly<Record<DispatchAgentId, DispatchProfile>> = {
  claude: {
    agent: 'claude',
    label: 'Claude Code',
    template: CLAUDE_DISPATCH_TEMPLATE,
    suggestedTerminalCommand: 'claude "$(cat {{handoffFile}})"',
  },
  codex: {
    agent: 'codex',
    label: 'Codex',
    template: CODEX_DISPATCH_TEMPLATE,
    suggestedTerminalCommand: 'codex "$(cat {{handoffFile}})"',
  },
};

/**
 * Resolve a `taskwright.dispatchAgent` setting value to a profile. Trims and
 * lowercases; anything unknown (including empty/undefined) falls back to the
 * Claude Code profile — dispatch must always produce a usable prompt.
 */
export function resolveDispatchProfile(agent: string | undefined): DispatchProfile {
  const id = (agent ?? '').trim().toLowerCase() as DispatchAgentId;
  return DISPATCH_PROFILES[id] ?? DISPATCH_PROFILES.claude;
}
