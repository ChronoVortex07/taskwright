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
  /** Node repos: script names found in package.json (empty when unreadable). */
  scripts: string[];
  /** Python repos: true when uv manages the project (uv.lock or [tool.uv]). */
  usesUv?: boolean;
}

export interface VerifyCommandFinding {
  command: string;
  ok: boolean;
  /** Present when ok=false: why the command provably cannot run here. */
  reason?: string;
}

export interface VerifyDoctorReport {
  profile: RepoProfile;
  findings: VerifyCommandFinding[];
  /** The subset of findings with ok=false. */
  broken: VerifyCommandFinding[];
  /** True when every configured command passed. */
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
    const packageManager: NodePackageManager =
      has(root, 'bun.lockb', fs) || has(root, 'bun.lock', fs)
        ? 'bun'
        : has(root, 'pnpm-lock.yaml', fs)
          ? 'pnpm'
          : has(root, 'yarn.lock', fs)
            ? 'yarn'
            : 'npm';
    return { kind: 'node', packageManager, scripts };
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

/**
 * Parse a script-runner invocation: `bun|npm|pnpm|yarn run <script>` plus
 * `npm test` (an alias for `npm run test`). Returns the script name, or
 * undefined when the command is not a provable script-runner call.
 * (`bun test` is bun's built-in test runner, not a script lookup — skipped.)
 */
function scriptRunnerTarget(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/);
  const [runner, sub, script] = tokens;
  if (!runner) return undefined;
  if (['bun', 'npm', 'pnpm', 'yarn'].includes(runner) && sub === 'run' && script) {
    return script;
  }
  if (runner === 'npm' && (sub === 'test' || sub === 't')) return 'test';
  return undefined;
}

/**
 * Flag the commands the repo's files PROVE cannot run. Everything else passes —
 * the doctor only reports evidence, never guesses.
 */
export function diagnoseVerifyCommands(
  commands: string[],
  profile: RepoProfile
): VerifyCommandFinding[] {
  return commands.map((command) => {
    const script = scriptRunnerTarget(command);
    if (script === undefined) return { command, ok: true };
    if (profile.kind !== 'node') {
      return {
        command,
        ok: false,
        reason: `no package.json in this repo, so \`${command}\` cannot run`,
      };
    }
    if (!profile.scripts.includes(script)) {
      return {
        command,
        ok: false,
        reason: `package.json has no "${script}" script`,
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
  return {
    profile,
    findings,
    broken,
    ok: broken.length === 0,
    suggestions: suggestVerifyCommands(profile),
  };
}

export interface VerifyDoctorNotification {
  message: string;
  suggestions: string[];
}

/**
 * Human-readable summary for a warning notification, or undefined when the
 * report is healthy (nothing to surface).
 */
export function verifyDoctorNotification(
  report: VerifyDoctorReport
): VerifyDoctorNotification | undefined {
  if (report.ok) return undefined;
  const brokenList = report.broken.map((f) => `\`${f.command}\``).join(', ');
  const cause = report.broken[0]?.reason ?? 'they cannot run in this repo';
  const suggestionText =
    report.suggestions.length > 0
      ? ` Suggested for this repo: ${report.suggestions.join(' && ')}.`
      : '';
  return {
    message:
      `Taskwright merge verify: ${report.broken.length} of ${report.findings.length} configured ` +
      `verify command(s) cannot run here (${brokenList} — ${cause}).${suggestionText}`,
    suggestions: report.suggestions,
  };
}
