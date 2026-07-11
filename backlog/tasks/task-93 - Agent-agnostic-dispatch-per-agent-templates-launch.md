---
id: TASK-93
title: >-
  Agent-agnostic dispatch — per-agent templates, launch commands, and print-mode
  guardrails
status: Done
assignee: []
created_date: '2026-07-10 11:44'
updated_date: '2026-07-10 14:46'
labels: []
milestone: Pipeline Refinement & Multi-Agent Support
dependencies:
  - TASK-92
priority: medium
category: Orchestration
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The dispatch pipeline hardcodes Claude Code: DEFAULT_DISPATCH_TEMPLATE says "run /execute-task" (a Claude skill invocation), and the terminal-launch guardrail (commandUsesClaudePrintMode in src/core/dispatchPrompt.ts) only recognizes `claude -p`. Dispatching a task to a Codex session gets Claude-flavored instructions and no headless-mode protection.

Scope:
- A taskwright.dispatchAgent setting (default 'claude', per-workspace) selecting a dispatch profile: prompt template variant (skill invocation phrasing per agent — /execute-task for Claude, the equivalent custom-prompt/plain-instructions form for Codex), suggested terminal launch command, and headless-mode guardrail patterns (`claude -p`, `codex exec`, and a generic non-interactive deny-list) — subscription-safety is a principle, not a Claude feature.
- Keep the {{placeholder}} substitution core (dispatchPrompt.ts) agent-neutral; profiles are data, not forks.
- Popover Dispatch action + dispatchActions.ts pick the profile; custom taskwright.dispatchTemplate still wins untouched.
- Handoff file content (handoff.ts) reviewed for Claude-specific phrasing.
- Unit tests per profile (template render + guardrail rejection).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Agent-agnostic dispatch implemented (TDD):

- New pure core src/core/dispatchProfiles.ts — dispatch profiles as DATA, not pipeline forks: DispatchAgentId ('claude' | 'codex'), DISPATCH_PROFILES (per-agent label + prompt template + suggested interactive terminal command), resolveDispatchProfile (case/whitespace-insensitive; unknown/empty → claude so dispatch always yields a usable prompt). CLAUDE_DISPATCH_TEMPLATE is the former DEFAULT_DISPATCH_TEMPLATE verbatim; CODEX_DISPATCH_TEMPLATE mirrors it word-for-word on the workflow contract (launch inside .worktrees/{{worktree}}, bun install, never touch the repo root, /execute-task entry point, request_merge from inside the worktree) with Codex phrasing (custom prompt instead of skill; never `codex exec`). A contract-marker test asserts both templates carry the identical non-negotiables.
- dispatchPrompt.ts stays agent-neutral: DEFAULT_DISPATCH_TEMPLATE is now a back-compat alias of the claude profile template. New commandUsesHeadlessMode replaces the claude-only guard in resolveTerminalLaunch, driven by a HEADLESS_LAUNCH_DENYLIST data table: claude -p/--print, codex exec (and its `e` alias), and a generic --headless/--non-interactive deny-list — all applied regardless of the selected agent (subscription safety is a principle, not a Claude feature). Segment-scoped as before (`git exec-path && codex "go"` passes; `codex executive-summary.md` passes). commandUsesClaudePrintMode kept as a deprecated back-compat export.
- dispatchActions.ts readSettings picks the profile from the new taskwright.dispatchAgent setting (default 'claude'); a custom taskwright.dispatchTemplate still wins untouched. The popover Dispatch action routes through dispatchTask, so it picks the profile automatically.
- package.json: new taskwright.dispatchAgent enum setting (claude|codex, enumDescriptions); dispatchTemplate/dispatchTerminalCommand descriptions updated to name both agents and the broadened guardrail.
- handoff.ts reviewed: already agent-neutral, no changes needed. Claude-specific module comments in dispatchPrompt.ts/dispatchActions.ts neutralized.
- Coverage: new src/test/unit/dispatchProfiles.test.ts (resolver, contract markers per profile, per-agent phrasing, suggested-command-passes-guardrail self-consistency, DEFAULT_DISPATCH_TEMPLATE back-compat); dispatchPrompt.test.ts gains commandUsesHeadlessMode + codex resolveTerminalLaunch cases; dispatchActions.test.ts gains per-agent profile selection (default claude, codex opt-in, custom template wins, unknown falls back). Suite: 1811 passed; lint + typecheck clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Dispatch is now agent-agnostic. A new taskwright.dispatchAgent setting (default 'claude') selects a dispatch profile — data in the new pure core src/core/dispatchProfiles.ts, never a fork of the pipeline: per-agent prompt templates (Claude Code /execute-task skill phrasing vs Codex /execute-task custom-prompt phrasing, both carrying the identical worktree/bun-install/no-root-commit/request_merge contract, enforced by a shared contract-marker test), a human label, and a suggested interactive terminal command. The terminal guardrail generalized from claude-only to a headless deny-list (commandUsesHeadlessMode): claude -p/--print, codex exec (and e alias), plus generic --headless/--non-interactive — applied regardless of the selected agent, because subscription safety is a principle, not a Claude feature. The {{placeholder}} substitution core stays agent-neutral; a custom taskwright.dispatchTemplate still wins untouched; handoff.ts needed no changes. Coverage: dispatchProfiles.test.ts + extended dispatchPrompt/dispatchActions tests. 1811 unit tests pass, lint + typecheck clean. Commit 12f06d6, merged via the queue.
<!-- SECTION:FINAL_SUMMARY:END -->
