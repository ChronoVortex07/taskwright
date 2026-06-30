# Phase 0 — De-risk findings

Date: 2026-06-30. Verifies the plan in `~/.claude/plans/i-have-an-idea-misty-moth.md` before committing to the fork.

## Verdict: **GO** on forking `ysamlan/vscode-backlog-md`

Clean MIT base, well-separated architecture whose module seams map almost 1:1 onto the planned
additions, and the existing agent integration is shallow enough that our agentic layer is purely
additive. Two real setup costs (Node 22 + Bun) and one Windows gotcha (long paths) to handle first.

---

## 1. Fork audit — `vscode-backlog-md@0.3.9`

**License:** MIT (© "Backlog.md VS Code Extension Contributors"). Fork/modify/relicense additions; keep the notice. ✅

**Architecture (src/):** clean separation, exactly the seams we need.

- `core/BacklogCli.ts` — shells out to `backlog` via `execAsync`, caches availability (60s TTL).
  Cross-branch features **require the CLI on PATH**; without it, local-read-only + a warning.
- `core/BacklogParser.ts` / `core/BacklogWriter.ts` — read/write task files (gray-matter).
- `core/CrossBranchTaskLoader.ts` + `core/GitBranchService.ts` — **cross-branch task loading already exists**
  → our multi-worktree board view is partly built.
- `core/FileWatcher.ts` + `debounce.ts` — live refresh on file changes.
- `core/AgentIntegrationDetector.ts` — see below.
- `language/` — completion, hover, doc-links. `providers/` — kanban + Details webviews, task create/detail panels.

**Existing agent integration is shallow (good — confirms our differentiation is open):**
`AgentIntegrationDetector.ts` only _detects/injects_ Backlog.md's own MCP server (`.mcp.json` `backlog` key)
and guideline markers into `CLAUDE.md`/`AGENTS.md`. It distinguishes **Claude Code vs Codex** already.
**No claiming, dispatch, active-task, or superpowers** — all of that is net-new for us.

**Dependency audit:** `npm audit` → 17 vulns (12 high), but **all in devDependencies / build tooling**
(`serialize-javascript`, `bin-version`, `find-versions`…), none in the shipped extension. Runtime deps
are 7 clean, modern libs (`gray-matter`, `js-yaml`, `marked`, `mermaid`, `svelte`5, `tiny-markdown-editor`,
`github-slugger`). Run `npm audit fix` post-fork; not a blocker. **No telemetry.**

**Build prerequisites (must install before Phase 1):**

- **Node ≥22** — current machine has **v20.12.2** (too old to build the fork). Backlog.md itself runs on Node 20.
- **Bun** — build script is `bun scripts/build.ts` (+ Vite for the Svelte webview, Tailwind v4). Not installed.
- Tests: Vitest (unit) + Playwright/`vscode-extension-tester`/CDP (e2e). VSCode engine `^1.110.0`.

**⚠️ Windows long-path gotcha:** cloning failed checkout on Backlog.md's own `backlog/tasks/*.md` files
(names like `task-134 - Route-sidebar-...-in-Tasks-view.md` exceed the 260-char `MAX_PATH`).
Fix: `git config --global core.longpaths true` (or per-clone `-c core.longpaths=true`). **This also affects
your own use of Backlog.md on Windows** — its long descriptive filenames will bite without longpaths enabled.

---

## 2. Backlog.md backbone — confirmed surface (`v1.47.1`, runs on Node 20)

- **MCP:** `backlog mcp start` — stdio transport (this is what the fork injects into `.mcp.json`).
- **Task CLI (writes):** `backlog task create | edit | view | list | complete | archive | demote`, `--plain`
  for agent-parseable output. Matches the `BacklogCli.execute(args, cwd)` pattern in the fork.
- **Extras worth using:** `sequence` (computes execution order from task dependencies → multi-task ordering),
  `cleanup` (auto-move completed by age), `agents` (manage instruction-file nudges), `board`, `browser`.

**Coupling confirmed (as planned):** read task files directly for the board; write via `backlog` CLI to keep
IDs/format valid; agents talk to `backlog mcp start`. Our Taskwright MCP adds only the missing semantics
(active-task, claim/release, attach plan/spec) — no CRUD reimplementation.

---

## 3. Module mapping — where our additions slot in

| Plan module                                           | Slots in next to                   | Notes                                                       |
| ----------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------- |
| `store/claims.ts` (claim frontmatter + staleness)     | `core/BacklogWriter.ts`            | reuse the writer; new fields `claimedBy/worktree/claimedAt` |
| `mcp/` (active-task, claim, attach_plan)              | `core/AgentIntegrationDetector.ts` | extend the existing Claude/Codex detection + injection      |
| `dispatch/` (worktree + clipboard prompt)             | new; uses `GitBranchService.ts`    | no `claude -p`; clipboard/handoff only                      |
| webview claim badges / dispatch panel / progress view | `providers/*` + Svelte webview     | inherit the kanban; add surfaces                            |

---

## 4. Remaining spike — **needs you** (the live round-trip)

Everything above was verified autonomously. The one spike that requires a human is proving a real
Claude Code session round-trips a task through the MCP — because dispatch is paste-driven by design.

Steps (in a throwaway repo):

1. `git config --global core.longpaths true` (Windows).
2. Install: `npm i -g backlog.md` (or keep using `npx backlog.md@latest`).
3. `backlog init` in a scratch repo; `backlog task create "Test task" -d "..." --ac "..."`.
4. Wire `backlog mcp start` into `.mcp.json`, open the repo in Claude Code.
5. Ask the session to read the task, edit it, and mark progress — confirm it round-trips via MCP.
6. Confirm a _pasted_ dispatch prompt (no `claude -p`) drives the work using your subscription.

## 5. Pre-Phase-1 setup checklist

- [ ] Install Node ≥22 (nvm-windows or fnm) — required to build the fork.
- [ ] Install Bun.
- [ ] `git config --global core.longpaths true`.
- [ ] Fork the repo, `npm/bun install`, `bun run build`, `npm audit fix`, confirm it builds + runs (F5).
- [ ] Run the §4 live spike before writing any agentic code.
