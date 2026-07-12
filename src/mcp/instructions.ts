/**
 * Workflow guidance sent during MCP initialization. Keep the essential loop in
 * the first 512 characters because clients may truncate server instructions.
 */
export const TASKWRIGHT_MCP_INSTRUCTIONS =
  'Taskwright manages work through its MCP tools. At session start call get_active_task, then claim_task with the assigned task ID. Work only in the isolated task worktree. Record progress and final notes with edit_task. When the worktree is committed and clean, close with request_merge and wait for its result. Do not call complete_task during the normal workflow, and do not merge from the primary checkout. If get_active_task has no assignment, ask which task to work on ONLY when the user asked you to work on a board task without naming one; for a standalone request like a code review or a question, just do what was asked without an active task.';
