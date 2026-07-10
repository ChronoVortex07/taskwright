import { describe, it, expect } from 'vitest';
import {
  resolveClaimIdentity,
  agentClaimIdentity,
  worktreeBranchFromPath,
  shortClaimIdentity,
} from '../../core/claimIdentity';

describe('resolveClaimIdentity', () => {
  it('uses the configured identity verbatim when set', () => {
    expect(resolveClaimIdentity('@team-lead', 'alice')).toBe('@team-lead');
  });

  it('trims surrounding whitespace from the configured identity', () => {
    expect(resolveClaimIdentity('  @bob  ', 'alice')).toBe('@bob');
  });

  it('falls back to the @-prefixed OS username when unconfigured', () => {
    expect(resolveClaimIdentity(undefined, 'alice')).toBe('@alice');
    expect(resolveClaimIdentity('', 'alice')).toBe('@alice');
    expect(resolveClaimIdentity('   ', 'alice')).toBe('@alice');
  });

  it('does not double-prefix an OS username that already starts with @', () => {
    expect(resolveClaimIdentity(undefined, '@alice')).toBe('@alice');
  });

  it('returns @unknown when neither a config nor a username is available', () => {
    expect(resolveClaimIdentity(undefined, '')).toBe('@unknown');
    expect(resolveClaimIdentity('', '   ')).toBe('@unknown');
  });
});

describe('agentClaimIdentity (TASK-89)', () => {
  it('derives @agent/<branch> from a branch name', () => {
    expect(agentClaimIdentity('task-61-fix-login')).toBe('@agent/task-61-fix-login');
  });

  it('trims the branch', () => {
    expect(agentClaimIdentity('  task-7-x  ')).toBe('@agent/task-7-x');
  });

  it('falls back to the bare generic @agent when no branch is known', () => {
    expect(agentClaimIdentity(undefined)).toBe('@agent');
    expect(agentClaimIdentity('')).toBe('@agent');
    expect(agentClaimIdentity('   ')).toBe('@agent');
  });
});

describe('worktreeBranchFromPath (TASK-89)', () => {
  it('extracts the branch segment after .worktrees (posix)', () => {
    expect(worktreeBranchFromPath('/repo/.worktrees/task-7-fix')).toBe('task-7-fix');
  });

  it('extracts the branch segment after .worktrees (windows)', () => {
    expect(worktreeBranchFromPath('C:\\repo\\.worktrees\\task-7-fix')).toBe('task-7-fix');
  });

  it('resolves from a path deeper inside the worktree', () => {
    expect(worktreeBranchFromPath('/repo/.worktrees/task-7-fix/src/core')).toBe('task-7-fix');
  });

  it('returns undefined for a primary-checkout root', () => {
    expect(worktreeBranchFromPath('/repo')).toBeUndefined();
    expect(worktreeBranchFromPath('C:\\Users\\dev\\repo')).toBeUndefined();
  });

  it('returns undefined when .worktrees is the last segment', () => {
    expect(worktreeBranchFromPath('/repo/.worktrees')).toBeUndefined();
  });
});

describe('shortClaimIdentity (TASK-89)', () => {
  it('collapses a worktree-derived identity to its task-id core', () => {
    expect(shortClaimIdentity('@agent/task-89-claim-identity-per-session')).toBe('@agent/task-89');
  });

  it('handles dot-notation subtask branches', () => {
    expect(shortClaimIdentity('@agent/task-7.1-polish-badge')).toBe('@agent/task-7.1');
  });

  it('keeps short identities verbatim', () => {
    expect(shortClaimIdentity('@alice')).toBe('@alice');
    expect(shortClaimIdentity('@agent')).toBe('@agent');
    expect(shortClaimIdentity('@agent/main')).toBe('@agent/main');
  });

  it('truncates long non-task identities with an ellipsis', () => {
    const long = '@some-very-long-human-or-bot-identity-string';
    const short = shortClaimIdentity(long);
    expect(short.length).toBeLessThanOrEqual(24);
    expect(short.endsWith('…')).toBe(true);
  });
});
