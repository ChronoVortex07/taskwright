import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createHost, mountCanvas } from './helpers/commandNonceHarness.svelte';

/**
 * TASK-112 — host→canvas command nonces.
 *
 * Two layers:
 *   1. BEHAVIOUR — the `onCommandNonce` idiom itself: a stale nonce from a prior mount must
 *      not replay, and a genuine bump after a remount must still fire. This is nonce-agnostic,
 *      so it covers all four command props at once.
 *   2. CONTRACT — TechTreeCanvas.svelte actually *uses* the idiom for every nonce prop it
 *      declares, so a fifth command prop cannot be added with the old hand-rolled `= 0` guard.
 */

const CANVAS = join(
  __dirname,
  '..',
  '..',
  'webview',
  'components',
  'tree',
  'TechTreeCanvas.svelte'
);
const HELPER = join(__dirname, '..', '..', 'webview', 'lib', 'commandNonce.svelte.ts');

describe('onCommandNonce — stale-nonce replay across a canvas remount', () => {
  it('fires the command on a genuine bump', () => {
    const host = createHost();
    const canvas = mountCanvas(host);
    expect(canvas.calls).toEqual([]);

    host.bump();
    expect(canvas.calls).toEqual([1]);

    host.bump();
    expect(canvas.calls).toEqual([1, 2]);
  });

  it('does NOT replay a nonce bumped during a PRIOR mount (the shipped bug)', () => {
    // The nonce prop lives in Tasks.svelte and survives the whole session; TechTreeCanvas is
    // destroyed/re-created on every tab switch. A guard seeded to 0 sees the stale non-zero
    // nonce on remount and replays the command with no user input.
    const host = createHost();

    const first = mountCanvas(host);
    host.bump(); // user presses `/` (or drags the minimap, or jumps a band)
    expect(first.calls).toEqual([1]);
    first.destroy(); // tab switch AWAY from Tree

    const second = mountCanvas(host); // tab switch BACK — remount, nonce prop is still 1
    expect(second.calls).toEqual([]); // must NOT replay
  });

  it('still fires a REAL bump issued after a remount (the fix must not disable commands)', () => {
    const host = createHost();

    const first = mountCanvas(host);
    host.bump();
    first.destroy();

    const second = mountCanvas(host);
    expect(second.calls).toEqual([]); // no replay…

    host.bump(); // …but a genuine command still works
    expect(second.calls).toEqual([2]);
  });

  it('does not replay across MANY remounts, however stale the nonce gets', () => {
    const host = createHost();

    const first = mountCanvas(host);
    host.bump();
    host.bump();
    host.bump();
    expect(first.calls).toEqual([1, 2, 3]);
    first.destroy();

    for (let i = 0; i < 3; i++) {
      const remount = mountCanvas(host);
      expect(remount.calls).toEqual([]);
      remount.destroy();
    }

    const last = mountCanvas(host);
    host.bump();
    expect(last.calls).toEqual([4]);
  });

  it('leaves each mount with an independent guard (a live canvas is unaffected by another)', () => {
    const host = createHost();
    const a = mountCanvas(host);
    const b = mountCanvas(host);

    host.bump();
    expect(a.calls).toEqual([1]);
    expect(b.calls).toEqual([1]);

    a.destroy();
    host.bump();
    expect(a.calls).toEqual([1]); // destroyed: no longer listening
    expect(b.calls).toEqual([1, 2]);
    b.destroy();
  });
});

/** Strip comments, so the contract below scans CODE and never our own prose about it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('command-nonce contract (TechTreeCanvas.svelte)', () => {
  const canvasSrc = readFileSync(CANVAS, 'utf8');
  const canvasCode = stripComments(canvasSrc);
  const helperSrc = readFileSync(HELPER, 'utf8');

  /** Every `<name>Nonce` command prop the canvas declares in its Props interface. */
  const declaredNonceProps = [...canvasSrc.matchAll(/^\s*(\w+Nonce)\??:\s*number;/gm)].map(
    (m) => m[1]
  );

  it('declares the command nonce props this contract is about', () => {
    // Guards the regexes below: if the prop naming convention changes, fail loudly here
    // rather than silently asserting over an empty set.
    expect(declaredNonceProps).toEqual(
      expect.arrayContaining(['jumpNonce', 'jumpTaskNonce', 'minimapPanNonce', 'findRequestNonce'])
    );
  });

  it('routes EVERY declared nonce prop through onCommandNonce', () => {
    for (const prop of declaredNonceProps) {
      expect(
        new RegExp(`onCommandNonce\\(\\s*\\(\\)\\s*=>\\s*${prop}\\b`).test(canvasCode),
        `${prop} must be consumed via onCommandNonce(() => ${prop}, …)`
      ).toBe(true);
    }
  });

  it('has no hand-rolled `let last*Nonce` guard left (the wrong-initializer pattern)', () => {
    // This is the pattern that shipped the bug: `let lastFooNonce = 0;` reseeds to 0 on every
    // remount. Centralizing the seed in onCommandNonce is what makes it unrepresentable.
    expect(canvasCode).not.toMatch(/let\s+last\w*Nonce\b/);
  });

  it('onCommandNonce seeds from the mount-time value and exposes no initializer to get wrong', () => {
    expect(helperSrc).toMatch(/let\s+last\s*=\s*untrack\(\s*readNonce\s*\)/);
    // Only two params: the reader and the command. No seed/initial argument a caller could
    // pass 0 to.
    expect(helperSrc).toMatch(
      /export function onCommandNonce\(\s*readNonce: \(\) => number,\s*run: \(\) => void\s*\): void/
    );
  });
});

describe('$derived acyclicity invariant (TechTreeCanvas.svelte)', () => {
  const canvasSrc = readFileSync(CANVAS, 'utf8');

  it('findResults reads only the primitive dim sources, never the composed dimmedIds/fadedIds', () => {
    // Svelte 5 deriveds are lazy synchronous getters with no fixed-point iteration, so a
    // derived that transitively reads itself throws `derived_references_self` in dev and
    // stack-overflows in production. `dimmedIds` folds in find's OWN output (findMatchIds),
    // so findResults/findCandidates must never read it back.
    const findCandidates = /const findCandidates = \$derived\(([\s\S]*?)\n {2}\);/.exec(canvasSrc);
    const findResults = /const findResults = \$derived\.by\(\(\) => \{([\s\S]*?)\n {2}\}\);/.exec(
      canvasSrc
    );
    expect(findCandidates, 'findCandidates declaration not found').toBeTruthy();
    expect(findResults, 'findResults declaration not found').toBeTruthy();

    const findGraph = `${findCandidates![1]}\n${findResults![1]}`;
    expect(findGraph).not.toMatch(/\bdimmedIds\b/);
    expect(findGraph).not.toMatch(/\bfadedIds\b/);
    // …and it still reads the two primitive sources it is allowed to read.
    expect(findGraph).toMatch(/\bnavFilterDimmedIds\b/);
    expect(findGraph).toMatch(/\bhiddenIds\b/);
  });
});
