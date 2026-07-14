import * as path from 'path';
import type { QueueFsDeps } from './mergeQueue';

/**
 * Verify-command doctor (TASK-86): inspect a repo's files to detect what kind
 * of project it is, prove which configured merge-verify commands CANNOT run
 * (e.g. Backlog default `bun run lint` in a Python repo with no package.json,
 * or a `bun run X` whose script does not exist), and suggest replacements
 * (e.g. `uv run pytest -q` for a uv-managed Python repo).
 *
 * Pure core: fs access goes through the injected `Pick<QueueFsDeps, 'exists'|'read'>`.
 * Diagnosis is strictly evidence-based — a command is only flagged when the
 * repo's files PROVE it cannot run (missing package.json / missing script).
 * Anything unprovable is left alone: the doctor must never cry wolf.
 */

export type RepoKind = 'node' | 'python' | 'rust' | 'go' | 'unknown';
export type NodePackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm';

export interface RepoProfile {
  kind: RepoKind;
  /** Node repos: the package manager inferred from the lockfile (default npm). */
  packageManager?: NodePackageManager;
  /**
   * True when a LOCKFILE proved `packageManager`. False means it was defaulted to
   * npm with no evidence — in which case a runner difference proves nothing and
   * must never be reported (see {@link diagnoseVerifyCommands}).
   */
  packageManagerProven?: boolean;
  /** Node repos: script names found in package.json (empty when unreadable). */
  scripts: string[];
  /** Python repos: true when uv manages the project (uv.lock or [tool.uv]). */
  usesUv?: boolean;
}

export interface VerifyCommandFinding {
  command: string;
  /** False only when the repo's files PROVE the command cannot run at all. */
  ok: boolean;
  /** Present when ok=false or mismatch=true: what the repo's files say. */
  reason?: string;
  /**
   * True when the command CAN run (its script exists) but invokes a package
   * manager other than the one this repo's lockfile proves it uses — the shape
   * the bun-flavored DEFAULTS take in a pnpm/npm/yarn repo (TASK-132). Weaker
   * evidence than `ok: false`, so it is tracked separately and never conflated.
   */
  mismatch?: boolean;
}

export interface VerifyDoctorReport {
  profile: RepoProfile;
  findings: VerifyCommandFinding[];
  /** The subset of findings with ok=false: provably cannot run here. */
  broken: VerifyCommandFinding[];
  /** The subset that runs but uses the wrong package manager for this repo. */
  mismatched: VerifyCommandFinding[];
  /** True when nothing needs attention — no broken commands AND no mismatches. */
  ok: boolean;
  /** Replacement commands for this repo (empty when none can be inferred). */
  suggestions: string[];
}

type DoctorFs = Pick<QueueFsDeps, 'exists' | 'read'>;

function readIfExists(root: string, name: string, fs: DoctorFs): string | undefined {
  const p = path.join(root, name);
  if (!fs.exists(p)) return undefined;
  try {
    return fs.read(p);
  } catch {
    return undefined;
  }
}

function has(root: string, name: string, fs: DoctorFs): boolean {
  return fs.exists(path.join(root, name));
}

/** Inspect the repo root's marker files and classify the project. */
export function detectRepoProfile(root: string, fs: DoctorFs): RepoProfile {
  // Node first: script-runner commands are the ones we can prove things about,
  // and a mixed repo with a package.json can run them.
  if (has(root, 'package.json', fs)) {
    let scripts: string[] = [];
    const raw = readIfExists(root, 'package.json', fs);
    if (raw !== undefined) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const s = (parsed as Record<string, unknown>).scripts;
          if (s !== null && typeof s === 'object' && !Array.isArray(s)) {
            scripts = Object.keys(s as Record<string, unknown>);
          }
        }
      } catch {
        // corrupt package.json — still a node repo, but no provable scripts
      }
    }
    const lockfilePm: NodePackageManager | undefined =
      has(root, 'bun.lockb', fs) || has(root, 'bun.lock', fs)
        ? 'bun'
        : has(root, 'pnpm-lock.yaml', fs)
          ? 'pnpm'
          : has(root, 'yarn.lock', fs)
            ? 'yarn'
            : has(root, 'package-lock.json', fs)
              ? 'npm'
              : undefined;
    return {
      kind: 'node',
      // Unchanged default: no lockfile ⇒ npm. But record that it was a GUESS, so
      // the mismatch check below cannot build an accusation on top of it.
      packageManager: lockfilePm ?? 'npm',
      packageManagerProven: lockfilePm !== undefined,
      scripts,
    };
  }

  const pythonMarkers = [
    'pyproject.toml',
    'pytest.ini',
    'setup.py',
    'setup.cfg',
    'requirements.txt',
    'tox.ini',
    'uv.lock',
  ];
  if (pythonMarkers.some((m) => has(root, m, fs))) {
    const pyproject = readIfExists(root, 'pyproject.toml', fs) ?? '';
    const usesUv = has(root, 'uv.lock', fs) || pyproject.includes('[tool.uv');
    return { kind: 'python', scripts: [], usesUv };
  }

  if (has(root, 'Cargo.toml', fs)) return { kind: 'rust', scripts: [] };
  if (has(root, 'go.mod', fs)) return { kind: 'go', scripts: [] };
  return { kind: 'unknown', scripts: [] };
}

const SCRIPT_RUNNERS: NodePackageManager[] = ['bun', 'npm', 'pnpm', 'yarn'];

/** The lockfile that proves each package manager — quoted as the evidence in a mismatch reason. */
const LOCKFILE_OF: Record<NodePackageManager, string> = {
  bun: 'bun.lock',
  pnpm: 'pnpm-lock.yaml',
  yarn: 'yarn.lock',
  npm: 'package-lock.json',
};

interface ScriptRunnerCall {
  runner: NodePackageManager;
  script: string;
}

/**
 * Parse a script-runner invocation: `bun|npm|pnpm|yarn run <script>` plus
 * `npm test` (an alias for `npm run test`). Returns the runner and the script
 * name, or undefined when the command is not a provable script-runner call.
 * (`bun test` is bun's built-in test runner, not a script lookup — skipped.)
 */
function scriptRunnerCall(command: string): ScriptRunnerCall | undefined {
  const tokens = command.trim().split(/\s+/);
  const [runner, sub, script] = tokens;
  if (!runner) return undefined;
  if (!(SCRIPT_RUNNERS as string[]).includes(runner)) return undefined;
  const pm = runner as NodePackageManager;
  if (sub === 'run' && script) return { runner: pm, script };
  if (pm === 'npm' && (sub === 'test' || sub === 't')) return { runner: pm, script: 'test' };
  return undefined;
}

/**
 * Diagnose each configured command against the repo's files. Two strictly
 * separate severities, both evidence-based:
 *
 *  - `ok: false` — the repo PROVES the command cannot run (no package.json for a
 *    script runner; no such script in package.json).
 *  - `mismatch: true` — the command runs, but drives a package manager the repo's
 *    LOCKFILE says it does not use. This is the silent case TASK-132 exists for:
 *    the bun-flavored defaults in a pnpm/npm/yarn repo are not "broken" by the
 *    proof above, so nothing ever flagged them and the gate quietly depended on a
 *    package manager that may not even be installed on the machine running it.
 *
 * Everything else passes. A package manager that was merely DEFAULTED (no lockfile)
 * is not evidence, so it never yields a mismatch — the doctor must not cry wolf.
 */
export function diagnoseVerifyCommands(
  commands: string[],
  profile: RepoProfile
): VerifyCommandFinding[] {
  return commands.map((command) => {
    const call = scriptRunnerCall(command);
    if (call === undefined) return { command, ok: true };
    if (profile.kind !== 'node') {
      return {
        command,
        ok: false,
        reason: `no package.json in this repo, so \`${command}\` cannot run`,
      };
    }
    if (!profile.scripts.includes(call.script)) {
      return {
        command,
        ok: false,
        reason: `package.json has no "${call.script}" script`,
      };
    }
    const pm = profile.packageManager;
    if (profile.packageManagerProven === true && pm !== undefined && call.runner !== pm) {
      return {
        command,
        ok: true,
        mismatch: true,
        reason: `this repo is ${pm}-managed (${LOCKFILE_OF[pm]}), but \`${command}\` runs ${call.runner}`,
      };
    }
    return { command, ok: true };
  });
}

/** The verify scripts worth wiring when they exist, in gate order. */
const PREFERRED_NODE_SCRIPTS = ['test', 'lint', 'typecheck'];

/** Suggest verify commands that CAN run in this repo (empty when unknowable). */
export function suggestVerifyCommands(profile: RepoProfile): string[] {
  switch (profile.kind) {
    case 'node': {
      const runner = profile.packageManager ?? 'npm';
      return PREFERRED_NODE_SCRIPTS.filter((s) => profile.scripts.includes(s)).map(
        (s) => `${runner} run ${s}`
      );
    }
    case 'python':
      return profile.usesUv ? ['uv run pytest -q'] : ['pytest -q'];
    case 'rust':
      return ['cargo test'];
    case 'go':
      return ['go test ./...'];
    default:
      return [];
  }
}

/** Detect + diagnose + suggest in one pass. */
export function runVerifyDoctor(options: {
  root: string;
  commands: string[];
  fs: DoctorFs;
}): VerifyDoctorReport {
  const profile = detectRepoProfile(options.root, options.fs);
  const findings = diagnoseVerifyCommands(options.commands, profile);
  const broken = findings.filter((f) => !f.ok);
  const mismatched = findings.filter((f) => f.ok && f.mismatch === true);
  return {
    profile,
    findings,
    broken,
    mismatched,
    ok: broken.length === 0 && mismatched.length === 0,
    suggestions: suggestVerifyCommands(profile),
  };
}

/**
 * A stable fingerprint of the SITUATION a report describes: the repo's shape, the
 * commands that were checked, and what the doctor would suggest instead. It keys
 * the prompt-once memory (verifyDoctorState.ts), so:
 *
 *  - re-running the doctor on unchanged state yields the same key ⇒ a decision
 *    recorded once is respected forever (no nagging);
 *  - changing the commands, or changing the repo so the advice changes, yields a
 *    NEW key ⇒ the doctor may speak once about the new situation. A decision is a
 *    decision about one situation, never a blanket mute of the doctor.
 */
export function verifyDoctorSignature(report: VerifyDoctorReport): string {
  return [
    `kind=${report.profile.kind}`,
    `pm=${report.profile.packageManagerProven === true ? report.profile.packageManager : '-'}`,
    `cmds=${report.findings.map((f) => f.command).join('|')}`,
    `suggest=${report.suggestions.join('|')}`,
  ].join(';');
}

export interface VerifyDoctorNotification {
  message: string;
  suggestions: string[];
}

/**
 * Human-readable summary for a warning notification, or undefined when the
 * report is healthy (nothing to surface). Broken commands lead — they are the
 * stronger claim ("cannot run") — and a mismatch-only report says exactly that
 * instead, so the message never overstates the evidence.
 */
export function verifyDoctorNotification(
  report: VerifyDoctorReport
): VerifyDoctorNotification | undefined {
  if (report.ok) return undefined;
  const suggestionText =
    report.suggestions.length > 0
      ? ` Suggested for this repo: ${report.suggestions.join(' && ')}.`
      : '';
  const total = report.findings.length;
  if (report.broken.length > 0) {
    const list = report.broken.map((f) => `\`${f.command}\``).join(', ');
    const cause = report.broken[0]?.reason ?? 'they cannot run in this repo';
    return {
      message:
        `Taskwright merge verify: ${report.broken.length} of ${total} configured ` +
        `verify command(s) cannot run here (${list} — ${cause}).${suggestionText}`,
      suggestions: report.suggestions,
    };
  }
  const list = report.mismatched.map((f) => `\`${f.command}\``).join(', ');
  const cause = report.mismatched[0]?.reason ?? 'they use the wrong package manager for this repo';
  return {
    message:
      `Taskwright merge verify: ${report.mismatched.length} of ${total} configured ` +
      `verify command(s) run the wrong package manager for this repo (${list} — ${cause}).${suggestionText}`,
    suggestions: report.suggestions,
  };
}
