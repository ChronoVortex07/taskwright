# Design: build-independent MCP + buildable dispatch worktrees

**Date:** 2026-07-01
**Status:** Approved (brainstorm) — pending implementation plan

## Problem

Taskwright dispatches each task into an isolated `.worktrees/<branch>` checkout and boots a
fresh Claude Code session there. Two things break in that worktree because git-ignored build
artifacts are absent:

1. **The `taskwright` MCP server never starts.** `.mcp.json` (committed, so present in every
   worktree) launches the server with a **relative** path, `node dist/mcp/server.js`. `dist/`
   is git-ignored (`.gitignore:2`), so a fresh worktree has no `dist/mcp/server.js`. When the
   session boots there, the command fails and the whole server is unavailable — the agent
   loses `get_active_task` / `claim_task` / `request_merge`, i.e. exactly the workflow
   `AGENTS.md` mandates. Confirmed missing in `.worktrees/task-12-…`.
2. **The worktree can't build or test.** A clean worktree has no `node_modules`, so
   `bun run build/test/lint/typecheck` and Playwright can't run.

### Enabling facts

- The MCP server is a **fully self-contained esbuild bundle** (`scripts/build.ts:18-21`): it
  inlines every dependency except `vscode` (which it never touches). So the built
  `dist/mcp/server.js` runs with only `node` — **no `node_modules` needed at runtime**.
- The server picks its project root from `TASKWRIGHT_ROOT || process.cwd()`
  (`src/mcp/server.ts:66`). So one build can serve every worktree, each operating on its own
  backlog, while the shared merge queue lives in the common `.git`.
- `main()` runs unconditionally at module load (no `require.main === module` guard) and the
  bundle is CJS, so it can be `require()`d in-process and its stdio transport just starts.
- The MCP server is **branch-agnostic infrastructure** — its behavior (read/write backlog,
  claims, merge queue) does not depend on the task's code under test.

## Approach (chosen: launcher + on-demand install)

Two independent components. Component A fixes the MCP breakage without any per-worktree build.
Component B keeps the worktree buildable via an on-demand `bun install` documented in the dispatch
prompt — an originally-approved `node_modules` junction was abandoned mid-implementation after
end-to-end testing proved it destroys the shared install (see Component B).

### Component A — Shared MCP launcher

New committed file **`scripts/taskwright-mcp.cjs`** (plain Node, zero dependencies — works
without `node_modules`):

1. Resolve the primary checkout: `git rev-parse --path-format=absolute --git-common-dir`
   yields the common `.git` (the primary's, even from a linked worktree); its parent is the
   primary worktree root. In the primary checkout this resolves to itself.
2. `serverPath = <primaryRoot>/dist/mcp/server.js`. If it does not exist, print a single clear
   stderr line — `taskwright MCP not built — run 'bun run build' (or 'bun run compile') in
<primaryRoot>` — and exit 1, instead of a cryptic `MODULE_NOT_FOUND`.
3. `process.env.TASKWRIGHT_ROOT ??= process.cwd()` to pin the project root to the worktree that
   launched the server, then `require(serverPath)` — the bundle's `main()` starts the stdio
   transport in-process.

`.mcp.json` changes `"args": ["dist/mcp/server.js"]` → `"args": ["scripts/taskwright-mcp.cjs"]`.
Behavior in the primary checkout is unchanged; every worktree now gets a live server from the
single primary build, at session start, with **zero build wait**.

The launcher is **plain committed CommonJS** — it must run when `dist/` and `node_modules` are
absent, so it is deliberately _not_ built or bundled and imports nothing outside Node core. Its
side-effecting entrypoint (git resolve → existence check → `require`) is guarded by
`if (require.main === module)`, and it `module.exports` its pure `resolveMainServerPath` so tests
can import the `.cjs` without launching a server.

**Testable seam:** a pure `resolveMainServerPath(commonDirOutput, cwd)` returning the resolved
server path (string logic only), exported from the launcher; the `git` call, existence check,
and `require` are thin glue around it.

### Component B — on-demand `bun install` (docs, not code)

The worktree still needs `node_modules` to run `bun run build`/`test`/`lint`/Playwright. The
`DEFAULT_DISPATCH_TEMPLATE` (`src/core/dispatchPrompt.ts`) instructs the dispatched session to run
`bun install` in its worktree once before building or testing; `AGENTS.md` states the same for
agents. No extension code provisions `node_modules`.

**Rejected alternative — `node_modules` junction/symlink (originally approved, then abandoned).**
The plan was to junction (Windows) / symlink each new worktree's `node_modules` to the primary's
for instant buildability. Smoke testing revealed this is **unsafe**: `request_merge` cleanup calls
`removeWorktree` → `git worktree remove --force` (`src/core/finishTask.ts:215`), and on Windows
that recursive delete **follows the directory junction and wipes the primary's `node_modules`**
(reproduced: it emptied the shared install, breaking every other worktree). Because worktrees are
removed automatically on every merge — and, in a multi-agent setup, unpredictably — the blast
radius (destroying shared deps for all agents) is unacceptable. A real per-worktree `bun install`
(isolated, safe to delete) and "make cleanup junction-aware" were also considered; on-demand
install was chosen for keeping dispatch instant and subscription-safe with zero footgun, given the
confirmed pain (MCP failing to load) is fully solved by Component A, which needs no `node_modules`.

### Configuration

- Component B contributes **no** setting (it is documentation only).
- Component A gets **no** setting: it is a strict improvement over the current relative path.

## Testing (TDD, Vitest)

Write failing unit tests first before implementing:

- `resolveMainServerPath` — primary-checkout case and linked-worktree case (both derive
  `<primaryRoot>/dist/mcp/server.js` from the `--git-common-dir` output + cwd), plus the relative
  fallback. Tested by `require`-ing `scripts/taskwright-mcp.cjs` (the `require.main` guard keeps
  the import side-effect-free); the "build missing" stderr/exit branch is thin glue.
- `DEFAULT_DISPATCH_TEMPLATE` — asserts the on-demand `bun install` / `node_modules` guidance is
  present (Component B is prompt text, so this is its only automated check).

Beyond unit tests, Component A is validated end-to-end: build the primary, create a throwaway
worktree with **no** `dist/`, launch `scripts/taskwright-mcp.cjs` with the worktree as cwd, and
confirm an MCP `initialize` + `tools/list` handshake returns `serverInfo` and the taskwright tools
with `root` = the worktree.

Then run the full gate: `bun run test && bun run lint && bun run typecheck`. (Note: ~22 upstream
unit tests assert POSIX paths and fail on Windows by design — see `CLAUDE.md`.)

## Documented limitations (by design, not bugs)

- The live MCP server reflects the **primary** build. A task that edits the MCP server itself
  won't exercise its own changes live until it is merged and the primary is rebuilt. This is
  acceptable — arguably safer, since a half-edited server should not drive the shared merge
  queue for other live agents. Note this in `AGENTS.md` / `CLAUDE.md`.
- A dispatched worktree has no `node_modules` until the session runs `bun install` there. The
  first build/test in a worktree therefore pays a one-time install (warm bun cache keeps it
  cheap). Documented in the dispatch prompt and `AGENTS.md`.

## Out of scope

- Auto-provisioning `node_modules` (junction rejected as unsafe; per-worktree auto-install
  rejected for blocking dispatch — see Component B).
- Any change to dispatch's paste-based, subscription-safe UX.

## Affected files

- `scripts/taskwright-mcp.cjs` (new) — launcher; hosts and exports pure `resolveMainServerPath`.
- `.mcp.json` — point `taskwright` at the launcher.
- `src/core/dispatchPrompt.ts` — on-demand `bun install` line in `DEFAULT_DISPATCH_TEMPLATE`.
- `src/test/…` — `resolveMainServerPath` tests (launcher test `require`s the `.cjs`) and the
  dispatch-template assertion.
- `AGENTS.md` / `CLAUDE.md` — document the MCP launcher, the on-demand install, and the caveats.
