/**
 * Dangling custom properties.
 *
 * **The failure this catches renders identically to the correct output.** An
 * undeclared custom property inside `calc()` invalidates the *whole declaration*
 * at parse time, so `width: calc(var(--typo) * 1%)` does not fall back to
 * something wrong, it produces no width at all. A progress bar at 0% and a
 * progress bar whose token was misspelled are the same pixels, and nothing in a
 * build, a typecheck or a browser console says which one you are looking at.
 *
 * The rule this file enforces:
 *
 *   a referenced token must be DECLARED, **or** every single reference to it must
 *   carry a fallback.
 *
 * "Some references carry a fallback" is the dangerous middle and is a failure
 * here. It is the state a stylesheet drifts into: somebody hits the bug once,
 * adds a fallback at that call site, and leaves the other four references to
 * fail silently on a different page.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractTokens } from './contrast';

const APP = join(__dirname, '..', 'app');
const globals = readFileSync(join(APP, 'globals.css'), 'utf8');
const layout = readFileSync(join(APP, 'layout.tsx'), 'utf8');

/**
 * Every custom property declared anywhere in the stylesheet.
 *
 * Not `extractTokens`, which reads one block. A token can legitimately be
 * declared in the dark override, on `[data-x]`, or inside a component rule, and a
 * check that only looked at `:root` would report every one of those as dangling.
 */
const declaredInCss = [...globals.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]!);

/**
 * The three the stylesheet cannot declare, because a font loader owns them.
 *
 * `next/font/google` hashes a filename at build time, so the family name does not
 * exist until then; `variable: '--font-prose'` is how it hands the value back, and
 * the property is set on `<html>` by the class the loader returns. Reading them
 * out of `layout.tsx` rather than allowlisting them by name is what keeps this
 * gate honest: rename one on either side and the mismatch still fails here, which
 * an allowlist of three strings would not catch.
 */
const declaredInLayout = [...layout.matchAll(/variable:\s*'(--[\w-]+)'/g)].map(
  (match) => match[1]!,
);

const declared = new Set([...declaredInCss, ...declaredInLayout]);

/** Every `var()` reference, with whether that particular one had a fallback. */
interface Reference {
  name: string;
  hasFallback: boolean;
}

const references: Reference[] = [...globals.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)].map(
  (match) => ({ name: match[1]!, hasFallback: match[2] === ',' }),
);

describe('the stylesheet declares what it references', () => {
  it('references at least a plausible number of tokens, so a broken regex fails loudly', () => {
    // The guard on the guard. If the reference regex stopped matching, every
    // assertion below would pass over an empty list and this gate would report
    // green while checking nothing, which is the exact failure mode
    // `docs/CODESTYLE.md` section 11 is about.
    expect(references.length).toBeGreaterThan(30);
    expect(declared.size).toBeGreaterThan(20);
  });

  it('picks up the font variables the loader declares, not the stylesheet', () => {
    // The guard on the exception above. If `layout.tsx` stopped matching -- a
    // reformat that put the option on two lines, say -- these three would look
    // undeclared and the suite would fail loudly rather than quietly widening.
    expect(declaredInLayout.sort()).toEqual(['--font-mono', '--font-prose', '--font-ui']);
  });

  it('has no reference to an undeclared token without a fallback', () => {
    const dangling = references
      .filter((reference) => !declared.has(reference.name) && !reference.hasFallback)
      .map((reference) => reference.name);

    expect([...new Set(dangling)]).toEqual([]);
  });

  it('does not leave a token half-covered by fallbacks', () => {
    // The dangerous middle. A token that is undeclared and referenced five times
    // with a fallback at only one of them works on the page somebody tested and
    // collapses on the other four.
    const undeclaredNames = new Set(
      references.filter((reference) => !declared.has(reference.name)).map((r) => r.name),
    );

    const halfCovered = [...undeclaredNames].filter((name) => {
      const uses = references.filter((reference) => reference.name === name);
      return uses.some((use) => use.hasFallback) && uses.some((use) => !use.hasFallback);
    });

    expect(halfCovered).toEqual([]);
  });
});

describe('the palette is complete in both schemes', () => {
  /**
   * Tokens whose value must exist in the light block.
   *
   * The dark block is an override *subset* by design, so it is not required to
   * redeclare everything. The light block is the base and a hole in it is a hole
   * everywhere.
   */
  const REQUIRED = [
    '--bg',
    '--surface',
    '--text',
    '--muted',
    '--accent',
    '--accent-ink',
    '--online',
    '--away',
    '--offline',
    '--border',
    '--radius',
  ] as const;

  const light = extractTokens(globals, ':root');
  const darkOverrides = extractTokens(globals, '@media (prefers-color-scheme: dark)');

  it.each(REQUIRED)('%s is declared on bare :root', (token) => {
    // On bare `:root`, not only inside a media query. A colour whose only
    // definition lives in `@media (prefers-color-scheme: dark)` is undefined for
    // every reader whose system is set to light or to no preference, and the
    // default on a fresh browser profile is no preference.
    expect(light[token]).toBeDefined();
  });

  it('overrides every colour it needs to in dark, and nothing it does not', () => {
    // Every dark override must correspond to a light declaration. One that does
    // not is either a typo or a token that exists in one scheme only, and both
    // render as nothing for half the readers.
    const orphans = Object.keys(darkOverrides).filter((token) => light[token] === undefined);

    expect(orphans).toEqual([]);
  });

  it('changes the canvas and the accent between schemes', () => {
    // A dark block that forgot the canvas is a page that stays paper-white with
    // dark-mode text on it, which is the single most common way this goes wrong.
    expect(darkOverrides['--bg']).toBeDefined();
    expect(darkOverrides['--bg']).not.toBe(light['--bg']);
    expect(darkOverrides['--accent']).not.toBe(light['--accent']);
  });
});
