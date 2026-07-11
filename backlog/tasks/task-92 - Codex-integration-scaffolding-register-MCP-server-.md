---
id: TASK-92
title: >-
  Codex integration scaffolding — register MCP server + install skills as Codex
  prompts
status: Done
assignee: []
created_date: '2026-07-10 11:44'
updated_date: '2026-07-10 13:08'
labels: []
milestone: Pipeline Refinement & Multi-Agent Support
dependencies: []
priority: high
category: Orchestration
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Taskwright's agent integration is Claude Code-only today: setUpClaudeIntegration (src/extension.ts) injects CLAUDE.md/AGENTS.md blocks, installs .claude/skills/*, and optionally writes .mcp.json. Codex (and other AGENTS.md-native agents) can already read the AGENTS.md convention block, but get no MCP server registration and no skill equivalents — so get_active_task/claim_task/request_merge are unreachable from a Codex session.

Scope:
- Generalize to setUpAgentIntegration with per-agent adapters; extend AgentIntegrationDetector (src/core/) to detect Codex (~/.codex/config.toml, AGENTS.md-only repos).
- Codex adapter: register the taskwright MCP server in Codex's config (mcp_servers table in config.toml, reusing scripts/taskwright-mcp.cjs so worktrees resolve the primary build exactly as with Claude), idempotent upsert mirroring mcpProjectConfig.ts.
- Translate the four user-facing skills (create-task, execute-task, index-codebase, orchestrate-board) into Codex custom prompts (~/.codex/prompts or repo-local equivalent) generated from the same source content — one source of truth, per-agent renderers (skillInstaller.ts generalization).
- AGENTS.md convention block stays the shared contract (already agent-neutral); verify the wording doesn't assume Claude-specific tool syntax.
- Unit coverage mirroring skillInstaller/mcpProjectConfig tests.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented Codex integration scaffolding:

- New pure core src/core/codexConfig.ts — renderCodexServerToml + upsertCodexMcpServer: idempotent, byte-stable upsert of the [mcp_servers.taskwright] table into Codex's config.toml, preserving all other user content (mirrors mcpProjectConfig.ts). Omits the Claude-specific "type" key; TOML basic-string escaping for Windows paths; swallows sub-tables of the owned server; exact-header match so [mcp_servers.taskwright2] is never clobbered.
- New pure core src/core/codexPrompts.ts — renderCodexPrompt (strips Claude YAML frontmatter incl. allowed-tools, surfaces description as a leading blockquote, appends an "ARGUMENTS: $ARGUMENTS" Codex substitution hook, adds a generated-file notice) + installCodexPrompts (one <name>.md per TASKWRIGHT_SKILL_NAMES skill, skip/overwrite semantics and missing-source surfacing identical to installTaskwrightSkills). One source of truth: rendered from the same bundled dist/skills SKILL.md sources.
- AgentIntegrationDetector: detectCodexIntegration now also checks <homeDir>/.codex/config.toml (the config Codex actually reads; homeDir param defaults to os.homedir()); new detectCodexInstalled (config.toml or auth.json under ~/.codex) and isAgentsMdOnlyRepo (AGENTS.md without CLAUDE.md) heuristics.
- extension.ts: generalized to setUpAgentIntegration(...targets) dispatching per-agent adapters {claude, codex}. New setUpCodexIntegration: upserts [mcp_servers.taskwright] into $CODEX_HOME/config.toml (CODEX_HOME env respected, default ~/.codex) with an ABSOLUTE path to the extension's scripts/taskwright-mcp.cjs launcher (config is user-global, so relative paths can't work; the launcher resolves the primary build from cwd, so worktrees behave exactly as with Claude), installs the four skills as Codex prompts into $CODEX_HOME/prompts, and offers the shared AGENTS.md convention block (extracted into offerAgentsConvention, reused by the Claude adapter). New command taskwright.setupCodexIntegration + one-time activation offer gated on detectCodexInstalled && !mcpConfigured.
- AGENTS.md convention wording neutralized: names both registration surfaces (.mcp.json for Claude Code, ~/.codex/config.toml for Codex); test asserts no Claude-specific mcp__ tool syntax.
- Coverage: src/test/unit/codexConfig.test.ts, codexPrompts.test.ts (incl. rendering the real committed skills), AgentIntegrationDetector.test.ts extensions, agentConvention.test.ts neutrality test. Suite: 1727 passed; lint + typecheck clean.

Decision: did NOT rename the legacy taskwright.setupAgentIntegration command (it is the Backlog.md-CLI init flow) — the generalized dispatcher is internal; command IDs stay stable.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Codex sessions can now reach the full Taskwright loop (get_active_task / claim_task / edit_task / request_merge). Two new pure cores: codexConfig.ts (idempotent, content-preserving [mcp_servers.taskwright] upsert into Codex's config.toml, mirroring mcpProjectConfig.ts) and codexPrompts.ts (renders the four user-facing skills — create-task, execute-task, index-codebase, orchestrate-board — as Codex custom prompts from the same bundled SKILL.md sources, mirroring skillInstaller.ts semantics). AgentIntegrationDetector gained home-dir ~/.codex/config.toml detection plus detectCodexInstalled / isAgentsMdOnlyRepo. extension.ts generalized to a setUpAgentIntegration dispatcher with {claude, codex} adapters sharing the AGENTS.md convention offer; the Codex adapter registers the MCP server in $CODEX_HOME/config.toml via an absolute path to scripts/taskwright-mcp.cjs (worktrees resolve the primary build exactly as with Claude) and installs prompts into $CODEX_HOME/prompts. New taskwright.setupCodexIntegration command + one-time activation offer. AGENTS.md convention wording neutralized to name both registration surfaces. 1727 unit tests pass (36 new), lint + typecheck clean. Commit fe2cab1.
<!-- SECTION:FINAL_SUMMARY:END -->
