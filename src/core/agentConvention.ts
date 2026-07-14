import { upsertMarkerBlock, TASKWRIGHT_MARKERS } from './markerBlock';

/**
 * The agent convention Taskwright injects into a project's CLAUDE.md so a
 * Claude Code session reaches for the Taskwright MCP instead of guessing the
 * task from the file tree. Availability of the MCP tools is not enough — the
 * session needs to be told to call them.
 */
export const TASKWRIGHT_CONVENTION = `## Taskwright

This project is managed with [Taskwright](https://github.com/ChronoVortex07/taskwright). At the **start of a task session**:

1. Call the \`taskwright\` MCP tool **\`get_active_task\`** to load your assigned task and its full context (description, acceptance criteria, plan). Work from that — do not infer the task from the file tree.
2. Call **\`claim_task\`** with your task ID to mark it in progress, so parallel sessions in other worktrees don't collide. Claiming is advisory.
3. When you finish or hand off, call **\`release_task\`**.

The active task is chosen on the Taskwright board ("Set active") or set by a dispatch. If \`get_active_task\` reports none is set, ask which task to work on **only when the user asked you to work on a board task without naming one**. For a standalone request — a code review, a question, an ad-hoc change — just do what was asked; you don't need an active task.`;

/**
 * Insert or update Taskwright's convention block in an existing CLAUDE.md body
 * (or empty string for a new file). Only the marked region is owned by
 * Taskwright; the rest of the file is preserved. Returns the input unchanged
 * when already up to date.
 */
export function injectConvention(existingClaudeMd: string): string {
  return upsertMarkerBlock(existingClaudeMd, TASKWRIGHT_CONVENTION, TASKWRIGHT_MARKERS);
}

/**
 * The AGENTS.md variant of the convention. AGENTS.md is the general-agent (Codex,
 * etc.) instruction surface, so this block frames the workflow around the
 * Taskwright MCP server declared in `.mcp.json` and names the full session loop
 * through `request_merge`. Reuses the same TASKWRIGHT markers as the CLAUDE.md
 * block, so it round-trips through upsertMarkerBlock and is picked up by
 * AgentIntegrationDetector's AGENTS.md scan with no detector change.
 */
export const TASKWRIGHT_AGENTS_CONVENTION = `## Taskwright

This project is managed with [Taskwright](https://github.com/ChronoVortex07/taskwright). Task and project management runs through the **Taskwright MCP server** — registered per agent (\`.mcp.json\` for Claude Code, \`~/.codex/config.toml\` for Codex), not an external CLI. At the **start of a task session**:

1. Call the \`taskwright\` MCP tool **\`get_active_task\`** to load your assigned task and its full context (description, acceptance criteria, plan). Work from that — do not infer the task from the file tree.
2. Call **\`claim_task\`** with your task ID to mark it in progress so parallel sessions don't collide (advisory).
3. Do the work inside your worktree — a plain git worktree under \`.worktrees/\`. Reach it by launching there, or with \`cd\` / \`git -C\`; **never** a harness worktree-switch tool (e.g. Claude Code's \`EnterWorktree\`), which manages only \`.claude/worktrees/\` and fails here. Record progress with **\`edit_task\`**.
4. Close with **\`request_merge\`** — it rebases, verifies, merges to the base branch, and marks the task Done. If you bootstrapped the worktree yourself with \`start_task\`, the MCP is still rooted in the primary tree (a \`cd\` does not move it), so close with \`request_merge { taskId, worktree }\`; a bare call aborts with \`wrong_root\`.

In a worktree with **no board task** (a dev/scratch branch)? Close with **\`request_branch_merge { worktree }\`** — same queue and verify, no board writes. Never merge in the repo root.

If \`get_active_task\` reports none is set, ask which task to work on **only when the user asked you to work on a board task without naming one**. For a standalone request (a code review, a question, an ad-hoc change) just do what was asked — no active task needed.

The full workflows are **progressively disclosed as native skills** under \`.agents/skills/\` (\`create-task\`, \`execute-task\`, \`index-codebase\`, \`orchestrate-board\`) — invoke a skill by name to load its detailed instructions on demand instead of inlining them here.`;

/**
 * A conservative character budget for the injected AGENTS.md block. AGENTS.md is
 * loaded into the agent's context every session, so the convention block stays
 * a concise pointer: the detailed, multi-step workflows live in the
 * progressively-disclosed skills under `.agents/skills/` and load only when a
 * skill is selected. Keeping the block well under this budget keeps AGENTS.md
 * within Codex's per-file instruction limits.
 */
export const TASKWRIGHT_AGENTS_CONVENTION_MAX_CHARS = 2000;

/**
 * Insert or update Taskwright's convention block in an existing AGENTS.md body
 * (or empty string for a new file). Only the marked region is owned by
 * Taskwright; the rest is preserved. Returns the input unchanged when already up
 * to date (callers detect a no-op by identity).
 */
export function injectAgentsConvention(existingAgentsMd: string): string {
  return upsertMarkerBlock(existingAgentsMd, TASKWRIGHT_AGENTS_CONVENTION, TASKWRIGHT_MARKERS);
}
