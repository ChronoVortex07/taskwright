import { describe, it, expect } from 'vitest';
import {
  detectRepoProfile,
  diagnoseVerifyCommands,
  suggestVerifyCommands,
  runVerifyDoctor,
  verifyDoctorNotification,
  type RepoProfile,
} from '../../core/verifyDoctor';

/** Build a Pick<QueueFsDeps,'exists'|'read'> over an in-memory file map keyed by
 *  repo-root-relative POSIX paths (the doctor joins with the platform separator,
 *  so normalize before lookup). */
function memFs(files: Record<string, string>) {
  const norm = (p: string) => p.replace(/\\/g, '/');
  return {
    exists: (p: string) => Object.keys(files).some((k) => norm(p).endsWith(`/${k}`)),
    read: (p: string) => {
      const key = Object.keys(files).find((k) => norm(p).endsWith(`/${k}`));
      if (key === undefined) throw new Error(`ENOENT: ${p}`);
      return files[key];
    },
  };
}

const ROOT = '/repo';

describe('detectRepoProfile', () => {
  it('detects a bun-managed node repo with its scripts', () => {
    const fs = memFs({
      'package.json': JSON.stringify({
        scripts: { test: 'vitest', lint: 'eslint .', typecheck: 'tsc --noEmit' },
      }),
      'bun.lock': '',
    });
    const profile = detectRepoProfile(ROOT, fs);
    expect(profile.kind).toBe('node');
    expect(profile.packageManager).toBe('bun');
    expect(profile.scripts).toEqual(['test', 'lint', 'typecheck']);
  });

  it('detects npm / pnpm / yarn from their lockfiles', () => {
    const base = { 'package.json': JSON.stringify({ scripts: {} }) };
    expect(
      detectRepoProfile(ROOT, memFs({ ...base, 'package-lock.json': '{}' })).packageManager
    ).toBe('npm');
    expect(detectRepoProfile(ROOT, memFs({ ...base, 'pnpm-lock.yaml': '' })).packageManager).toBe(
      'pnpm'
    );
    expect(detectRepoProfile(ROOT, memFs({ ...base, 'yarn.lock': '' })).packageManager).toBe(
      'yarn'
    );
  });

  it('defaults the package manager to npm when no lockfile is present', () => {
    const fs = memFs({ 'package.json': JSON.stringify({ scripts: { test: 'x' } }) });
    expect(detectRepoProfile(ROOT, fs).packageManager).toBe('npm');
  });

  it('tolerates a corrupt package.json (node repo, no scripts)', () => {
    const fs = memFs({ 'package.json': 'not json', 'bun.lock': '' });
    const profile = detectRepoProfile(ROOT, fs);
    expect(profile.kind).toBe('node');
    expect(profile.scripts).toEqual([]);
  });

  it('detects a uv python repo', () => {
    const fs = memFs({ 'pyproject.toml': '[project]\nname = "x"', 'uv.lock': '' });
    const profile = detectRepoProfile(ROOT, fs);
    expect(profile.kind).toBe('python');
    expect(profile.usesUv).toBe(true);
  });

  it('detects uv via [tool.uv] in pyproject.toml without a lockfile', () => {
    const fs = memFs({ 'pyproject.toml': '[tool.uv]\ndev-dependencies = []' });
    const profile = detectRepoProfile(ROOT, fs);
    expect(profile.kind).toBe('python');
    expect(profile.usesUv).toBe(true);
  });

  it('detects plain python (pytest.ini / requirements.txt) without uv', () => {
    const profile = detectRepoProfile(ROOT, memFs({ 'pytest.ini': '', 'requirements.txt': '' }));
    expect(profile.kind).toBe('python');
    expect(profile.usesUv).toBe(false);
  });

  it('detects rust and go repos', () => {
    expect(detectRepoProfile(ROOT, memFs({ 'Cargo.toml': '' })).kind).toBe('rust');
    expect(detectRepoProfile(ROOT, memFs({ 'go.mod': '' })).kind).toBe('go');
  });

  it('node wins over python in a mixed repo', () => {
    const fs = memFs({
      'package.json': JSON.stringify({ scripts: { test: 'x' } }),
      'pyproject.toml': '',
    });
    expect(detectRepoProfile(ROOT, fs).kind).toBe('node');
  });

  it('returns unknown for an unrecognized repo', () => {
    expect(detectRepoProfile(ROOT, memFs({})).kind).toBe('unknown');
  });
});

describe('diagnoseVerifyCommands', () => {
  const nodeProfile: RepoProfile = {
    kind: 'node',
    packageManager: 'bun',
    scripts: ['test', 'typecheck'],
  };
  const pythonProfile: RepoProfile = { kind: 'python', scripts: [], usesUv: true };

  it('passes script-runner commands whose script exists', () => {
    const findings = diagnoseVerifyCommands(['bun run test', 'bun run typecheck'], nodeProfile);
    expect(findings.every((f) => f.ok)).toBe(true);
  });

  it('flags a script-runner command whose script is missing', () => {
    const findings = diagnoseVerifyCommands(['bun run lint'], nodeProfile);
    expect(findings[0].ok).toBe(false);
    expect(findings[0].reason).toContain('lint');
  });

  it('flags every script-runner command when there is no package.json (python repo)', () => {
    const findings = diagnoseVerifyCommands(
      ['bun run test', 'bun run lint', 'bun run typecheck'],
      pythonProfile
    );
    expect(findings).toHaveLength(3);
    expect(findings.every((f) => !f.ok)).toBe(true);
    expect(findings[0].reason).toContain('package.json');
  });

  it('understands npm/pnpm/yarn run variants', () => {
    const findings = diagnoseVerifyCommands(
      ['npm run lint', 'pnpm run lint', 'yarn run lint'],
      nodeProfile
    );
    expect(findings.every((f) => !f.ok)).toBe(true);
  });

  it('flags npm test without a test script, but not bun test (built-in runner)', () => {
    const profile: RepoProfile = { kind: 'node', packageManager: 'npm', scripts: [] };
    const [npmTest, bunTest] = diagnoseVerifyCommands(['npm test', 'bun test'], profile);
    expect(npmTest.ok).toBe(false);
    expect(bunTest.ok).toBe(true);
  });

  it('never flags commands it cannot prove broken', () => {
    const findings = diagnoseVerifyCommands(
      ['uv run pytest -q', 'cargo test', 'make check', 'npx vitest'],
      pythonProfile
    );
    expect(findings.every((f) => f.ok)).toBe(true);
  });
});

describe('suggestVerifyCommands', () => {
  it('builds runner commands from the scripts that actually exist', () => {
    const profile: RepoProfile = { kind: 'node', packageManager: 'bun', scripts: ['test', 'lint'] };
    expect(suggestVerifyCommands(profile)).toEqual(['bun run test', 'bun run lint']);
  });

  it('uses the detected package manager for the runner', () => {
    const profile: RepoProfile = { kind: 'node', packageManager: 'pnpm', scripts: ['typecheck'] };
    expect(suggestVerifyCommands(profile)).toEqual(['pnpm run typecheck']);
  });

  it('suggests uv run pytest -q for a uv python repo', () => {
    expect(suggestVerifyCommands({ kind: 'python', scripts: [], usesUv: true })).toEqual([
      'uv run pytest -q',
    ]);
  });

  it('suggests bare pytest -q for a non-uv python repo', () => {
    expect(suggestVerifyCommands({ kind: 'python', scripts: [], usesUv: false })).toEqual([
      'pytest -q',
    ]);
  });

  it('suggests cargo test / go test for rust and go', () => {
    expect(suggestVerifyCommands({ kind: 'rust', scripts: [] })).toEqual(['cargo test']);
    expect(suggestVerifyCommands({ kind: 'go', scripts: [] })).toEqual(['go test ./...']);
  });

  it('suggests nothing for an unknown repo', () => {
    expect(suggestVerifyCommands({ kind: 'unknown', scripts: [] })).toEqual([]);
  });
});

describe('runVerifyDoctor', () => {
  it('reports ok for the default commands in a bun repo with matching scripts', () => {
    const fs = memFs({
      'package.json': JSON.stringify({
        scripts: { test: 'vitest', lint: 'eslint', typecheck: 'tsc' },
      }),
      'bun.lock': '',
    });
    const report = runVerifyDoctor({
      root: ROOT,
      commands: ['bun run test', 'bun run lint', 'bun run typecheck'],
      fs,
    });
    expect(report.ok).toBe(true);
    expect(report.broken).toEqual([]);
  });

  it('flags the bun defaults in a uv python repo and suggests uv run pytest -q', () => {
    const fs = memFs({ 'pyproject.toml': '[project]', 'uv.lock': '' });
    const report = runVerifyDoctor({
      root: ROOT,
      commands: ['bun run test', 'bun run lint', 'bun run typecheck'],
      fs,
    });
    expect(report.ok).toBe(false);
    expect(report.broken).toHaveLength(3);
    expect(report.suggestions).toEqual(['uv run pytest -q']);
  });

  it('flags a missing script in an npm repo and suggests only existing scripts', () => {
    const fs = memFs({
      'package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
      'package-lock.json': '{}',
    });
    const report = runVerifyDoctor({
      root: ROOT,
      commands: ['npm run test', 'npm run lint'],
      fs,
    });
    expect(report.ok).toBe(false);
    expect(report.broken.map((f) => f.command)).toEqual(['npm run lint']);
    expect(report.suggestions).toEqual(['npm run test']);
  });
});

describe('verifyDoctorNotification', () => {
  it('returns undefined for a healthy report', () => {
    const fs = memFs({
      'package.json': JSON.stringify({ scripts: { test: 'x' } }),
      'bun.lock': '',
    });
    const report = runVerifyDoctor({ root: ROOT, commands: ['bun run test'], fs });
    expect(verifyDoctorNotification(report)).toBeUndefined();
  });

  it('summarizes broken commands and includes the suggestions', () => {
    const fs = memFs({ 'pyproject.toml': '', 'uv.lock': '' });
    const report = runVerifyDoctor({
      root: ROOT,
      commands: ['bun run test', 'bun run lint'],
      fs,
    });
    const note = verifyDoctorNotification(report);
    expect(note).toBeDefined();
    expect(note?.message).toContain('bun run test');
    expect(note?.message).toContain('uv run pytest -q');
    expect(note?.suggestions).toEqual(['uv run pytest -q']);
  });
});
