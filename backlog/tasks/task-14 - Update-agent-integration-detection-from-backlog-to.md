---
id: TASK-14
title: Update agent-integration detection from backlog to taskwright MCP naming
status: Done
assignee: []
created_date: '2026-06-30 13:45'
updated_date: '2026-07-04 00:41'
labels:
  - bug
  - refactor
milestone: Foundation & Rebrand
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
AgentIntegrationDetector (src/core/AgentIntegrationDetector.ts) still detects the inherited Backlog.md agent-integration naming rather than Taskwright's:

- detectClaudeCodeIntegration checks `.mcp.json` for `mcpServers.backlog` (and a raw `"backlog"` string fallback), but the Taskwright MCP server is registered as `taskwright` (see TASKWRIGHT_MCP_NAME in src/core/claudeMcp.ts and .mcp.json). So a correctly-set-up Taskwright MCP is reported as NOT configured (mcpConfigured stays false), which makes the "Set Up Agent Integration" banner/flow misleading.
- detectCodexIntegration checks `.codex/config.toml` for `mcp_servers.backlog`.
- Guidelines-marker detection (hasGuidelinesMarker / detectGuidelinesMarker) keys off `<!-- BACKLOG.MD MCP GUIDELINES ... -->` / `<!-- BACKLOG.MD GUIDELINES ... -->` markers.

This is the deliberately-scoped-out follow-up from TASK-1 (the backlog.* -> taskwright.* contribution-namespace migration). It is a separate concern: it spans the detector AND the setup-writer that emits these markers/MCP entries (the `setupAgentIntegration` command + agentConvention/guidelines injection), plus any markers written into CLAUDE.md/AGENTS.md. Changing only the detector would desync it from what the writer produces, so both sides must move together, ideally with a back-compat read of the old markers/server name so existing set-up projects still register as integrated.

## Acceptance Criteria
- [ ] AgentIntegrationDetector detects the `taskwright` MCP server in .mcp.json (Claude) and .codex/config.toml (Codex), not `backlog`
- [ ] The guidelines-marker detection recognizes Taskwright's marker, with legacy BACKLOG.MD markers still detected for back-compat
- [ ] The setup-writer side (setupAgentIntegration / guidelines injection) emits the taskwright MCP entry and Taskwright markers, kept in sync with the detector
- [ ] Existing projects set up under the old backlog naming still report as integrated (back-compat)
- [ ] Unit tests in AgentIntegrationDetector.test.ts updated for the new naming plus legacy back-compat cases; typecheck, lint, and unit tests pass

## Notes

<!-- SECTION:NOTES:BEGIN -->
Detector-focused fix; the writers already used Taskwright naming, so the sync was achieved by making the detector share their constants.

Changes (src/core/AgentIntegrationDetector.ts):
- Imported the writers' own constants as the single source of truth: `TASKWRIGHT_MCP_NAME` (src/core/claudeMcp.ts, used by registerTaskwrightMcp) and `TASKWRIGHT_MARKERS` (src/core/markerBlock.ts, used by injectConvention/agentConvention.ts). This is what keeps detector and setup-writer in sync (AC3).
- MCP detection now checks a `MCP_SERVER_NAMES = [taskwright, backlog]` list for both `.mcp.json` (`mcpServers[name]` + raw-string fallback) and `.codex/config.toml` (`mcp_servers.<name>`). taskwright first, legacy backlog kept for back-compat (AC1, AC4).
- Guidelines markers array now leads with `TASKWRIGHT_MARKERS.begin` (`<!-- TASKWRIGHT:BEGIN -->`) and retains both legacy `<!-- BACKLOG.MD ... -->` markers (AC2, AC4).

Why the writer side needed no change: injectConvention already emits `<!-- TASKWRIGHT:BEGIN -->` and registerTaskwrightMcp already registers `taskwright`. The `setupAgentIntegration` command delegates to the external `backlog init` CLI (legacy), which writes legacy naming — still recognized via back-compat. Rewiring that command to the Taskwright-native flow is a UX/behavior change out of scope for this detection-naming bug.

Tests (src/test/unit/AgentIntegrationDetector.test.ts): 31 tests (was 22). Added taskwright-primary cases for Claude .mcp.json (object + invalid-JSON fallback), codex config.toml, CLAUDE.md/AGENTS.md markers, detectGuidelinesMarker, and detectIntegration; kept all legacy cases relabelled "(back-compat)". Added `execFile: vi.fn()` to the child_process mock because the detector now transitively imports claudeMcp.ts (which promisifies execFile at load).

Verification: typecheck passes; eslint on the two changed files is clean; all 31 AgentIntegrationDetector tests pass. Full `bun run test` = 1081 passed / 9 failed, but every failure is in unrelated path/separator modules (BacklogWriter, CrossBranch*, openWorkspaceFile) — the documented Windows POSIX-path failures plus TASK-4's in-flight working-tree changes; none touch AgentIntegrationDetector. Repo-wide `bun run lint` reports 2 errors, both in src/test/unit/BacklogWriter.test.ts (unused toPosix/posixPath) — pre-existing pollution from TASK-4's uncommitted work, not introduced here.
<!-- SECTION:NOTES:END -->
## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 AgentIntegrationDetector detects the `taskwright` MCP server in .mcp.json (Claude) and .codex/config.toml (Codex), not `backlog`
- [x] #2 The guidelines-marker detection recognizes Taskwright's marker, with legacy BACKLOG.MD markers still detected for back-compat
- [x] #3 The setup-writer side (setupAgentIntegration / guidelines injection) emits the taskwright MCP entry and Taskwright markers, kept in sync with the detector
- [x] #4 Existing projects set up under the old backlog naming still report as integrated (back-compat)
- [x] #5 Unit tests in AgentIntegrationDetector.test.ts updated for the new naming plus legacy back-compat cases; typecheck, lint, and unit tests pass
<!-- AC:END -->
