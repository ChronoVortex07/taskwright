---
id: TASK-94
title: 'Release 1.3.0 — changelog for the m-10 wave, version bump, docs refresh'
status: Done
assignee: []
created_date: '2026-07-11 00:18'
updated_date: '2026-07-11 01:19'
labels: []
milestone: Pipeline Refinement & Multi-Agent Support
dependencies:
  - TASK-89
priority: medium
category: Docs & Branding
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
CHANGELOG.md ends at 1.2.1 (2026-07-08) and package.json still says 1.2.1 — the entire nine-task m-10 wave (TASK-84..90, 92, 93) is unversioned and undocumented.

Scope:
- Add a [1.3.0] CHANGELOG.md entry (Keep a Changelog format, matching the 1.2.x entries' voice) covering: configurable verify timeout + machine-readable request_merge abort codes (84); merge-config no longer clobbered on activation (85); verify-command doctor (86); queue-head re-verify skip + collision-only primary-dirty check (87); MCP progress notifications + re-entrant waitMinutes/ticket (88); per-session claim identity + folded-scalar frontmatter corruption fix + badge overflow fix (89 incl. reopen); board doctor + board_doctor MCP tool + taskwright.doctor command (90); Codex integration scaffolding (92); agent-agnostic dispatch profiles + headless guardrails (93). Do NOT document TASK-91 (in flight, unreleased).
- Bump package.json version to 1.3.0.
- Docs refresh: append/adjust CLAUDE.md "Taskwright additions" bullets for the m-10 features (merge-gate configurability, board doctor, claim identity, Codex/multi-agent scaffolding) in the established bullet style; check AGENTS.md workflow section for stale statements (e.g. request_merge now supports waitMinutes 'pending' resumption; new settings names) and README if it enumerates features/settings.
- Verify all new settings/commands/tools introduced by m-10 appear in package.json contributes and are named consistently in the docs.

Note: TASK-91 is being worked concurrently in another session and will likely touch package.json — if rebase conflicts, keep both sides (version bump + their settings).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Release 1.3.0 assembled from the nine merged m-10 task files (backlog/tasks/task-84..90, 92, 93 incl. TASK-89's reopen ACs) and `git log --oneline` since 2026-07-09 (b0580e8..bdb409b).

- CHANGELOG.md: new [1.3.0] — 2026-07-11 entry in the 1.2.x voice / Keep-a-Changelog structure. Added: configurable verify timeout + machine-readable abort codes (84), verify-command doctor (86), request_merge unpinned — MCP progress + waitMinutes/'pending'/ticket resumption (88), per-session claim identity (89), board doctor + board_doctor MCP tool + taskwright.doctor (90), Codex integration scaffolding (92), agent-agnostic dispatch profiles + headless guardrails (93). Changed: queue-head re-verify skip on unmoved base, primary-dirty relaxed to real collisions (87). Fixed: merge-config.json clobber (85), folded-scalar claim corruption + indicator-badge overflow (89 incl. reopen). TASK-91 deliberately NOT documented (in flight, unreleased).
- package.json: version 1.2.1 → 1.3.0.
- CLAUDE.md: four new "Taskwright additions" bullets in the established style — merge-gate configurability + resumable request_merge (84/85/86/87/88), claim identity (89), board doctor (90), multi-agent scaffolding Codex + agent-agnostic dispatch (92/93).
- AGENTS.md: step 3 documents per-session claim identity + idempotent re-claim/surrendered semantics; step 5 documents waitMinutes → 'pending' poll-or-park resumption (ticket, sent_back) and the verify_timeout remedy.
- README.md: skills table corrected from "Three" to four (adds /orchestrate-board; predates m-10 — stale since 1.1.0), setup-commands table gains the Codex row (now three commands), agentic-workflow feature list gains doctors/claim-identity/dispatchAgent/merge-gate items, intro + subscription-safety wording generalized to Claude Code or Codex.
- Consistency check: taskwright.mergeVerifyTimeoutMinutes / mergeVerifyTimeoutMaxMinutes / dispatchAgent settings, taskwright.doctor / setupCodexIntegration commands all present in package.json contributes; board_doctor tool + request_merge verifyTimeoutMinutes/waitMinutes/ticket params present in src/mcp/server.ts — doc names match exactly.

TDD not applicable (docs + version metadata only, per AGENTS.md "When TDD doesn't apply"); full gate (test/lint/typecheck) run before commit.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Released 1.3.0 (docs + version metadata; commit 0f1040b in the task worktree). CHANGELOG.md gains a [1.3.0] — 2026-07-11 entry in the established Keep-a-Changelog voice covering all nine m-10 tasks — Added: verify timeout setting + per-call verifyTimeoutMinutes + machine-readable abort codes (84), verify-command doctor (86), request_merge progress notifications + waitMinutes/'pending'/ticket resumption (88), per-session @agent/<branch> claim identity (89), board doctor + taskwright.doctor + board_doctor MCP tool (90), Codex integration scaffolding (92), agent-agnostic dispatch profiles + headless guardrails (93); Changed: queue-head re-verify skip + collision-only primary-dirty check (87); Fixed: merge-config.json activation clobber (85), folded-scalar claim corruption and the reopened indicator-badge overflow (89). TASK-91 deliberately excluded (unreleased, in flight). package.json bumped 1.2.1 → 1.3.0. CLAUDE.md gains four m-10 "Taskwright additions" bullets in the established style; AGENTS.md documents claim-identity semantics and the waitMinutes 'pending' poll-or-park protocol; README fixed the stale three-skill table (now four incl. /orchestrate-board), added the Codex setup-command row, and refreshed the feature list (doctors, claim identity, dispatchAgent, merge-gate upgrades). Verified every m-10 setting/command/tool name against package.json contributes and src/mcp/server.ts — all consistent. Gate: 1872/1872 unit tests, lint, typecheck green on Windows.
<!-- SECTION:FINAL_SUMMARY:END -->
