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

The active task is chosen on the Taskwright board ("Set active") or set by a dispatch. If \`get_active_task\` reports none is set, ask which task to work on rather than assuming.`;

/**
 * Insert or update Taskwright's convention block in an existing CLAUDE.md body
 * (or empty string for a new file). Only the marked region is owned by
 * Taskwright; the rest of the file is preserved. Returns the input unchanged
 * when already up to date.
 */
export function injectConvention(existingClaudeMd: string): string {
  return upsertMarkerBlock(existingClaudeMd, TASKWRIGHT_CONVENTION, TASKWRIGHT_MARKERS);
}
