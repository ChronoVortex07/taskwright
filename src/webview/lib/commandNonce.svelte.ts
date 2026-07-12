import { untrack } from 'svelte';

/**
 * The ONE idiom for a host→canvas *command* prop.
 *
 * A command (jump to a band, jump to a task, pan the minimap, open the find bar) is an
 * **event**, but props are **state** — so the host (`Tasks.svelte`) encodes "do it again"
 * by bumping a monotonic nonce, and the consumer fires whenever the nonce *changes*.
 *
 * The hazard this helper exists to make unrepresentable
 * ---------------------------------------------------
 * The nonce props live in `Tasks.svelte` and survive for the whole webview session, while
 * `TechTreeCanvas` is rendered inside `{:else if activeTab === 'tree'}` and is therefore
 * **destroyed and re-created on every tab switch**. A guard seeded to `0` on each mount
 * therefore sees a stale, non-zero nonce from a PRIOR mount and **replays the last command
 * with no user input**.
 *
 * That shipped once, on the find bar (fixed in 1.8.0, commit `fb63630`): press `/` →
 * Escape → switch tab → switch back, and the find bar spontaneously reopened and stole
 * keyboard focus, on every Tree-tab re-entry for the rest of the session.
 *
 * The fix is to seed the guard from the prop's **mount-time value**, not `0`. Because that
 * seed is internal here and there is no initializer parameter, a newly added command prop
 * *cannot* reintroduce the wrong initializer — which is the point of centralizing it.
 * `untrack` makes the one-time, non-reactive read explicit (and silences Svelte's
 * `state_referenced_locally` warning for this deliberately-once read).
 *
 * Reactive-graph note: the returned effect reads ONLY the nonce (via `readNonce`) on the
 * no-op path, so it adds no edge to the canvas's find/dim derived graph. TechTreeCanvas
 * holds a load-bearing invariant that `findResults` may depend only on the primitive dim
 * sources (`navFilterDimmedIds`, `hiddenIds`) and never on the composed
 * `dimmedIds`/`fadedIds`; this helper does not touch it.
 *
 * @param readNonce Reads the nonce prop reactively, e.g. `() => jumpNonce`.
 * @param run       The command to run on a genuine bump. Runs inside the effect, so any
 *                  state it reads becomes a dependency only on the firing path.
 *
 * @example
 * onCommandNonce(
 *   () => jumpTaskNonce,
 *   () => centerOn(jumpTaskId)
 * );
 */
export function onCommandNonce(readNonce: () => number, run: () => void): void {
  // Seeded from the prop's MOUNT-TIME value, NEVER 0 — see the hazard note above.
  let last = untrack(readNonce);
  $effect(() => {
    const nonce = readNonce();
    if (nonce === last) return;
    last = nonce;
    run();
  });
}
