/**
 * WCAG contrast arithmetic, and a parser for the tokens it runs against.
 *
 * Contrast is the same input for the same output every time, so it does not
 * belong in anyone's judgement: not a designer's eye and not a model's. It
 * belongs in a function with a test around it. `contrast.test.ts` reads the real
 * `app/globals.css`, pulls the palette out of it, and fails the commit when a pair
 * drops below AA.
 *
 * Reading the stylesheet rather than duplicating the palette in TypeScript is
 * deliberate. A copy drifts, and a contrast test that passes against a stale copy
 * of the colours is worse than no test, because it reports safety that is not
 * there. `docs/SPECS.md` §6.2 quotes the numbers this file produces; the file is
 * the authority and the table is the transcript.
 *
 * Formulae: WCAG 2.1 relative luminance and contrast ratio.
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** AA thresholds. Large text is >=18.66px bold or >=24px. */
export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;
/** Non-text UI (borders, control boundaries, focus rings), WCAG 1.4.11. */
export const AA_UI = 3;

export function parseHex(value: string): Rgb {
  const hex = value.trim().replace(/^#/, '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((char) => char + char)
          .join('')
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`not a hex colour: ${value}`);
  }
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

/** WCAG relative luminance, on the linearised sRGB channels. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (raw: number): number => {
    const scaled = raw / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two colours, 1..21, order-independent. */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(parseHex(a));
  const second = relativeLuminance(parseHex(b));
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Rounded to 2dp, so a failure message reads like the numbers designers quote. */
export function ratio(a: string, b: string): number {
  return Math.round(contrastRatio(a, b) * 100) / 100;
}

/**
 * The greyscale twin of a colour, as a hex string.
 *
 * Rec. 601 luma, which is what a greyscale display and most colour-blindness
 * simulations use. It exists so the "colour is never the only channel" rule is a
 * measurement rather than a claim: `contrast.test.ts` runs the three presence
 * hues through this and shows they collapse into each other.
 */
export function greyscale(hex: string): string {
  const { r, g, b } = parseHex(hex);
  const value = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  return `#${[value, value, value].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Extract CSS custom properties from one selector block.
 *
 * Intentionally small rather than a real CSS parser: the stylesheet is
 * hand-written and flat, and pulling in a parser to read `--x: #fff` lines would
 * be more dependency than the job needs. It matches the *first* block whose
 * selector text matches, which is all `:root` and the dark-scheme override are.
 */
export function extractTokens(css: string, selector: string): Record<string, string> {
  const index = css.indexOf(selector);
  if (index === -1) throw new Error(`selector not found in stylesheet: ${selector}`);

  const open = css.indexOf('{', index);
  if (open === -1) throw new Error(`no block opens after ${selector}`);

  // Walk braces so a nested block does not terminate the scan early. The dark
  // palette is a `:root` INSIDE `@media (prefers-color-scheme: dark)`, so a scan
  // that stopped at the first `}` would read an empty block, every token would
  // come back undefined, and `resolve` would throw on the first one. Stopping at
  // the first `}` is the version of this function that looks right in review.
  let depth = 0;
  let end = -1;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`unterminated block for ${selector}`);

  const body = css.slice(open + 1, end);
  const tokens: Record<string, string> = {};
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[match[1]!] = match[2]!.trim();
  }
  return tokens;
}

/**
 * Resolve a token to a literal hex value, following `var(--other)` hops.
 *
 * Throws rather than returning undefined: a token that cannot be resolved means
 * the test is silently skipping a colour, which is the failure mode this whole
 * file exists to prevent. An `undefined` reaching `parseHex` would throw anyway,
 * but three frames later and with a message naming the wrong thing.
 */
export function resolve(
  tokens: Record<string, string>,
  name: string,
  seen: Set<string> = new Set(),
): string {
  if (seen.has(name)) throw new Error(`circular token reference at ${name}`);
  seen.add(name);

  const raw = tokens[name];
  if (raw === undefined) throw new Error(`undefined token: ${name}`);

  const indirect = /^var\(\s*(--[\w-]+)\s*\)$/.exec(raw);
  if (indirect) return resolve(tokens, indirect[1]!, seen);

  // Strip a trailing comment, which the stylesheet uses on some colour lines.
  const cleaned = raw.replace(/\/\*.*?\*\//g, '').trim();
  if (!/^#[0-9a-fA-F]{3,8}$/.test(cleaned)) {
    throw new Error(`token ${name} is not a plain hex colour: ${raw}`);
  }
  return cleaned;
}
