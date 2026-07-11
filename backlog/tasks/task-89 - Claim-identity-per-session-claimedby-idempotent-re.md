---
id: TASK-89
title: >-
  Claim identity — per-session claimed_by + idempotent re-claim for the same
  claimant
status: Done
assignee: []
created_date: '2026-07-10 11:43'
updated_date: '2026-07-11 01:05'
labels: []
milestone: Pipeline Refinement & Multi-Agent Support
dependencies: []
priority: medium
category: Core Board
  task-89-claim-identity-per-session-claimed-by-idempotent-re-claim-for-the-same-claimant
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Every claim today is the generic '@agent', so after a Claude Code restart a session cannot tell "my claim" from "someone else's" — transcript evidence shows coordinators injecting "the claim is YOURS, do NOT re-claim" warnings, and the stock-trading board drifted to 3 In Progress tasks vs 2 claims vs 3 worktree dirs (task-61 orphaned with no frontmatter at all).

Scope:
- Derive a stable claimant identity from the worktree/branch (e.g. '@agent/task-61-<branch>'; the worktree path is already in the claim frontmatter — make identity first-class).
- claim_task becomes idempotent for the same identity: re-claiming your own task returns claimed: true (no-op), while a different identity still gets surrendered/heldBy.
- Keep claims.ts surgical-write guarantees and Backlog.md frontmatter round-trip byte-for-byte.
- Update claimResolution.ts stale/foreign logic and the kanban claim badge to show the short identity.
- Works for any agent brand (Claude, Codex) — identity comes from the worktree, not the tool.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Per-session claim identity derived from worktree/branch (@agent/<branch>); explicit arg > .worktrees segment > git branch
- [x] #2 claim_task idempotent for same identity; foreign live claim returns surrendered/heldBy; stale/legacy @agent upgraded in place
- [x] #3 Folded-scalar corruption fixed: removal sweeps continuation lines; claim fields serialize single-line
- [x] #4 Kanban badge shows short identity
- [x] #5 REOPENED — badge overflow: .claim-indicator-label (flex item, min-width:auto) refuses to shrink and spills past the 120px container, which lacks overflow control — long identities (e.g. 95-char @agent/task-91-…) overflow the kanban card. Fix: overflow:hidden on .claim-indicator + min-width:0 on the label; audit sibling indicator labels (merge/active/readonly) for the same flex bug
- [x] #6 DetailPopover 'Claimed by' line uses shortClaimIdentity for display (full identity + worktree in tooltip/title), no popover blowout at 95-char identities
- [x] #7 Playwright webview test: card badge with a 95-char claimedBy stays within the card bounds (clientWidth assertion) and ellipsizes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Scope addition (coordinator, same PR): fixed the folded-scalar claim corruption. Root cause: claims.ts always writes single-line, but BacklogWriter full rewrites (gray-matter/js-yaml, lineWidth 80) fold a long worktree value into 'worktree: >-' + an indented continuation line; the surgical removers (clearClaim / removeField / applyClaim's replace) filtered only the KEY line, orphaning the continuation onto the next field (mangled category on TASK-80/84/85/87/92/93).

Fix, both sides: (1) removal is continuation-safe — new removeFieldLines(fields, keyRe) in src/core/frontmatterEdit.ts removes a key line together with any indented continuation lines (folded scalars AND block sequences); used by removeField, upsertScalarField's replace branch, and claims.ts applyClaim/clearClaim. (2) write avoids the fold — collapseFoldedSurgicalFields in src/core/BacklogWriter.ts post-processes matter.stringify output, collapsing >-/| blocks for the Taskwright surgical keys (claimed_by/worktree/claimed_at/plan) back to one quoted/plain line (fold-joined with spaces); all other fields stay byte-for-byte as serialized (upstream still folds long titles etc., unchanged). Regression tests: frontmatterEdit folded/block-sequence removal + folded replace; claims clearClaim/applyClaim on a folded fixture (category intact); BacklogWriter.roundTrip no->- on rewrite + rewrite-then-release parses clean. Full suite 1847 passed (a prior run had 13 env-only 'Hook timed out' failures in git-temp-repo suites from parallel-runner machine load; all pass in isolation and in the final full run), lint + typecheck green.

REOPENED scope (badge overflow, ACs #5–#7): hardened every kanban indicator badge against the flex min-width:auto overflow hazard — .claim-indicator / .merge-indicator / .active-task-indicator / .readonly-indicator all clip (overflow:hidden + max-width:120px on the badge) and their labels shrink and ellipsize (min-width:0 + overflow:hidden + text-overflow:ellipsis); readonly-indicator's bare text node got a .readonly-indicator-label span in TaskCard and ListView so the ellipsis can apply. Finding while writing the failing test: at HEAD the claim badge was ALREADY contained in Chromium, because the label's own overflow:hidden nullifies the flex automatic minimum (min-width:auto only bites when item overflow is visible) — the CSS change makes containment explicit and uniform (merge/active/readonly had NO overflow control at all) rather than an accident of one rule. The real user-visible blowout was the DetailPopover: it rendered the raw 95-char claimedBy + full worktree branch as a 4-line 66px blob. DetailPopover now displays shortClaimIdentity ('Claimed by @agent/task-91') with the full identity + worktree in the title tooltip, and .tp-worker clips/ellipsizes as belt-and-braces. New Playwright regression tests: e2e/board-indicators.spec.ts (95-char claimedBy → badge scrollWidth<=clientWidth, label CSS-ellipsized, stays in card bounds, full identity in tooltip) and e2e/tree-popover.spec.ts (short display, full tooltip, no popover blowout). Visual proof doc: tmp/task-89-visual-proof.md in the task worktree (before/after screenshots via Vite fixture + agent-browser).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Claim identity is now per-session and worktree-derived. claim_task derives '@agent/<branch>' (explicit worktree arg > '.worktrees/<branch>' session-root segment > git branch; bare '@agent' fallback) and records the branch as the claim's worktree. Re-claiming your own task is an idempotent no-op ({ claimed: true, alreadyClaimed: true }, no file write); a live claim by a different identity returns { claimed: false, surrendered: true, heldBy } instead of silently overwriting; stale foreign claims are still reclaimed; legacy generic '@agent' claims are upgraded in place for agent-derived claimants (humans keep the conflict prompt). New pure helpers agentClaimIdentity / worktreeBranchFromPath / shortClaimIdentity in src/core/claimIdentity.ts; resolveClaimAction updated in src/core/claimResolution.ts; kanban claim badge shows the short identity ('@agent/task-89') with the full identity in the tooltip. claims.ts / ClaimService surgical-write and byte-for-byte round-trip guarantees untouched. Works for any agent brand — identity comes from the worktree, not the tool. Verified: 1810 unit tests, lint, typecheck, build all green.

Reopened scope (badge overflow, ACs #5–#7) closed: every kanban indicator badge (claim / merge / active / readonly) now clips and its label shrink-ellipsizes (overflow:hidden + max-width on badges, min-width:0 + text-overflow:ellipsis on labels; readonly text wrapped in a label span in TaskCard + ListView), and the tree DetailPopover 'Claimed by' line shows shortClaimIdentity with the full identity + worktree in the title tooltip (no more 4-line blowout at 95-char identities). Pinned by new Playwright regression tests in e2e/board-indicators.spec.ts and e2e/tree-popover.spec.ts; before/after visual proof in tmp/task-89-visual-proof.md (task worktree). Verified: 1872 unit + 405 Playwright + lint + typecheck green.
<!-- SECTION:FINAL_SUMMARY:END -->
