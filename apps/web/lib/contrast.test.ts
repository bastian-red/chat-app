/**
 * Every colour pair on this surface, against WCAG AA, in both schemes.
 *
 * **The numbers are derived from the real stylesheet, not from a copy of the
 * palette.** That is the whole design of this file. A table of hexes in
 * TypeScript would pass forever while `app/globals.css` said something else, and
 * the drift is invisible: the page renders, nothing throws, and the only symptom
 * is that somebody cannot read it.
 *
 * AA is 4.5:1 for body text, 3:1 for large text and for non-text UI that carries
 * meaning. `docs/SPECS.md` section 6.2 records the measured values; this file is
 * what makes that table true rather than aspirational, so a hand-edited hex fails
 * the commit.
 *
 * The second half of the file is the one that matters for this product
 * specifically: **the three presence colours are useless against each other**, and
 * that is asserted rather than assumed. Light-mode `online` and `offline` differ
 * by a contrast ratio of 1.00 -- identical relative luminance, the same pixel on a
 * greyscale display and to a reader with deuteranopia. A design that leaned on
 * hue to say who is online would be unreadable for those readers and would look
 * perfect to everybody reviewing it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AA_NORMAL, AA_UI, extractTokens, greyscale, ratio, resolve } from './contrast';

const globals = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8');

/**
 * The dark scheme is an override SUBSET, so it is layered over the light one.
 * Reading it standalone would report every token it inherits as missing.
 */
const light = extractTokens(globals, ':root');
const dark = { ...light, ...extractTokens(globals, '@media (prefers-color-scheme: dark)') };

const SCHEMES = [
  ['light', light],
  ['dark', dark],
] as const;

/** Foreground, background, and the floor that pair has to clear. */
const TEXT_PAIRS = [
  ['--text', '--bg'],
  ['--text', '--surface'],
  ['--muted', '--bg'],
  ['--muted', '--surface'],
  ['--accent', '--bg'],
  ['--accent', '--surface'],
  ['--accent-ink', '--accent'],
  ['--online', '--bg'],
  ['--away', '--bg'],
  ['--offline', '--bg'],
] as const;

/**
 * Non-text pairs, at the lower 3:1 floor.
 *
 * `--border` is here because it is what separates the composer from the
 * conversation and the sidebar from both: a border nobody can see is a layout
 * nobody can parse. `--rule` is deliberately absent -- it is a hairline nothing is
 * distinguished by, and holding decoration to 3:1 would force the page to be
 * louder than it needs to be.
 */
const UI_PAIRS = [
  ['--border', '--bg'],
  ['--border', '--surface'],
] as const;

describe('text contrast clears AA in both schemes', () => {
  for (const [scheme, palette] of SCHEMES) {
    for (const [foreground, background] of TEXT_PAIRS) {
      it(`${scheme}: ${foreground} on ${background}`, () => {
        const value = ratio(resolve(palette, foreground), resolve(palette, background));

        expect(
          value,
          `${scheme} ${foreground} on ${background} is ${value.toFixed(2)}:1, below AA`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);
      });
    }
  }
});

describe('non-text UI clears the 3:1 floor', () => {
  for (const [scheme, palette] of SCHEMES) {
    for (const [foreground, background] of UI_PAIRS) {
      it(`${scheme}: ${foreground} on ${background}`, () => {
        const value = ratio(resolve(palette, foreground), resolve(palette, background));

        expect(value).toBeGreaterThanOrEqual(AA_UI);
      });
    }
  }
});

describe('the accent is reserved', () => {
  it.each(SCHEMES)('%s: no status colour resolves to the accent', (_scheme, palette) => {
    // The cyan was chosen partly to sit far from the green/amber status range, so
    // a mention marker is never read as a presence dot. A status token that
    // resolved to the accent would undo that in one line and nothing would fail.
    const accent = resolve(palette, '--accent').toLowerCase();

    for (const status of ['--online', '--away', '--offline']) {
      expect(resolve(palette, status).toLowerCase(), `${status} must not be the accent`).not.toBe(
        accent,
      );
    }
  });
});

describe('presence cannot be carried by colour, which is why the word exists', () => {
  /**
   * The pairs `docs/SPECS.md` section 6.3 measures.
   *
   * These are assertions that the colours are **indistinguishable**, which reads
   * backwards until you see what it is protecting: the moment somebody "improves"
   * the palette so these separate, the argument for the glyph and the word looks
   * unnecessary, and the next person deletes them. Pinning the collision keeps
   * the reason for the design visible in the test suite.
   */
  const COLLISIONS = [
    ['light', light, '--online', '--away'],
    ['light', light, '--online', '--offline'],
    ['dark', dark, '--online', '--away'],
    ['dark', dark, '--away', '--offline'],
  ] as const;

  it.each(COLLISIONS)(
    '%s: %s and %s are indistinguishable by contrast',
    (_scheme, palette, a, b) => {
      const value = ratio(resolve(palette, a), resolve(palette, b));

      // Below 3:1, which is the floor for anything that carries meaning without
      // text beside it. Every one of these is far below it.
      expect(value).toBeLessThan(AA_UI);
    },
  );

  it('light online and offline have the same relative luminance', () => {
    // 1.00, and the number is the justification for the whole rule: to a reader
    // with deuteranopia, or to anyone on a greyscale display, these are the same
    // pixel. Rounded to two decimals because the underlying value is a float and
    // an exact comparison would be a test about IEEE 754.
    const value = ratio(resolve(light, '--online'), resolve(light, '--offline'));

    expect(Number(value.toFixed(2))).toBe(1.0);
  });

  it.each(SCHEMES)(
    '%s: the status colours still clear AA against the canvas alone',
    (_scheme, palette) => {
      // The other half of the story. Each one is perfectly legible as text on the
      // page; it is only against *each other* that they collapse. A palette where
      // they were also illegible on the canvas would be a different bug.
      for (const status of ['--online', '--away', '--offline']) {
        expect(ratio(resolve(palette, status), resolve(palette, '--bg'))).toBeGreaterThanOrEqual(
          AA_NORMAL,
        );
      }
    },
  );

  it('the collapse survives a greyscale conversion, which is the actual display case', () => {
    // Contrast ratio is already luminance-based, so this is nearly the same
    // question asked a second way. It is here because "greyscale" is the thing a
    // reviewer can actually picture, and a screenshot in a monochrome terminal or
    // a printed page is a real way this product gets looked at.
    const online = greyscale(resolve(light, '--online'));
    const offline = greyscale(resolve(light, '--offline'));

    expect(ratio(online, offline)).toBeLessThan(AA_UI);
  });
});

describe('the parser this file depends on', () => {
  it('reads the dark block from inside its media query', () => {
    // The brace-walking half of `extractTokens`. A scan that stopped at the first
    // `}` would read an empty block here, every token would come back undefined,
    // and every assertion above would fail with "undefined token" rather than
    // with a contrast number -- or worse, would be skipped.
    const overrides = extractTokens(globals, '@media (prefers-color-scheme: dark)');

    expect(overrides['--bg']).toBe('#15191c');
    expect(overrides['--accent']).toBe('#63c9e6');
  });

  it('throws on a token that does not exist rather than skipping it', () => {
    expect(() => resolve(light, '--not-a-token')).toThrow(/undefined token/u);
  });
});
