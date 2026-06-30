# Native task CRUD in the Taskwright MCP server

- **Date:** 2026-06-30
- **Status:** Approved (design)
- **Task:** TASK-8 — Add native task CRUD to the Taskwright MCP server (drop the backlog CLI requirement)

## Context

Today Taskwright **reads** task files directly (`BacklogParser`) but agent-facing **writes**
are delegated to the external Backlog.md project: `.mcp.json` registers a separate `backlog`
MCP server (`backlog mcp start`) that a dispatched session uses to create and edit tasks. This
forces every user of the extension to install the `backlog` CLI just to manage tasks through an
agent, which contradicts Taskwright's goal of being a self-contained agentic board.

Two facts make removing that dependency cheap:

1. `src/core/BacklogWriter.ts` is **already a complete, vscode-free CRUD engine** —
   `createTask`, `updateTask`, `completeTask`, `archiveTask`, `promoteDraft`/`demoteTask`,
   `createSubtask`, `restoreArchivedTask`, `toggleChecklistItem`, plus `reconstructFile` /
   `orderFrontmatter` written specifically to match upstream Backlog.md **byte-for-byte**
   (canonical field order, gray-matter serialization, empty-field omission). It is covered by
   `src/test/unit/BacklogWriter.test.ts`.
2. Inside the extension, the `backlog` CLI is used in only two places (`TasksController`,
   `extension.ts`) and only for **cross-branch board loading** (which already degrades
   gracefully to "local tasks only" when the CLI is absent) plus an availability/status-bar UI.
   It is **not** on the task-write path. The only thing forcing the `backlog` dependency for
   agents is that the `backlog` MCP server is what currently exposes task CRUD.

## Goals

- The Taskwright MCP server exposes task CRUD tools that write Backlog.md-compatible files.
- Creating/editing tasks via an agent no longer requires the external `backlog` CLI or its MCP
  server.
- Generated files remain byte-for-byte compatible with Backlog.md frontmatter and section
  markers (interoperable with the upstream tools).
- Docs and `.mcp.json` no longer require the `backlog` MCP server for core task management.

## Non-goals

- Reimplementing cross-branch board loading without the CLI (stays an optional CLI enhancement,
  unchanged).
- Milestones / documents / decisions CRUD over MCP (listed under Future Extensions).
- A web UI or board export over MCP.

## Approach

Reuse the existing `BacklogWriter` from inside the MCP server. Two alternatives were rejected:

- **Import `backlog.md` as a library** — not possible: the published package exposes no
  programmatic API (`main`/`exports` undefined; `files` ships only `cli.js`).
- **Bundle the `backlog` CLI binary and shell out** — heavyweight (ships a binary, grows the
  VSIX, keeps a process dependency) for no benefit over reusing `BacklogWriter`.

## Architecture

### Server wiring

`src/mcp/server.ts` already resolves `root` and `backlogPath` and builds `McpHandlerDeps`.
Extend the deps with the writer and backlog path:

```ts
export interface McpHandlerDeps {
  root: string;
  backlogPath: string; // new — needed by create_task / create_subtask
  parser: BacklogParser;
  writer: BacklogWriter; // new — the existing vscode-free CRUD engine
  claimService: ClaimService;
  planService: PlanService;
}
```

`BacklogWriter` imports only `fs`, `path`, `crypto`, `js-yaml`, `gray-matter`, and core types —
no `vscode` — so it is safe to construct in the standalone MCP process. No new runtime
dependency is added.

### Tools

New tools registered in `server.ts`, each a thin handler in `src/mcp/handlers.ts` over an
existing writer method. Success returns differ by whether the task stays in the active set:

- `create_task`, `edit_task`, `promote_draft`, `demote_task`, `create_subtask` return the full
  JSON task summary used by `get_active_task` (re-read via `parser` + the existing `toSummary`).
- `complete_task`, `archive_task`, `restore_task` move the file out of (or back into) `tasks/`,
  so the parser may no longer resolve it; they return a light result instead:
  `{ taskId, outcome: 'completed' | 'archived' | 'restored', path }`.

On failure each returns a structured error envelope (see Error handling).

| Tool             | Backs onto                   | Input (zod)                                                                                                                                                                                                                                       |
| ---------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_task`    | `createTask` / `createDraft` | `title` (req), `description?`, `status?`, `priority?`, `labels?`, `assignee?`, `milestone?`, `draft?`                                                                                                                                             |
| `edit_task`      | `updateTask`                 | `taskId` (req) + any of: `title`, `status`, `priority`, `labels`, `assignee`, `milestone`, `description`, `acceptanceCriteria[]`, `definitionOfDone[]`, `implementationPlan`, `implementationNotes`, `finalSummary`, `dependencies`, `references` |
| `complete_task`  | `completeTask`               | `taskId` (req)                                                                                                                                                                                                                                    |
| `archive_task`   | `archiveTask`                | `taskId` (req)                                                                                                                                                                                                                                    |
| `promote_draft`  | `promoteDraft`               | `taskId` (req, a `DRAFT-N`)                                                                                                                                                                                                                       |
| `demote_task`    | `demoteTask`                 | `taskId` (req)                                                                                                                                                                                                                                    |
| `create_subtask` | `createSubtask` _(extended)_ | `parentTaskId` (req), `title?`, `description?`                                                                                                                                                                                                    |
| `restore_task`   | `restoreArchivedTask`        | `taskId` (req)                                                                                                                                                                                                                                    |

Existing tools (`get_active_task`, `claim_task`, `release_task`, `attach_plan`) are unchanged.

### Small writer extensions

Two additive, backward-compatible tweaks so the new tools can set content at creation time
(both currently hardcode `title: 'Untitled'`):

- `createSubtask(parentTaskId, backlogPath, parser, opts?: { title?; description? })`
- `createDraft(backlogPath, parser, opts?: { title?; description? })`

Defaults are preserved when `opts` is omitted, so existing callers (`TaskCreatePanel`, the
extension command) are unaffected. Existing `BacklogWriter` tests continue to pass; new cases
cover the option paths.

### `edit_task` checklist shape

`acceptanceCriteria` and `definitionOfDone` are accepted as arrays of
`{ text: string; checked?: boolean }`. The handler renders them to the canonical marker format
(`- [ ] #N text` / `- [x] #N text`, 1-based) and passes the rendered block to
`updateTask`'s existing checklist path. This matches the AGENTS.md guidance that AC/DoD are
structured checklists, not freeform markdown.

## Validation & error handling

- `status` is validated against `config.statuses`; `priority` against `high|medium|low`.
  Invalid values return an `INVALID_ARGUMENT` error rather than writing a bad file.
- Unknown `taskId` (writer throws `Task X not found`) is caught and returned as a `NOT_FOUND`
  error. The stdio server never crashes on a tool-level failure.
- Error envelope: tools return `{ isError: true, content: [{ type: 'text', text }] }` where
  `text` is `JSON.stringify({ error: { code, message } })`. Success keeps the current
  `jsonContent(summary)` shape.
- Concurrency is last-write-wins: agents do read-modify-write, and the MCP does not pass
  `expectedHash`. The writer's `FileConflictError` path remains available for a future opt-in.

## ID allocation caveat

`BacklogWriter` mints the next ID by scanning the local `tasks/` directory. In the extension,
cross-branch IDs are supplied by the CLI-backed `CrossBranchTaskLoader` to avoid collisions; the
MCP process does not have that. MCP-created task IDs are therefore **local-only**: two parallel
worktree sessions could mint the same `TASK-N`. This is consistent with Taskwright's existing
advisory / eventually-consistent model (the same caveat already applies to claims). It will be
documented in the tool descriptions and README. A future hardening — scanning sibling branches
via the vscode-free `GitBranchService` to seed `crossBranchIds` — is listed under Future
Extensions and is out of scope here.

## Dropping the hard `backlog` dependency

- **`.mcp.json`** — remove the `backlog` server entry; `taskwright` and `svelte` remain.
- **Intake prompt** (`src/core/intakePrompt.ts`) — repoint "create tasks via the Backlog.md
  MCP" to Taskwright's `create_task` tool.
- **README** — the `backlog` CLI is no longer required for task management; note it as optional,
  solely for cross-branch board view.
- **CLAUDE.md coupling rules** — writes now go through Taskwright's `BacklogWriter` (exposed to
  agents via the Taskwright MCP), not the `backlog` CLI. Reading is unchanged.
- **AGENTS.md** — it currently instructs agents to read `backlog://workflow/overview` from the
  `backlog` MCP. With that server removed, replace that instruction with a concise inline
  workflow section that references the Taskwright tools (`get_active_task`, `create_task`,
  `edit_task`, `complete_task`, claim/release). We inline rather than add a new MCP resource to
  keep the server lean; a `get_workflow_overview` tool is a possible future addition.
- Cross-branch board loading is untouched and already degrades gracefully when the CLI is
  absent (`BacklogCli.showCrossbranchWarning` → "local tasks only").

## Testing

- Per-handler unit tests against a temp backlog dir: `create → edit → complete → archive →
restore`; `create(draft) → promote → demote`; `create_subtask`; checklist rendering;
  `status`/`priority` validation; not-found errors.
- New `BacklogWriter` cases for the `createSubtask` / `createDraft` option paths.
- Byte-compatibility remains covered by the existing `BacklogWriter.test.ts`.
- Lint, typecheck, and the full unit suite pass (Windows path-assertion failures are tracked
  separately under TASK-4 and are unrelated to this change).

## Future extensions

- Milestones / documents / decisions CRUD over MCP (the writer already implements them).
- Cross-branch-aware ID allocation via `GitBranchService`.
- Optional `get_workflow_overview` MCP tool.
- Opt-in optimistic-concurrency (`expectedHash`) for `edit_task`.

## Relationship to other work

Independent of TASK-1 (the `backlog.*` → `taskwright.*` namespace migration), though both touch
`.mcp.json` and docs; either order is fine. If TASK-1 lands first, the new tools simply register
under the renamed server identity.
