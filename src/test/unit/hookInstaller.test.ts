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
  resolveHookTargetFor,
  installLabeledHook,
  uninstallLabeledHook,
  BOARD_SYNC_HOOK_SCRIPT_REL,
  installBoardSyncHooks,
  uninstallBoardSyncHooks,
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

describe('resolveHookTargetFor', () => {
  it('targets .husky/<hookName> when it exists', () => {
    const fs = memFs({ '/repo/.husky/pre-push': '#!/bin/sh\n' });
    const t = resolveHookTargetFor('/repo', 'pre-push', fs);
    expect(t.manager).toBe('husky');
    expect(t.hookPath.replace(/\\/g, '/')).toBe('/repo/.husky/pre-push');
  });

  it('falls back to .git/hooks/<hookName> otherwise', () => {
    const t = resolveHookTargetFor('/repo', 'post-merge', memFs());
    expect(t.manager).toBe('plain');
    expect(t.hookPath.replace(/\\/g, '/')).toBe('/repo/.git/hooks/post-merge');
  });
});

describe('installLabeledHook / uninstallLabeledHook', () => {
  const LABEL = 'taskwright test hook';

  it('appends a labeled fence to an existing husky hook and is idempotent', () => {
    const fs = memFs({ '/repo/.husky/pre-push': '#!/bin/sh\nnpx something\n' });
    expect(installLabeledHook('/repo', 'pre-push', LABEL, 'echo hi', fs)).toBe('husky');
    const after = fs.files['/repo/.husky/pre-push'];
    expect(after).toContain('npx something');
    expect(after).toContain('# >>> taskwright test hook >>>');
    expect(after).toContain('echo hi');
    installLabeledHook('/repo', 'pre-push', LABEL, 'echo hi', fs);
    expect(fs.files['/repo/.husky/pre-push'].match(/taskwright test hook/g)!.length).toBe(2); // start+end only
  });

  it('seeds a shebang for a brand-new plain hook', () => {
    const fs = memFs();
    expect(installLabeledHook('/repo', 'post-merge', LABEL, 'echo hi', fs)).toBe('plain');
    const body = fs.files['/repo/.git/hooks/post-merge'];
    expect(body.startsWith('#!/bin/sh')).toBe(true);
    expect(body).toContain('echo hi');
  });

  it('uninstall removes only its own labeled fence, leaving other content intact', () => {
    const fs = memFs({ '/repo/.husky/pre-push': '#!/bin/sh\nnpx something\n' });
    installLabeledHook('/repo', 'pre-push', LABEL, 'echo hi', fs);
    uninstallLabeledHook('/repo', 'pre-push', LABEL, fs);
    expect(fs.files['/repo/.husky/pre-push']).toContain('npx something');
    expect(fs.files['/repo/.husky/pre-push']).not.toContain('taskwright test hook');
  });

  it('uninstall is a no-op when the hook file does not exist', () => {
    const fs = memFs();
    expect(() => uninstallLabeledHook('/repo', 'pre-push', LABEL, fs)).not.toThrow();
    expect(fs.files['/repo/.git/hooks/pre-push']).toBeUndefined();
  });
});

describe('installBoardSyncHooks / uninstallBoardSyncHooks', () => {
  it('installs a non-blocking pre-push (push) and post-merge (pull) fence referencing the committed launcher', () => {
    const fs = memFs();
    const { prePush, postMerge } = installBoardSyncHooks('/repo', fs);
    expect(prePush).toBe('plain');
    expect(postMerge).toBe('plain');

    const push = fs.files['/repo/.git/hooks/pre-push'];
    expect(push).toContain(BOARD_SYNC_HOOK_SCRIPT_REL);
    expect(push).toContain(`"${BOARD_SYNC_HOOK_SCRIPT_REL}" push`);
    expect(push).toContain('|| true'); // never blocks the push on failure

    const pull = fs.files['/repo/.git/hooks/post-merge'];
    expect(pull).toContain(BOARD_SYNC_HOOK_SCRIPT_REL);
    expect(pull).toContain(`"${BOARD_SYNC_HOOK_SCRIPT_REL}" pull`);
    expect(pull).toContain('|| true');
  });

  it('is idempotent (re-running does not duplicate the fence)', () => {
    const fs = memFs();
    installBoardSyncHooks('/repo', fs);
    installBoardSyncHooks('/repo', fs);
    const push = fs.files['/repo/.git/hooks/pre-push'];
    expect(push.match(/taskwright board sync \(push\)/g)!.length).toBe(2); // start+end only
  });

  it('prefers husky hooks when present, independently per hook', () => {
    const fs = memFs({ '/repo/.husky/pre-push': '#!/bin/sh\nnpx lint-staged\n' });
    const { prePush, postMerge } = installBoardSyncHooks('/repo', fs);
    expect(prePush).toBe('husky');
    expect(postMerge).toBe('plain');
    expect(fs.files['/repo/.husky/pre-push']).toContain('npx lint-staged');
  });

  it('uninstall removes both fences, leaving surrounding hook content intact', () => {
    const fs = memFs({ '/repo/.husky/pre-push': '#!/bin/sh\nnpx lint-staged\n' });
    installBoardSyncHooks('/repo', fs);
    uninstallBoardSyncHooks('/repo', fs);
    expect(fs.files['/repo/.husky/pre-push']).toContain('npx lint-staged');
    expect(fs.files['/repo/.husky/pre-push']).not.toContain(BOARD_SYNC_HOOK_SCRIPT_REL);
    expect(fs.files['/repo/.git/hooks/post-merge']).not.toContain(BOARD_SYNC_HOOK_SCRIPT_REL);
  });
});
