# Native task CRUD in the Taskwright MCP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Taskwright MCP server its own task-CRUD tools (backed by the existing `BacklogWriter`) so agents can create/edit/move tasks without the external `backlog` CLI or its MCP server.

**Architecture:** Add thin, pure handler functions in `src/mcp/handlers.ts` over the existing vscode-free `BacklogWriter`, plus pure helpers in a new `src/mcp/taskWriteHelpers.ts`. Register them as MCP tools in `src/mcp/server.ts` behind a uniform error wrapper. Then remove the `backlog` MCP server from `.mcp.json` and repoint the intake prompt and docs.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` (`McpServer`), `zod` for tool input schemas, Vitest for tests, Bun for scripts.

## Global Constraints

- Node ≥ 22; the MCP server process imports **only vscode-free** `src/core` modules (`BacklogWriter` qualifies — it imports `fs`, `path`, `crypto`, `js-yaml`, `gray-matter`, core types).
- Generated task files must stay **byte-for-byte compatible** with Backlog.md; achieve this by going through `BacklogWriter` (which already does), never by hand-writing frontmatter.
- No new runtime dependency may be added.
- Reads stay as today (parse files directly); only writes are added.
- Spec of record: `docs/superpowers/specs/2026-06-30-taskwright-native-mcp-crud-design.md`.
- Run a single test file with: `bunx vitest run <path>`. Full gate: `bun run test && bun run lint && bun run typecheck`.
- **Windows note:** ~21 pre-existing unit tests assert POSIX paths and fail on Windows (tracked by TASK-4). Treat the suite as green if the only failures are those four files (`BacklogParser`, `BacklogWriter`, `CrossBranchIntegration`, `openWorkspaceFile`). New tests in this plan must pass on both platforms (use `path.join`, never hardcoded `/`).
- Commit messages reference TASK-8; the final commit uses `Completes TASK-8.` Trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

- Create `src/mcp/taskWriteHelpers.ts` — pure helpers: `ChecklistInput`, `renderChecklist`, `assertValidStatus`, `assertValidPriority`. One responsibility: input shaping/validation, no fs.
- Create `src/test/unit/taskWriteHelpers.test.ts` — unit tests for the helpers.
- Create `src/test/unit/mcpWriteHandlers.test.ts` — handler tests against a **real temp backlog dir** (the write handlers move/create files, which is awkward to fake; a temp dir also exercises `BacklogWriter` byte-compat end-to-end).
- Modify `src/mcp/handlers.ts` — extend `McpHandlerDeps` (add `writer`, `backlogPath`), `export` `toSummary`, add 8 write handlers + a private `requireSummary`.
- Modify `src/core/BacklogWriter.ts` — `createDraft` and `createSubtask` accept an optional `{ title?, description? }` (backward-compatible).
- Modify `src/mcp/server.ts` — construct `BacklogWriter`, pass new deps, add a `runTool` error wrapper, register 8 tools.
- Modify `src/test/unit/mcpHandlers.test.ts` — update `makeDeps()` for the new required deps.
- Modify `src/core/intakePrompt.ts` + `src/test/unit/intakePrompt.test.ts` — point intake at `create_task`.
- Modify `.mcp.json`, `README.md`, `CLAUDE.md`, `AGENTS.md` — drop the hard `backlog` dependency.

---

### Task 1: Pure helpers + deps interface

**Files:**

- Create: `src/mcp/taskWriteHelpers.ts`
- Test: `src/test/unit/taskWriteHelpers.test.ts`
- Modify: `src/mcp/handlers.ts` (extend `McpHandlerDeps`, export `toSummary`, import `BacklogWriter`)
- Modify: `src/test/unit/mcpHandlers.test.ts` (`makeDeps` gets `writer` + `backlogPath`)

**Interfaces:**

- Produces: `ChecklistInput = { text: string; checked?: boolean }`; `renderChecklist(items: ChecklistInput[]): string`; `assertValidStatus(status: string, allowed: string[]): void`; `assertValidPriority(priority: string): void`. Extended `McpHandlerDeps` now has `writer: BacklogWriter` and `backlogPath: string`. `toSummary(task: Task, root: string): TaskSummary` is now exported.

- [ ] **Step 1: Write the failing helper test**

Create `src/test/unit/taskWriteHelpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  renderChecklist,
  assertValidStatus,
  assertValidPriority,
} from '../../mcp/taskWriteHelpers';

describe('renderChecklist', () => {
  it('renders 1-based numbered checkbox items', () => {
    expect(renderChecklist([{ text: 'first' }, { text: 'second', checked: true }])).toBe(
      '- [ ] #1 first\n- [x] #2 second'
    );
  });

  it('returns an empty string for no items', () => {
    expect(renderChecklist([])).toBe('');
  });
});

describe('assertValidStatus', () => {
  it('accepts a configured status case-insensitively', () => {
    expect(() => assertValidStatus('in progress', ['To Do', 'In Progress'])).not.toThrow();
  });
  it('throws on an unknown status', () => {
    expect(() => assertValidStatus('Nope', ['To Do', 'Done'])).toThrow('Invalid status');
  });
});

describe('assertValidPriority', () => {
  it('accepts high/medium/low', () => {
    expect(() => assertValidPriority('medium')).not.toThrow();
  });
  it('throws otherwise', () => {
    expect(() => assertValidPriority('urgent')).toThrow('Invalid priority');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run src/test/unit/taskWriteHelpers.test.ts`
Expected: FAIL — cannot find module `../../mcp/taskWriteHelpers`.

- [ ] **Step 3: Implement the helpers**

Create `src/mcp/taskWriteHelpers.ts`:

```ts
/**
 * Pure input-shaping and validation for the Taskwright MCP write tools. No fs,
 * no MCP types — just transforms an agent's arguments into the shapes
 * `BacklogWriter` expects, and rejects obviously-invalid values early.
 */

/** A single acceptance-criteria / definition-of-done item from a tool call. */
export interface ChecklistInput {
  text: string;
  checked?: boolean;
}

/**
 * Render checklist items into Backlog.md's canonical body format
 * (`- [ ] #N text`, 1-based). The result is the content placed between the
 * AC/DOD markers by `BacklogWriter.updateTask`.
 */
export function renderChecklist(items: ChecklistInput[]): string {
  return items
    .map((item, i) => `- [${item.checked ? 'x' : ' '}] #${i + 1} ${item.text.trim()}`)
    .join('\n');
}

/** Throw unless `status` matches one of the board's configured statuses (case-insensitive). */
export function assertValidStatus(status: string, allowed: string[]): void {
  if (!allowed.some((s) => s.toLowerCase() === status.toLowerCase())) {
    throw new Error(
      `Invalid status "${status}". Allowed: ${allowed.join(', ') || '(none configured)'}.`
    );
  }
}

/** Throw unless `priority` is one of high/medium/low. */
export function assertValidPriority(priority: string): void {
  if (priority !== 'high' && priority !== 'medium' && priority !== 'low') {
    throw new Error(`Invalid priority "${priority}". Allowed: high, medium, low.`);
  }
}
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `bunx vitest run src/test/unit/taskWriteHelpers.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Extend `McpHandlerDeps` and export `toSummary`**

In `src/mcp/handlers.ts`, add the import near the top:

```ts
import { BacklogWriter } from '../core/BacklogWriter';
```

Change the deps interface to add two fields:

```ts
export interface McpHandlerDeps {
  /** Directory holding `.taskwright/active-task.json` (session cwd / worktree). */
  root: string;
  /** Path to the `backlog/` directory (parent of `tasks/`); used by create tools. */
  backlogPath: string;
  parser: BacklogParser;
  writer: BacklogWriter;
  claimService: ClaimService;
  planService: PlanService;
}
```

Change `function toSummary(` to `export function toSummary(` (same body).

- [ ] **Step 6: Update the existing handler test's `makeDeps`**

In `src/test/unit/mcpHandlers.test.ts`, add the import:

```ts
import { BacklogWriter } from '../../core/BacklogWriter';
```

and update `makeDeps`:

```ts
function makeDeps(): McpHandlerDeps {
  return {
    root: ROOT,
    backlogPath: BACKLOG,
    parser: new BacklogParser(BACKLOG),
    writer: new BacklogWriter(),
    claimService: new ClaimService(),
    planService: new PlanService(),
  };
}
```

- [ ] **Step 7: Verify typecheck + existing handler tests still pass**

Run: `bunx vitest run src/test/unit/mcpHandlers.test.ts src/test/unit/taskWriteHelpers.test.ts && bun run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/taskWriteHelpers.ts src/test/unit/taskWriteHelpers.test.ts src/mcp/handlers.ts src/test/unit/mcpHandlers.test.ts
git commit -m "Add MCP write helpers and extend handler deps

Pure renderChecklist/assertValidStatus/assertValidPriority helpers; add
writer + backlogPath to McpHandlerDeps and export toSummary for reuse.

Part of TASK-8.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `create_task` tool (+ titled `createDraft`)

**Files:**

- Create: `src/test/unit/mcpWriteHandlers.test.ts`
- Modify: `src/mcp/handlers.ts` (add `requireSummary`, `createTaskHandler`)
- Modify: `src/core/BacklogWriter.ts` (`createDraft` accepts `{ title?, description? }`)
- Modify: `src/mcp/server.ts` (runTool wrapper, construct writer, register `create_task`)

**Interfaces:**

- Consumes: `renderChecklist`/`assertValidStatus`/`assertValidPriority` (Task 1); `BacklogWriter.createTask(backlogPath, options, parser)`, `BacklogWriter.createDraft(backlogPath, parser?, opts?)`; `toSummary`.
- Produces: `createTaskHandler(deps, args: CreateTaskArgs): Promise<TaskSummary>`; private `requireSummary(deps, taskId): Promise<TaskSummary>`; server helper `runTool(fn): Promise<ToolResult>`.

- [ ] **Step 1: Write the failing handler test**

Create `src/test/unit/mcpWriteHandlers.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { BacklogParser } from '../../core/BacklogParser';
import { BacklogWriter } from '../../core/BacklogWriter';
import { ClaimService } from '../../core/ClaimService';
import { PlanService } from '../../core/PlanService';
import { createTaskHandler } from '../../mcp/handlers';
import type { McpHandlerDeps } from '../../mcp/handlers';

let root: string;
let backlogPath: string;

function scaffold(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-mcp-'));
  backlogPath = path.join(root, 'backlog');
  fs.mkdirSync(path.join(backlogPath, 'tasks'), { recursive: true });
  fs.writeFileSync(
    path.join(backlogPath, 'config.yml'),
    'project_name: "test"\nstatuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: "task"\n',
    'utf-8'
  );
}

function deps(): McpHandlerDeps {
  return {
    root,
    backlogPath,
    parser: new BacklogParser(backlogPath),
    writer: new BacklogWriter(),
    claimService: new ClaimService(),
    planService: new PlanService(),
  };
}

beforeEach(scaffold);
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('createTaskHandler', () => {
  it('creates a task and returns its summary', async () => {
    const summary = await createTaskHandler(deps(), {
      title: 'Add login',
      description: 'Users can sign in',
      priority: 'high',
      labels: ['feature'],
    });
    expect(summary.id).toBe('TASK-1');
    expect(summary.title).toBe('Add login');
    expect(summary.priority).toBe('high');
    expect(summary.labels).toEqual(['feature']);
    expect(summary.description).toContain('Users can sign in');
    expect(fs.existsSync(path.join(backlogPath, 'tasks', 'task-1 - Add-login.md'))).toBe(true);
  });

  it('rejects an invalid status before writing anything', async () => {
    await expect(createTaskHandler(deps(), { title: 'X', status: 'Nope' })).rejects.toThrow(
      'Invalid status'
    );
    expect(fs.readdirSync(path.join(backlogPath, 'tasks'))).toHaveLength(0);
  });

  it('creates a draft when draft is set, with the given title', async () => {
    const summary = await createTaskHandler(deps(), { title: 'Spike caching', draft: true });
    expect(summary.id).toBe('DRAFT-1');
    expect(summary.title).toBe('Spike caching');
    expect(fs.existsSync(path.join(backlogPath, 'drafts', 'draft-1 - Spike-caching.md'))).toBe(
      true
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run src/test/unit/mcpWriteHandlers.test.ts`
Expected: FAIL — `createTaskHandler` is not exported / draft title is "Untitled".

- [ ] **Step 3: Make `createDraft` accept a title/description**

In `src/core/BacklogWriter.ts`, replace the whole `createDraft` method with:

```ts
  /**
   * Create a new draft file in the drafts/ directory. `opts` lets callers seed
   * the title and description; both default to the empty/"Untitled" form so
   * existing callers are unaffected.
   */
  async createDraft(
    backlogPath: string,
    _parser?: BacklogParser,
    opts?: { title?: string; description?: string }
  ): Promise<{ id: string; filePath: string }> {
    const draftsDir = path.join(backlogPath, 'drafts');
    if (!fs.existsSync(draftsDir)) {
      fs.mkdirSync(draftsDir, { recursive: true });
    }

    const nextId = this.getNextDraftId(draftsDir);
    const draftId = `DRAFT-${nextId}`;
    const title = opts?.title?.trim() || 'Untitled';
    const sanitizedTitle = title
      .replace(/[^a-zA-Z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50);
    const fileName = `draft-${nextId} - ${sanitizedTitle}.md`;
    const filePath = path.join(draftsDir, fileName);

    const today = nowTimestamp();
    const frontmatter: FrontmatterData = {
      id: draftId,
      title,
      status: 'Draft',
      labels: [],
      assignee: [],
      dependencies: [],
      created_date: today,
      updated_date: today,
    };

    const descBlock = opts?.description
      ? `<!-- SECTION:DESCRIPTION:BEGIN -->\n${opts.description}\n<!-- SECTION:DESCRIPTION:END -->`
      : '<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->';
    const body = `\n## Description\n\n${descBlock}\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n<!-- AC:END -->\n`;

    const content = this.reconstructFile(frontmatter, body);
    fs.writeFileSync(filePath, content, 'utf-8');

    return { id: draftId, filePath };
  }
```

- [ ] **Step 4: Add `requireSummary` and `createTaskHandler`**

In `src/mcp/handlers.ts`, add the import:

```ts
import { assertValidPriority, assertValidStatus } from './taskWriteHelpers';
```

Then append after the existing handlers:

```ts
/** Re-read a just-written task and shape it for return; throws if it vanished. */
async function requireSummary(deps: McpHandlerDeps, taskId: string): Promise<TaskSummary> {
  const task = await deps.parser.getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} was written but could not be read back.`);
  }
  return toSummary(task, deps.root);
}

export interface CreateTaskArgs {
  title: string;
  description?: string;
  status?: string;
  priority?: 'high' | 'medium' | 'low';
  labels?: string[];
  assignee?: string[];
  milestone?: string;
  draft?: boolean;
}

/** Create a task (or draft) and return its summary. */
export async function createTaskHandler(
  deps: McpHandlerDeps,
  args: CreateTaskArgs
): Promise<TaskSummary> {
  const title = args.title?.trim();
  if (!title) throw new Error('A task title is required.');
  const config = await deps.parser.getConfig();
  if (args.status) assertValidStatus(args.status, config.statuses ?? []);
  if (args.priority) assertValidPriority(args.priority);

  if (args.draft) {
    const { id } = await deps.writer.createDraft(deps.backlogPath, deps.parser, {
      title,
      description: args.description,
    });
    return requireSummary(deps, id);
  }

  const { id } = await deps.writer.createTask(
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
  );
  return requireSummary(deps, id);
}
```

- [ ] **Step 5: Run the handler test to verify it passes**

Run: `bunx vitest run src/test/unit/mcpWriteHandlers.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Wire the writer + `runTool` + register `create_task` in `server.ts`**

In `src/mcp/server.ts`: `z` is already imported. Add one new import:

```ts
import { BacklogWriter } from '../core/BacklogWriter';
```

and extend the existing `from './handlers'` import block to also pull in `createTaskHandler` (do not add a second `./handlers` import line).

Add a tool wrapper near `jsonContent`:

```ts
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** Run a handler and convert success/throw into a uniform MCP tool result. */
async function runTool(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await fn(), null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: { message } }) }],
      isError: true,
    };
  }
}
```

In `main()`, add the writer to deps:

```ts
const deps: McpHandlerDeps = {
  root,
  backlogPath,
  parser: new BacklogParser(backlogPath),
  writer: new BacklogWriter(),
  claimService: new ClaimService(),
  planService: new PlanService(),
};
```

Register the tool (after `attach_plan`):

```ts
server.registerTool(
  'create_task',
  {
    title: 'Create task',
    description:
      'Create a new Backlog.md task (or draft) on the board. Returns the created task summary.',
    inputSchema: {
      title: z.string().describe('Task title, imperative mood.'),
      description: z.string().optional(),
      status: z.string().optional().describe('Defaults to the board default status.'),
      priority: z.enum(['high', 'medium', 'low']).optional(),
      labels: z.array(z.string()).optional(),
      assignee: z.array(z.string()).optional(),
      milestone: z.string().optional(),
      draft: z.boolean().optional().describe('Create as a draft (DRAFT-N in drafts/).'),
    },
  },
  async (args) => runTool(() => createTaskHandler(deps, args))
);
```

- [ ] **Step 7: Verify build + typecheck**

Run: `bun run typecheck && bun run compile`
Expected: typecheck exits 0; esbuild bundles `dist/mcp/server.js` with no errors.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/handlers.ts src/mcp/server.ts src/core/BacklogWriter.ts src/test/unit/mcpWriteHandlers.test.ts
git commit -m "Add create_task MCP tool backed by BacklogWriter

Adds createTaskHandler (+ draft support via a titled createDraft) and the
create_task tool with a uniform runTool error envelope.

Part of TASK-8.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `edit_task` tool

**Files:**

- Modify: `src/mcp/handlers.ts` (add `EditTaskArgs`, `editTaskHandler`)
- Modify: `src/mcp/server.ts` (register `edit_task`)
- Modify: `src/test/unit/mcpWriteHandlers.test.ts` (add edit cases)

**Interfaces:**

- Consumes: `renderChecklist`, `assertValidStatus`, `assertValidPriority`, `requireSummary`, `BacklogWriter.updateTask(taskId, updates, parser)`.
- Produces: `editTaskHandler(deps, args: EditTaskArgs): Promise<TaskSummary>`.

- [ ] **Step 1: Write the failing edit tests**

Append to `src/test/unit/mcpWriteHandlers.test.ts`:

```ts
import { createTaskHandler, editTaskHandler } from '../../mcp/handlers';

describe('editTaskHandler', () => {
  it('updates fields and acceptance criteria', async () => {
    await createTaskHandler(deps(), { title: 'Edit me' });
    const summary = await editTaskHandler(deps(), {
      taskId: 'TASK-1',
      status: 'In Progress',
      priority: 'low',
      acceptanceCriteria: [{ text: 'compiles' }, { text: 'tested', checked: true }],
    });
    expect(summary.status).toBe('In Progress');
    expect(summary.priority).toBe('low');
    expect(summary.acceptanceCriteria.map((c) => c.text)).toEqual(['compiles', 'tested']);
    expect(summary.acceptanceCriteria[1].checked).toBe(true);
  });

  it('rejects an invalid status', async () => {
    await createTaskHandler(deps(), { title: 'Edit me' });
    await expect(editTaskHandler(deps(), { taskId: 'TASK-1', status: 'Nope' })).rejects.toThrow(
      'Invalid status'
    );
  });

  it('throws when the task does not exist', async () => {
    await expect(editTaskHandler(deps(), { taskId: 'TASK-404', title: 'x' })).rejects.toThrow(
      'TASK-404'
    );
  });
});
```

(Replace the existing `createTaskHandler` import line at the top of the file with the combined import shown here.)

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/test/unit/mcpWriteHandlers.test.ts`
Expected: FAIL — `editTaskHandler` is not exported.

- [ ] **Step 3: Implement `editTaskHandler`**

In `src/mcp/handlers.ts`, update the helper import to include `renderChecklist` and its type:

```ts
import {
  ChecklistInput,
  assertValidPriority,
  assertValidStatus,
  renderChecklist,
} from './taskWriteHelpers';
```

Append:

```ts
export interface EditTaskArgs {
  taskId: string;
  title?: string;
  status?: string;
  priority?: 'high' | 'medium' | 'low';
  labels?: string[];
  assignee?: string[];
  milestone?: string;
  description?: string;
  acceptanceCriteria?: ChecklistInput[];
  definitionOfDone?: ChecklistInput[];
  implementationPlan?: string;
  implementationNotes?: string;
  finalSummary?: string;
  dependencies?: string[];
  references?: string[];
}

/** Apply partial edits to a task and return the updated summary. */
export async function editTaskHandler(
  deps: McpHandlerDeps,
  args: EditTaskArgs
): Promise<TaskSummary> {
  const config = await deps.parser.getConfig();
  if (args.status) assertValidStatus(args.status, config.statuses ?? []);
  if (args.priority) assertValidPriority(args.priority);

  const updates: Record<string, unknown> = {};
  if (args.title !== undefined) updates.title = args.title;
  if (args.status !== undefined) updates.status = args.status;
  if (args.priority !== undefined) updates.priority = args.priority;
  if (args.labels !== undefined) updates.labels = args.labels;
  if (args.assignee !== undefined) updates.assignee = args.assignee;
  if (args.milestone !== undefined) updates.milestone = args.milestone;
  if (args.description !== undefined) updates.description = args.description;
  if (args.acceptanceCriteria !== undefined)
    updates.acceptanceCriteria = renderChecklist(args.acceptanceCriteria);
  if (args.definitionOfDone !== undefined)
    updates.definitionOfDone = renderChecklist(args.definitionOfDone);
  if (args.implementationPlan !== undefined) updates.implementationPlan = args.implementationPlan;
  if (args.implementationNotes !== undefined)
    updates.implementationNotes = args.implementationNotes;
  if (args.finalSummary !== undefined) updates.finalSummary = args.finalSummary;
  if (args.dependencies !== undefined) updates.dependencies = args.dependencies;
  if (args.references !== undefined) updates.references = args.references;

  await deps.writer.updateTask(args.taskId, updates as Partial<Task>, deps.parser);
  return requireSummary(deps, args.taskId);
}
```

- [ ] **Step 4: Run edit tests to verify pass**

Run: `bunx vitest run src/test/unit/mcpWriteHandlers.test.ts`
Expected: PASS (6 tests total).

- [ ] **Step 5: Register `edit_task` in `server.ts`**

Add `editTaskHandler` to the `./handlers` import. After `create_task`:

```ts
server.registerTool(
  'edit_task',
  {
    title: 'Edit task',
    description:
      'Apply partial edits to a task (status, priority, fields, description, acceptance criteria, notes). Returns the updated summary.',
    inputSchema: {
      taskId: z.string().describe('Task ID to edit, e.g. TASK-7.'),
      title: z.string().optional(),
      status: z.string().optional(),
      priority: z.enum(['high', 'medium', 'low']).optional(),
      labels: z.array(z.string()).optional(),
      assignee: z.array(z.string()).optional(),
      milestone: z.string().optional(),
      description: z.string().optional(),
      acceptanceCriteria: z
        .array(z.object({ text: z.string(), checked: z.boolean().optional() }))
        .optional(),
      definitionOfDone: z
        .array(z.object({ text: z.string(), checked: z.boolean().optional() }))
        .optional(),
      implementationPlan: z.string().optional(),
      implementationNotes: z.string().optional(),
      finalSummary: z.string().optional(),
      dependencies: z.array(z.string()).optional(),
      references: z.array(z.string()).optional(),
    },
  },
  async (args) => runTool(() => editTaskHandler(deps, args))
);
```

- [ ] **Step 6: Verify typecheck + compile**

Run: `bun run typecheck && bun run compile`
Expected: exit 0; bundle succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/handlers.ts src/mcp/server.ts src/test/unit/mcpWriteHandlers.test.ts
git commit -m "Add edit_task MCP tool

editTaskHandler maps partial edits (incl. AC/DoD checklists) onto
BacklogWriter.updateTask with status/priority validation.

Part of TASK-8.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Lifecycle moves — `complete_task` / `archive_task` / `restore_task`

**Files:**

- Modify: `src/mcp/handlers.ts` (add `MoveResult` + 3 handlers)
- Modify: `src/mcp/server.ts` (register 3 tools)
- Modify: `src/test/unit/mcpWriteHandlers.test.ts` (add move cases)

**Interfaces:**

- Consumes: `BacklogWriter.completeTask`, `archiveTask`, `restoreArchivedTask` (each returns the destination path string).
- Produces: `MoveResult = { taskId: string; outcome: 'completed' | 'archived' | 'restored'; path: string }`; `completeTaskHandler`, `archiveTaskHandler`, `restoreTaskHandler`.

- [ ] **Step 1: Write the failing move tests**

Append to `src/test/unit/mcpWriteHandlers.test.ts` (update the import to add the three handlers):

```ts
import {
  createTaskHandler,
  editTaskHandler,
  completeTaskHandler,
  archiveTaskHandler,
  restoreTaskHandler,
} from '../../mcp/handlers';

describe('lifecycle moves', () => {
  it('completes a task into completed/', async () => {
    await createTaskHandler(deps(), { title: 'Finish me' });
    const result = await completeTaskHandler(deps(), { taskId: 'TASK-1' });
    expect(result.outcome).toBe('completed');
    expect(result.path.replace(/\\/g, '/')).toContain('/completed/');
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it('archives then restores a task', async () => {
    await createTaskHandler(deps(), { title: 'Archive me' });
    const archived = await archiveTaskHandler(deps(), { taskId: 'TASK-1' });
    expect(archived.outcome).toBe('archived');
    expect(archived.path.replace(/\\/g, '/')).toContain('/archive/tasks/');

    const restored = await restoreTaskHandler(deps(), { taskId: 'TASK-1' });
    expect(restored.outcome).toBe('restored');
    expect(restored.path.replace(/\\/g, '/')).toContain('/tasks/');
    expect(fs.existsSync(restored.path)).toBe(true);
  });

  it('throws completing a missing task', async () => {
    await expect(completeTaskHandler(deps(), { taskId: 'TASK-404' })).rejects.toThrow('TASK-404');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/test/unit/mcpWriteHandlers.test.ts`
Expected: FAIL — move handlers not exported.

- [ ] **Step 3: Implement the move handlers**

Append to `src/mcp/handlers.ts`:

```ts
export interface MoveResult {
  taskId: string;
  outcome: 'completed' | 'archived' | 'restored';
  path: string;
}

/** Move a task into completed/. */
export async function completeTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<MoveResult> {
  const dest = await deps.writer.completeTask(args.taskId, deps.parser);
  return { taskId: args.taskId, outcome: 'completed', path: dest };
}

/** Move a task into archive/tasks/. */
export async function archiveTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<MoveResult> {
  const dest = await deps.writer.archiveTask(args.taskId, deps.parser);
  return { taskId: args.taskId, outcome: 'archived', path: dest };
}

/** Move an archived task back into tasks/ (or drafts/ for DRAFT- ids). */
export async function restoreTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<MoveResult> {
  const dest = await deps.writer.restoreArchivedTask(args.taskId, deps.parser);
  return { taskId: args.taskId, outcome: 'restored', path: dest };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bunx vitest run src/test/unit/mcpWriteHandlers.test.ts`
Expected: PASS (9 tests total).

- [ ] **Step 5: Register the three tools in `server.ts`**

Add the three handlers to the `./handlers` import, then:

```ts
server.registerTool(
  'complete_task',
  {
    title: 'Complete task',
    description: 'Move a task into completed/. Returns { taskId, outcome, path }.',
    inputSchema: { taskId: z.string().describe('Task ID to complete.') },
  },
  async (args) => runTool(() => completeTaskHandler(deps, args))
);

server.registerTool(
  'archive_task',
  {
    title: 'Archive task',
    description: 'Soft-delete a task into archive/tasks/. Returns { taskId, outcome, path }.',
    inputSchema: { taskId: z.string().describe('Task ID to archive.') },
  },
  async (args) => runTool(() => archiveTaskHandler(deps, args))
);

server.registerTool(
  'restore_task',
  {
    title: 'Restore task',
    description: 'Restore an archived task back to tasks/. Returns { taskId, outcome, path }.',
    inputSchema: { taskId: z.string().describe('Task ID to restore.') },
  },
  async (args) => runTool(() => restoreTaskHandler(deps, args))
);
```

- [ ] **Step 6: Verify typecheck + compile**

Run: `bun run typecheck && bun run compile`
Expected: exit 0; bundle succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/handlers.ts src/mcp/server.ts src/test/unit/mcpWriteHandlers.test.ts
git commit -m "Add complete/archive/restore MCP tools

Lifecycle move handlers return a light { taskId, outcome, path } since the
task leaves the active set.

Part of TASK-8.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Draft lifecycle — `promote_draft` / `demote_task`

**Files:**

- Modify: `src/mcp/handlers.ts` (add 2 handlers)
- Modify: `src/mcp/server.ts` (register 2 tools)
- Modify: `src/test/unit/mcpWriteHandlers.test.ts` (add cases)

**Interfaces:**

- Consumes: `BacklogWriter.promoteDraft(taskId, parser)` and `demoteTask(taskId, parser)` (each returns the new ID); `requireSummary`.
- Produces: `promoteDraftHandler(deps, { taskId }): Promise<TaskSummary>`; `demoteTaskHandler(deps, { taskId }): Promise<TaskSummary>`.

- [ ] **Step 1: Write the failing tests**

Append to `src/test/unit/mcpWriteHandlers.test.ts` (extend the handler import with `promoteDraftHandler, demoteTaskHandler`):

```ts
describe('draft lifecycle', () => {
  it('promotes a draft to a task', async () => {
    const draft = await createTaskHandler(deps(), { title: 'Idea', draft: true });
    expect(draft.id).toBe('DRAFT-1');
    const promoted = await promoteDraftHandler(deps(), { taskId: 'DRAFT-1' });
    expect(promoted.id).toMatch(/^TASK-\d+$/);
    expect(promoted.status).toBe('To Do');
  });

  it('demotes a task to a draft', async () => {
    await createTaskHandler(deps(), { title: 'Too early' });
    const demoted = await demoteTaskHandler(deps(), { taskId: 'TASK-1' });
    expect(demoted.id).toMatch(/^DRAFT-\d+$/);
    expect(demoted.status).toBe('Draft');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/test/unit/mcpWriteHandlers.test.ts`
Expected: FAIL — promote/demote handlers not exported.

- [ ] **Step 3: Implement the handlers**

Append to `src/mcp/handlers.ts`:

```ts
/** Promote a draft (DRAFT-N) to a task (new TASK-N id). */
export async function promoteDraftHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<TaskSummary> {
  const newId = await deps.writer.promoteDraft(args.taskId, deps.parser);
  return requireSummary(deps, newId);
}

/** Demote a task to a draft (new DRAFT-N id, status Draft). */
export async function demoteTaskHandler(
  deps: McpHandlerDeps,
  args: { taskId: string }
): Promise<TaskSummary> {
  const newId = await deps.writer.demoteTask(args.taskId, deps.parser);
  return requireSummary(deps, newId);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bunx vitest run src/test/unit/mcpWriteHandlers.test.ts`
Expected: PASS (11 tests total).

- [ ] **Step 5: Register the two tools in `server.ts`**

Add the handlers to the import, then:

```ts
server.registerTool(
  'promote_draft',
  {
    title: 'Promote draft',
    description: 'Promote a draft (DRAFT-N) into a task with a new TASK-N id.',
    inputSchema: { taskId: z.string().describe('Draft ID to promote, e.g. DRAFT-3.') },
  },
  async (args) => runTool(() => promoteDraftHandler(deps, args))
);

server.registerTool(
  'demote_task',
  {
    title: 'Demote task',
    description: 'Demote a task into a draft (new DRAFT-N id, status Draft).',
    inputSchema: { taskId: z.string().describe('Task ID to demote, e.g. TASK-7.') },
  },
  async (args) => runTool(() => demoteTaskHandler(deps, args))
);
```

- [ ] **Step 6: Verify typecheck + compile**

Run: `bun run typecheck && bun run compile`
Expected: exit 0; bundle succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/handlers.ts src/mcp/server.ts src/test/unit/mcpWriteHandlers.test.ts
git commit -m "Add promote_draft/demote_task MCP tools

Part of TASK-8.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `create_subtask` tool (+ titled `createSubtask`)

**Files:**

- Modify: `src/core/BacklogWriter.ts` (`createSubtask` accepts `{ title?, description? }`)
- Modify: `src/mcp/handlers.ts` (add `createSubtaskHandler`)
- Modify: `src/mcp/server.ts` (register `create_subtask`)
- Modify: `src/test/unit/mcpWriteHandlers.test.ts` (add case)

**Interfaces:**

- Consumes: `BacklogWriter.createSubtask(parentTaskId, backlogPath, parser?, opts?)`; `requireSummary`.
- Produces: `createSubtaskHandler(deps, { parentTaskId, title?, description? }): Promise<TaskSummary>`.

- [ ] **Step 1: Write the failing test**

Append to `src/test/unit/mcpWriteHandlers.test.ts` (extend the import with `createSubtaskHandler`):

```ts
describe('createSubtaskHandler', () => {
  it('creates a titled subtask under its parent', async () => {
    await createTaskHandler(deps(), { title: 'Parent' });
    const sub = await createSubtaskHandler(deps(), {
      parentTaskId: 'TASK-1',
      title: 'Child step',
    });
    expect(sub.id).toBe('TASK-1.1');
    expect(sub.title).toBe('Child step');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/test/unit/mcpWriteHandlers.test.ts`
Expected: FAIL — `createSubtaskHandler` not exported / title is "Untitled".

- [ ] **Step 3: Make `createSubtask` accept a title/description**

In `src/core/BacklogWriter.ts`, change the `createSubtask` signature and the title/body lines. Update the signature:

```ts
  async createSubtask(
    parentTaskId: string,
    backlogPath: string,
    parser?: BacklogParser,
    opts?: { title?: string; description?: string }
  ): Promise<{ id: string; filePath: string }> {
```

Replace the filename/title section (currently hardcoding `Untitled`) with:

```ts
const taskId = `${taskPrefix}-${parentNum}.${nextSubId}`.toUpperCase();
const title = opts?.title?.trim() || 'Untitled';
const sanitizedTitle = title
  .replace(/[^a-zA-Z0-9\s-]/g, '')
  .replace(/\s+/g, '-')
  .substring(0, 50);
const fileName = `${lowerPrefix}-${parentNum}.${nextSubId} - ${sanitizedTitle}.md`;
const filePath = path.join(tasksDir, fileName);
```

In the `frontmatter` object literal, change `title: 'Untitled',` to `title,`. Then replace the body assignment:

```ts
const descBlock = opts?.description
  ? `<!-- SECTION:DESCRIPTION:BEGIN -->\n${opts.description}\n<!-- SECTION:DESCRIPTION:END -->`
  : '<!-- SECTION:DESCRIPTION:BEGIN -->\n<!-- SECTION:DESCRIPTION:END -->';
let body = `\n## Description\n\n${descBlock}\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n<!-- AC:END -->\n`;
```

(The existing Definition-of-Done append block below this line stays unchanged.)

- [ ] **Step 4: Implement `createSubtaskHandler`**

Append to `src/mcp/handlers.ts`:

```ts
/** Create a subtask under a parent and return its summary. */
export async function createSubtaskHandler(
  deps: McpHandlerDeps,
  args: { parentTaskId: string; title?: string; description?: string }
): Promise<TaskSummary> {
  const { id } = await deps.writer.createSubtask(args.parentTaskId, deps.backlogPath, deps.parser, {
    title: args.title,
    description: args.description,
  });
  return requireSummary(deps, id);
}
```

- [ ] **Step 5: Run to verify pass**

Run: `bunx vitest run src/test/unit/mcpWriteHandlers.test.ts`
Expected: PASS (12 tests total).

- [ ] **Step 6: Register `create_subtask` in `server.ts`**

Add `createSubtaskHandler` to the import, then:

```ts
server.registerTool(
  'create_subtask',
  {
    title: 'Create subtask',
    description: 'Create a subtask (dot-notation id, e.g. TASK-7.1) under a parent task.',
    inputSchema: {
      parentTaskId: z.string().describe('Parent task ID, e.g. TASK-7.'),
      title: z.string().optional(),
      description: z.string().optional(),
    },
  },
  async (args) => runTool(() => createSubtaskHandler(deps, args))
);
```

- [ ] **Step 7: Verify the full unit suite + compile**

Run: `bun run typecheck && bunx vitest run src/test/unit/mcpWriteHandlers.test.ts src/test/unit/mcpHandlers.test.ts && bun run compile`
Expected: typecheck 0; all handler tests pass; bundle succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/core/BacklogWriter.ts src/mcp/handlers.ts src/mcp/server.ts src/test/unit/mcpWriteHandlers.test.ts
git commit -m "Add create_subtask MCP tool

Extend BacklogWriter.createSubtask to accept a title/description and expose
it as the create_subtask tool.

Part of TASK-8.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Drop the hard `backlog` dependency (config + docs)

**Files:**

- Modify: `.mcp.json` (remove the `backlog` server)
- Modify: `src/core/intakePrompt.ts` (point at `create_task`)
- Modify: `src/test/unit/intakePrompt.test.ts` (assert `create_task`)
- Modify: `README.md` (CLI optional)
- Modify: `CLAUDE.md` (coupling rules)
- Modify: `AGENTS.md` (inline workflow, drop `backlog://workflow/overview`)

**Interfaces:** None (config + prose). Behavior verified by the intake test and a grep.

- [ ] **Step 1: Update the failing intake test first**

In `src/test/unit/intakePrompt.test.ts`, change the assertion:

```ts
expect(out).toContain('create_task');
```

and add, in the same `it` block:

```ts
expect(out).not.toContain('Backlog.md MCP');
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run src/test/unit/intakePrompt.test.ts`
Expected: FAIL — template still says `task_create` / `Backlog.md MCP`.

- [ ] **Step 3: Repoint the intake template**

In `src/core/intakePrompt.ts`: in the module doc comment, change "via the Backlog.md MCP" to "via the Taskwright MCP". In `DEFAULT_INTAKE_TEMPLATE`, change the second paragraph's first sentence to:

```ts
For each distinct issue in the dump below, create one task with the Taskwright MCP \`create_task\` tool. Before creating, review existing tasks and skip anything already tracked. For each new task:
```

- [ ] **Step 4: Run to verify pass**

Run: `bunx vitest run src/test/unit/intakePrompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Remove the `backlog` server from `.mcp.json`**

Replace the file contents with (drop the `backlog` block; keep `taskwright` and `svelte`):

```json
{
  "mcpServers": {
    "taskwright": {
      "type": "stdio",
      "command": "node",
      "args": ["dist/mcp/server.js"],
      "env": {}
    },
    "svelte": {
      "type": "http",
      "url": "https://mcp.svelte.dev/mcp"
    }
  }
}
```

- [ ] **Step 6: Update `README.md` Requirements**

In `README.md`, change the Backlog.md CLI requirement line to reflect that it is now optional. Replace:

```
- The [Backlog.md](https://github.com/MrLesk/Backlog.md) CLI on PATH for writes and cross-branch features
```

with:

```
- The [Backlog.md](https://github.com/MrLesk/Backlog.md) CLI is **optional** — Taskwright reads and writes tasks itself (the latter via its MCP server). The CLI is only needed for the cross-branch board view, which otherwise degrades to local-branch tasks.
```

- [ ] **Step 7: Update `CLAUDE.md` coupling rules**

In `CLAUDE.md`, under "Coupling rules", replace the first bullet:

```
- **Read** task data by parsing `backlog/tasks/*.md` directly. **Write** via the `backlog` CLI
  (`BacklogCli.execute`) to keep IDs/frontmatter format valid. Only Taskwright's own new fields
  (claims) are written directly.
```

with:

```
- **Read** task data by parsing `backlog/tasks/*.md` directly. **Write** through Taskwright's own
  `BacklogWriter` (`src/core/BacklogWriter.ts`), which reproduces Backlog.md's frontmatter
  byte-for-byte; agents reach it via the Taskwright MCP write tools (`create_task`, `edit_task`,
  …). The external `backlog` CLI is no longer required for task CRUD.
```

- [ ] **Step 8: Update `AGENTS.md` workflow instruction**

In `AGENTS.md`, replace the `<CRITICAL_INSTRUCTION>` "BACKLOG WORKFLOW INSTRUCTIONS" block (which tells agents to read `backlog://workflow/overview` from the backlog MCP) with a concise inline workflow that references the Taskwright tools:

```markdown
<CRITICAL_INSTRUCTION>

## Task workflow (Taskwright MCP)

Task and project management runs through the **Taskwright MCP server** (`.mcp.json`), not an
external CLI. At the start of a task session:

1. `get_active_task` — load your assigned task and its full context.
2. `claim_task` — mark it in progress (advisory; prevents cross-worktree collisions).
3. Do the work. Use `create_task` / `edit_task` to add or update tasks, `create_subtask` for
   breakdowns, and `complete_task` when done. Record progress with `edit_task`
   (implementationNotes / finalSummary).
4. `release_task` when you finish or hand off.

Generated task files stay byte-for-byte compatible with Backlog.md, so the board remains
readable by the upstream tools if they are installed.

</CRITICAL_INSTRUCTION>
```

- [ ] **Step 9: Verify no stale references remain**

Run: `bunx vitest run src/test/unit/intakePrompt.test.ts && bun run typecheck`
Then confirm the `backlog` MCP server is gone and intake is repointed (use the Grep tool, not shell): search `src` and root config for `task_create` and `backlog mcp` — expect no matches except historical mentions in `docs/` specs.

- [ ] **Step 10: Commit**

```bash
git add .mcp.json src/core/intakePrompt.ts src/test/unit/intakePrompt.test.ts README.md CLAUDE.md AGENTS.md
git commit -m "Drop the hard backlog CLI/MCP dependency

Remove the backlog MCP server from .mcp.json; repoint the intake prompt at
the Taskwright create_task tool; update README/CLAUDE.md/AGENTS.md so task
CRUD goes through Taskwright. Cross-branch view stays an optional CLI extra.

Part of TASK-8.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Full verification + finalize

**Files:**

- Modify: `docs/superpowers/specs/2026-06-30-taskwright-native-mcp-crud-design.md` (Status → Implemented)
- Modify: the TASK-8 board file (status → Done) via the workflow

**Interfaces:** None.

- [ ] **Step 1: Run the full gate**

Run: `bun run test ; bun run lint ; bun run typecheck`
Expected: lint + typecheck exit 0. Unit tests: the only acceptable failures are the four pre-existing Windows POSIX-path files (`BacklogParser`, `BacklogWriter`, `CrossBranchIntegration`, `openWorkspaceFile`) — and only when run on Windows. All new tests (`taskWriteHelpers`, `mcpWriteHandlers`, updated `mcpHandlers`, `intakePrompt`) pass. On Linux/CI the whole suite is green.

- [ ] **Step 2: Build the bundle and confirm the MCP server boots + registers the tools**

Run: `bun run build`

Then confirm the server boots without crashing (it logs its ready line to stderr and stays running):

Run: `node -e "const{spawn}=require('child_process');const c=spawn('node',['dist/mcp/server.js']);let e='';c.stderr.on('data',d=>e+=d);setTimeout(()=>{c.kill();console.log(/\[taskwright-mcp\] ready/.test(e)?'BOOT OK':'BOOT FAIL: '+e);},1500);"`
Expected: prints `BOOT OK`.

Then confirm all eight write tools are registered in the bundle (use the Grep tool on `dist/mcp/server.js`, or):

Run: `node -e "const s=require('fs').readFileSync('dist/mcp/server.js','utf8');console.log(['create_task','edit_task','complete_task','archive_task','promote_draft','demote_task','create_subtask','restore_task'].filter(t=>!s.includes(t)).join(',')||'ALL PRESENT')"`
Expected: prints `ALL PRESENT`.

- [ ] **Step 3: Flip the spec status**

In `docs/superpowers/specs/2026-06-30-taskwright-native-mcp-crud-design.md`, change `- **Status:** Approved (design)` to `- **Status:** Implemented`.

- [ ] **Step 4: Mark TASK-8 Done on the board**

Set TASK-8 status to Done and add a short final summary. The simplest reliable path is the local
`backlog` CLI:

Run: `backlog task edit 8 -s Done --notes "Taskwright MCP now exposes native task CRUD; backlog CLI no longer required for task management."`

(Dogfooding the new `edit_task` tool instead is optional and not required for this step.) Verify the
board file under `backlog/tasks/task-8 - *.md` shows `status: Done`.

- [ ] **Step 5: Final commit**

```bash
git add docs/superpowers/specs/2026-06-30-taskwright-native-mcp-crud-design.md "backlog/tasks/"
git commit -m "Finalize native MCP task CRUD

Full gate green (modulo pre-existing Windows path tests, TASK-4); MCP server
lists all eight write tools. Mark spec Implemented and TASK-8 Done.

Completes TASK-8.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **ID allocation is local-only** by design (see spec): the MCP process scans the local `tasks/`
  dir, so two parallel worktree sessions can mint the same `TASK-N`. This is the accepted
  advisory model — do not add cross-branch ID scanning here.
- **Do not hand-write frontmatter.** Every write must go through `BacklogWriter`; that is what
  guarantees byte-compatibility. Tests assert file locations, not byte layout (already covered by
  `BacklogWriter.test.ts`).
- **`runTool` is the only error surface.** Handlers throw plain `Error`s; the wrapper turns them
  into `{ isError: true }` results so the stdio JSON-RPC channel never breaks.
- Keep all incidental logging on `stderr` (the server already reroutes `console.log`).
