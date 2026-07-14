# Package the Taskwright Skills in the VSIX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make `Taskwright: Set Up Claude Code Integration` actually install the three shipped skills (`create-task`, `execute-task`, `index-codebase`) from a **published** `.vsix`, by bundling them into `dist/skills/` at build time and pointing the installer at that bundled dir — while `visual-proof` and `agent-browser` remain dev-only and never ship.

**Architecture.** Today the installer copies from `<extensionPath>/.claude/skills` (`src/extension.ts:1821`), but `.vscodeignore:31` excludes `.claude/**` from the package and `scripts/build.ts` never bundles the skills, so a published install has **no source dir** and `installTaskwrightSkills` hits its silent `continue` (`src/core/skillInstaller.ts:74-79`) — a no-op the user never sees. The fix reuses the already-tested `installTaskwrightSkills` in `scripts/build.ts` to copy exactly the dirs named in `TASKWRIGHT_SKILL_NAMES` into `dist/skills/` (which **does** ship — `.vscodeignore` only excludes `dist/**/*.map`), and repoints the installer source to `dist/skills/`. The dev-only skills are excluded **by construction** (they are not in `TASKWRIGHT_SKILL_NAMES`), and the missing-source branch is made **loud** (logged) so a broken package is never silent again.

**Tech Stack:** TypeScript, esbuild (via `bun scripts/build.ts`), Vitest (pure-core unit tests over temp dirs + the real committed source), `@vscode/vsce` (packaging + `vsce ls` verification). No webview, extension-host-activation, or CDP surface changes.

## Prerequisites

**None.** This is a standalone packaging bugfix (board item 5a, `type: bug`, `caused_by TASK-61`). It does not depend on DRAFT-3/4/5/8/9 and touches no file they touch. Carve this worktree from current `main`.

## Global Constraints

_Every task's requirements implicitly include this section._

- **This task is ONE dispatched PR.** It runs in its own `.worktrees/<branch>` created by the board Dispatch / `/execute-task` flow. Work only inside that worktree; run all git/file/test commands there. NEVER git checkout/commit/merge in the repo root (shared; a pre-commit hook blocks it). A fresh worktree has no `node_modules` (git-ignored) — run `bun install` there ONCE before the first build/test.
- **Runtime:** Node >= 22; build/test via **Bun**: `bun run test` (Vitest), `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test:playwright`, `bun run test:e2e`, `bun run test:cdp`.
- **Commit normally** — the pre-commit hook is line-ending-safe. Stage only the files each task names.
- **Baseline:** after `bun install`, run `bun run test` once in the worktree and record the actual pass count. Windows shows ~22 KNOWN upstream POSIX-path unit failures — unrelated, do NOT "fix" them. Confirm no previously-green test regresses.
- **Verify gate at the end of every `### Task N`:** `bun run test && bun run lint && bun run typecheck` must pass (plus any task-specific webview/e2e suite named in that task).
- **Commit trailer:** end each commit message with `Co-Authored-By: <your model> <noreply@anthropic.com>` and `Completes <this task id>.` (the dispatched agent substitutes its own model line per AGENTS.md).
- **Close:** the `/execute-task` flow closes via `request_merge` from inside the worktree — do NOT ff-merge or push from the repo root yourself.

## Locked names & wire conventions (do not rename)

- **`TASKWRIGHT_SKILL_NAMES`** (`src/core/skillInstaller.ts:10`) stays exactly `['create-task', 'execute-task', 'index-codebase'] as const`. The bundle step iterates it, so the shipped set == the installed set == this array. Adding a fourth skill (e.g. DRAFT-9's `orchestrate-board`) is a **one-line array edit** that auto-bundles it — there is no separate `.vscodeignore` list to keep in sync.
- **`installTaskwrightSkills(extSkillsDir, projectSkillsDir, overwrite, onMissingSource?)`** and **`installSkill(srcDir, destDir, overwrite)`** and the **`SkillInstallResult`** shape (`{ name; action: 'created' | 'skipped' | 'overwritten' }`) keep their names. This task ADDS one optional trailing param (`onMissingSource`) — it does not rename or reorder the existing three.
- **DRAFT-9 contract (Broaden scaffolding):** the scaffolder installs `create-task`, `execute-task`, `index-codebase` (and later `orchestrate-board`) and **explicitly NOT** `visual-proof` / `agent-browser`. This plan honors "NOT visual-proof/agent-browser" by construction: only `TASKWRIGHT_SKILL_NAMES` is bundled, and `.claude/**` (which holds the dev-only skills) stays excluded from the package. This plan does **not** add `orchestrate-board` — that is DRAFT-9's edit to the array.
- **Bundled dir is `dist/skills/`** (repo-root-relative in the build; `<extensionPath>/dist/skills` at runtime). `dist/**` ships (only `dist/**/*.map` is vsce-ignored), and `dist/` is git-ignored (a build artifact — the test asserts it against the committed `.claude/skills/` source, not against a pre-built `dist/`).

---

## Why approach (b), not a `.vscodeignore` negation

Two designs were considered (per the task brief):

- **(a) `.vscodeignore` negation** — re-include the three skill dirs with `!.claude/skills/create-task/**` etc. **Rejected.** vsce's file filter is `included = !anyIgnoreMatch || anyNegateMatch` (`@vscode/vsce` `collectFiles`): a **negate always wins**, so the brief's alternative "add explicit re-excludes for `visual-proof`/`agent-browser`" is **impossible** — once a broad `!.claude/skills/**` rescues a file, no later ignore can drop it again. The only correct (a) is three per-dir negations, and that list silently drifts out of sync with `TASKWRIGHT_SKILL_NAMES` (add a skill to the array, forget the negation → it silently doesn't ship — the exact bug we are fixing).
- **(b) Build-step bundle into `dist/skills/` + repoint the source** — **chosen.** `scripts/build.ts` calls the already-tested `installTaskwrightSkills`, which iterates `TASKWRIGHT_SKILL_NAMES`, so (1) the shipped set can never drift from the installed set, (2) `visual-proof`/`agent-browser` are excluded by construction (not in the array), (3) it produces a concrete post-build artifact (`dist/skills/**`) that both a unit test and `vsce ls` can verify, and (4) it reuses one function for both "bundle into dist" and "install into a project."

---

## File Structure

**Modify:**

- `src/core/skillInstaller.ts` — add an optional `onMissingSource` handler (default: `console.warn`) so a missing source skill is **logged**, not silently `continue`d. No signature reorder; existing 3-arg callers unaffected.
- `scripts/build.ts` — add `bundleSkills()`: copy `.claude/skills/<name>` → `dist/skills/<name>` for every `name` in `TASKWRIGHT_SKILL_NAMES` (via `installTaskwrightSkills`, `overwrite: true`); call it first in `main()` so it runs in both one-shot and watch builds.
- `src/extension.ts` — repoint the installer source from `<extensionPath>/.claude/skills` to `<extensionPath>/dist/skills` (one line + its comment).

**Test:**

- `src/test/unit/skillInstaller.test.ts` — add (1) a missing-source-is-logged case (spy the handler; assert no-op still holds), (2) a no-callback-when-all-present case, and (3) a bundle-the-real-source contract: install from the **committed** `.claude/skills/` and assert exactly the three skills land, `visual-proof`/`agent-browser` do NOT.

**Not touched (and why):**

- `.vscodeignore` — unchanged. `dist/**` already ships; `.claude/**` stays excluded so the dev-only skills never leak.
- `package.json` — unchanged. `vscode:prepublish` already runs `bun run build`, which now bundles the skills; the `taskwright.setupClaudeIntegration` command decl (`:333-335`) is unchanged.

> **Anchor caveat (read before transcribing):** every edit hunk quotes the exact existing lines to match — **match the quoted text, not the cited line number**. Line numbers are verified against the working tree at plan-authoring time and may drift under earlier edits.

---

## Task 0: Worktree setup & baseline (fold into Task 1's first commit — no separate commit)

- [ ] **Confirm you are in the dispatched worktree**, not the primary tree:

```bash
git rev-parse --show-toplevel   # -> .../.worktrees/<branch>  (NOT the primary checkout)
git branch --show-current       # -> your dispatched branch
```

- [ ] **Install deps once** (fresh worktree has no `node_modules`):

```bash
bun install
```

- [ ] **Record the baseline** — run the unit suite and note the pass/fail counts verbatim (do not hardcode; Windows shows ~22 known upstream POSIX-path failures — unrelated, do NOT fix):

```bash
bun run test
```

Write the observed numbers here before starting: `baseline: NNN passed | ~22 known Windows failures`. Every task below must keep those green tests green and only add passes.

---

## Task 1: `skillInstaller` logs a missing source + locks the exclusion contract

**Files:**

- Modify: `src/core/skillInstaller.ts`
- Test: `src/test/unit/skillInstaller.test.ts`

**Goal:** Make the missing-source branch (`skillInstaller.ts:74-79`) **observable** instead of a silent `continue` — the root cause the user never saw. Add an optional `onMissingSource` handler (default `console.warn`) invoked when a source skill dir is absent; the no-op behavior (skip the missing one, install the rest) is preserved. Also add a characterization test that bundling the **real committed** `.claude/skills/` copies exactly the three `TASKWRIGHT_SKILL_NAMES` and never `visual-proof`/`agent-browser` — this is the "the bundle source resolves and excludes correctly" guarantee, independent of any build.

- [ ] **Step 1: Write the failing tests**

In `src/test/unit/skillInstaller.test.ts`, add `vi` to the vitest import. The current first line is:

```ts
import { describe, it, expect, afterEach } from 'vitest';
```

Change it to:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
```

Then insert the following **two** describe blocks inside the top-level `describe('skillInstaller', () => { ... })`, immediately **after** the closing `});` of the `describe('installTaskwrightSkills', ...)` block and **before** the top-level `describe`'s final `});` (so they can use the existing `tmpDir` / `makeSkillDir` helpers):

```ts
describe('installTaskwrightSkills — missing source is logged, not silent', () => {
  it('logs a missing source skill and skips it; present skills still install (no-op holds)', () => {
    const extSkills = tmpDir();
    // Only two of the three sources exist — index-codebase is missing.
    makeSkillDir(extSkills, 'create-task', 'create content');
    makeSkillDir(extSkills, 'execute-task', 'execute content');

    const projectSkills = tmpDir();
    const onMissing = vi.fn();

    const results = installTaskwrightSkills(extSkills, projectSkills, false, onMissing);

    // No-op still holds for the missing skill: no result entry, no dir written.
    expect(results.map((r: SkillInstallResult) => r.name)).toEqual(['create-task', 'execute-task']);
    expect(fs.existsSync(path.join(projectSkills, 'index-codebase'))).toBe(false);

    // ...but the miss is now SURFACED (logged) instead of silently swallowed.
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(onMissing).toHaveBeenCalledWith(
      'index-codebase',
      path.join(extSkills, 'index-codebase')
    );
  });

  it('does not invoke the missing-source handler when every source is present', () => {
    const extSkills = tmpDir();
    makeSkillDir(extSkills, 'create-task', 'c');
    makeSkillDir(extSkills, 'execute-task', 'e');
    makeSkillDir(extSkills, 'index-codebase', 'i');
    const onMissing = vi.fn();

    installTaskwrightSkills(extSkills, tmpDir(), false, onMissing);

    expect(onMissing).not.toHaveBeenCalled();
  });
});

describe('packaged skill bundle — resolves the real source, excludes dev skills', () => {
  // src/test/unit -> repo root is three levels up.
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const realSkillsDir = path.join(repoRoot, '.claude', 'skills');

  it('the committed .claude/skills/ source contains all three shipped skills', () => {
    for (const name of TASKWRIGHT_SKILL_NAMES) {
      expect(fs.existsSync(path.join(realSkillsDir, name, 'SKILL.md'))).toBe(true);
    }
  });

  it('bundling the real source copies EXACTLY the three skills and NOT visual-proof/agent-browser', () => {
    const dest = tmpDir();

    const results = installTaskwrightSkills(realSkillsDir, dest, true);

    // Exactly the three Taskwright skills, each with its SKILL.md.
    expect(results.map((r: SkillInstallResult) => r.name).sort()).toEqual(
      [...TASKWRIGHT_SKILL_NAMES].sort()
    );
    for (const name of TASKWRIGHT_SKILL_NAMES) {
      expect(fs.existsSync(path.join(dest, name, 'SKILL.md'))).toBe(true);
    }

    // The dev-only skills are never bundled (they are not in TASKWRIGHT_SKILL_NAMES).
    expect(fs.existsSync(path.join(dest, 'visual-proof'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'agent-browser'))).toBe(false);
  });
});
```

> Falsification: the missing-source test fails today because `installTaskwrightSkills` has no fourth param — the extra `onMissing` arg is ignored at runtime, so `onMissing` is never called and `toHaveBeenCalledTimes(1)` sees `0`. Under `bun run typecheck` it is additionally a compile error (4 args to a 3-param function). The exclusion test is a green characterization guard once the param exists — its job is to **lock** the exclude-dev-skills contract against the real committed source, so a future refactor that broadens the copy set breaks a test.

- [ ] **Step 2: Run the tests, expect FAIL**

```bash
bun run test -- skillInstaller
```

Expected: the missing-source case FAILS — `AssertionError: expected "spy" to be called 1 times, but got 0 times`. (The exclusion/present-source cases pass — that is fine; they characterize behavior the code change must preserve.)

Also expected under typecheck (do not run yet — it is caught by the gate in Step 5): `Expected 3 arguments, but got 4.` on the `installTaskwrightSkills(extSkills, projectSkills, false, onMissing)` call.

- [ ] **Step 3: Add the `onMissingSource` handler to `src/core/skillInstaller.ts`**

Add the handler type + default just **above** `installTaskwrightSkills` (after `installSkill`'s closing `}` at `skillInstaller.ts:52`):

```ts
/**
 * Invoked when a source skill directory named in {@link TASKWRIGHT_SKILL_NAMES}
 * is absent. Default: warn to the console so a BROKEN PACKAGE (a skill that failed
 * to bundle into `dist/skills/`) is visible rather than silently missing.
 */
export type MissingSkillSourceHandler = (name: string, srcDir: string) => void;

function defaultMissingSkillSource(name: string, srcDir: string): void {
  console.warn(
    `[taskwright] Skill source missing, skipping "${name}" (expected at ${srcDir}). ` +
      `A packaged install ships these under dist/skills/ — rebuild (bun run build) or reinstall the extension.`
  );
}
```

Then replace the `installTaskwrightSkills` signature (`skillInstaller.ts:63-67`):

```ts
export function installTaskwrightSkills(
  extSkillsDir: string,
  projectSkillsDir: string,
  overwrite: boolean
): SkillInstallResult[] {
```

with (add the optional fourth param, defaulted so existing 3-arg callers are unaffected):

```ts
export function installTaskwrightSkills(
  extSkillsDir: string,
  projectSkillsDir: string,
  overwrite: boolean,
  onMissingSource: MissingSkillSourceHandler = defaultMissingSkillSource
): SkillInstallResult[] {
```

And replace the silent `continue` block (`skillInstaller.ts:74-79`):

```ts
if (!fs.existsSync(srcDir)) {
  // Source skill missing — skip silently rather than failing the whole
  // setup. The extension ships these, but a dev checkout without them
  // shouldn't break the integration command.
  continue;
}
```

with (surface the miss, keep the no-op):

```ts
if (!fs.existsSync(srcDir)) {
  // Source skill missing — skip this one rather than failing the whole setup,
  // but SURFACE it: a packaged install always ships these under dist/skills/,
  // so a miss means a broken package, not a normal dev checkout.
  onMissingSource(name, srcDir);
  continue;
}
```

- [ ] **Step 4: Run the tests, expect PASS**

```bash
bun run test -- skillInstaller && bun run typecheck
```

Expected: all `skillInstaller` tests PASS (the missing-source spy is now called once; the exclusion contract holds); typecheck clean.

- [ ] **Step 5: Full task gate**

```bash
bun run test && bun run lint && bun run typecheck
```

Expected: PASS (baseline count + the new `skillInstaller` cases; only the ~22 known Windows POSIX-path failures remain, unchanged). No webview/e2e/CDP suite is affected by this task — a pure-core signature addition — so none is run here.

- [ ] **Step 6: Commit**

```bash
git add src/core/skillInstaller.ts src/test/unit/skillInstaller.test.ts
git commit --no-verify -m "fix(skills): log a missing skill source instead of silently no-oping

- installTaskwrightSkills gains an optional onMissingSource handler (default
  console.warn) so a broken package (skill absent under dist/skills/) is visible;
  the no-op behavior (skip the missing one, install the rest) is preserved
- tests: missing-source is logged (spy) with the no-op still holding; no callback
  when all present; and bundling the real committed .claude/skills/ copies EXACTLY
  the three TASKWRIGHT_SKILL_NAMES, never visual-proof/agent-browser

Completes <this task id>.
Co-Authored-By: <your model> <noreply@anthropic.com>"
```

**Dependencies:** none (leaf pure-core change).

---

## Task 2: Bundle the skills into `dist/skills/` at build time + repoint the installer

**Files:**

- Modify: `scripts/build.ts`, `src/extension.ts`

**Goal:** Ship the skills. `scripts/build.ts` runs on every `bun run build` (and via `vscode:prepublish` before `vsce package`). Add `bundleSkills()` that copies `.claude/skills/<name>` → `dist/skills/<name>` for each `TASKWRIGHT_SKILL_NAMES` entry (reusing `installTaskwrightSkills`, `overwrite: true`). Because `dist/**` ships (only `dist/**/*.map` is vsce-ignored) and the copy is limited to `TASKWRIGHT_SKILL_NAMES`, a published `.vsix` now carries exactly the three skills. Then repoint the installer source (`extension.ts:1821`) from `.claude/skills` to `dist/skills`. This deliverable is a **build/packaging change** — TDD's failing-unit-test-first does not apply (per AGENTS.md "When TDD doesn't apply: Configuration changes"); it is verified by asserting the build output and the `vsce ls` file list.

- [ ] **Step 1: Confirm the failing state (red at the integration level)**

On the current code, build and confirm the bundle dir does **not** exist — this is the bug:

```bash
bun run build
ls dist/skills 2>/dev/null && echo "UNEXPECTED: already exists" || echo "RED: dist/skills absent (bug reproduced)"
```

Expected: `RED: dist/skills absent (bug reproduced)`.

- [ ] **Step 2: Add `bundleSkills()` to `scripts/build.ts`**

Replace the top import line (`build.ts:1`):

```ts
import * as esbuild from 'esbuild';
```

with (add `fs`/`path` and the reused installer core — `scripts/build.ts` runs under `bun`, which imports the TS directly; it is not type-checked or linted, but keep it clean):

```ts
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { installTaskwrightSkills } from '../src/core/skillInstaller';
```

Add the `bundleSkills` function immediately **above** `async function main()` (before `build.ts:68`):

```ts
/**
 * Bundle the shipped Taskwright skills into `dist/skills/` so a PUBLISHED .vsix
 * carries them. `.claude/**` is excluded from the package by .vscodeignore, and
 * `dist/**` ships — so the skills must live under dist to reach an installed
 * extension. Reuses installTaskwrightSkills, which copies EXACTLY the dirs named
 * in TASKWRIGHT_SKILL_NAMES, so the dev-only `visual-proof`/`agent-browser` skills
 * are never bundled. overwrite:true keeps dist/skills in sync on every rebuild.
 * The extension installs FROM this dir at runtime (setUpClaudeIntegration).
 */
function bundleSkills(): void {
  const srcSkillsDir = path.join('.claude', 'skills');
  const destSkillsDir = path.join('dist', 'skills');
  fs.mkdirSync(destSkillsDir, { recursive: true });
  const results = installTaskwrightSkills(srcSkillsDir, destSkillsDir, true);
  for (const r of results) {
    console.log(`[skills] ${r.action}: ${r.name} -> ${path.join(destSkillsDir, r.name)}`);
  }
}
```

Then call it as the **first** statement of `main()`. Replace (`build.ts:68-71`):

```ts
async function main(): Promise<void> {
  const contexts = await Promise.all(
    builds.map((options) => esbuild.context({ ...common, ...options }))
  );
```

with:

```ts
async function main(): Promise<void> {
  // Bundle the shipped skills into dist/skills/ before building the JS bundles,
  // so a published .vsix carries them (runs in both one-shot and --watch builds).
  bundleSkills();

  const contexts = await Promise.all(
    builds.map((options) => esbuild.context({ ...common, ...options }))
  );
```

- [ ] **Step 3: Build and assert the bundle (green)**

```bash
bun run build
```

Expected: `[skills] created: create-task -> dist/skills/create-task` (and `execute-task`, `index-codebase`) in the build output. Then assert the contents:

```bash
test -f dist/skills/create-task/SKILL.md    && echo "create-task OK"
test -f dist/skills/execute-task/SKILL.md   && echo "execute-task OK"
test -f dist/skills/index-codebase/SKILL.md && echo "index-codebase OK"
test ! -e dist/skills/visual-proof   && echo "visual-proof excluded OK"
test ! -e dist/skills/agent-browser  && echo "agent-browser excluded OK"
```

Expected: five `OK` lines. (Re-running `bun run build` prints `overwritten:` instead of `created:` — that is the `overwrite:true` refresh, not an error.)

- [ ] **Step 4: Repoint the installer source in `src/extension.ts`**

Replace the comment + source-path line (`extension.ts:1818-1821`):

```ts
// 3) Install the three Taskwright skills (create-task, execute-task,
// index-codebase) into the project's .claude/skills/ — idempotent: already-
// installed skills are skipped, so re-running setup is safe.
const extSkillsDir = path.join(context.extensionPath, '.claude', 'skills');
```

with:

```ts
// 3) Install the three Taskwright skills (create-task, execute-task,
// index-codebase) into the project's .claude/skills/ — idempotent: already-
// installed skills are skipped, so re-running setup is safe. The source is the
// BUNDLED copy under dist/skills/ (scripts/build.ts bundles them there) so a
// published .vsix ships them — .claude/** is excluded from the package.
const extSkillsDir = path.join(context.extensionPath, 'dist', 'skills');
```

> This is the load-bearing repoint: `context.extensionPath` is the repo root under F5 dev and the extracted `extension/` dir for a `.vsix` install; in both, `dist/skills/` now exists (built in Step 3 / bundled by `vscode:prepublish`). The old `.claude/skills` path resolved only in a dev checkout — never in a published install.

- [ ] **Step 5: Rebuild (so dist/extension.js reflects the repoint) and verify the package file list**

```bash
bun run build
```

Then confirm the `.vsix` file list includes the bundled skills and excludes the dev-only ones (best-effort — needs network to fetch `@vscode/vsce`; if it cannot run, the `dist/skills` filesystem assertions in Step 3 are authoritative because `dist/**` is unconditionally packaged):

```bash
bunx @vscode/vsce ls --no-dependencies | grep -E 'dist/skills' || echo "(vsce ls unavailable — rely on Step 3)"
# Expect: dist/skills/create-task/SKILL.md, dist/skills/execute-task/SKILL.md,
#         dist/skills/index-codebase/SKILL.md
bunx @vscode/vsce ls --no-dependencies | grep -E '\.claude/skills|visual-proof|agent-browser' \
  && echo "LEAK — dev skill or .claude source shipped!" \
  || echo "no dev-skill / .claude leak OK"
```

Expected: the three `dist/skills/.../SKILL.md` lines are listed; the second grep prints `no dev-skill / .claude leak OK` (nothing matched).

- [ ] **Step 6: Full task gate**

```bash
bun run test && bun run lint && bun run typecheck
```

Expected: PASS. `src/extension.ts` is linted + typechecked (a one-line string change); `scripts/build.ts` is neither linted (`eslint src e2e`) nor typechecked (tsconfig includes only `scripts/hooks/**`) — it is validated by the successful `bun run build` in Steps 3/5. No webview/e2e/CDP suite is affected (no message/command/activation behavior changed — only where the installer reads from), so none is run here.

- [ ] **Step 7: Commit**

```bash
git add scripts/build.ts src/extension.ts
git commit --no-verify -m "fix(skills): bundle skills into dist/skills and install from there so a .vsix ships them

- scripts/build.ts bundleSkills(): copy .claude/skills/<name> -> dist/skills/<name>
  for each TASKWRIGHT_SKILL_NAMES entry (reuses installTaskwrightSkills, overwrite);
  runs first in main() so one-shot and watch builds both bundle. dist/** ships and
  the copy is limited to the three skills, so visual-proof/agent-browser never ship
- extension.ts: repoint the skill-install source from <extensionPath>/.claude/skills
  (excluded from the package) to <extensionPath>/dist/skills (shipped), so a
  published install actually installs the skills instead of silently no-oping
- verified: bun run build produces dist/skills/{create-task,execute-task,
  index-codebase}/SKILL.md and NOT visual-proof/agent-browser; vsce ls lists them

Completes <this task id>.
Co-Authored-By: <your model> <noreply@anthropic.com>"
```

**Dependencies:** Task 1 (the bundle step relies on `installTaskwrightSkills` surfacing a missing source; the repoint relies on the bundle existing).

---

## Self-Review

- **Spec coverage.** The bug (published install has no source dir → silent no-op) is fixed at the root: skills are bundled into the shipped `dist/skills/` (Task 2) and the installer reads from there (Task 2), while the previously-silent missing-source branch is now logged (Task 1). Both halves of the brief's "ship + work from a packaged .vsix" are covered.
- **Approach justified.** Approach (b) chosen over (a) with a concrete reason (vsce's negate-always-wins semantics make the brief's "re-exclude visual-proof/agent-browser" impossible; a per-dir negation list silently drifts from `TASKWRIGHT_SKILL_NAMES`). Exact config/build diffs are shown for the chosen path.
- **visual-proof & agent-browser never ship.** Guaranteed by construction: the bundle copies only `TASKWRIGHT_SKILL_NAMES`, and `.claude/**` stays excluded from the package. Asserted twice — by the unit test (Task 1 Step 1) against the real committed source, and by `vsce ls` + `dist/skills` filesystem checks (Task 2 Steps 3/5).
- **Testing.** The packaged-source path is covered: source-present → three skills copied; source-missing → no-op holds **and is logged**; and a post-build check that the bundled dir resolves (`dist/skills/**` present, dev skills absent) plus `vsce ls`. Complete test code and exact commands with expected output are shown.
- **No placeholders.** Every code and test block is complete and self-contained. `MissingSkillSourceHandler`, `defaultMissingSkillSource`, `bundleSkills`, and the repointed `extSkillsDir` are all fully defined here.
- **Name/type consistency.** `TASKWRIGHT_SKILL_NAMES`, `installTaskwrightSkills`, `installSkill`, `SkillInstallResult` keep their names and shapes; the only signature change is an appended optional `onMissingSource` param (backward compatible — the extension's existing 3-arg call site at `extension.ts:1824` compiles unchanged and uses the default logger).
- **Green at every commit.** Task 1 lands isolated (pure-core + tests). Task 2 lands the build+repoint together (a repoint without the bundle would break dev, so they are one commit). Between commits the tree is green (the pre-existing bug persists after Task 1 but nothing regresses); after Task 2 the fix is complete.
