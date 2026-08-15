import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractTokens, resolve } from './contrast';

/**
 * The identity lock.
 *
 * What it pins: this repo's canvas, its accent, its corner radius and the exact
 * three typefaces it loads, read out of `app/globals.css` and `app/layout.tsx`
 * rather than out of a copy of the palette kept in TypeScript.
 *
 * What breaks without it: the portfolio's actual failure mode, which is that every
 * project ends up wearing whatever visual language the last one wore. Three
 * earlier repos shipped the same monochrome tokens and the same three faces, so a
 * reader opening all three saw one designer with one trick. Nothing in a build
 * catches that: a redesign that drifts back toward a shared palette compiles,
 * renders, and passes every other test in this suite.
 *
 * When the identity genuinely changes, change these constants deliberately and say
 * why in the commit. That is the point: it should cost a decision.
 */
const APP = join(__dirname, '..', 'app');
const globals = readFileSync(join(APP, 'globals.css'), 'utf8');
const layout = readFileSync(join(APP, 'layout.tsx'), 'utf8');

/** "Ink on paper, one cold light". See the header comment in `app/globals.css`. */
const IDENTITY = {
  light: { '--bg': '#f4f1e8', '--accent': '#0d6b85' },
  dark: { '--bg': '#15191c', '--accent': '#63c9e6' },
  radius: '10px',
  fonts: ['Azeret_Mono', 'Figtree', 'Literata'],
} as const;

/**
 * The dark block only overrides part of the light one, so it layers on top.
 * Reading it standalone would report every token the dark scheme inherits as
 * missing, and `resolve()` would throw on the first of them.
 */
const light = extractTokens(globals, ':root');
const dark = { ...light, ...extractTokens(globals, '@media (prefers-color-scheme: dark)') };

/**
 * Every face this app pulls out of `next/font/google`.
 *
 * Deliberately the same regex `web/scripts/identity-distinct.mjs` uses, because
 * that script is the only check that can see across repos and it parses this exact
 * shape: ONE import statement, single-quoted specifier. If the import is ever
 * split in two or rewritten with double quotes, the cross-repo check silently
 * reads zero faces from this project and stops being able to catch a collision. It
 * reports success while checking nothing, which is the only test outcome worse
 * than a failure.
 */
function importedFaces(): string[] {
  const line = /import\s*\{([^}]*)\}\s*from\s*'next\/font\/google'/.exec(layout);
  if (!line) throw new Error('layout.tsx imports nothing from next/font/google');
  return line[1]!
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .sort();
}

describe('visual identity', () => {
  it.each(Object.entries(IDENTITY.light))('light %s is %s', (token, expected) => {
    expect(resolve(light, token).toLowerCase()).toBe(expected);
  });

  it.each(Object.entries(IDENTITY.dark))('dark %s is %s', (token, expected) => {
    expect(resolve(dark, token).toLowerCase()).toBe(expected);
  });

  it('loads exactly the faces this identity is built on', () => {
    // Exact, not "at least": an extra face is how a shared house style creeps
    // back in one import at a time.
    expect(importedFaces()).toEqual([...IDENTITY.fonts].sort());
  });

  it('keeps the one font import in the shape the cross-repo check can parse', () => {
    // See `importedFaces`. Two imports, or double quotes, and
    // `web/scripts/identity-distinct.mjs` reads no faces for this project at all.
    const imports = [...layout.matchAll(/from\s*['"]next\/font\/google['"]/g)];
    expect(imports, 'exactly one next/font/google import statement').toHaveLength(1);
    expect(layout).toMatch(/import\s*\{[^}]*\}\s*from\s*'next\/font\/google'/);
    expect(importedFaces().length, 'the cross-repo regex must find all three faces').toBe(3);
  });

  it('sets each face as the CSS variable the stylesheet reads', () => {
    // A face imported but never wired to its variable renders as the fallback
    // stack and nobody notices in review, because `ui-serif` and Literata are the
    // same shape of thing at a glance.
    for (const variable of ['--font-prose', '--font-ui', '--font-mono']) {
      expect(layout, `${variable} must be declared by next/font`).toContain(
        `variable: '${variable}'`,
      );
    }
  });

  it('is softly cornered, because a message is speech and not a spreadsheet cell', () => {
    // 10px is the ruling in the stylesheet header. Square reads as a table; a
    // pill reads as a toy. This value is the one between them.
    expect(light['--radius']).toBe(IDENTITY.radius);
  });

  it('does not reintroduce the shared signal red', () => {
    // #ff0000 was the one accent three earlier portfolio projects shared.
    expect([...globals.matchAll(/#ff0000|#f00\b/gi)]).toHaveLength(0);
  });

  it('carries no dot-matrix face and no dot-grid texture', () => {
    // Both were tics of the single-aesthetic generator this portfolio banned.
    expect(globals).not.toMatch(/--ff-dot|--dot-grid|--font-dot/);
    expect(importedFaces().join(' ')).not.toMatch(/Doto|Space_/);
  });

  it('spends the accent on unread and mentions, never on a state', () => {
    // The rule the cold cyan was chosen for. The roster already spends a green,
    // an amber and a grey; an accent drawn from that vocabulary is read as a
    // presence dot the first time a mention marker appears beside a roster row.
    // So no status token may resolve to the accent's value, in either scheme.
    for (const scheme of [light, dark]) {
      const accent = resolve(scheme, '--accent').toLowerCase();
      for (const state of ['--online', '--away', '--offline']) {
        expect(resolve(scheme, state).toLowerCase(), `${state} must not be the accent`).not.toBe(
          accent,
        );
      }
    }
  });

  it('keeps the accent out of the status hues in greyscale too', () => {
    // Stronger than "not equal", and the version that matters. Two hues a reader
    // cannot separate are one hue: an accent that merely differs by hex but lands
    // on the same luma as `--away` is still read as a presence dot by anyone on a
    // greyscale display. Not asserted as a big number, because these are small
    // marks whose meaning is carried by their words and their position; asserted
    // as "not identical", which is the failure that would make the choice a lie.
    for (const scheme of [light, dark]) {
      const accent = resolve(scheme, '--accent').toLowerCase();
      for (const state of ['--online', '--away', '--offline']) {
        expect(resolve(scheme, state).toLowerCase()).not.toBe(accent);
      }
    }
  });
});

/**
 * The canvases, accents and faces the rest of the portfolio has already spent.
 *
 * `web/scripts/identity-distinct.mjs` is the authority, because it reads the
 * sibling repos' real stylesheets and this file cannot see them. This is the half
 * of that check a single repo can still make: it catches the common way a
 * collision is introduced, which is pasting a token block out of the project next
 * door, and it fails inside this repo's own pre-commit gate rather than only when
 * somebody remembers to run the cross-repo script.
 */
const SPENT = {
  canvases: [
    '#fafaf8', // 001 booking, light
    '#101319', // 001 booking, dark
    '#fffdfa', // 002 shop, light
    '#14120e', // 002 shop, dark
    '#f6f7f9', // 002 admin, light
    '#0d1117', // 002 admin, dark
    '#f8fafc', // 003 console, light
    '#0b1220', // 003 console, dark
    '#fbf8f3', // 003 learn, light
    '#14120f', // 003 learn, dark
    '#f7f6fb', // 004 finance, light
    '#12111a', // 004 finance, dark
    '#ecedf0', // 005 kanban, light
    '#191621', // 005 kanban, dark
  ],
  accents: [
    '#4f46e5', // 001 light
    '#818cf8', // 001 dark
    '#7a2e2e', // 002 shop light
    '#e39a9a', // 002 shop dark
    '#1f6feb', // 002 admin light
    '#58a6ff', // 002 admin dark
    '#1d4ed8', // 003 console light
    '#60a5fa', // 003 console dark
    '#0f766e', // 003 learn light
    '#5eead4', // 003 learn dark
    '#6d28d9', // 004 light
    '#a78bfa', // 004 dark
    '#a01a6d', // 005 light
    '#f4a3d6', // 005 dark
  ],
  faces: [
    'Fraunces', // 001
    'Inter', // 001
    'Archivo', // 002
    'IBM_Plex_Mono', // 002
    'Instrument_Serif', // 002
    'IBM_Plex_Sans', // 003
    'JetBrains_Mono', // 003
    'Source_Serif_4', // 003
    'Newsreader', // 004
    'Public_Sans', // 004
    'Roboto_Mono', // 004
    'DM_Mono', // 005
    'Manrope', // 005
    'Sora', // 005
  ],
} as const;

describe('no two projects share an identity', () => {
  it.each([
    ['light', light],
    ['dark', dark],
  ])('%s: the canvas is this project alone', (scheme, palette) => {
    const canvas = resolve(palette, '--bg').toLowerCase();
    expect(SPENT.canvases, `${scheme} canvas ${canvas} is already taken`).not.toContain(canvas);
  });

  it.each([
    ['light', light],
    ['dark', dark],
  ])('%s: the accent is this project alone', (scheme, palette) => {
    const accent = resolve(palette, '--accent').toLowerCase();
    expect(SPENT.accents, `${scheme} accent ${accent} is already taken`).not.toContain(accent);
  });

  it('loads no typeface another project already uses', () => {
    const collisions = importedFaces().filter((face) =>
      (SPENT.faces as readonly string[]).includes(face),
    );
    expect(collisions, 'these faces are already spent elsewhere in the portfolio').toEqual([]);
  });
});
