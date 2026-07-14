import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';

/**
 * TASK-128. This repo's `pre-commit` hook (`bunx lint-staged`) once corrupted the
 * ENTIRE working tree on Windows — a tree-wide CRLF→LF flip — so the standing
 * advice became "commit with `--no-verify`". That folklore is worse than the bug:
 * skipping the hook also skips the lint it exists to run, and every new agent had
 * to know the ritual or wreck the tree.
 *
 * The corruption needed a working tree whose line endings disagreed with what git
 * expected. The structural fix is in `.gitattributes`: `eol=lf` **overrides**
 * `core.autocrlf`, so every checkout materializes LF no matter how the developer's
 * git is configured — the disagreement can no longer exist. `core.autocrlf=false`
 * / `core.eol=lf` are only *local* git config (never committed, absent on a fresh
 * clone), so `.gitattributes` is the ONLY defense that travels with the repo.
 *
 * These tests pin that defense and the invariant it buys, so the hook can be
 * trusted and `--no-verify` retired:
 *   1. the EOL policy is coherent across .gitattributes / prettier / lint-staged;
 *   2. a real commit through the real lint-staged leaves every file it did not
 *      stage byte-identical — proven against a hostile `core.autocrlf=true` clone;
 *   3. no agent-facing doc teaches the `--no-verify` workaround any more.
 */

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');

// ---------------------------------------------------------------------------
// 1. EOL policy coherence (AC #2)
// ---------------------------------------------------------------------------

describe('EOL policy is coherent across the toolchain (TASK-128)', () => {
  it('.gitattributes forces LF checkout, overriding whatever core.autocrlf the dev has', () => {
    const rule = read('.gitattributes')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('*') && !l.startsWith('#'));

    expect(rule, '.gitattributes must carry a repo-wide `*` rule').toBeDefined();
    // `text=auto` normalizes to LF in the object store; `eol=lf` is what makes the
    // WORKING TREE LF too, overriding core.autocrlf=true. Dropping `eol=lf` brings
    // back the CRLF working tree that the hook used to smear across the repo.
    expect(rule).toContain('text=auto');
    expect(rule).toContain('eol=lf');
  });

  it('prettier emits the same line endings .gitattributes mandates', () => {
    const prettierrc = JSON.parse(read('.prettierrc')) as { endOfLine?: string };

    // Must be explicit and must be `lf`. `auto` merely PRESERVES whatever is on
    // disk: it can never heal a stray CRLF file and it makes `prettier --check`
    // green on files that violate the repo's own `eol=lf` policy — the formatter
    // abstaining rather than agreeing.
    expect(prettierrc.endOfLine).toBe('lf');
  });

  it('lint-staged only ever formats the files it was handed, never the whole tree', () => {
    const cfg = (JSON.parse(read('package.json')) as Record<string, unknown>)['lint-staged'] as
      | Record<string, string[]>
      | undefined;

    expect(cfg, 'package.json must configure lint-staged').toBeDefined();
    for (const [glob, commands] of Object.entries(cfg!)) {
      expect(glob.startsWith('*'), `lint-staged key "${glob}" must be a file glob`).toBe(true);
      for (const cmd of commands) {
        // lint-staged appends the staged paths, so a command must not also name a
        // target of its own. `prettier --write .` here would reformat the entire
        // repository on every commit — exactly the blast radius this task removes.
        expect(
          cmd.trim(),
          `lint-staged command "${cmd}" must not target the whole tree`
        ).not.toMatch(/\s\.$|\s\.\/|\s\*\*/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The invariant, proven end-to-end against a hostile clone (AC #1)
// ---------------------------------------------------------------------------

/**
 * Builds an origin repo carrying THIS repo's real `.gitattributes` / `.prettierrc`
 * / lint-staged config, then clones it with `core.autocrlf=true` — the Windows
 * default, and the condition under which the tree used to get flipped.
 */
describe('a commit through the real pre-commit hook cannot corrupt the tree (TASK-128)', () => {
  const lintStagedBin = path.join(repoRoot, 'node_modules', 'lint-staged', 'bin', 'lint-staged.js');
  const localBin = path.join(repoRoot, 'node_modules', '.bin');

  let tmp: string;
  let work: string;

  const git = (args: string[], cwd: string): string =>
    execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' });
  const sha = (f: string): string =>
    createHash('sha256')
      .update(fs.readFileSync(path.join(work, f)))
      .digest('hex');
  const hasCR = (f: string): boolean => fs.readFileSync(path.join(work, f)).includes(0x0d);

  // Files the commit never stages — the ones the old bug used to smear.
  const bystanders = ['untouched.md', 'untouched.json', 'untouched.css'];

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-eol-'));
    const origin = path.join(tmp, 'origin');
    work = path.join(tmp, 'work');
    fs.mkdirSync(origin);

    git(['init', '-b', 'main'], origin);
    git(['config', 'user.email', 'test@example.com'], origin);
    git(['config', 'user.name', 'Test'], origin);
    git(['config', 'core.autocrlf', 'false'], origin);

    // The REAL policy files — the test is worthless against copies that drift.
    fs.copyFileSync(path.join(repoRoot, '.gitattributes'), path.join(origin, '.gitattributes'));
    fs.copyFileSync(path.join(repoRoot, '.prettierrc'), path.join(origin, '.prettierrc'));
    const lintStaged = (JSON.parse(read('package.json')) as Record<string, unknown>)['lint-staged'];
    fs.writeFileSync(
      path.join(origin, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', 'lint-staged': lintStaged }, null, 2) +
        '\n'
    );

    const seed: Record<string, string> = {
      'staged.md': '# staged\n\nbody\n',
      'dirty.md': '# dirty\n\nbody\n',
      'untouched.md': '# untouched\n\nbody\n',
      'untouched.json': '{ "a": 1 }\n',
      'untouched.css': 'a {\n  color: red;\n}\n',
    };
    for (const [f, content] of Object.entries(seed))
      fs.writeFileSync(path.join(origin, f), content);
    git(['add', '-A'], origin);
    git(['commit', '-m', 'init', '--no-verify'], origin);

    // Clone as a Windows dev whose git wants CRLF working files.
    git(['clone', origin, work], tmp);
    git(['config', 'user.email', 'test@example.com'], work);
    git(['config', 'user.name', 'Test'], work);
    git(['config', 'core.autocrlf', 'true'], work);
    // Re-materialize the tree now that autocrlf=true is set, so the checkout is the
    // one a hostile clone would really get.
    for (const f of fs.readdirSync(work))
      if (f !== '.git') fs.rmSync(path.join(work, f), { recursive: true, force: true });
    git(['checkout', '--', '.'], work);
  });

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('checks out an LF working tree even though core.autocrlf=true', () => {
    // The load-bearing assertion: this is `eol=lf` doing its job. Drop it from
    // .gitattributes and these files come back CRLF (verified), which is the soil
    // the whole-tree flip grew in.
    expect(git(['config', 'core.autocrlf'], work).trim()).toBe('true');
    for (const f of bystanders)
      expect(hasCR(f), `${f} should be LF in the working tree`).toBe(false);
  });

  it('leaves unstaged and untouched files byte-identical across a hook-run commit', () => {
    // A badly-formatted staged file (so prettier really does rewrite something)…
    fs.writeFileSync(path.join(work, 'staged.md'), '#   staged\n\n\n\nreformat     me\n');
    git(['add', 'staged.md'], work);
    // …alongside a local edit that was deliberately NOT staged. lint-staged stashes
    // this; the stash/restore round-trip is what used to amplify into a tree flip.
    fs.appendFileSync(path.join(work, 'dirty.md'), 'unstaged local edit\n');

    const before = Object.fromEntries(bystanders.map((f) => [f, sha(f)]));

    // The real hook: the real lint-staged binary, the real config, then the commit.
    execFileSync(process.execPath, [lintStagedBin], {
      cwd: work,
      stdio: 'pipe',
      env: { ...process.env, PATH: `${localBin}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    git(['commit', '-m', 'change', '--no-verify'], work);

    for (const f of bystanders)
      expect(sha(f), `${f} was rewritten by a commit that never staged it`).toBe(before[f]);

    // The unstaged edit survives, and no bystander is left dirty.
    expect(fs.readFileSync(path.join(work, 'dirty.md'), 'utf-8')).toContain('unstaged local edit');
    const dirty = git(['status', '--porcelain'], work)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    expect(dirty).toEqual(['M dirty.md']);

    // And prettier really did run on the staged file (the hook did its job).
    expect(fs.readFileSync(path.join(work, 'staged.md'), 'utf-8')).toContain('# staged');
  });
});

// ---------------------------------------------------------------------------
// 3. The folklore is gone (AC #3)
// ---------------------------------------------------------------------------

describe('no agent-facing doc teaches the --no-verify workaround (TASK-128)', () => {
  /** Docs an agent actually reads for "how do I commit in this repo". */
  const docs = (): string[] => {
    const out: string[] = ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md'];
    const walk = (rel: string): void => {
      const abs = path.join(repoRoot, rel);
      if (!fs.existsSync(abs)) return;
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const child = path.posix.join(rel, e.name);
        if (e.isDirectory()) walk(child);
        else if (e.name.endsWith('.md')) out.push(child);
      }
    };
    walk('.claude/skills');
    walk('docs/superpowers/plans');
    walk('docs/superpowers/specs');
    return out.filter((f) => fs.existsSync(path.join(repoRoot, f)));
  };

  /**
   * The folklore always justified itself the same way: skip the hook BECAUSE it
   * flips the tree's line endings. That justification is what must never return.
   *
   * Deliberately narrow. `--no-verify` has legitimate uses in this repo that must
   * stay readable — the worktree-guard escape hatch ("bypass a single commit"),
   * and the board-sync hook passing it to avoid hook recursion. Matching bare
   * `--no-verify`, or merely co-occurring with the word CRLF, would flag those too.
   */
  const CRLF_JUSTIFICATION =
    /flips? the (whole|entire) tree|CRLF\s*(→|->|-)\s*LF|Windows CRLF hook|autocrlf corruption|hook can flip/i;

  it('never recommends --no-verify as a line-ending workaround', () => {
    const offenders: string[] = [];

    for (const doc of docs()) {
      const lines = read(doc).split('\n');
      lines.forEach((line, i) => {
        if (!line.includes('--no-verify')) return;
        if (CRLF_JUSTIFICATION.test(line)) offenders.push(`${doc}:${i + 1}: ${line.trim()}`);
      });
    }

    expect(
      offenders,
      `The pre-commit hook is line-ending-safe (see .gitattributes eol=lf + the fixture test\n` +
        `above). These docs still teach the retired --no-verify ritual:\n\n${offenders.join('\n')}\n`
    ).toEqual([]);
  });
});
