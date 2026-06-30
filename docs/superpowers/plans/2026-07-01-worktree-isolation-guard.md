# Worktree Isolation Guard (TASK-15 Component A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a parallel agent from committing a dispatched task branch in the shared primary working tree (the TASK-15 "escape" bug) via a hardened dispatch prompt plus a managed `pre-commit` git hook.

**Architecture:** A pure decision core (`worktreeGuard.ts`) decides block/allow from gathered git facts. A pure, husky-aware installer (`hookInstaller.ts`) writes an idempotent fenced block into the repo's `pre-commit` hook. A tiny bundled Node entrypoint (`src/hooks/worktree-guard.ts`) gathers the git facts at commit time and calls the core. Extension activation copies the bundle into the user repo's gitignored `.taskwright/hooks/` and installs/removes the fence per a new setting.

**Tech Stack:** TypeScript, esbuild (Node CJS bundles), Vitest, VS Code extension API, husky + lint-staged (already present).

## Global Constraints

- Node **≥ 22**, Bun for scripts/tests (`bunx vitest run …`, `bun run build`).
- All business logic lives in `src/core/` and must be **vscode-free** with injectable `fs`/`exec` (matches `WorktreeService.ts`); only `src/extension.ts` may import `vscode`.
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- Settings are namespaced `taskwright.*` under `contributes.configuration.properties` in `package.json`.
- The guard must **never block** commits on the integration branch (`main`), on undispatched branches, or inside a linked worktree — only a _dispatched task branch committed from the primary tree_.
- The guard must always be bypassable (`git commit --no-verify`) and removable (setting `false`).
- Cross-platform: normalize path separators (`replace(/\\/g, '/')`) in any path comparison; the repo's CI asserts POSIX paths.
- Commit messages reference the task and end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Commits run husky/lint-staged (prettier may reformat staged files — that is expected).

---

## File Structure

- `src/core/worktreeGuard.ts` (new) — pure block/allow decision + `.worktrees/` listing helper. No imports beyond `path`.
- `src/core/hookInstaller.ts` (new) — pure fence upsert/remove + husky-aware target resolution + install/uninstall over injectable fs.
- `src/hooks/worktree-guard.ts` (new) — thin Node entrypoint: gather git facts, call the core, exit 0/1.
- `scripts/build.ts` (modify) — add the `src/hooks/worktree-guard.ts` esbuild bundle.
- `package.json` (modify) — add `taskwright.enforceWorktreeIsolation` setting.
- `src/extension.ts` (modify) — copy bundled guard into `<repoRoot>/.taskwright/hooks/` and install/remove the hook per setting.
- `src/core/dispatchPrompt.ts` (modify) — add isolation guidance to `DEFAULT_DISPATCH_TEMPLATE`.
- `AGENTS.md` (modify) — document the worktree-isolation rule.
- Tests: `src/test/unit/worktreeGuard.test.ts`, `src/test/unit/hookInstaller.test.ts` (new); `src/test/unit/dispatchPrompt.test.ts` (modify if it asserts template text).

---

### Task 1: `worktreeGuard` decision core

**Files:**

- Create: `src/core/worktreeGuard.ts`
- Test: `src/test/unit/worktreeGuard.test.ts`

**Interfaces:**

- Produces: `isPrimaryTree(gitDir: string): boolean`; `shouldBlockCommit(ctx: GuardContext): GuardDecision`; `collectDispatchedBranches(primaryRoot: string, deps: WorktreeListDeps): string[]`; types `GuardContext { gitDir: string; branch: string | null; dispatchedBranches: string[] }`, `GuardDecision { block: boolean; message?: string }`, `WorktreeListDeps { listDirs: (dir: string) => string[] }`.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/worktreeGuard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  isPrimaryTree,
  shouldBlockCommit,
  collectDispatchedBranches,
} from '../../core/worktreeGuard';

describe('isPrimaryTree', () => {
  it('is true for the primary .git dir', () => {
    expect(isPrimaryTree('/repo/.git')).toBe(true);
    expect(isPrimaryTree('C:\\repo\\.git')).toBe(true);
  });
  it('is false for a linked worktree git dir', () => {
    expect(isPrimaryTree('/repo/.git/worktrees/task-7')).toBe(false);
    expect(isPrimaryTree('C:\\repo\\.git\\worktrees\\task-7')).toBe(false);
  });
});

describe('shouldBlockCommit', () => {
  const dispatched = ['task-7-login', 'task-9-prereq'];

  it('blocks a dispatched branch committed in the primary tree', () => {
    const d = shouldBlockCommit({
      gitDir: '/repo/.git',
      branch: 'task-7-login',
      dispatchedBranches: dispatched,
    });
    expect(d.block).toBe(true);
    expect(d.message).toContain('.worktrees/task-7-login');
    expect(d.message).toContain('--no-verify');
  });

  it('allows the same branch when committed inside its worktree', () => {
    expect(
      shouldBlockCommit({
        gitDir: '/repo/.git/worktrees/task-7-login',
        branch: 'task-7-login',
        dispatchedBranches: dispatched,
      }).block
    ).toBe(false);
  });

  it('allows the integration branch in the primary tree', () => {
    expect(
      shouldBlockCommit({ gitDir: '/repo/.git', branch: 'main', dispatchedBranches: dispatched })
        .block
    ).toBe(false);
  });

  it('allows an undispatched branch in the primary tree', () => {
    expect(
      shouldBlockCommit({ gitDir: '/repo/.git', branch: 'hotfix', dispatchedBranches: dispatched })
        .block
    ).toBe(false);
  });

  it('allows a detached HEAD (null branch)', () => {
    expect(
      shouldBlockCommit({ gitDir: '/repo/.git', branch: null, dispatchedBranches: dispatched })
        .block
    ).toBe(false);
  });
});

describe('collectDispatchedBranches', () => {
  it('returns the immediate subdirectory names of <root>/.worktrees', () => {
    const seen: string[] = [];
    const result = collectDispatchedBranches('/repo', {
      listDirs: (dir) => {
        seen.push(dir.replace(/\\/g, '/'));
        return ['task-7-login', 'task-9-prereq'];
      },
    });
    expect(seen[0]).toBe('/repo/.worktrees');
    expect(result).toEqual(['task-7-login', 'task-9-prereq']);
  });

  it('returns [] when there are no worktrees', () => {
    expect(collectDispatchedBranches('/repo', { listDirs: () => [] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/test/unit/worktreeGuard.test.ts`
Expected: FAIL — cannot resolve `../../core/worktreeGuard`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/worktreeGuard.ts`:

```ts
import * as path from 'path';

/** Git facts gathered at commit time, enough to decide whether to block. */
export interface GuardContext {
  /** `git rev-parse --git-dir`, resolved to an absolute path. */
  gitDir: string;
  /** Current branch (`git symbolic-ref --short HEAD`), or null when detached. */
  branch: string | null;
  /** Branch names that have a dispatched worktree under `.worktrees/`. */
  dispatchedBranches: string[];
}

export interface GuardDecision {
  block: boolean;
  /** Populated only when `block` is true. */
  message?: string;
}

/**
 * True when `gitDir` is the primary repository `.git` directory rather than a
 * linked worktree's git dir (`<primary>/.git/worktrees/<id>`).
 */
export function isPrimaryTree(gitDir: string): boolean {
  return !gitDir.replace(/\\/g, '/').includes('/.git/worktrees/');
}

/**
 * Block only the precise TASK-15 failure mode: committing a *dispatched task
 * branch* while standing in the *primary* working tree (an agent escaped its
 * worktree). Commits on the integration branch, on undispatched branches, or
 * inside a worktree all pass.
 */
export function shouldBlockCommit(ctx: GuardContext): GuardDecision {
  if (ctx.branch === null) return { block: false };
  if (!isPrimaryTree(ctx.gitDir)) return { block: false };
  if (!ctx.dispatchedBranches.includes(ctx.branch)) return { block: false };
  return {
    block: true,
    message:
      `Taskwright: branch "${ctx.branch}" is dispatched to .worktrees/${ctx.branch} — ` +
      `commit inside that worktree, not the primary tree. ` +
      `(To bypass this one commit: git commit --no-verify)`,
  };
}

/** Injectable directory listing for `collectDispatchedBranches`. */
export interface WorktreeListDeps {
  /** Immediate subdirectory names of `dir`, or [] when `dir` is absent. */
  listDirs: (dir: string) => string[];
}

/**
 * Dispatched task branches are exactly the immediate subdirectory names of
 * `<primaryRoot>/.worktrees/` (see WorktreeService.worktreePathFor).
 */
export function collectDispatchedBranches(primaryRoot: string, deps: WorktreeListDeps): string[] {
  return deps.listDirs(path.join(primaryRoot, '.worktrees'));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/test/unit/worktreeGuard.test.ts`
Expected: PASS (10 assertions across the describes).

- [ ] **Step 5: Commit**

```bash
git add src/core/worktreeGuard.ts src/test/unit/worktreeGuard.test.ts
git commit -m "Add worktreeGuard decision core (TASK-15)"
```

---

### Task 2: `hookInstaller` fence management

**Files:**

- Create: `src/core/hookInstaller.ts`
- Test: `src/test/unit/hookInstaller.test.ts`

**Interfaces:**

- Produces: constants `FENCE_START`, `FENCE_END`; `guardBlock(rel: string): string`; `upsertFence(existing: string, block: string): string`; `removeFence(existing: string): string`; `resolveHookTarget(repoRoot: string, deps: HookFsDeps): { manager: 'husky' | 'plain'; hookPath: string }`; `installGuard(repoRoot: string, guardScriptRelPath: string, deps: HookFsDeps): 'husky' | 'plain'`; `uninstallGuard(repoRoot: string, deps: HookFsDeps): void`; type `HookFsDeps { exists: (p: string) => boolean; read: (p: string) => string; write: (p: string, content: string) => void }`.
- Consumes: nothing from Task 1.

- [ ] **Step 1: Write the failing test**

Create `src/test/unit/hookInstaller.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  FENCE_START,
  FENCE_END,
  guardBlock,
  upsertFence,
  removeFence,
  resolveHookTarget,
  installGuard,
  uninstallGuard,
  HookFsDeps,
} from '../../core/hookInstaller';

const REL = '.taskwright/hooks/worktree-guard.js';

/** In-memory fs for deterministic tests. */
function memFs(seed: Record<string, string> = {}): HookFsDeps & { files: Record<string, string> } {
  const files = { ...seed };
  const norm = (p: string) => p.replace(/\\/g, '/');
  return {
    files,
    exists: (p) => norm(p) in files,
    read: (p) => files[norm(p)],
    write: (p, c) => {
      files[norm(p)] = c;
    },
  };
}

describe('guardBlock', () => {
  it('wraps an existence-guarded node invocation in the fence', () => {
    const b = guardBlock(REL);
    expect(b.startsWith(FENCE_START)).toBe(true);
    expect(b.trimEnd().endsWith(FENCE_END)).toBe(true);
    expect(b).toContain(`if [ -f "${REL}" ]; then node "${REL}" || exit 1; fi`);
  });
});

describe('upsertFence', () => {
  it('appends the block to an empty file', () => {
    expect(upsertFence('', guardBlock(REL))).toBe(guardBlock(REL) + '\n');
  });

  it('appends after existing content with a separating newline', () => {
    const out = upsertFence('#!/bin/sh\nnpx lint-staged\n', guardBlock(REL));
    expect(out).toContain('npx lint-staged');
    expect(out).toContain(FENCE_START);
    expect(out.indexOf('lint-staged')).toBeLessThan(out.indexOf(FENCE_START));
  });

  it('replaces an existing fence in place (idempotent, no duplicate)', () => {
    const once = upsertFence('#!/bin/sh\n', guardBlock(REL));
    const twice = upsertFence(once, guardBlock(REL));
    expect(twice).toBe(once);
    expect(twice.match(new RegExp(FENCE_START.replace(/[>]/g, '\\$&'), 'g'))!.length).toBe(1);
  });
});

describe('removeFence', () => {
  it('strips the fence and leaves surrounding content', () => {
    const withFence = upsertFence('#!/bin/sh\nnpx lint-staged\n', guardBlock(REL));
    const out = removeFence(withFence);
    expect(out).toContain('npx lint-staged');
    expect(out).not.toContain(FENCE_START);
  });

  it('is a no-op when no fence is present', () => {
    expect(removeFence('#!/bin/sh\n')).toBe('#!/bin/sh\n');
  });
});

describe('resolveHookTarget', () => {
  it('targets .husky/pre-commit when it exists', () => {
    const fs = memFs({ '/repo/.husky/pre-commit': '#!/bin/sh\n' });
    const t = resolveHookTarget('/repo', fs);
    expect(t.manager).toBe('husky');
    expect(t.hookPath.replace(/\\/g, '/')).toBe('/repo/.husky/pre-commit');
  });

  it('falls back to .git/hooks/pre-commit otherwise', () => {
    const t = resolveHookTarget('/repo', memFs());
    expect(t.manager).toBe('plain');
    expect(t.hookPath.replace(/\\/g, '/')).toBe('/repo/.git/hooks/pre-commit');
  });
});

describe('installGuard / uninstallGuard', () => {
  it('appends the fence to an existing husky hook and is idempotent', () => {
    const fs = memFs({ '/repo/.husky/pre-commit': '#!/bin/sh\nnpx lint-staged\n' });
    expect(installGuard('/repo', REL, fs)).toBe('husky');
    const after = fs.files['/repo/.husky/pre-commit'];
    expect(after).toContain('npx lint-staged');
    expect(after).toContain(FENCE_START);
    installGuard('/repo', REL, fs);
    expect(fs.files['/repo/.husky/pre-commit'].match(/taskwright worktree guard/g)!.length).toBe(2); // start+end only
  });

  it('seeds a shebang for a brand-new plain hook', () => {
    const fs = memFs();
    expect(installGuard('/repo', REL, fs)).toBe('plain');
    const body = fs.files['/repo/.git/hooks/pre-commit'];
    expect(body.startsWith('#!/bin/sh')).toBe(true);
    expect(body).toContain(FENCE_START);
  });

  it('uninstall removes the fence and leaves the rest', () => {
    const fs = memFs({ '/repo/.husky/pre-commit': '#!/bin/sh\nnpx lint-staged\n' });
    installGuard('/repo', REL, fs);
    uninstallGuard('/repo', fs);
    expect(fs.files['/repo/.husky/pre-commit']).toContain('npx lint-staged');
    expect(fs.files['/repo/.husky/pre-commit']).not.toContain(FENCE_START);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/test/unit/hookInstaller.test.ts`
Expected: FAIL — cannot resolve `../../core/hookInstaller`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/hookInstaller.ts`:

```ts
import * as path from 'path';

export const FENCE_START = '# >>> taskwright worktree guard >>>';
export const FENCE_END = '# <<< taskwright worktree guard <<<';
const PLAIN_SHEBANG = '#!/bin/sh\n';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FENCE_RE = new RegExp(`${escapeRe(FENCE_START)}[\\s\\S]*?${escapeRe(FENCE_END)}`);
const FENCE_RE_TRAILING_NL = new RegExp(
  `${escapeRe(FENCE_START)}[\\s\\S]*?${escapeRe(FENCE_END)}\\n?`
);

/**
 * The fenced block invoking the bundled guard. Existence-guarded so a linked
 * worktree (whose cwd has no `.taskwright/hooks/` script) skips silently — the
 * guard only ever needs to act in the primary tree.
 */
export function guardBlock(guardScriptRelPath: string): string {
  const rel = guardScriptRelPath.replace(/\\/g, '/');
  return [FENCE_START, `if [ -f "${rel}" ]; then node "${rel}" || exit 1; fi`, FENCE_END].join(
    '\n'
  );
}

/** Insert the fenced block, or replace it in place when a fence already exists. */
export function upsertFence(existing: string, block: string): string {
  if (FENCE_RE.test(existing)) return existing.replace(FENCE_RE, block);
  const base = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  return `${base}${block}\n`;
}

/** Remove the fenced block (and a single trailing newline) when present. */
export function removeFence(existing: string): string {
  return existing.replace(FENCE_RE_TRAILING_NL, '');
}

export interface HookFsDeps {
  exists: (p: string) => boolean;
  read: (p: string) => string;
  write: (p: string, content: string) => void;
}

/** Where the guard hook lives, husky-aware. */
export function resolveHookTarget(
  repoRoot: string,
  deps: HookFsDeps
): { manager: 'husky' | 'plain'; hookPath: string } {
  const husky = path.join(repoRoot, '.husky', 'pre-commit');
  if (deps.exists(husky)) return { manager: 'husky', hookPath: husky };
  return { manager: 'plain', hookPath: path.join(repoRoot, '.git', 'hooks', 'pre-commit') };
}

/** Idempotently install the guard fence into the appropriate pre-commit hook. */
export function installGuard(
  repoRoot: string,
  guardScriptRelPath: string,
  deps: HookFsDeps
): 'husky' | 'plain' {
  const { manager, hookPath } = resolveHookTarget(repoRoot, deps);
  const current = deps.exists(hookPath)
    ? deps.read(hookPath)
    : manager === 'plain'
      ? PLAIN_SHEBANG
      : '';
  deps.write(hookPath, upsertFence(current, guardBlock(guardScriptRelPath)));
  return manager;
}

/** Remove the guard fence; leaves the rest of the hook intact. */
export function uninstallGuard(repoRoot: string, deps: HookFsDeps): void {
  const { hookPath } = resolveHookTarget(repoRoot, deps);
  if (!deps.exists(hookPath)) return;
  deps.write(hookPath, removeFence(deps.read(hookPath)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/test/unit/hookInstaller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/hookInstaller.ts src/test/unit/hookInstaller.test.ts
git commit -m "Add husky-aware pre-commit hook installer (TASK-15)"
```

---

### Task 3: Bundled guard entrypoint + esbuild wiring

**Files:**

- Create: `src/hooks/worktree-guard.ts`
- Modify: `scripts/build.ts` (add a bundle entry to the `builds` array)

**Interfaces:**

- Consumes: `shouldBlockCommit`, `collectDispatchedBranches` from `src/core/worktreeGuard` (Task 1).
- Produces: `dist/hooks/worktree-guard.js` (a standalone CJS script; exit 1 to block a commit, 0 to allow).

- [ ] **Step 1: Create the entrypoint**

Create `src/hooks/worktree-guard.ts`:

```ts
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { shouldBlockCommit, collectDispatchedBranches } from '../core/worktreeGuard';

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function main(): void {
  let gitDir: string;
  let commonDir: string;
  let branch: string | null;
  try {
    gitDir = path.resolve(git(['rev-parse', '--git-dir']));
    commonDir = path.resolve(git(['rev-parse', '--git-common-dir']));
    try {
      branch = git(['symbolic-ref', '--short', 'HEAD']);
    } catch {
      branch = null; // detached HEAD
    }
  } catch {
    process.exit(0); // not a git repo — never block
  }
  const primaryRoot = path.dirname(commonDir);
  const dispatchedBranches = collectDispatchedBranches(primaryRoot, { listDirs });
  const decision = shouldBlockCommit({ gitDir, branch, dispatchedBranches });
  if (decision.block) {
    process.stderr.write(`\n${decision.message}\n\n`);
    process.exit(1);
  }
  process.exit(0);
}

main();
```

- [ ] **Step 2: Add the esbuild bundle**

In `scripts/build.ts`, add this object to the `builds` array (after the MCP server entry):

```ts
  {
    // Pre-commit worktree-isolation guard — a tiny standalone Node script the
    // git hook runs. Reuses the vscode-free worktreeGuard core.
    entryPoints: ['src/hooks/worktree-guard.ts'],
    outfile: 'dist/hooks/worktree-guard.js',
    external: ['vscode'],
  },
```

- [ ] **Step 3: Build and verify the bundle exists**

Run: `bun run build`
Expected: log line `[esbuild] Build succeeded: dist/hooks/worktree-guard.js`, and `dist/hooks/worktree-guard.js` exists.

- [ ] **Step 4: Smoke-test the guard against this repo**

Run (allow case — on `main`, no dispatched worktrees):

```bash
node dist/hooks/worktree-guard.js; echo "exit=$?"
```

Expected: `exit=0`.

Run (block case — simulate a dispatched branch):

```bash
git branch task-smoke-guard 2>/dev/null; mkdir -p .worktrees/task-smoke-guard
git switch task-smoke-guard
node dist/hooks/worktree-guard.js; echo "exit=$?"
git switch -; git branch -D task-smoke-guard; rmdir .worktrees/task-smoke-guard
```

Expected: the middle `node …` prints the block message to stderr and `exit=1`; the surrounding switches restore `main` and clean up.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/worktree-guard.ts scripts/build.ts
git commit -m "Bundle the worktree-guard pre-commit entrypoint (TASK-15)"
```

---

### Task 4: Activation wiring + `enforceWorktreeIsolation` setting

**Files:**

- Modify: `package.json` (add the setting under `contributes.configuration.properties`, after `taskwright.intakeTemplate`)
- Modify: `src/extension.ts` (copy the bundled guard into the repo and sync the hook)

**Interfaces:**

- Consumes: `installGuard`, `uninstallGuard`, `HookFsDeps` from `src/core/hookInstaller` (Task 2); `getTaskwrightConfig` from `src/config`; `dist/hooks/worktree-guard.js` shipped in the extension (Task 3).
- Produces: a `.taskwright/hooks/worktree-guard.js` copy in the active repo and a managed `pre-commit` fence, toggled by `taskwright.enforceWorktreeIsolation`.

- [ ] **Step 1: Add the setting to `package.json`**

In `contributes.configuration.properties`, add after the `taskwright.intakeTemplate` block:

```json
        "taskwright.enforceWorktreeIsolation": {
          "type": "boolean",
          "default": true,
          "markdownDescription": "Install a managed `pre-commit` git hook that blocks committing a dispatched task branch from the primary working tree — the failure mode where a parallel agent escapes its `.worktrees/<branch>` and clobbers a sibling branch. Bypass a single commit with `git commit --no-verify`. Set to `false` to remove the hook."
        }
```

(Add a comma after the preceding `}` so the JSON stays valid.)

- [ ] **Step 2: Add the sync helper to `src/extension.ts`**

Near the existing imports at the top of `src/extension.ts`, add:

```ts
import * as fs from 'fs';
import * as nodePath from 'path';
import { installGuard, uninstallGuard, HookFsDeps } from './core/hookInstaller';
```

(If `getTaskwrightConfig` is not already imported, add `import { getTaskwrightConfig } from './config';`.)

Then add this module-level helper (above `export function activate`):

```ts
const GUARD_REL = '.taskwright/hooks/worktree-guard.js';

const guardFs: HookFsDeps = {
  exists: fs.existsSync,
  read: (p) => fs.readFileSync(p, 'utf8'),
  write: (p, c) => {
    fs.mkdirSync(nodePath.dirname(p), { recursive: true });
    fs.writeFileSync(p, c);
  },
};

/**
 * Install or remove the worktree-isolation pre-commit guard for `repoRoot`,
 * per the `taskwright.enforceWorktreeIsolation` setting. When enabling, copy the
 * extension's bundled guard into the repo's gitignored `.taskwright/hooks/` so
 * the hook references a stable in-repo path.
 */
function syncWorktreeGuard(repoRoot: string, extensionUri: vscode.Uri): void {
  try {
    if (!getTaskwrightConfig<boolean>('enforceWorktreeIsolation', true)) {
      uninstallGuard(repoRoot, guardFs);
      return;
    }
    const bundled = nodePath.join(extensionUri.fsPath, 'dist', 'hooks', 'worktree-guard.js');
    if (!fs.existsSync(bundled)) return; // dev build without the bundle yet
    const dest = nodePath.join(repoRoot, GUARD_REL);
    fs.mkdirSync(nodePath.dirname(dest), { recursive: true });
    fs.copyFileSync(bundled, dest);
    const manager = installGuard(repoRoot, GUARD_REL, guardFs);
    if (manager === 'plain') {
      try {
        fs.chmodSync(nodePath.join(repoRoot, '.git', 'hooks', 'pre-commit'), 0o755);
      } catch {
        /* chmod is a no-op / unsupported on Windows */
      }
    }
  } catch (e) {
    console.warn('[Taskwright] Worktree guard sync failed:', e);
  }
}
```

- [ ] **Step 3: Call the helper in `activate`**

In `activate`, just after `workspaceRootPath` is set and used for `setWorkspaceRoot` (around the `if (workspaceRootPath) { tasksHosts.forEach(...) }` block), add:

```ts
if (workspaceRootPath) {
  syncWorktreeGuard(workspaceRootPath, context.extensionUri);
}
```

- [ ] **Step 4: Build, typecheck, and verify end-to-end in this repo**

Run: `bun run build && bun run typecheck`
Expected: both succeed.

Manual check (Extension Development Host): press F5, open this repo, then in a terminal:

```bash
grep -c "taskwright worktree guard" .husky/pre-commit   # expect 2 (start+end fence lines)
test -f .taskwright/hooks/worktree-guard.js && echo "guard copied"
```

Expected: `2` and `guard copied`. Then set `taskwright.enforceWorktreeIsolation` to `false`, reload the window, and re-run the `grep` — expect `0`.

- [ ] **Step 5: Commit**

```bash
git add package.json src/extension.ts
git commit -m "Install/remove the worktree guard on activation (TASK-15)"
```

---

### Task 5: Soft guidance — dispatch prompt + AGENTS.md

**Files:**

- Modify: `src/core/dispatchPrompt.ts` (`DEFAULT_DISPATCH_TEMPLATE`)
- Modify: `AGENTS.md`
- Test: `src/test/unit/dispatchPrompt.test.ts` (add an assertion; create the file only if it does not already exist)

**Interfaces:**

- Consumes/Produces: none beyond the existing `DEFAULT_DISPATCH_TEMPLATE` export.

> Note: do **not** mention `request_merge` here — that tool arrives in Component B. This task only adds the stay-in-your-worktree guidance.

- [ ] **Step 1: Write/extend the failing test**

If `src/test/unit/dispatchPrompt.test.ts` exists, add this test; otherwise create the file with it:

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_DISPATCH_TEMPLATE } from '../../core/dispatchPrompt';

describe('DEFAULT_DISPATCH_TEMPLATE worktree isolation', () => {
  it('tells the session to cd into and stay in its worktree', () => {
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('.worktrees/{{worktree}}');
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('cd into it');
    expect(DEFAULT_DISPATCH_TEMPLATE).toContain('repository root');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/test/unit/dispatchPrompt.test.ts`
Expected: FAIL — the template does not yet contain `.worktrees/{{worktree}}`.

- [ ] **Step 3: Add the isolation preamble to the template**

In `src/core/dispatchPrompt.ts`, change the first line of `DEFAULT_DISPATCH_TEMPLATE` from:

```ts
export const DEFAULT_DISPATCH_TEMPLATE = `You are a fresh Claude Code session assigned exactly one task. Work only on this task — do not touch unrelated code or other tasks.
```

to:

```ts
export const DEFAULT_DISPATCH_TEMPLATE = `You are a fresh Claude Code session assigned exactly one task. Work only on this task — do not touch unrelated code or other tasks.

Your isolated worktree is .worktrees/{{worktree}}. cd into it first and run every git, file, and test command there. Do NOT git checkout, commit, or merge in the repository root — that tree is shared with other agents and committing there corrupts their branches.
```

(Leave the rest of the template unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/test/unit/dispatchPrompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Update AGENTS.md**

In `AGENTS.md`, under the `## Task workflow (Taskwright MCP)` section (inside the `<CRITICAL_INSTRUCTION>` block), add a new numbered point after step 1 (`get_active_task`) — renumber following steps:

```markdown
2. **Stay in your worktree.** Your task runs in `.worktrees/<branch>`. `cd` there
   first and run all git/file/test commands inside it. Never `git checkout`,
   `commit`, or `merge` in the repository root — it is shared with other agents,
   and a managed `pre-commit` hook will block such commits.
```

- [ ] **Step 6: Verify the full suite and commit**

Run: `bun run test && bun run lint && bun run typecheck`
Expected: all pass (no regression from the template change).

```bash
git add src/core/dispatchPrompt.ts src/test/unit/dispatchPrompt.test.ts AGENTS.md
git commit -m "Harden dispatch prompt + AGENTS.md for worktree isolation (TASK-15)"
```

---

## Self-Review

**Spec coverage (spec §4 — Component A):**

- §4.1 soft guidance (template + AGENTS.md + dispatchOpenTerminal recommendation) → Task 5 (template + AGENTS.md). The `dispatchOpenTerminal` recommendation is documentation-only and is covered by the AGENTS.md note context; no code needed.
- §4.2 hard guard predicate (`worktreeGuard`, primary-tree + dispatched-branch logic, message, bypass) → Task 1.
- §4.3 hook installation (husky-aware fence, bundled entrypoint, copy into `.taskwright/hooks/`, existence-guarded fence, activation gate, uninstall on `false`) → Tasks 2, 3, 4.
- `post-checkout` warn hook (spec §4.2 final paragraph): **intentionally deferred** — the `pre-commit` block is the load-bearing guard; the advisory `post-checkout` warning is a nice-to-have and is out of scope for this plan to keep it tight. Tracked as a follow-up note on TASK-15.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; no "similar to Task N".

**Type consistency:** `HookFsDeps`, `GuardContext`, `GuardDecision`, `WorktreeListDeps` are defined in Tasks 1–2 and consumed with matching shapes in Tasks 3–4. `GUARD_REL` (`.taskwright/hooks/worktree-guard.js`) is the single path used by `guardBlock`, the copy step, and `installGuard`. `installGuard` returns `'husky' | 'plain'`, matched by the `manager === 'plain'` chmod branch in Task 4.

**Out-of-scope (later components):** the `request_merge` closing instruction in the dispatch prompt and the merge-queue/board-status work are Components B and C, planned separately.
