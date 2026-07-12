import { flushSync } from 'svelte';
import { onCommandNonce } from '../../../webview/lib/commandNonce.svelte';

/**
 * Rune harness for `onCommandNonce`. Runes can only be compiled inside `.svelte`/`.svelte.ts`
 * modules, so the reactive plumbing lives here and the assertions live in the plain
 * `commandNonce.test.ts` beside it.
 *
 * It models the exact shape of the shipped bug:
 *   - `createHost()` is `Tasks.svelte` — the nonce prop lives here and survives for the whole
 *     webview session, across any number of tab switches.
 *   - `mountCanvas()` is `TechTreeCanvas` — destroyed and re-created on every tab switch
 *     ({:else if activeTab === 'tree'}), so each mount gets a FRESH guard.
 */

/** The host (Tasks.svelte): a session-scoped nonce prop. */
export function createHost(): { readonly nonce: number; bump: () => void } {
  let nonce = $state(0);
  return {
    get nonce() {
      return nonce;
    },
    /** The user issues the command (presses `/`, drags the minimap, clicks a band…). */
    bump() {
      nonce += 1;
      flushSync();
    },
  };
}

/** A canvas mount consuming the host's nonce. `destroy()` is the tab-switch-away. */
export function mountCanvas(host: { readonly nonce: number }): {
  /** Nonce values the command actually fired with. */
  calls: number[];
  destroy: () => void;
} {
  const calls: number[] = [];
  const destroy = $effect.root(() => {
    onCommandNonce(
      () => host.nonce,
      () => calls.push(host.nonce)
    );
  });
  // Settle the mount effect, exactly as the browser would before the user does anything.
  flushSync();
  return { calls, destroy };
}
