# Default-to-Worktrees Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make per-task git worktrees the default for dispatch, and add an opt-in way to launch an interactive Claude Code chat (never `claude -p`) in the worktree terminal, seeded from the handoff file.

**Architecture:** Flip the `dispatchCreateWorktree` setting default to `true` (manifest + code fallback in lockstep). Add pure, unit-tested core functions in `src/core/dispatchPrompt.ts` (`handoffFile` on the dispatch context, a `claude -p` detector, and a `resolveTerminalLaunch` decision function). The vscode-coupled `src/providers/dispatchActions.ts` stays thin — it just wires those decisions to `terminal.sendText` / warnings.

**Tech Stack:** TypeScript, Vitest (unit), VS Code extension API. Build/test via Bun.

## Global Constraints

- Subscription-safe: Taskwright NEVER spawns `claude -p` and never auto-launches a session by default. (verbatim project rule)
- Manifest default and code fallback default for a setting MUST match (`package.json` `contributes.configuration` ↔ `getTaskwrightConfig` default arg).
- Pure cores live in `src/core/` and stay vscode-free (importable by the MCP server and unit tests). vscode glue lives in `src/providers/`.
- TDD: failing test first. Run `bun run test && bun run lint && bun run typecheck` before marking the task Done.
- Unit tests live in `src/test/unit/**/*.test.ts`; `vscode` is aliased to a mock, so provider glue (`dispatchActions.ts`) is NOT unit-tested — its logic is extracted into pure cores that are.
- Lucide icons (not emojis) in any webview. (No webview changes in this plan.)
- Commit per task, referencing TASK-13.

---

### Task 1: Add `handoffFile` to the dispatch context

The terminal-launch command needs the handoff file path as a `{{handoffFile}}` placeholder. Thread it through the dispatch context (mirroring how `worktree` is threaded).

**Files:**

- Modify: `src/core/dispatchPrompt.ts` (interface `DispatchContext`; function `dispatchContextFromTask`)
- Test: `src/test/unit/dispatchPrompt.test.ts`

**Interfaces:**

- Consumes: existing `dispatchContextFromTask(task, opts)`.
- Produces: `DispatchContext.handoffFile: string`; `dispatchContextFromTask(task, { worktree?: string; handoffFile?: string })` — `handoffFile` defaults to `''`.

- [ ] **Step 1: Write the failing tests**

Add to `src/test/unit/dispatchPrompt.test.ts` inside the existing `describe('dispatchContextFromTask', …)` block:

```ts
it('carries the handoff file path when provided', () => {
  const ctx = dispatchContextFromTask(makeTask(), {
    worktree: 'task-7',
    handoffFile: '/repo/.taskwright/handoff/TASK-7.md',
  });
  expect(ctx.handoffFile).toBe('/repo/.taskwright/handoff/TASK-7.md');
});

it('defaults handoffFile to empty when not provided', () => {
  expect(dispatchContextFromTask(makeTask()).handoffFile).toBe('');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- dispatchPrompt`
Expected: FAIL — `ctx.handoffFile` is `undefined` (property does not exist yet).

- [ ] **Step 3: Add the field and populate it**

In `src/core/dispatchPrompt.ts`, add `handoffFile` to the `DispatchContext` interface (after `filePath`):

```ts
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
```

Update `dispatchContextFromTask`'s signature and return value:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- dispatchPrompt`
Expected: PASS (all dispatchPrompt tests, including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add src/core/dispatchPrompt.ts src/test/unit/dispatchPrompt.test.ts
git commit -m "Add handoffFile to dispatch context

- Thread {{handoffFile}} placeholder through DispatchContext
- Reference TASK-13

Co-Authored-By: Claude 4.8-Opus"
```

---

### Task 2: Add the `claude -p` guard and terminal-launch decision

Pure, testable decision logic for what (if anything) to run in the dispatch terminal. Empty template → do nothing; a `claude -p`/`--print` command → refuse with a warning; otherwise render and run.

**Files:**

- Modify: `src/core/dispatchPrompt.ts` (add `TerminalLaunchDecision`, `commandUsesClaudePrintMode`, `resolveTerminalLaunch`)
- Test: `src/test/unit/dispatchPrompt.test.ts`

**Interfaces:**

- Consumes: `renderDispatchPrompt(template, ctx)` (reused as the generic context renderer — DRY, no separate command renderer), `DispatchContext` from Task 1.
- Produces:
  - `interface TerminalLaunchDecision { run: boolean; command?: string; warning?: string }`
  - `commandUsesClaudePrintMode(command: string): boolean`
  - `resolveTerminalLaunch(commandTemplate: string, ctx: DispatchContext): TerminalLaunchDecision`

- [ ] **Step 1: Write the failing tests**

Add to the imports at the top of `src/test/unit/dispatchPrompt.test.ts`:

```ts
import {
  DEFAULT_DISPATCH_TEMPLATE,
  commandUsesClaudePrintMode,
  dispatchBranchName,
  dispatchContextFromTask,
  formatChecklist,
  renderDispatchPrompt,
  resolveTerminalLaunch,
} from '../../core/dispatchPrompt';
```

Append these `describe` blocks to the file:

```ts
describe('commandUsesClaudePrintMode', () => {
  it('flags claude -p and --print invocations', () => {
    expect(commandUsesClaudePrintMode('claude -p "do it"')).toBe(true);
    expect(commandUsesClaudePrintMode('claude --print < file')).toBe(true);
  });

  it('allows an interactive claude chat seeded from a file', () => {
    expect(commandUsesClaudePrintMode('claude "$(cat handoff.md)"')).toBe(false);
    expect(commandUsesClaudePrintMode("claude (Get-Content -Raw 'handoff.md')")).toBe(false);
  });

  it('does not flag -p that belongs to a different command segment', () => {
    expect(commandUsesClaudePrintMode('grep -p foo && claude "go"')).toBe(false);
  });

  it('ignores non-claude commands', () => {
    expect(commandUsesClaudePrintMode('echo -p hello')).toBe(false);
  });
});

describe('resolveTerminalLaunch', () => {
  const ctx = dispatchContextFromTask(makeTask(), {
    worktree: 'task-7',
    handoffFile: '/repo/.taskwright/handoff/TASK-7.md',
  });

  it('does nothing for an empty or whitespace template', () => {
    expect(resolveTerminalLaunch('', ctx)).toEqual({ run: false });
    expect(resolveTerminalLaunch('   ', ctx)).toEqual({ run: false });
  });

  it('renders placeholders and runs an interactive command', () => {
    const d = resolveTerminalLaunch('claude "$(cat {{handoffFile}})"', ctx);
    expect(d.run).toBe(true);
    expect(d.command).toBe('claude "$(cat /repo/.taskwright/handoff/TASK-7.md)"');
    expect(d.warning).toBeUndefined();
  });

  it('refuses a claude -p command and returns a warning', () => {
    const d = resolveTerminalLaunch('claude -p "$(cat {{handoffFile}})"', ctx);
    expect(d.run).toBe(false);
    expect(d.command).toBeUndefined();
    expect(d.warning).toMatch(/-p/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- dispatchPrompt`
Expected: FAIL — `commandUsesClaudePrintMode`/`resolveTerminalLaunch` are not exported (import error / not a function).

- [ ] **Step 3: Implement the functions**

Append to `src/core/dispatchPrompt.ts` (after `renderDispatchPrompt`):

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- dispatchPrompt`
Expected: PASS (all dispatchPrompt tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/dispatchPrompt.ts src/test/unit/dispatchPrompt.test.ts
git commit -m "Add subscription-safe terminal-launch decision core

- commandUsesClaudePrintMode flags claude -p/--print
- resolveTerminalLaunch: empty=noop, -p=refuse+warn, else render+run
- Reference TASK-13

Co-Authored-By: Claude 4.8-Opus"
```

---

### Task 3: Make worktrees the dispatch default

Flip the `dispatchCreateWorktree` default to `true` in both the manifest and the code fallback, guarded by a config-consistency test.

**Files:**

- Modify: `package.json:78-82` (`taskwright.dispatchCreateWorktree`)
- Modify: `src/providers/dispatchActions.ts:43-50` (`readSettings`)
- Test (create): `src/test/unit/configDefaults.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: no new code symbols; behavioral default change. `readSettings()` now returns `createWorktree: true` when the setting is unset.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/configDefaults.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The manifest's contributed defaults are the source of truth users see; these
 * assertions guard against the manifest and the code fallbacks drifting apart.
 */
const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'));
const props = pkg.contributes.configuration.properties as Record<
  string,
  { type: string; default: unknown }
>;

describe('contributed dispatch config defaults', () => {
  it('defaults dispatchCreateWorktree to true (worktrees by default)', () => {
    expect(props['taskwright.dispatchCreateWorktree'].default).toBe(true);
  });

  it('keeps dispatchOpenTerminal opt-in (default false)', () => {
    expect(props['taskwright.dispatchOpenTerminal'].default).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- configDefaults`
Expected: FAIL — `dispatchCreateWorktree` default is currently `false`.

- [ ] **Step 3: Flip the manifest default**

In `package.json`, change the `taskwright.dispatchCreateWorktree` block to:

```json
        "taskwright.dispatchCreateWorktree": {
          "type": "boolean",
          "default": true,
          "markdownDescription": "Dispatch each task into its own isolated git worktree at `.worktrees/<branch>` (the default), so parallel sessions never share a working directory or active task. Set to `false` to dispatch into the workspace root instead. Falls back to the workspace root automatically when the folder is not a git repository."
        },
```

- [ ] **Step 4: Flip the code fallback**

In `src/providers/dispatchActions.ts`, change the `createWorktree` line in `readSettings` so the fallback matches the manifest:

```ts
    createWorktree: getTaskwrightConfig<boolean>('dispatchCreateWorktree', true),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test -- configDefaults`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json src/providers/dispatchActions.ts src/test/unit/configDefaults.test.ts
git commit -m "Default dispatch to git worktrees

- dispatchCreateWorktree default false -> true (manifest + code fallback)
- Config-consistency test guards manifest/code default drift
- Reference TASK-13

Co-Authored-By: Claude 4.8-Opus"
```

---

### Task 4: Wire the opt-in terminal-launch command

Add the `dispatchTerminalCommand` setting and run the resolved command in the dispatch-opened worktree terminal (using the Task 2 core).

**Files:**

- Modify: `package.json` (after the `taskwright.dispatchOpenTerminal` block, before `taskwright.intakeTemplate`)
- Modify: `src/providers/dispatchActions.ts` (imports; `DispatchSettings`; `readSettings`; context build; terminal block)
- Test: `src/test/unit/configDefaults.test.ts` (append the new-setting assertion)

**Interfaces:**

- Consumes: `resolveTerminalLaunch` + `DispatchContext` (Task 2), `handoffPath` from `src/core/handoff.ts`, `dispatchContextFromTask` with `handoffFile` (Task 1).
- Produces: `DispatchSettings.terminalCommand: string`; setting `taskwright.dispatchTerminalCommand`.

- [ ] **Step 1: Write the failing test**

Append to the `describe('contributed dispatch config defaults', …)` block in `src/test/unit/configDefaults.test.ts`:

```ts
it('contributes dispatchTerminalCommand defaulting to empty string', () => {
  const setting = props['taskwright.dispatchTerminalCommand'];
  expect(setting.type).toBe('string');
  expect(setting.default).toBe('');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- configDefaults`
Expected: FAIL — `props['taskwright.dispatchTerminalCommand']` is `undefined`.

- [ ] **Step 3: Add the manifest setting**

In `package.json`, insert this block immediately after the `taskwright.dispatchOpenTerminal` block (and before `taskwright.intakeTemplate`):

```json
        "taskwright.dispatchTerminalCommand": {
          "type": "string",
          "default": "",
          "markdownDescription": "When a dispatch opens a worktree terminal (`taskwright.dispatchOpenTerminal`), run this command in it. Supports the dispatch placeholders, notably `{{handoffFile}}` (path to the saved prompt) plus `{{id}}`, `{{title}}`, `{{worktree}}`. Leave empty to just open the terminal. To auto-start a session, use an **interactive** Claude Code chat seeded from the handoff file — e.g. bash: `claude \"$(cat {{handoffFile}})\"`, PowerShell: `claude (Get-Content -Raw '{{handoffFile}}')`. Commands using `claude -p`/`--print` (headless/metered) are skipped with a warning."
        },
```

- [ ] **Step 3b: Run the test to verify it passes**

Run: `bun run test -- configDefaults`
Expected: PASS.

- [ ] **Step 4: Wire it in `dispatchActions.ts`**

Update the imports — change the handoff import to include `handoffPath`, and add `resolveTerminalLaunch` to the dispatchPrompt import:

```ts
import { writeHandoff, handoffPath } from '../core/handoff';
```

```ts
import {
  DEFAULT_DISPATCH_TEMPLATE,
  dispatchBranchName,
  dispatchContextFromTask,
  renderDispatchPrompt,
  resolveTerminalLaunch,
} from '../core/dispatchPrompt';
```

Add `terminalCommand` to the `DispatchSettings` interface:

```ts
interface DispatchSettings {
  template: string;
  createWorktree: boolean;
  openTerminal: boolean;
  terminalCommand: string;
}
```

Add it to `readSettings`'s returned object:

```ts
    terminalCommand: getTaskwrightConfig<string>('dispatchTerminalCommand', ''),
```

Replace the active-task / prompt / handoff block (currently lines ~97-103) so the context carries the handoff path and is reused for the terminal command:

```ts
// Mark the task active for the session root so the MCP get_active_task resolves
// it, then render + persist the paste-ready prompt.
writeActiveTask(sessionRoot, taskId);
const handoffFile = handoffPath(sessionRoot, taskId);
const context = dispatchContextFromTask(task, { worktree: branch, handoffFile });
const prompt = renderDispatchPrompt(settings.template, context);
writeHandoff(sessionRoot, taskId, prompt);
await vscode.env.clipboard.writeText(prompt);
```

Replace the terminal block (currently lines ~105-111):

```ts
if (settings.openTerminal && worktreePath) {
  const terminal = vscode.window.createTerminal({
    name: `Taskwright ${taskId}`,
    cwd: worktreePath,
  });
  terminal.show();
  const launch = resolveTerminalLaunch(settings.terminalCommand, context);
  if (launch.warning) {
    vscode.window.showWarningMessage(launch.warning);
  }
  if (launch.run && launch.command) {
    terminal.sendText(launch.command, true);
  }
}
```

(`DispatchResult.handoffFile` is still returned as `handoffFile` — now sourced from `handoffPath`, which equals what `writeHandoff` writes.)

- [ ] **Step 5: Verify the whole suite + types + lint**

Run: `bun run test && bun run lint && bun run typecheck`
Expected: PASS. (No new unit test for the vscode wiring itself — its logic lives in the Task 2 pure core; the wiring is exercised manually / by build.)

- [ ] **Step 6: Commit**

```bash
git add package.json src/providers/dispatchActions.ts src/test/unit/configDefaults.test.ts
git commit -m "Add opt-in dispatch terminal command

- dispatchTerminalCommand runs in the worktree terminal, templated on {{handoffFile}}
- Refuses claude -p; recommends an interactive chat per shell
- Reference TASK-13

Co-Authored-By: Claude 4.8-Opus"
```

---

### Task 5: Update docs

Reword the README and CLAUDE.md so worktrees read as the default and the new setting is documented.

**Files:**

- Modify: `README.md` (lines ~17, ~34 — dispatch / worktree wording)
- Modify: `CLAUDE.md` (Phase 3 "Subscription-safe dispatch" bullet)

**Interfaces:** none (documentation only — no test cycle; UI/doc-only change per AGENTS.md).

- [ ] **Step 1: Update README**

In `README.md`, reword the dispatch bullet (~line 34) from:

```
- **Dispatch** — copies a paste-ready prompt (and an optional git worktree) for a task. Never spawns
```

to:

```
- **Dispatch** — copies a paste-ready prompt and carves an isolated git worktree (the default) for a task. Never spawns
```

And the numbered "Dispatch" line (~line 17) from:

```
3. **Dispatch** an isolated session per task. Each task maps to a branch/worktree; the agent claims it,
```

to:

```
3. **Dispatch** an isolated session per task. Each task gets its own git worktree (the default) so parallel sessions never collide; the agent claims it,
```

If the README has a settings section, add a short note (otherwise skip): worktree-per-dispatch is on by default (`taskwright.dispatchCreateWorktree: false` to opt out); `taskwright.dispatchOpenTerminal` + `taskwright.dispatchTerminalCommand` can open a worktree terminal and run an interactive `claude` chat seeded from `{{handoffFile}}`.

- [ ] **Step 2: Update CLAUDE.md**

In `CLAUDE.md`, in the "Subscription-safe dispatch ✅ (Phase 3)" bullet, after the `WorktreeService.ts` parenthetical, change the worktree description to reflect the new default and append a sentence documenting the terminal command. Replace:

```
`src/core/WorktreeService.ts`
  (optional `.worktrees/<branch>` isolation, `backlog.dispatchCreateWorktree`), `src/core/handoff.ts`
```

with:

```
`src/core/WorktreeService.ts`
  (`.worktrees/<branch>` isolation, **on by default** via `taskwright.dispatchCreateWorktree`; set `false` to opt out), `src/core/handoff.ts`
```

And append to the end of that same bullet (after the `e2e/dispatch.spec.ts` sentence):

```
  Opt-in `taskwright.dispatchOpenTerminal` + `taskwright.dispatchTerminalCommand` run a command (templated on `{{handoffFile}}`) in the worktree terminal; the command is refused if it uses `claude -p` (subscription-safe — `resolveTerminalLaunch` / `commandUsesClaudePrintMode` in `src/core/dispatchPrompt.ts`).
```

- [ ] **Step 3: Verify build still passes (lint touches markdown via prettier)**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "Document worktree-default dispatch and terminal command

- README + CLAUDE.md: worktrees are the default; document dispatchTerminalCommand
- Reference TASK-13

Co-Authored-By: Claude 4.8-Opus"
```

---

### Final verification

- [ ] **Step 1: Full gate**

Run: `bun run test && bun run lint && bun run typecheck`
Expected: PASS (note: ~22 upstream unit tests assert POSIX paths and fail only on Windows per CLAUDE.md — verify no NEW failures beyond those known ones).

- [ ] **Step 2: Record outcome in the task**

Use the `edit_task` MCP tool to set `TASK-13` Implementation Notes (what changed, the `-p` guard rationale, the cross-shell command examples) and Final Summary, then mark it Done — before announcing completion, per AGENTS.md.

## Self-Review

**Spec coverage:**

- Goal 1 (worktree default) → Task 3. ✓
- Goal 2 (subscription-safe, no `-p`) → Task 2 guard + Task 4 wiring. ✓
- Goal 3 (opt-in interactive chat launch) → Task 4 setting + Task 2 `resolveTerminalLaunch`. ✓
- Goal 4 (existing fallback unchanged) → not modified; Task 3/4 leave the non-git fallback in `dispatchTask` intact. ✓
- `{{handoffFile}}` on context → Task 1. ✓
- Pure cores for testability → Tasks 1–2. ✓
- Docs tidy → Task 5. ✓
- Tests: unit (Tasks 1, 2, config-consistency Tasks 3–4). The spec mentioned extending `e2e/dispatch.spec.ts` for worktree/terminal behavior; on inspection that file is a **webview** component test (no extension host / real git), so it cannot assert provider-glue behavior. Resolved by extracting the logic into the unit-tested `resolveTerminalLaunch` core instead — deviation noted here.

**Placeholder scan:** No TBD/TODO/"add error handling" — all steps carry concrete code. ✓

**Type consistency:** `DispatchContext.handoffFile: string` (Task 1) used by `resolveTerminalLaunch` (Task 2) and built in `dispatchActions` (Task 4). `TerminalLaunchDecision { run, command?, warning? }` produced in Task 2, consumed in Task 4 as `launch.warning` / `launch.run` / `launch.command`. `handoffPath` imported from `../core/handoff` (exists). `terminalCommand` consistent across `DispatchSettings`, `readSettings`, and `resolveTerminalLaunch` call. ✓
