/**
 * Deferred activation bootstrap (TASK-109).
 *
 * Taskwright's `activate()` used to kick off a burst of git subprocesses while
 * the VS Code window was still coming up — the worktree guard, the post-checkout
 * warn, the board hooks, the merge-config publish + verify doctor, the sync-config
 * publish, and (in git-auto) the board-worktree bootstrap plus a network fetch and
 * push. None of it is needed to render the board, but all of it competed with
 * window startup: Taskwright was the last eager extension to activate and gated the
 * "Eager extensions activated" milestone, delaying every `onStartupFinished`
 * extension behind it.
 *
 * This runs that work exactly once, off the critical path: after a delay, or
 * sooner if a caller that genuinely needs it (the board view opening, an explicit
 * sync command) pulls it forward with `runNow()`.
 *
 * It never rejects. A failing bootstrap degrades — it must not take activation,
 * or the caller that pulled it forward, down with it.
 */
export const DEFERRED_BOOTSTRAP_DELAY_MS = 2000;

export interface DeferredRunner {
  /** Arrange for the work to run once the delay elapses. Cheap; never blocks. */
  schedule(): void;
  /** Run the work now (or await the run already in flight). Resolves when done. */
  runNow(): Promise<void>;
  /** Cancel the work if it has not started yet. */
  dispose(): void;
}

export function createDeferredRunner(
  work: () => void | Promise<void>,
  delayMs: number = DEFERRED_BOOTSTRAP_DELAY_MS
): DeferredRunner {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started: Promise<void> | undefined;

  const run = (): Promise<void> => {
    // At most once, however many schedule()/runNow() calls race here.
    if (!started) {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      started = (async () => {
        await work();
      })().catch((err) => {
        console.warn('[Taskwright] deferred activation bootstrap failed:', err);
      });
    }
    return started;
  };

  return {
    schedule() {
      if (started || timer) return;
      timer = setTimeout(() => void run(), delayMs);
    },
    runNow: run,
    dispose() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
