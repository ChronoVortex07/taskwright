import { describe, it, expect } from 'vitest';
import { runVerifyDoctor, verifyDoctorSignature } from '../../core/verifyDoctor';
import {
  verifyDoctorStatePath,
  readVerifyDoctorState,
  recordVerifyDoctorDecision,
  shouldPromptVerifyDoctor,
  isVerifyDoctorDismissed,
  type VerifyDoctorState,
} from '../../core/verifyDoctorState';

/**
 * The proactive verify doctor (TASK-132). The doctor itself was already advisory
 * (TASK-86); what shipped wrong verify commands silently was that nothing ever
 * ASKED the human. These tests pin the three paths the prompt-once memory has to
 * get right: prompt (once), apply, and decline-remembered.
 */

/** An in-memory Pick<QueueFsDeps,'exists'|'read'|'writeAtomic'> over one file map. */
function memFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  return {
    files,
    exists: (p: string) => files.has(p),
    read: (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeAtomic: (p: string, data: string) => {
      files.set(p, data);
    },
  };
}

/** A repo whose files prove the bun defaults are wrong: pnpm lockfile, all scripts present. */
function pnpmRepoFs() {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      scripts: { test: 'vitest', lint: 'eslint', typecheck: 'tsc' },
    }),
    'pnpm-lock.yaml': '',
  };
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

const BUN_DEFAULTS = ['bun run test', 'bun run lint', 'bun run typecheck'];

/** The report a fresh pnpm repo running the unchanged bun defaults produces. */
const unhealthy = () =>
  runVerifyDoctor({ root: '/repo', commands: BUN_DEFAULTS, fs: pnpmRepoFs() });

/** The report after the human applies the doctor's suggestions. */
const healthy = () =>
  runVerifyDoctor({
    root: '/repo',
    commands: ['pnpm run test', 'pnpm run lint', 'pnpm run typecheck'],
    fs: pnpmRepoFs(),
  });

const STATE_FILE = verifyDoctorStatePath('/repo/.git');
const NOW = new Date('2026-07-14T12:00:00Z');

describe('verifyDoctorStatePath', () => {
  it('sits beside merge-config.json under the git common dir', () => {
    expect(verifyDoctorStatePath('/repo/.git').replace(/\\/g, '/')).toBe(
      '/repo/.git/taskwright/verify-doctor.json'
    );
  });
});

describe('readVerifyDoctorState', () => {
  it('returns an empty state when the file is missing (never throws)', () => {
    expect(readVerifyDoctorState(STATE_FILE, memFs())).toEqual({});
  });

  it('tolerates a corrupt file as "no decision recorded"', () => {
    expect(readVerifyDoctorState(STATE_FILE, memFs({ [STATE_FILE]: 'not json' }))).toEqual({});
  });
});

describe('shouldPromptVerifyDoctor — prompt once', () => {
  it('prompts when the commands need attention and nothing is recorded', () => {
    expect(shouldPromptVerifyDoctor(unhealthy(), {})).toBe(true);
  });

  it('never prompts for a healthy repo', () => {
    expect(shouldPromptVerifyDoctor(healthy(), {})).toBe(false);
  });

  it('does not prompt a SECOND time for the same situation (any decision counts)', () => {
    const report = unhealthy();
    for (const decision of ['applied', 'declined', 'deferred'] as const) {
      const state: VerifyDoctorState = {
        signature: verifyDoctorSignature(report),
        decision,
        decidedAt: NOW.toISOString(),
      };
      expect(shouldPromptVerifyDoctor(report, state)).toBe(false);
    }
  });

  it('prompts again when the SITUATION changes (a decision is not a blanket mute)', () => {
    const declinedOnDefaults: VerifyDoctorState = {
      signature: verifyDoctorSignature(unhealthy()),
      decision: 'declined',
      decidedAt: NOW.toISOString(),
    };
    // The user later hand-edits the commands to something else that is still wrong:
    // a different situation, so the doctor is entitled to speak once more.
    const other = runVerifyDoctor({
      root: '/repo',
      commands: ['bun run test'],
      fs: pnpmRepoFs(),
    });
    expect(shouldPromptVerifyDoctor(other, declinedOnDefaults)).toBe(true);
  });
});

describe('recordVerifyDoctorDecision — the decision is durable', () => {
  it('persists the applied decision against the signature of what was prompted', () => {
    const fs = memFs();
    const report = unhealthy();
    recordVerifyDoctorDecision(STATE_FILE, report, 'applied', fs, NOW);

    const state = readVerifyDoctorState(STATE_FILE, fs);
    expect(state.signature).toBe(verifyDoctorSignature(report));
    expect(state.decision).toBe('applied');
    expect(state.decidedAt).toBe(NOW.toISOString());
    // Applying resolves the problem, so the next pass has nothing to say anyway.
    expect(shouldPromptVerifyDoctor(healthy(), state)).toBe(false);
  });

  it('remembers a decline across restarts — re-reading the file suppresses the prompt', () => {
    const fs = memFs();
    const report = unhealthy();
    expect(shouldPromptVerifyDoctor(report, readVerifyDoctorState(STATE_FILE, fs))).toBe(true);

    recordVerifyDoctorDecision(STATE_FILE, report, 'declined', fs, NOW);

    // A fresh process re-reads the same file and stays silent: no re-prompt, and —
    // the load-bearing half of "no silent rewrite" — the commands are untouched.
    const reloaded = readVerifyDoctorState(STATE_FILE, fs);
    expect(reloaded.decision).toBe('declined');
    expect(shouldPromptVerifyDoctor(unhealthy(), reloaded)).toBe(false);
  });
});

describe('isVerifyDoctorDismissed — what a decline suppresses', () => {
  it('an explicit decline also silences the standing board_doctor finding', () => {
    const report = unhealthy();
    const fs = memFs();
    recordVerifyDoctorDecision(STATE_FILE, report, 'declined', fs, NOW);
    expect(isVerifyDoctorDismissed(report, readVerifyDoctorState(STATE_FILE, fs))).toBe(true);
  });

  it('a merely DEFERRED prompt (dismissed with X) keeps the finding — only the nag stops', () => {
    const report = unhealthy();
    const fs = memFs();
    recordVerifyDoctorDecision(STATE_FILE, report, 'deferred', fs, NOW);
    const state = readVerifyDoctorState(STATE_FILE, fs);
    expect(shouldPromptVerifyDoctor(report, state)).toBe(false);
    expect(isVerifyDoctorDismissed(report, state)).toBe(false);
  });

  it('a decline recorded for a DIFFERENT situation does not silence this one', () => {
    const stale: VerifyDoctorState = {
      signature: 'kind=python;pm=-;cmds=pytest;suggest=pytest -q',
      decision: 'declined',
      decidedAt: NOW.toISOString(),
    };
    expect(isVerifyDoctorDismissed(unhealthy(), stale)).toBe(false);
  });
});
