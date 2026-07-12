import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createDeferredRunner,
  DEFERRED_BOOTSTRAP_DELAY_MS,
} from '../../core/deferredBootstrap';

/**
 * TASK-109. Taskwright's activation used to fire a burst of git subprocesses —
 * worktree guard, post-checkout warn, board hooks, merge-config + verify doctor,
 * sync-config publish, the git-auto bootstrap and its network fetch/push — while
 * the VS Code window was still coming up. Even un-awaited, that work competes for
 * the extension host during startup.
 *
 * The runner moves it off the window-open critical path: it runs ONCE, after a
 * delay, unless something that genuinely needs it (the board view opening) pulls
 * it forward — in which case it must still only run once.
 */
describe('deferred bootstrap runner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not run the work synchronously on schedule()', () => {
    const work = vi.fn();
    createDeferredRunner(work).schedule();
    expect(work).not.toHaveBeenCalled();
  });

  it('runs the work once the delay elapses', async () => {
    const work = vi.fn();
    createDeferredRunner(work).schedule();

    await vi.advanceTimersByTimeAsync(DEFERRED_BOOTSTRAP_DELAY_MS - 1);
    expect(work).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('runNow() pulls the work forward for a caller that actually needs it', async () => {
    const work = vi.fn();
    const runner = createDeferredRunner(work);
    runner.schedule();

    await runner.runNow();
    expect(work).toHaveBeenCalledTimes(1);

    // …and the pending timer must not fire it a second time.
    await vi.advanceTimersByTimeAsync(DEFERRED_BOOTSTRAP_DELAY_MS * 2);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('runs at most once however many times it is scheduled or pulled', async () => {
    const work = vi.fn();
    const runner = createDeferredRunner(work);
    runner.schedule();
    runner.schedule();
    await Promise.all([runner.runNow(), runner.runNow()]);
    await vi.advanceTimersByTimeAsync(DEFERRED_BOOTSTRAP_DELAY_MS * 2);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('concurrent runNow() callers await the SAME in-flight run', async () => {
    let resolveWork: () => void = () => {};
    const work = vi.fn(() => new Promise<void>((r) => (resolveWork = r)));
    const runner = createDeferredRunner(work);

    const a = runner.runNow();
    const b = runner.runNow();
    resolveWork();
    await Promise.all([a, b]);

    expect(work).toHaveBeenCalledTimes(1);
  });

  it('dispose() cancels pending work that has not started', async () => {
    const work = vi.fn();
    const runner = createDeferredRunner(work);
    runner.schedule();
    runner.dispose();

    await vi.advanceTimersByTimeAsync(DEFERRED_BOOTSTRAP_DELAY_MS * 2);
    expect(work).not.toHaveBeenCalled();
  });

  it('a throwing bootstrap never rejects into the caller (activation must not fail)', async () => {
    const work = vi.fn(async () => {
      throw new Error('git exploded');
    });
    const runner = createDeferredRunner(work);

    await expect(runner.runNow()).resolves.toBeUndefined();

    runner.schedule();
    await expect(
      vi.advanceTimersByTimeAsync(DEFERRED_BOOTSTRAP_DELAY_MS * 2)
    ).resolves.not.toThrow();
  });

  it('defers by enough to clear the window-open critical path', () => {
    expect(DEFERRED_BOOTSTRAP_DELAY_MS).toBeGreaterThanOrEqual(1000);
  });
});
