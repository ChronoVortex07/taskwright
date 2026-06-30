# Default to worktrees on dispatch (+ opt-in terminal prompt prefill)

**Task:** TASK-13 — Default to using worktrees rather than branches
**Date:** 2026-06-30
**Status:** Approved (brainstorming)

## Problem

Taskwright's reason for existing is running **multiple isolated Claude Code sessions
at once**, one per task. A plain git branch can't deliver that: a single working
directory can only have one branch checked out, so two sessions sharing it stomp on
each other. Git **worktrees** are the mechanism that actually gives each session its
own working directory (and its own `.taskwright/active-task.json`).

The worktree machinery already exists (`src/core/WorktreeService.ts`, the
`dispatchCreateWorktree` setting, fallback-to-root on non-git), but it ships **off by
default** (`taskwright.dispatchCreateWorktree: false`). So out of the box Taskwright
dispatches into the shared workspace root — the exact thing that breaks parallel
sessions. This task makes worktrees the default and tidies the surrounding UX/docs.

A secondary request (from brainstorming): when a dispatch opens a terminal in the new
worktree, optionally **prefill the dispatch prompt** so the user can drop straight into
a session — but only as an opt-in, and only ever via an **interactive Claude Code chat**,
never a `claude -p` (headless/metered) process.

## Goals

1. Worktree-per-dispatch is the **default** behavior, with a documented opt-out.
2. Keep dispatch **subscription-safe**: the extension never auto-spawns a session and
   never uses `claude -p`.
3. Provide an **opt-in** way to launch an interactive Claude Code chat in the worktree
   terminal, seeded with the dispatch prompt.
4. Existing safety nets unchanged: non-git repo or worktree failure still falls back to
   the workspace root with a warning, so dispatch always yields a paste-ready prompt.

## Non-goals

- Auto-launching a session by default. Default behavior remains "copy a prompt
  (+ create a worktree)"; nothing runs without the user opting in.
- Making worktrees mandatory / removing the opt-out path.
- Changing how claims, active-task handoff, or the cross-branch board work.

## Design

### 1. Worktrees become the default

- `package.json` → `taskwright.dispatchCreateWorktree` default `false → true`. Reword its
  `markdownDescription` so worktree-per-dispatch reads as the default, with an explicit
  opt-out (`false` dispatches into the workspace root).
- `src/providers/dispatchActions.ts` `readSettings()` → the `getTaskwrightConfig` fallback
  for `dispatchCreateWorktree` changes `false → true`, so the manifest default and the
  code default agree (this fallback only applies when neither namespace has an explicit
  value, but it must still match the contributed default).
- `taskwright.dispatchOpenTerminal` **stays `false`** (opt-in), per the user's call.

### 2. Opt-in terminal prompt prefill

A new setting lets a user turn the dispatch-opened terminal into a ready-to-go session.

- New setting `taskwright.dispatchTerminalCommand` (string, default `""`). When
  `dispatchOpenTerminal` is on **and** this is non-empty, after the worktree terminal
  opens the extension runs the rendered command via `terminal.sendText(cmd, /*run*/ true)`.
- The command is `{{placeholder}}`-templated via the existing `substitutePlaceholders`
  core. The dispatch context is extended with `{{handoffFile}}` (absolute path to the
  already-written handoff file under `.taskwright/handoff/<id>.md`), alongside the
  existing dispatch fields (`{{id}}`, `{{title}}`, `{{worktree}}`, …).
- **Why reference the handoff file instead of inlining the prompt:** the full rendered
  prompt is already persisted to the handoff file. Referencing that file keeps the
  command a short one-liner and sidesteps multi-line shell-quoting (which differs sharply
  between bash and PowerShell). The user supplies the invocation appropriate to their
  shell.
- **Subscription-safe, unchanged by default:** with the empty default, behavior is
  identical to today — the terminal just opens. The extension never hardcodes launching
  `claude`; the user opts in and chooses the command. Recommended values (documented):
  - bash / zsh / git-bash: `claude "$(cat {{handoffFile}})"`
  - PowerShell: `claude (Get-Content -Raw '{{handoffFile}}')`

  Both forms start an **interactive** Claude Code chat seeded with the prompt — not
  `claude -p`.

#### `-p` guard

To honor "make sure it launches a chat, not a `claude -p` process," the resolved command
is checked: if it invokes `claude` with `-p`/`--print` (headless mode), the extension
shows a non-blocking warning that this defeats subscription-safety and skips running it.
This is a narrow, best-effort regex guard (`\bclaude\b` followed by a `-p`/`--print`
flag), not a general shell parser — it nudges users away from the one footgun the
project explicitly avoids without blocking arbitrary commands.

### 3. New pure core: `renderDispatchTerminalCommand`

Keep substitution out of the vscode-coupled provider so it is unit-testable:

- Extend `DispatchContext` (in `src/core/dispatchPrompt.ts`) with `handoffFile: string`.
- `dispatchContextFromTask(task, { worktree, handoffFile })` populates it (defaulting to
  `''` when not supplied, mirroring `worktree`).
- Add `renderDispatchTerminalCommand(template, ctx)` — thin wrapper over
  `substitutePlaceholders`, symmetric with `renderDispatchPrompt`.
- Add `commandUsesClaudePrintMode(command): boolean` — the `-p`/`--print` detector used
  by the guard.
- `dispatchActions.ts` computes the handoff path (it already calls `writeHandoff`), passes
  `handoffFile` into the context, renders the command, runs the guard, and only then
  `sendText`s it.

### 4. Docs / UX tidy

- `README.md`: reword "optional git worktree" / "branch/worktree" so worktrees are the
  default path; document the opt-out and the new `dispatchTerminalCommand` (with the
  per-shell examples and the "interactive chat, not `claude -p`" note).
- `CLAUDE.md`: update the Phase 3 dispatch bullet to note worktree-by-default and the new
  setting.

## Testing (TDD)

- **Unit (pure cores, Vitest):**
  - `dispatchContextFromTask` exposes `handoffFile` (set when provided, `''` otherwise).
  - `renderDispatchTerminalCommand` substitutes `{{handoffFile}}` and dispatch fields, and
    leaves unknown placeholders intact (inherited `substitutePlaceholders` behavior).
  - `commandUsesClaudePrintMode` is true for `claude -p …` / `claude --print …` and false
    for an interactive `claude "$(cat …)"` invocation and for non-claude commands.
  - Config-consistency: assert `package.json` contributes
    `taskwright.dispatchCreateWorktree` default `true` (guards against the manifest/code
    defaults drifting apart).
- **e2e (`e2e/dispatch.spec.ts`):** extend to assert a default dispatch (no setting
  override) creates the worktree, and that with `dispatchTerminalCommand` set the worktree
  terminal receives the rendered command. (`dispatchActions` is vscode-coupled provider
  glue, so behavior coverage lives here rather than in unit tests.)

## Alternatives considered

- **Minimal: flip the default only** — rejected; leaves the prompt wording/docs implying
  worktrees are optional, and skips the requested terminal prefill.
- **Make worktrees mandatory (drop the setting)** — rejected; removes a useful escape
  hatch for non-git or single-session use, more disruptive than the goal requires.
- **Dedicated `dispatchLaunchClaude` boolean that the extension wires itself** — rejected
  for now in favor of the freeform command: a single hardcoded invocation cannot seed a
  multi-line prompt robustly across bash and PowerShell (their command-substitution and
  newline handling differ), whereas the freeform command lets the user pick the form that
  fits their shell. The `-p` guard gives the safety the boolean would have enforced.
- **Auto-type the raw multi-line prompt into the terminal** — rejected; sending newlines
  to an interactive shell executes lines mid-prompt. The handoff file + command
  substitution is robust.
