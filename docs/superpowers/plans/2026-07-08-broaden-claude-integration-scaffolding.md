# Broaden Set-Up-Claude-Integration Scaffolding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `setUpClaudeIntegration` (`src/extension.ts`) so a fresh repo is fully wired for Taskwright — beyond today's 3-skill install + CLAUDE.md marked block + user-scope MCP registration — by (1) injecting a Taskwright convention block into **AGENTS.md** too, (2) offering an **opt-in project-local `.mcp.json`** (plus the copied `scripts/taskwright-mcp.cjs` launcher) so any session opened in the repo gets the MCP without the user-scope CLI, and (3) installing a **fourth** user-facing skill, `orchestrate-board`, while still excluding the internal `visual-proof`/`agent-browser` skills.

**Architecture.** Three thin, independently-testable seams, each reusing an existing pattern. The AGENTS.md injector clones `agentConvention.ts`'s `injectConvention` (same `upsertMarkerBlock` + `TASKWRIGHT_MARKERS`, different body). The project-local `.mcp.json` is a new **pure, string-in/string-out** core (`src/core/mcpProjectConfig.ts`) that extracts the `taskwright` server def from the extension's shipped `.mcp.json` template and upserts it into the target repo's `.mcp.json`; the extension owns the fs I/O and copies the committed launcher. The skill-set change is a one-line array edit in `skillInstaller.ts`. All wiring lands in the existing `setUpClaudeIntegration` closure.

**Tech Stack:** TypeScript, Vitest (pure cores + temp-dir/string fixtures), esbuild (extension bundle) + `vsce` packaging (`.vscodeignore`). No webview, Svelte, Playwright, or CDP surface is touched by this task.

---

## Prerequisites (this draft is blocked — carve the worktree AFTER these land)

This is **DRAFT-9**. It depends on two other drafts being **MERGED to the base branch first**; carve this worktree AFTER those land so their code is present in it:

- **DRAFT-6 (packaging fix)** — establishes the `.vscodeignore` un-ignore approach for shipping runtime assets in the VSIX. Task 3 below mirrors that approach to ship `scripts/taskwright-mcp.cjs` and `.mcp.json`. If DRAFT-6 has already added a `!scripts/taskwright-mcp.cjs` or `!.mcp.json` negation, Task 3's `.vscodeignore` edit becomes a no-op for that line — verify by re-reading the file before editing and skip any line already present.
- **DRAFT-8 (`/orchestrate-board` skill)** — creates `.claude/skills/orchestrate-board/SKILL.md`. Task 2 adds `'orchestrate-board'` to `TASKWRIGHT_SKILL_NAMES`; the skill directory **must exist** for `installTaskwrightSkills` to actually copy it (a missing source dir is silently skipped by design — `skillInstaller.ts:74-79`). If DRAFT-8 has not merged, Task 2's install would silently drop the fourth skill in a real run even though its unit tests (which fabricate the source dir) pass.

Do not begin implementation until `.claude/skills/orchestrate-board/SKILL.md` is present on the base branch and DRAFT-6's packaging changes are merged.

---

## Global Constraints

_Every task's requirements implicitly include this section._

- **This task is ONE dispatched PR.** It runs in its own `.worktrees/<branch>` created by the board Dispatch / `/execute-task` flow. Work only inside that worktree; run all git/file/test commands there. NEVER git checkout/commit/merge in the repo root (shared; a pre-commit hook blocks it). A fresh worktree has no `node_modules` (git-ignored) — run `bun install` there ONCE before the first build/test.
- **Runtime:** Node >= 22; build/test via **Bun**: `bun run test` (Vitest), `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test:playwright`, `bun run test:e2e`, `bun run test:cdp`.
- **Commit with `--no-verify`** (the repo's lint-staged pre-commit hook flips the whole tree CRLF->LF on Windows). Stage only the files each task names.
- **Baseline:** after `bun install`, run `bun run test` once in the worktree and record the actual pass count. Windows shows ~22 KNOWN upstream POSIX-path unit failures — unrelated, do NOT "fix" them. Confirm no previously-green test regresses.
- **Verify gate at the end of every `### Task N`:** `bun run test && bun run lint && bun run typecheck` must pass (plus any task-specific webview/e2e suite named in that task).
- **Commit trailer:** end each commit message with `Co-Authored-By: <your model> <noreply@anthropic.com>` and `Completes <this task id>.` (the dispatched agent substitutes its own model line per AGENTS.md).
- **Close:** the `/execute-task` flow closes via `request_merge` from inside the worktree — do NOT ff-merge or push from the repo root yourself.

> **Anchor caveat (read before transcribing):** every edit hunk quotes the exact existing lines to match — **match the quoted text, not the cited line number.** Line numbers may drift under earlier edits or under the two prerequisite merges; the quoted before/after snippets are authoritative.

---

## Locked names & wire conventions (from the cross-task contracts — do not rename)

- **Broaden scaffolding (DRAFT-9, this task):** installs skills `create-task`, `execute-task`, `index-codebase`, `orchestrate-board` — and explicitly **NOT** `visual-proof`/`agent-browser`. Also AGENTS.md injection + optional project-local `.mcp.json` (+ shipped `scripts/taskwright-mcp.cjs`).
- **`/orchestrate-board` skill (DRAFT-8):** `.claude/skills/orchestrate-board/SKILL.md` (name chosen to avoid clashing with the claude-harness `/orchestrate` deepseek-worker skill). This is the exact skill directory name `installTaskwrightSkills` copies — the array entry MUST be the string `'orchestrate-board'`.
- **Existing marker pair (reuse verbatim):** `TASKWRIGHT_MARKERS = { begin: '<!-- TASKWRIGHT:BEGIN -->', end: '<!-- TASKWRIGHT:END -->' }` (`src/core/markerBlock.ts:14-17`). AGENTS.md reuses this SAME pair — `AgentIntegrationDetector.detectClaudeCodeIntegration`/`detectCodexIntegration` already scan AGENTS.md for `TASKWRIGHT_MARKERS.begin` (`src/core/AgentIntegrationDetector.ts:91-97/119-121`), so reusing it makes the new block detectable with zero detector changes.
- **Existing MCP server key:** `TASKWRIGHT_MCP_NAME = 'taskwright'` (`src/core/claudeMcp.ts:20`). The `.mcp.json` writer keys off this constant, not a literal.
- **New pure core (this task):** `src/core/mcpProjectConfig.ts` exporting `McpServerDef`, `extractTaskwrightServer(templateJson: string): McpServerDef`, `upsertTaskwrightMcpServer(existingProjectJson: string, taskwrightServer: McpServerDef): string`.
- **New agentConvention exports (this task):** `TASKWRIGHT_AGENTS_CONVENTION: string`, `injectAgentsConvention(existingAgentsMd: string): string`.
- **New setting (this task):** `taskwright.setupWritesProjectMcpJson` (boolean, default `false`) — opt-in gate for the `.mcp.json` writer, read via `getTaskwrightConfig<boolean>('setupWritesProjectMcpJson', false)`.

---

## File Structure

**Create:**

- `src/core/mcpProjectConfig.ts` — pure `.mcp.json` template extractor + idempotent upsert writer (string in / string out; no fs, no vscode).
- `src/test/unit/mcpProjectConfig.test.ts` — unit tests: extract from template, throws on missing/malformed, upsert creates-from-empty / preserves-other-servers / idempotent / updates-in-place.

**Modify:**

- `src/core/agentConvention.ts` — add `TASKWRIGHT_AGENTS_CONVENTION` + `injectAgentsConvention` alongside the existing CLAUDE.md pair.
- `src/test/unit/agentConvention.test.ts` — add an `injectAgentsConvention` describe (marked block, preserves content, idempotent).
- `src/core/skillInstaller.ts` — add `'orchestrate-board'` to `TASKWRIGHT_SKILL_NAMES`; update the doc comment (three → four; note visual-proof/agent-browser stay internal).
- `src/test/unit/skillInstaller.test.ts` — expect 4 names incl `orchestrate-board`, assert `visual-proof`/`agent-browser` excluded; update the three install-flow tests to 4 skills.
- `src/extension.ts` — import `injectAgentsConvention` + the two `mcpProjectConfig` fns; add an AGENTS.md injection step and an opt-in `.mcp.json` step to `setUpClaudeIntegration`; update the skills-install comment (three → four).
- `.vscodeignore` — un-ignore `scripts/taskwright-mcp.cjs` and `.mcp.json` so both ship in the VSIX (mirrors DRAFT-6).
- `package.json` — contribute the `taskwright.setupWritesProjectMcpJson` setting.
- `CLAUDE.md` — append a scaffolding bullet to the "Taskwright additions" list (Task 4).

**Test commands used throughout:** `bun run test -- <filename-substring>` filters Vitest to one file (e.g. `bun run test -- agentConvention`).

---

## Task 1: AGENTS.md convention injector + wire into setup

**Files:**

- Modify: `src/core/agentConvention.ts`, `src/extension.ts`
- Test: `src/test/unit/agentConvention.test.ts`

**Goal:** Today `setUpClaudeIntegration` only writes CLAUDE.md (`extension.ts:1787-1816`); a Codex/general agent reading AGENTS.md never learns to call the Taskwright MCP. Add an AGENTS.md-flavored convention and an `injectAgentsConvention` that reuses the exact `upsertMarkerBlock` + `TASKWRIGHT_MARKERS` pattern, then wire a parallel AGENTS.md step into setup (mirroring the CLAUDE.md modal so file **creation** stays consent-gated, while a re-run is a no-op).

- [ ] **Step 1: Write the failing tests**

Append this describe block to `src/test/unit/agentConvention.test.ts` and extend the import on line 2. Replace the existing import line:

```ts
import { injectConvention, TASKWRIGHT_CONVENTION } from '../../core/agentConvention';
```

with:

```ts
import {
  injectConvention,
  injectAgentsConvention,
  TASKWRIGHT_CONVENTION,
  TASKWRIGHT_AGENTS_CONVENTION,
} from '../../core/agentConvention';
```

Then add this describe block after the existing `describe('injectConvention', ...)` block (the file already imports `TASKWRIGHT_MARKERS` from `../../core/markerBlock`):

```ts
describe('injectAgentsConvention', () => {
  it('wraps the AGENTS convention in Taskwright markers for a new file', () => {
    const out = injectAgentsConvention('');
    expect(out).toContain(TASKWRIGHT_MARKERS.begin);
    expect(out).toContain(TASKWRIGHT_MARKERS.end);
    expect(out).toContain('get_active_task');
    expect(out).toContain('request_merge');
    expect(out).toContain(TASKWRIGHT_AGENTS_CONVENTION);
  });

  it('preserves existing AGENTS.md content and appends the block once', () => {
    const existing = '# Contributor guide\n\nRun the tests.\n';
    const out = injectAgentsConvention(existing);
    expect(out.startsWith(existing)).toBe(true);
    expect((out.match(/TASKWRIGHT:BEGIN/g) ?? []).length).toBe(1);
  });

  it('is idempotent', () => {
    const once = injectAgentsConvention('# Doc\n');
    expect(injectAgentsConvention(once)).toBe(once);
  });

  it('is a distinct body from the CLAUDE.md convention', () => {
    // The AGENTS.md block leads with the MCP-server framing and the merge close;
    // the CLAUDE.md block does not mention request_merge.
    expect(TASKWRIGHT_AGENTS_CONVENTION).not.toBe(TASKWRIGHT_CONVENTION);
    expect(TASKWRIGHT_AGENTS_CONVENTION).toContain('request_merge');
    expect(TASKWRIGHT_CONVENTION).not.toContain('request_merge');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- agentConvention`
Expected: FAIL — `injectAgentsConvention` and `TASKWRIGHT_AGENTS_CONVENTION` are not exported from `../../core/agentConvention` (TypeScript/Vitest import error, e.g. `injectAgentsConvention is not a function` or a transform error naming the missing export).

- [ ] **Step 3: Add the AGENTS convention + injector to `src/core/agentConvention.ts`**

The file currently ends after `injectConvention` (`agentConvention.ts:25-27`). Add the two new exports at the end of the file (after the closing `}` of `injectConvention`):

```ts
/**
 * The AGENTS.md variant of the convention. AGENTS.md is the general-agent (Codex,
 * etc.) instruction surface, so this block frames the workflow around the
 * Taskwright MCP server declared in `.mcp.json` and names the full session loop
 * through `request_merge`. Reuses the same TASKWRIGHT markers as the CLAUDE.md
 * block, so it round-trips through upsertMarkerBlock and is picked up by
 * AgentIntegrationDetector's AGENTS.md scan with no detector change.
 */
export const TASKWRIGHT_AGENTS_CONVENTION = `## Taskwright

This project is managed with [Taskwright](https://github.com/ChronoVortex07/taskwright), an agentic task board on a git-native Backlog.md backbone. Task and project management runs through the **Taskwright MCP server** (see \`.mcp.json\`), not an external CLI. At the **start of a task session**:

1. Call the \`taskwright\` MCP tool **\`get_active_task\`** to load your assigned task and its full context (description, acceptance criteria, plan). Work from that — do not infer the task from the file tree.
2. Call **\`claim_task\`** with your task ID to mark it in progress so parallel sessions in other worktrees don't collide (advisory).
3. Do the work inside your worktree. Record progress with **\`edit_task\`** (implementationNotes / finalSummary).
4. Close with **\`request_merge\`** from inside your worktree — it rebases, verifies, merges to the base branch, and marks the task Done.

If \`get_active_task\` reports none is set, ask which task to work on rather than assuming.`;

/**
 * Insert or update Taskwright's convention block in an existing AGENTS.md body
 * (or empty string for a new file). Only the marked region is owned by
 * Taskwright; the rest is preserved. Returns the input unchanged when already up
 * to date (callers detect a no-op by identity).
 */
export function injectAgentsConvention(existingAgentsMd: string): string {
  return upsertMarkerBlock(existingAgentsMd, TASKWRIGHT_AGENTS_CONVENTION, TASKWRIGHT_MARKERS);
}
```

> Both `upsertMarkerBlock` and `TASKWRIGHT_MARKERS` are already imported at the top of the file (`agentConvention.ts:1`) — no new import needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- agentConvention && bun run typecheck`
Expected: PASS — all `injectConvention` and `injectAgentsConvention` cases green.

- [ ] **Step 5: Wire the AGENTS.md step into `setUpClaudeIntegration`**

In `src/extension.ts`, extend the `agentConvention` import. Replace (`extension.ts:40`):

```ts
import { injectConvention } from './core/agentConvention';
```

with:

```ts
import { injectConvention, injectAgentsConvention } from './core/agentConvention';
```

Then insert the AGENTS.md step immediately after the CLAUDE.md step. Find the tail of the CLAUDE.md block (`extension.ts:1812-1816`):

```ts
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update CLAUDE.md: ${error}`);
        }
      }
    }
```

and replace it with (same lines, then the new step appended):

```ts
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update CLAUDE.md: ${error}`);
        }
      }
    }

    // 2b) Offer the same convention for AGENTS.md so non-Claude agents (Codex,
    // etc.) also reach for the Taskwright MCP. Idempotent — only a marked block
    // is written; existing content is preserved. Creation is consent-gated with a
    // modal, mirroring the CLAUDE.md step above.
    const agentsMdPath = path.join(root, 'AGENTS.md');
    const agentsExisted = fs.existsSync(agentsMdPath);
    const agentsExisting = agentsExisted ? fs.readFileSync(agentsMdPath, 'utf-8') : '';
    const agentsUpdated = injectAgentsConvention(agentsExisting);
    if (agentsUpdated === agentsExisting) {
      if (agentsExisted) {
        vscode.window.showInformationMessage('AGENTS.md already has the Taskwright instructions.');
      }
      // fall through — skills install still needs to run below
    } else {
      const agentsChoice = await vscode.window.showInformationMessage(
        agentsExisted
          ? 'Add Taskwright agent instructions to your AGENTS.md? Only a marked block is added — your existing content is preserved.'
          : 'Create an AGENTS.md with Taskwright agent instructions so any agent uses the MCP server?',
        { modal: true },
        'Add'
      );
      if (agentsChoice === 'Add') {
        try {
          fs.writeFileSync(agentsMdPath, agentsUpdated, 'utf-8');
          vscode.window.showInformationMessage(
            `${agentsExisted ? 'Updated' : 'Created'} AGENTS.md with Taskwright agent instructions.`
          );
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to update AGENTS.md: ${error}`);
        }
      }
    }
```

> `root` (`extension.ts:1755`), `path`, `fs`, and `vscode` are all in scope in this closure. `setUpClaudeIntegration` is already `async`, so `await vscode.window.showInformationMessage(...)` is valid. There is no unit-test harness for `setUpClaudeIntegration` in the repo (only `commandTitles.test.ts`, which checks the contributed title — unchanged here); this wiring is covered by `typecheck` + `build` and a manual dogfood in Task 4.

- [ ] **Step 6: Full task gate**

Run: `bun run test && bun run lint && bun run typecheck`
Expected: PASS — the new `agentConvention` cases pass; no previously-green test regresses (Windows: the ~22 known POSIX-path failures remain, unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/core/agentConvention.ts src/test/unit/agentConvention.test.ts src/extension.ts
git commit --no-verify -m "feat(scaffolding): inject Taskwright convention into AGENTS.md too

- agentConvention.ts: TASKWRIGHT_AGENTS_CONVENTION + injectAgentsConvention,
  reusing upsertMarkerBlock + the shared TASKWRIGHT markers (detectable by
  AgentIntegrationDetector's AGENTS.md scan with no detector change)
- setUpClaudeIntegration writes a consent-gated, idempotent AGENTS.md marked
  block alongside the existing CLAUDE.md block
- tests: marked block for a new file, preserves existing content, idempotent,
  distinct body from the CLAUDE.md convention

Co-Authored-By: <your model> <noreply@anthropic.com>
Completes <this task id>."
```

**Dependencies:** none (leaf; uses only existing marker helpers).

---

## Task 2: Install the fourth skill (orchestrate-board)

**Files:**

- Modify: `src/core/skillInstaller.ts`, `src/extension.ts`
- Test: `src/test/unit/skillInstaller.test.ts`

**Goal:** `TASKWRIGHT_SKILL_NAMES` lists three skills (`skillInstaller.ts:10`); DRAFT-8 shipped `orchestrate-board`. Add it as the fourth **user-facing** skill so setup installs it, and keep the internal `visual-proof`/`agent-browser` skills excluded. (Prereq: `.claude/skills/orchestrate-board/SKILL.md` exists on the base branch — see Prerequisites; otherwise a real install silently drops it while the fabricated-source unit tests still pass.)

- [ ] **Step 1: Update the failing tests**

In `src/test/unit/skillInstaller.test.ts`, make these edits.

(a) Replace the `TASKWRIGHT_SKILL_NAMES` describe (`skillInstaller.test.ts:34-38`):

```ts
  describe('TASKWRIGHT_SKILL_NAMES', () => {
    it('lists the three Taskwright skills', () => {
      expect(TASKWRIGHT_SKILL_NAMES).toEqual(['create-task', 'execute-task', 'index-codebase']);
    });
  });
```

with:

```ts
  describe('TASKWRIGHT_SKILL_NAMES', () => {
    it('lists the four user-facing Taskwright skills incl orchestrate-board', () => {
      expect(TASKWRIGHT_SKILL_NAMES).toEqual([
        'create-task',
        'execute-task',
        'index-codebase',
        'orchestrate-board',
      ]);
    });

    it('excludes the internal proof/testing skills', () => {
      expect(TASKWRIGHT_SKILL_NAMES).not.toContain('visual-proof');
      expect(TASKWRIGHT_SKILL_NAMES).not.toContain('agent-browser');
    });
  });
```

(b) Replace the "installs all three skills" test (`skillInstaller.test.ts:104-125`):

```ts
    it('installs all three skills into the project skills directory', () => {
      const extSkills = tmpDir();
      makeSkillDir(extSkills, 'create-task', 'create content');
      makeSkillDir(extSkills, 'execute-task', 'execute content');
      makeSkillDir(extSkills, 'index-codebase', 'index content');

      const projectSkills = tmpDir();

      const results = installTaskwrightSkills(extSkills, projectSkills, false);

      expect(results).toHaveLength(3);
      expect(results.map((r: SkillInstallResult) => r.action)).toEqual([
        'created',
        'created',
        'created',
      ]);

      for (const name of TASKWRIGHT_SKILL_NAMES) {
        const dest = path.join(projectSkills, name, 'SKILL.md');
        expect(fs.existsSync(dest)).toBe(true);
      }
    });
```

with:

```ts
    it('installs all four skills into the project skills directory', () => {
      const extSkills = tmpDir();
      makeSkillDir(extSkills, 'create-task', 'create content');
      makeSkillDir(extSkills, 'execute-task', 'execute content');
      makeSkillDir(extSkills, 'index-codebase', 'index content');
      makeSkillDir(extSkills, 'orchestrate-board', 'orchestrate content');

      const projectSkills = tmpDir();

      const results = installTaskwrightSkills(extSkills, projectSkills, false);

      expect(results).toHaveLength(4);
      expect(results.map((r: SkillInstallResult) => r.action)).toEqual([
        'created',
        'created',
        'created',
        'created',
      ]);

      for (const name of TASKWRIGHT_SKILL_NAMES) {
        const dest = path.join(projectSkills, name, 'SKILL.md');
        expect(fs.existsSync(dest)).toBe(true);
      }
    });
```

(c) Replace the "skips already-installed skills and creates missing ones" test (`skillInstaller.test.ts:127-145`):

```ts
    it('skips already-installed skills and creates missing ones', () => {
      const extSkills = tmpDir();
      makeSkillDir(extSkills, 'create-task', 'create content');
      makeSkillDir(extSkills, 'execute-task', 'execute content');
      makeSkillDir(extSkills, 'index-codebase', 'index content');

      const projectSkills = tmpDir();
      // Pre-install one skill.
      makeSkillDir(projectSkills, 'create-task', 'existing content');

      const results = installTaskwrightSkills(extSkills, projectSkills, false);

      const byName: Record<string, SkillInstallResult> = {};
      for (const r of results) byName[r.name] = r;

      expect(byName['create-task'].action).toBe('skipped');
      expect(byName['execute-task'].action).toBe('created');
      expect(byName['index-codebase'].action).toBe('created');
    });
```

with:

```ts
    it('skips already-installed skills and creates missing ones', () => {
      const extSkills = tmpDir();
      makeSkillDir(extSkills, 'create-task', 'create content');
      makeSkillDir(extSkills, 'execute-task', 'execute content');
      makeSkillDir(extSkills, 'index-codebase', 'index content');
      makeSkillDir(extSkills, 'orchestrate-board', 'orchestrate content');

      const projectSkills = tmpDir();
      // Pre-install one skill.
      makeSkillDir(projectSkills, 'create-task', 'existing content');

      const results = installTaskwrightSkills(extSkills, projectSkills, false);

      const byName: Record<string, SkillInstallResult> = {};
      for (const r of results) byName[r.name] = r;

      expect(byName['create-task'].action).toBe('skipped');
      expect(byName['execute-task'].action).toBe('created');
      expect(byName['index-codebase'].action).toBe('created');
      expect(byName['orchestrate-board'].action).toBe('created');
    });
```

(d) Replace the "overwrites all skills when overwrite is true" test (`skillInstaller.test.ts:147-164`):

```ts
    it('overwrites all skills when overwrite is true', () => {
      const extSkills = tmpDir();
      makeSkillDir(extSkills, 'create-task', 'new create');
      makeSkillDir(extSkills, 'execute-task', 'new execute');
      makeSkillDir(extSkills, 'index-codebase', 'new index');

      const projectSkills = tmpDir();
      makeSkillDir(projectSkills, 'create-task', 'old create');
      makeSkillDir(projectSkills, 'execute-task', 'old execute');

      const results = installTaskwrightSkills(extSkills, projectSkills, true);

      expect(results.map((r: SkillInstallResult) => r.action)).toEqual([
        'overwritten',
        'overwritten',
        'created',
      ]);
    });
```

with:

```ts
    it('overwrites all skills when overwrite is true', () => {
      const extSkills = tmpDir();
      makeSkillDir(extSkills, 'create-task', 'new create');
      makeSkillDir(extSkills, 'execute-task', 'new execute');
      makeSkillDir(extSkills, 'index-codebase', 'new index');
      makeSkillDir(extSkills, 'orchestrate-board', 'new orchestrate');

      const projectSkills = tmpDir();
      makeSkillDir(projectSkills, 'create-task', 'old create');
      makeSkillDir(projectSkills, 'execute-task', 'old execute');

      const results = installTaskwrightSkills(extSkills, projectSkills, true);

      expect(results.map((r: SkillInstallResult) => r.action)).toEqual([
        'overwritten',
        'overwritten',
        'created',
        'created',
      ]);
    });
```

(e) Replace the "is idempotent" test (`skillInstaller.test.ts:166-180`):

```ts
    it('is idempotent: re-running with overwrite=false creates nothing new', () => {
      const extSkills = tmpDir();
      makeSkillDir(extSkills, 'create-task', 'create content');
      makeSkillDir(extSkills, 'execute-task', 'execute content');
      makeSkillDir(extSkills, 'index-codebase', 'index content');

      const projectSkills = tmpDir();

      // First run installs everything.
      installTaskwrightSkills(extSkills, projectSkills, false);
      // Second run should skip everything.
      const secondResults = installTaskwrightSkills(extSkills, projectSkills, false);

      expect(secondResults.every((r: SkillInstallResult) => r.action === 'skipped')).toBe(true);
    });
```

with:

```ts
    it('is idempotent: re-running with overwrite=false creates nothing new', () => {
      const extSkills = tmpDir();
      makeSkillDir(extSkills, 'create-task', 'create content');
      makeSkillDir(extSkills, 'execute-task', 'execute content');
      makeSkillDir(extSkills, 'index-codebase', 'index content');
      makeSkillDir(extSkills, 'orchestrate-board', 'orchestrate content');

      const projectSkills = tmpDir();

      // First run installs everything.
      installTaskwrightSkills(extSkills, projectSkills, false);
      // Second run should skip everything.
      const secondResults = installTaskwrightSkills(extSkills, projectSkills, false);

      expect(secondResults).toHaveLength(4);
      expect(secondResults.every((r: SkillInstallResult) => r.action === 'skipped')).toBe(true);
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- skillInstaller`
Expected: FAIL — `TASKWRIGHT_SKILL_NAMES` still equals `['create-task', 'execute-task', 'index-codebase']`, so the `toEqual([...4...])` assertion fails and the install-flow tests report length 3, not 4.

- [ ] **Step 3: Add the skill to `src/core/skillInstaller.ts`**

Replace the doc comment + constant (`skillInstaller.ts:4-10`):

```ts
/**
 * The three Taskwright skills installed into the project's `.claude/skills/`
 * as part of Claude Code integration setup. These skills are tightly coupled to
 * the Taskwright MCP tools which are also registered per-project via `.mcp.json`,
 * so per-project installation is the right default.
 */
export const TASKWRIGHT_SKILL_NAMES = ['create-task', 'execute-task', 'index-codebase'] as const;
```

with:

```ts
/**
 * The four user-facing Taskwright skills installed into the project's
 * `.claude/skills/` as part of Claude Code integration setup: create-task,
 * execute-task, index-codebase, and orchestrate-board. These are tightly coupled
 * to the Taskwright MCP tools (also registered per-project via `.mcp.json`), so
 * per-project installation is the right default. The internal proof/testing
 * skills (visual-proof, agent-browser) are deliberately NOT shipped to users.
 */
export const TASKWRIGHT_SKILL_NAMES = [
  'create-task',
  'execute-task',
  'index-codebase',
  'orchestrate-board',
] as const;
```

- [ ] **Step 4: Update the setup comment in `src/extension.ts`**

Replace the skills-install comment (`extension.ts:1818-1820`):

```ts
    // 3) Install the three Taskwright skills (create-task, execute-task,
    // index-codebase) into the project's .claude/skills/ — idempotent: already-
    // installed skills are skipped, so re-running setup is safe.
```

with:

```ts
    // 3) Install the four user-facing Taskwright skills (create-task,
    // execute-task, index-codebase, orchestrate-board) into the project's
    // .claude/skills/ — idempotent: already-installed skills are skipped, so
    // re-running setup is safe. (visual-proof/agent-browser stay internal.)
```

> This is a comment-only change — the loop already iterates `TASKWRIGHT_SKILL_NAMES`, so no logic changes in `setUpClaudeIntegration`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run test -- skillInstaller && bun run typecheck`
Expected: PASS — 4 names asserted, install-flow tests report length 4.

- [ ] **Step 6: Full task gate**

Run: `bun run test && bun run lint && bun run typecheck`
Expected: PASS — no regression elsewhere.

- [ ] **Step 7: Commit**

```bash
git add src/core/skillInstaller.ts src/test/unit/skillInstaller.test.ts src/extension.ts
git commit --no-verify -m "feat(scaffolding): install the fourth user-facing skill (orchestrate-board)

- TASKWRIGHT_SKILL_NAMES gains orchestrate-board (DRAFT-8); visual-proof and
  agent-browser stay excluded (internal proof/testing skills)
- setUpClaudeIntegration comment updated: three -> four
- tests: 4 names + explicit exclusion of visual-proof/agent-browser; all
  install-flow cases exercise the fourth skill

Co-Authored-By: <your model> <noreply@anthropic.com>
Completes <this task id>."
```

**Dependencies:** DRAFT-8 merged (the `orchestrate-board` skill directory must exist for a real install to copy it — see Prerequisites).

---

## Task 3: Opt-in project-local `.mcp.json` writer + shipped launcher

**Files:**

- Create: `src/core/mcpProjectConfig.ts`, `src/test/unit/mcpProjectConfig.test.ts`
- Modify: `src/extension.ts`, `.vscodeignore`, `package.json`

**Goal:** Today the MCP is only reachable after the user-scope CLI registration (`registerTaskwrightMcp`, `extension.ts:1767-1785`), which points at the extension bundle. Give a repo a **committable** per-project path: write a `.mcp.json` that launches the MCP via `scripts/taskwright-mcp.cjs` (the same committed, dependency-free launcher Taskwright's own repo-root `.mcp.json` uses — `.mcp.json:3-8`, `scripts/taskwright-mcp.cjs`) and copy that launcher into the repo. Gate it behind an opt-in setting (default off). The launcher resolves the **primary** checkout's built `dist/mcp/server.js` via `git rev-parse --git-common-dir` (`scripts/taskwright-mcp.cjs:33-38`) — this project-local path is the parity/dogfood surface for Taskwright checkouts and their worktrees, complementing the user-scope registration; that is the launcher's existing, unchanged behavior.

- [ ] **Step 1: Write the failing tests**

Create `src/test/unit/mcpProjectConfig.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { extractTaskwrightServer, upsertTaskwrightMcpServer } from '../../core/mcpProjectConfig';

// The exact shape the extension ships as its .mcp.json template (repo-root .mcp.json).
const TEMPLATE = JSON.stringify(
  {
    mcpServers: {
      taskwright: {
        type: 'stdio',
        command: 'node',
        args: ['scripts/taskwright-mcp.cjs'],
        env: {},
      },
      svelte: { type: 'http', url: 'https://mcp.svelte.dev/mcp' },
    },
  },
  null,
  2
);

const TASKWRIGHT_SERVER = {
  type: 'stdio',
  command: 'node',
  args: ['scripts/taskwright-mcp.cjs'],
  env: {},
};

describe('extractTaskwrightServer', () => {
  it('returns the taskwright server definition from a template', () => {
    expect(extractTaskwrightServer(TEMPLATE)).toEqual(TASKWRIGHT_SERVER);
  });

  it('throws when the template has no taskwright entry', () => {
    const noTaskwright = JSON.stringify({ mcpServers: { svelte: { type: 'http' } } });
    expect(() => extractTaskwrightServer(noTaskwright)).toThrow(/no "taskwright" server/);
  });

  it('throws on malformed JSON', () => {
    expect(() => extractTaskwrightServer('{ not json')).toThrow(/not valid JSON/);
  });
});

describe('upsertTaskwrightMcpServer', () => {
  it('creates a fresh .mcp.json from empty input, with a trailing newline', () => {
    const out = upsertTaskwrightMcpServer('', TASKWRIGHT_SERVER);
    expect(JSON.parse(out)).toEqual({ mcpServers: { taskwright: TASKWRIGHT_SERVER } });
    expect(out.endsWith('\n')).toBe(true);
  });

  it('preserves other servers and top-level keys', () => {
    const existing = JSON.stringify({
      $schema: 'https://example.com/mcp.json',
      mcpServers: { other: { type: 'stdio', command: 'x' } },
    });
    const out = JSON.parse(upsertTaskwrightMcpServer(existing, TASKWRIGHT_SERVER));
    expect(out.mcpServers.other).toEqual({ type: 'stdio', command: 'x' });
    expect(out.mcpServers.taskwright).toEqual(TASKWRIGHT_SERVER);
    expect(out.$schema).toBe('https://example.com/mcp.json');
  });

  it('updates a stale taskwright entry in place', () => {
    const stale = JSON.stringify({
      mcpServers: { taskwright: { type: 'stdio', command: 'OLD', args: [] } },
    });
    const out = JSON.parse(upsertTaskwrightMcpServer(stale, TASKWRIGHT_SERVER));
    expect(out.mcpServers.taskwright).toEqual(TASKWRIGHT_SERVER);
  });

  it('creates mcpServers when the existing file omits it', () => {
    const existing = JSON.stringify({ $schema: 'x' });
    const out = JSON.parse(upsertTaskwrightMcpServer(existing, TASKWRIGHT_SERVER));
    expect(out.mcpServers.taskwright).toEqual(TASKWRIGHT_SERVER);
  });

  it('is idempotent: re-running yields byte-identical output', () => {
    const once = upsertTaskwrightMcpServer('', TASKWRIGHT_SERVER);
    const twice = upsertTaskwrightMcpServer(once, TASKWRIGHT_SERVER);
    expect(twice).toBe(once);
  });

  it('round-trips the extracted server from the template', () => {
    const server = extractTaskwrightServer(TEMPLATE);
    const out = JSON.parse(upsertTaskwrightMcpServer('', server));
    expect(out.mcpServers.taskwright).toEqual(TASKWRIGHT_SERVER);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- mcpProjectConfig`
Expected: FAIL — `src/core/mcpProjectConfig` does not exist (module-not-found / import transform error).

- [ ] **Step 3: Write `src/core/mcpProjectConfig.ts`**

```ts
import { TASKWRIGHT_MCP_NAME } from './claudeMcp';

/**
 * Pure helpers for writing a project-local `.mcp.json` that registers the
 * Taskwright MCP server for any MCP client (Claude Code, etc.) opened in the
 * repo — the per-project counterpart to the user-scope CLI registration
 * (src/core/claudeMcp.ts). The server is launched via the committed,
 * dependency-free `scripts/taskwright-mcp.cjs` (copied into the repo alongside
 * this file), exactly as Taskwright's own repo-root `.mcp.json` does.
 *
 * String-in / string-out so the extension owns all fs I/O and these stay
 * unit-testable without a workspace. No vscode, no fs.
 */

/** The shape of a single MCP server definition in an `.mcp.json` file. */
export interface McpServerDef {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

interface McpJson {
  mcpServers?: Record<string, McpServerDef>;
  [key: string]: unknown;
}

/**
 * Extract the `taskwright` server definition from an `.mcp.json` template (the
 * extension's own shipped `.mcp.json`). Throws when the template is malformed or
 * has no `taskwright` entry — the caller surfaces the error.
 */
export function extractTaskwrightServer(templateJson: string): McpServerDef {
  let parsed: McpJson;
  try {
    parsed = JSON.parse(templateJson) as McpJson;
  } catch (error) {
    throw new Error(`.mcp.json template is not valid JSON: ${(error as Error).message}`);
  }
  const server = parsed.mcpServers?.[TASKWRIGHT_MCP_NAME];
  if (!server) {
    throw new Error(`.mcp.json template has no "${TASKWRIGHT_MCP_NAME}" server entry`);
  }
  return server;
}

/**
 * Insert or update the `taskwright` server in a project's `.mcp.json` body,
 * preserving any other configured servers and top-level keys. Empty/blank input
 * starts from `{}`. Returns pretty-printed JSON with a trailing newline.
 * Idempotent — re-running with the same server yields byte-identical output.
 */
export function upsertTaskwrightMcpServer(
  existingProjectJson: string,
  taskwrightServer: McpServerDef
): string {
  const obj: McpJson = existingProjectJson.trim()
    ? (JSON.parse(existingProjectJson) as McpJson)
    : {};
  if (!obj.mcpServers || typeof obj.mcpServers !== 'object') {
    obj.mcpServers = {};
  }
  obj.mcpServers[TASKWRIGHT_MCP_NAME] = taskwrightServer;
  return `${JSON.stringify(obj, null, 2)}\n`;
}
```

> `claudeMcp.ts` imports only `child_process`/`util` (Node builtins), never `vscode`, so this core stays vscode-free and Vitest-loadable (it is already a dependency of `AgentIntegrationDetector`, another core).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test -- mcpProjectConfig && bun run typecheck`
Expected: PASS — all extract/upsert cases green.

- [ ] **Step 5: Un-ignore the launcher + template for packaging (`.vscodeignore`)**

The launcher and template must be present in the packaged extension so `context.extensionPath/scripts/taskwright-mcp.cjs` and `context.extensionPath/.mcp.json` exist at runtime. `.vscodeignore` currently ignores both (`scripts/**` at line 17, `.mcp.json` at line 45). Re-read the file first — DRAFT-6 may already have added one of these negations; skip any line already present.

Replace (`.vscodeignore:16-19`):

```
eslint.config.mjs
scripts/**
vitest.config.ts
vite.webview.config.ts
```

with:

```
eslint.config.mjs
scripts/**
!scripts/taskwright-mcp.cjs
vitest.config.ts
vite.webview.config.ts
```

Replace (`.vscodeignore:44-45`):

```
core
.mcp.json
```

with:

```
core
.mcp.json
!.mcp.json
```

> `.vscodeignore` uses `.gitignore` semantics (vsce → the `ignore` npm package). `scripts/**` matches the files under `scripts/` (not the dir itself), so a later `!scripts/taskwright-mcp.cjs` re-includes exactly that one file while every other script stays ignored. `!.mcp.json` re-includes the repo-root template. After building, verify with `bunx @vscode/vsce ls | grep -E 'taskwright-mcp.cjs|\.mcp\.json'` in Task 4.

- [ ] **Step 6: Contribute the opt-in setting (`package.json`)**

In `package.json`, add the setting next to the other dispatch/sync settings. Find (`package.json`, the `taskwright.sync.installHooks` block):

```json
        "taskwright.sync.installHooks": {
          "type": "boolean",
          "default": false,
          "markdownDescription": "Opt-in: install Windows-safe `pre-push`/`post-merge` git hooks that automatically push/pull the board ref alongside your normal code push/pull. Off by default — the explicit Push/Pull Board commands always work without this."
        },
```

and insert the new setting immediately after it (before `"taskwright.dispatchTemplate"`):

```json
        "taskwright.sync.installHooks": {
          "type": "boolean",
          "default": false,
          "markdownDescription": "Opt-in: install Windows-safe `pre-push`/`post-merge` git hooks that automatically push/pull the board ref alongside your normal code push/pull. Off by default — the explicit Push/Pull Board commands always work without this."
        },
        "taskwright.setupWritesProjectMcpJson": {
          "type": "boolean",
          "default": false,
          "markdownDescription": "Opt-in: when running \"Set Up Claude Code Integration\", also write a project-local `.mcp.json` and copy `scripts/taskwright-mcp.cjs` into the repo, so a Claude Code session opened in this repo gets the Taskwright MCP without the user-scope CLI registration. Off by default. The launcher resolves the primary Taskwright checkout's built server, so this is intended for Taskwright checkouts and their worktrees."
        },
```

- [ ] **Step 7: Wire the opt-in `.mcp.json` step into `setUpClaudeIntegration`**

In `src/extension.ts`, add the core import. Insert after the `skillInstaller` import (`extension.ts:41`):

```ts
import { installTaskwrightSkills, type SkillInstallResult } from './core/skillInstaller';
```

so it reads:

```ts
import { installTaskwrightSkills, type SkillInstallResult } from './core/skillInstaller';
import { extractTaskwrightServer, upsertTaskwrightMcpServer } from './core/mcpProjectConfig';
```

Then add the `.mcp.json` step at the **end** of `setUpClaudeIntegration`, just before the closing `};`. Find the tail of the skills-install block (`extension.ts:1841-1844`):

```ts
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to install Taskwright skills: ${error}`);
    }
  };
```

and replace it with (same lines, then the new step inserted before `  };`):

```ts
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to install Taskwright skills: ${error}`);
    }

    // 4) Optionally wire a project-local .mcp.json so a session opened in this
    // repo gets the Taskwright MCP without the user-scope CLI registration.
    // Opt-in (taskwright.setupWritesProjectMcpJson, default false): upsert the
    // taskwright server into .mcp.json (preserving other servers) and copy the
    // committed, dependency-free launcher it references.
    if (getTaskwrightConfig<boolean>('setupWritesProjectMcpJson', false)) {
      try {
        const templatePath = path.join(context.extensionPath, '.mcp.json');
        const taskwrightServer = extractTaskwrightServer(fs.readFileSync(templatePath, 'utf-8'));

        const projectMcpPath = path.join(root, '.mcp.json');
        const existingMcp = fs.existsSync(projectMcpPath)
          ? fs.readFileSync(projectMcpPath, 'utf-8')
          : '';
        fs.writeFileSync(
          projectMcpPath,
          upsertTaskwrightMcpServer(existingMcp, taskwrightServer),
          'utf-8'
        );

        // Copy the launcher the .mcp.json references into <root>/scripts/.
        const launcherSrc = path.join(context.extensionPath, 'scripts', 'taskwright-mcp.cjs');
        const launcherDestDir = path.join(root, 'scripts');
        fs.mkdirSync(launcherDestDir, { recursive: true });
        fs.copyFileSync(launcherSrc, path.join(launcherDestDir, 'taskwright-mcp.cjs'));

        vscode.window.showInformationMessage(
          'Wrote project-local .mcp.json and scripts/taskwright-mcp.cjs for the Taskwright MCP server.'
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to write project-local .mcp.json: ${error}`);
      }
    }
  };
```

> `context` (the `activate` param), `root` (`extension.ts:1755`), `path`, `fs`, `vscode`, and `getTaskwrightConfig` (imported `extension.ts:42`) are all in scope. This step is off by default, so no existing test's behavior changes; it is covered by the pure-core tests + `typecheck` + the packaging check and dogfood in Task 4.

- [ ] **Step 8: Full task gate**

Run: `bun run test && bun run lint && bun run typecheck && bun run build`
Expected: PASS — new `mcpProjectConfig` suite green; `bun run build` confirms the extension bundle still compiles with the new imports.

- [ ] **Step 9: Commit**

```bash
git add src/core/mcpProjectConfig.ts src/test/unit/mcpProjectConfig.test.ts src/extension.ts .vscodeignore package.json
git commit --no-verify -m "feat(scaffolding): opt-in project-local .mcp.json + shipped launcher

- mcpProjectConfig.ts: pure extractTaskwrightServer (from the shipped template)
  + idempotent upsertTaskwrightMcpServer (preserves other servers/top-level keys)
- setUpClaudeIntegration step 4 (opt-in, taskwright.setupWritesProjectMcpJson):
  upsert .mcp.json + copy scripts/taskwright-mcp.cjs into the repo
- ship both in the VSIX: un-ignore scripts/taskwright-mcp.cjs and .mcp.json
- new setting contributed (default false)
- tests: extract (+throws), upsert create/preserve/in-place/idempotent/round-trip

Co-Authored-By: <your model> <noreply@anthropic.com>
Completes <this task id>."
```

**Dependencies:** DRAFT-6 merged (packaging un-ignore approach); no code dependency on Tasks 1/2.

---

## Task 4: Docs bullet + packaging verification + close

**Files:**

- Modify: `CLAUDE.md`

**Goal:** Record the broadened scaffolding in the project guide, verify the two runtime assets actually ship, and close the PR through the merge queue.

- [ ] **Step 1: Append the scaffolding bullet to `CLAUDE.md`**

In the "## Taskwright additions (see the project plan)" list, append a new bullet after the P6 bullet. Find the end of the P6 bullet (its final line):

```
  `docs/superpowers/plans/2026-07-04-tech-tree-p6-codebase-indexing-skill.md`.
```

and add a new bullet immediately after it:

```
- **Broadened Claude-integration scaffolding (5b)** ✅: `setUpClaudeIntegration`
  (`src/extension.ts`) now wires a fresh repo end-to-end. It injects the Taskwright
  convention into **AGENTS.md** too (`injectAgentsConvention` +
  `TASKWRIGHT_AGENTS_CONVENTION` in `src/core/agentConvention.ts`, same marked-block
  pattern as the CLAUDE.md block), installs **four** user-facing skills
  (`TASKWRIGHT_SKILL_NAMES` in `src/core/skillInstaller.ts`: create-task,
  execute-task, index-codebase, orchestrate-board — visual-proof/agent-browser stay
  internal), and — **opt-in** via `taskwright.setupWritesProjectMcpJson` (default
  off) — writes a project-local `.mcp.json` (pure `src/core/mcpProjectConfig.ts`:
  `extractTaskwrightServer` from the shipped template + idempotent
  `upsertTaskwrightMcpServer` preserving other servers) and copies the committed
  `scripts/taskwright-mcp.cjs` launcher into the repo. Both assets ship in the VSIX
  (`.vscodeignore` un-ignores `scripts/taskwright-mcp.cjs` and `.mcp.json`). The
  launcher resolves the primary checkout's built `dist/mcp/server.js` via
  `git rev-parse --git-common-dir`, so the project-local path targets Taskwright
  checkouts and their worktrees; user-scope registration remains the general path.
  Coverage: `src/test/unit/{agentConvention,skillInstaller,mcpProjectConfig}.test.ts`.
  Plan: `docs/superpowers/plans/2026-07-08-broaden-claude-integration-scaffolding.md`.
```

- [ ] **Step 2: Verify the packaged assets (packaging proof)**

Run: `bunx @vscode/vsce ls`
Expected: the listing includes both `scripts/taskwright-mcp.cjs` and `.mcp.json`. If either is missing, re-check the Task 3 `.vscodeignore` negations are placed AFTER their ignoring pattern (order matters for `!` negation). Optionally narrow the check:

```bash
bunx @vscode/vsce ls | grep -E 'taskwright-mcp\.cjs|^\.mcp\.json'
```

Expected output includes both paths.

- [ ] **Step 3: Manual dogfood of the setup command (optional but recommended)**

Since `setUpClaudeIntegration` has no unit-test harness, confirm end-to-end in the Extension Development Host: `bun run build`, press F5, run **"Taskwright: Set Up Claude Code Integration (MCP + CLAUDE.md)"** in a scratch folder that has a `backlog/`. Confirm: CLAUDE.md and AGENTS.md each gain one `<!-- TASKWRIGHT:BEGIN -->…END -->` block; the four skills report installed; with `taskwright.setupWritesProjectMcpJson` set to `true`, a `.mcp.json` with a `taskwright` server and a `scripts/taskwright-mcp.cjs` appear in the folder. Re-running the command is a no-op (idempotent).

- [ ] **Step 4: Final full gate**

Run: `bun run test && bun run lint && bun run typecheck && bun run build`
Expected: PASS — full unit suite green (minus the ~22 known Windows POSIX-path failures), lint/typecheck clean, extension + MCP bundles build.

- [ ] **Step 5: Commit the docs**

```bash
git add CLAUDE.md
git commit --no-verify -m "docs(scaffolding): record broadened Claude-integration scaffolding (5b)

- CLAUDE.md additions bullet: AGENTS.md injection, 4-skill install
  (orchestrate-board incl; visual-proof/agent-browser excluded), opt-in
  project-local .mcp.json + shipped taskwright-mcp.cjs launcher, packaging notes

Co-Authored-By: <your model> <noreply@anthropic.com>
Completes <this task id>."
```

- [ ] **Step 6: Close through the merge queue**

With the worktree clean and all gates green, call **`request_merge`** from inside the worktree and wait for it to return. Do NOT ff-merge or push from the repo root yourself.

**Dependencies:** Tasks 1–3 (documents their combined behavior; the packaging check depends on Task 3's `.vscodeignore` edits).

---

## Self-Review

- **Spec coverage (item 5b):** AGENTS.md convention-block injector reusing the `injectConvention`/`upsertMarkerBlock` pattern, called from `setUpClaudeIntegration` (Task 1) ✅; opt-in project-local `.mcp.json` writer + shipped/copied `scripts/taskwright-mcp.cjs`, both un-ignored for packaging, templated to launch via the launcher (Task 3) ✅; `orchestrate-board` added to `TASKWRIGHT_SKILL_NAMES` for a 4-skill install with visual-proof/agent-browser still excluded (Task 2) ✅. Exact diffs shown for every source and test edit.
- **TDD order:** every task writes/updates the failing test first, runs it to observe the exact failure, then adds the minimal implementation, re-runs to green, then commits — with concrete `bun run test -- <file>` commands and expected messages.
- **Locked contracts honored:** skills list is exactly `create-task, execute-task, index-codebase, orchestrate-board` (DRAFT-9 contract); `orchestrate-board` matches DRAFT-8's `.claude/skills/orchestrate-board/SKILL.md` directory name; reused constants `TASKWRIGHT_MARKERS` and `TASKWRIGHT_MCP_NAME` are referenced, not re-declared; new names (`TASKWRIGHT_AGENTS_CONVENTION`, `injectAgentsConvention`, `McpServerDef`, `extractTaskwrightServer`, `upsertTaskwrightMcpServer`, `taskwright.setupWritesProjectMcpJson`) are used consistently across their defining and consuming tasks.
- **Prerequisites stated:** DRAFT-6 (packaging) and DRAFT-8 (orchestrate-board skill) must be MERGED first; carve this worktree after they land so their code is present.
- **No placeholders:** every function body, test body, `.vscodeignore` negation, `package.json` setting, and CLAUDE.md bullet is shown in full — no "TBD", no "similar to above", no undefined type or function.
- **Type/name consistency:** `extractTaskwrightServer` returns `McpServerDef`, consumed by `upsertTaskwrightMcpServer(existing, McpServerDef)`; the extension passes the extracted server straight through; `getTaskwrightConfig<boolean>('setupWritesProjectMcpJson', false)` matches the contributed default. `injectAgentsConvention` mirrors `injectConvention`'s signature (`string → string`). No webview/Svelte/Playwright/CDP surface is touched, so those suites are regression-only.
