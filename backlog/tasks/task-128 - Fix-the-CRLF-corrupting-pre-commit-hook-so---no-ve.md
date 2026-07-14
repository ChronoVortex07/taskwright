---
id: TASK-128
title: Fix the CRLF-corrupting pre-commit hook so --no-verify folklore can be retired
type: bug
status: Done
assignee: []
created_date: '2026-07-14 05:25'
updated_date: '2026-07-14 09:14'
labels:
  - friction
  - windows
  - tooling
milestone: Workflow Friction Hardening
dependencies: []
references:
  - .taskwright/docs/friction-report-2026-07-14.md
  - .husky/
  - .gitattributes
priority: high
category: Bugs
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On Windows, the lint-staged pre-commit hook rewrites line endings across the tree (CRLF→LF flips), corrupting unrelated files. The standing workaround is folklore: "commit with --no-verify" lives in HANDOFF.md, agent memory notes, and tribal knowledge — every new agent must know the ritual or corrupt the tree, and skipping the hook also skips the lint it was supposed to run. This has never been fixed at the hook level (friction report 2026-07-14, item 4; memory notes precommit-hook-autocrlf-corruption and root-tree-healing-lf-config).

Fix direction: make the hook line-ending-safe — align .gitattributes (`* text=auto` policy), prettier/eslint end-of-line config, and lint-staged so the hook only touches staged files and never rewrites endings the repo policy doesn't mandate. Then delete the --no-verify guidance from HANDOFF.md and anywhere else it appears, so hooks run again.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A commit on Windows with the hook enabled leaves unstaged/untouched files byte-identical (no tree-wide CRLF/LF flips); proven with a repo-fixture test or documented manual verification
- [x] #2 lint-staged operates only on staged files; formatter end-of-line settings agree with .gitattributes
- [x] #3 All --no-verify guidance is removed from HANDOFF.md and other agent-facing docs
- [x] #4 A normal `git commit` (hook active) succeeds cleanly on Windows in the primary checkout
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Investigated before changing anything, and the root cause was NOT where the folklore said it was.

**The hook was already structurally safe.** The corruption needed a working tree whose line endings
disagreed with what git expected. `.gitattributes` (`* text=auto eol=lf`) had already closed that:
`eol=lf` *overrides* `core.autocrlf`, so every checkout materializes LF regardless of the developer's
git config. I verified this empirically with a 3-way fixture experiment (hostile `core.autocrlf=true`
clone):
- `* text=auto` (no eol=lf)  -> working tree checks out **CRLF**  <- the soil the bug grew in
- `* text=auto eol=lf`       -> working tree checks out **LF**, even with autocrlf=true

Crucially, `core.autocrlf=false` / `core.eol=lf` (from the 2026-07-02 heal) are only *local* git
config -- they never travel with a clone. `.gitattributes` is the ONLY defense that does. Nothing
pinned it, so the fix was one careless edit away from regressing, and the workaround was never retired.

**Careful call on prettier `endOfLine`.** The memory note says the 2026-07-01 fix was `endOfLine: auto`.
Prettier's *default* is already `lf`, so naively "aligning" the formatter looked like reverting to the
exact setting that caused the corruption. It isn't: the experiment shows `lf` is safe now, because
`eol=lf` guarantees the working tree is LF, so prettier writing LF can no longer contradict git. Moved
`auto` -> `lf`: `auto` merely preserves whatever is on disk, so it can never heal a stray CRLF file and
leaves `prettier --check` green on files that violate the repo's own eol policy -- the formatter
abstaining rather than agreeing (AC #2).

**What I added.** `src/test/unit/precommitEol.test.ts` (6 tests):
1. EOL coherence: .gitattributes declares text=auto + eol=lf; prettier endOfLine === 'lf'; every
   lint-staged command is file-scoped (no whole-tree `.` target, which would reformat the repo on
   every commit).
2. End-to-end fixture: builds an origin repo from THIS repo's real .gitattributes/.prettierrc/
   lint-staged config, clones it with hostile `core.autocrlf=true`, stages one badly-formatted file,
   leaves another edited-but-unstaged (the stash/restore path that used to amplify), runs the REAL
   lint-staged binary, commits -- then asserts every bystander file is byte-identical.
3. Doc contract: no agent-facing doc justifies `--no-verify` with a CRLF/line-ending rationale.

**Mutation-tested the guard.** Removed `eol=lf` from .gitattributes -> the fixture checks out CRLF and
2 tests fail on observed bytes. The guard is real, not a tautology.

**Folklore removal.** Stripped the CRLF `--no-verify` guidance from 15 plan docs (it had been
copy-forwarded verbatim into 9 of the 2026-07-08 plans) + HANDOFF.md:106. The doc-contract regex is
deliberately narrow -- it keys on the *justification* (flips the tree / Windows CRLF hook / CRLF->LF),
so the two legitimate `--no-verify` uses stay readable: the worktree-guard escape hatch, and the
board-sync hook passing it to avoid hook recursion. Documented the policy in CONTRIBUTING.md.

**Dogfooded.** This task's own commit was made WITHOUT `--no-verify`, hook active, on Windows.
Fingerprinted all 555 tracked files before/after: zero rewritten, working tree clean, zero CRLF files.
Gate: 2292 tests / 158 files pass, lint + typecheck clean.

Note on AC #4: the commit was made in the task worktree, not the repo root -- committing from the
primary root is forbidden by the repo's own rules (and the managed worktree guard). Same shared
.husky hook, same .gitattributes, same OS; and the fixture covers the strictly harsher fresh-hostile-
clone case.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Retired the `--no-verify` folklore by pinning the invariant that made it obsolete.

The pre-commit hook turned out to be already safe: `.gitattributes` (`* text=auto eol=lf`) overrides
`core.autocrlf`, so the working tree is LF on every clone and the CRLF/LF disagreement that fed the
tree-wide flip cannot form. But nothing pinned that -- and the local git config people credited for the
fix (`core.autocrlf=false`) never travels with a clone -- so the guarantee was one edit from regressing
while every doc still taught the workaround.

Added `src/test/unit/precommitEol.test.ts`: an end-to-end fixture that clones a repo carrying this
repo's real configs with a hostile `core.autocrlf=true`, runs the real lint-staged over a staged file
(plus an unstaged edit, the stash/restore path that used to amplify), commits, and asserts every
bystander file is byte-identical -- plus config-coherence and doc-contract tests. Mutation-tested:
dropping `eol=lf` makes it check out CRLF and fail.

Aligned prettier `endOfLine: auto -> lf` (verified safe by experiment; `auto` hides CRLF drift rather
than agreeing with the repo's eol policy), asserted lint-staged is file-scoped, stripped the CRLF
`--no-verify` guidance from 15 plan docs and HANDOFF.md while deliberately preserving the two
legitimate `--no-verify` uses, and documented "just commit normally" in CONTRIBUTING.md.

Proof: this task's own commit ran through the live hook with no `--no-verify` on Windows -- 555 tracked
files fingerprinted before/after, zero rewritten, tree clean. Full gate green (2292 tests, lint,
typecheck).
<!-- SECTION:FINAL_SUMMARY:END -->
