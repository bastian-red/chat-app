#!/usr/bin/env node
/**
 * Bans invisible characters from source, because a character you cannot see is a
 * bug you cannot review.
 *
 * This exists because of a real one. `budget-status.math.ts` built its map key as
 * a template literal with a raw U+0000 between the two fields, and both the code
 * and the comment documenting it rendered as `${categoryId} ${month}` in every
 * editor, every diff and every code review. The unit test written against what the
 * source appeared to say (`'cat_a 2026-01'`) failed four times over with
 * `expected undefined`, and the obvious next move -- "the code must be wrong" --
 * would have been wrong. The separator was deliberate; only its spelling was not.
 *
 * The rule is simple: write the escape, never the character. `\u00a0` and
 * a space are identical in every editor and every diff, and so are `\u0000` and
 * nothing at all. This turns that rule from a thing to remember into a thing the
 * commit refuses. The escape sequence `\u0000` is seven visible ASCII characters
 * and passes; the byte does not.
 *
 * Usage:
 *   node scripts/invisible-chars.mjs              scan the repo
 *   node scripts/invisible-chars.mjs --self-test  run this file's own cases
 */
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Every code point banned in source, and the name a human needs to act on the
 * report. Two families:
 *
 *   - C0 controls other than tab and newline. A carriage return is included:
 *     every file in this repo is written LF-only, and a stray CRLF inside a shell
 *     script's shebang line is an exec format error that reads as "file not
 *     found". This scanner is the only thing enforcing that -- there is no
 *     .gitattributes here, deliberately, because a `text=auto` rule would rewrite
 *     line endings on checkout and hide exactly what this is looking for.
 *   - The Unicode formatting characters that render as nothing or as a space:
 *     NBSP, the zero-widths, the bidi overrides (a genuine supply-chain trick --
 *     text that reads one way and compiles another), line/paragraph separators,
 *     and the BOM.
 *
 * U+00A0 earns its place twice over: it is what `Intl.NumberFormat('es-ES')` puts
 * before a currency symbol, so it lands in test expectations by copy-paste, where
 * it is indistinguishable from the space a reader assumes.
 */
const BANNED = new Map([
  [0x00, 'U+0000 NULL'],
  [0x0b, 'U+000B VERTICAL TAB'],
  [0x0c, 'U+000C FORM FEED'],
  [0x0d, 'U+000D CARRIAGE RETURN'],
  [0x1b, 'U+001B ESCAPE'],
  [0x00a0, 'U+00A0 NO-BREAK SPACE'],
  [0x00ad, 'U+00AD SOFT HYPHEN'],
  [0x200b, 'U+200B ZERO WIDTH SPACE'],
  [0x200c, 'U+200C ZERO WIDTH NON-JOINER'],
  [0x200d, 'U+200D ZERO WIDTH JOINER'],
  [0x200e, 'U+200E LEFT-TO-RIGHT MARK'],
  [0x200f, 'U+200F RIGHT-TO-LEFT MARK'],
  [0x2028, 'U+2028 LINE SEPARATOR'],
  [0x2029, 'U+2029 PARAGRAPH SEPARATOR'],
  [0x202a, 'U+202A LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'U+202B RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'U+202C POP DIRECTIONAL FORMATTING'],
  [0x202d, 'U+202D LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'U+202E RIGHT-TO-LEFT OVERRIDE'],
  [0x2060, 'U+2060 WORD JOINER'],
  [0xfeff, 'U+FEFF ZERO WIDTH NO-BREAK SPACE (BOM)'],
]);

/** Any other C0 control is banned too; tab and newline are the only ones allowed. */
function nameOf(code) {
  const known = BANNED.get(code);
  if (known !== undefined) return known;
  if (code < 0x20 && code !== 0x09 && code !== 0x0a) {
    return `U+${code.toString(16).toUpperCase().padStart(4, '0')} (C0 control)`;
  }
  return null;
}

/** Source we author. Data files (CSV fixtures, lockfiles, images) are not source. */
const EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.md',
  '.yml',
  '.yaml',
  '.sh',
  '.prisma',
  '.sql',
  '.html',
]);

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  'dist',
  'build',
  'coverage',
  'generated',
  'playwright-report',
  'test-results',
  'assets',
  'docs',
]);

/**
 * Paths exempted from the scan.
 *
 * Empty, and that is the honest state for this project: nothing here is meant to
 * contain an invisible character. A sibling project needed an entry because it
 * ships real bank exports as fixtures -- latin1 bytes, CRLF endings, a BOM --
 * where sanitising the file would delete the test. This one has no such input, so
 * inventing an exemption in advance would only create a hole to fall into.
 *
 * The constant stays rather than being deleted, because the loop below reads it
 * and a future fixture directory should be added here rather than by weakening
 * EXTENSIONS.
 */
const SKIP_PATHS = [];

/** @returns {{line: number, column: number, name: string, excerpt: string}[]} */
export function findInvisible(text) {
  const findings = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    for (let column = 0; column < line.length; column += 1) {
      const name = nameOf(line.codePointAt(column));
      if (name === null) continue;
      findings.push({
        line: index + 1,
        column: column + 1,
        name,
        // The character itself is unprintable, so the report shows its
        // neighbourhood with the offender spelled as an escape. Printing the raw
        // line would reproduce exactly the invisibility being reported.
        excerpt: escapeInvisible(line.slice(Math.max(0, column - 24), column + 24)),
      });
    }
  }
  return findings;
}

/** Rewrites every banned character as its `\uXXXX` escape, for display. */
export function escapeInvisible(text) {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0);
    out += nameOf(code) === null ? character : `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return out;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    const rel = relative(ROOT, full);
    if (SKIP_PATHS.some((skip) => rel === skip || rel.startsWith(`${skip}/`))) continue;
    if (entry.isDirectory()) yield* walk(full);
    else if (EXTENSIONS.has(extname(entry.name))) yield full;
  }
}

const SELF_TESTS = [
  { name: 'clean ASCII passes', text: 'const key = `${a} ${b}`;\n', expected: 0 },
  {
    name: 'tabs and newlines are allowed',
    text: '\tconst a = 1;\n\n\tconst b = 2;\n',
    expected: 0,
  },
  {
    // The exact bug this file exists for.
    name: 'a raw NUL inside a template literal is caught',
    text: 'return `${categoryId}\u0000${month}`;\n',
    expected: 1,
  },
  {
    name: 'the escape sequence spelling the same character passes',
    text: 'return `${categoryId}\\u0000${month}`;\n',
    expected: 0,
  },
  {
    // Pasted out of a browser console after running Intl.NumberFormat('es-ES').
    name: 'NBSP in a test expectation is caught',
    text: "expect(money(123456)).toBe('1.234,56\u00a0€');\n",
    expected: 1,
  },
  { name: 'a BOM is caught', text: '\ufeffimport { a } from "b";\n', expected: 1 },
  { name: 'CRLF is caught', text: '#!/usr/bin/env bash\r\nset -e\r\n', expected: 2 },
  {
    name: 'a bidi override is caught',
    text: 'const admin = false; // \u202eeurt = nimda\n',
    expected: 1,
  },
  {
    name: 'accented Latin and emoji are not invisible and pass',
    text: "const label = 'Café Ñandú ✅ 中文';\n",
    expected: 0,
  },
  {
    name: 'reports the 1-based line and column',
    text: 'ok\nstill ok\nbad\u200bhere\n',
    expected: 1,
    check: (findings) => findings[0].line === 3 && findings[0].column === 4,
  },
  {
    name: 'the excerpt spells the offender as an escape rather than reprinting it',
    text: 'const a = "x\u00a0y";\n',
    expected: 1,
    check: (findings) =>
      findings[0].excerpt.includes('\\u00a0') && !findings[0].excerpt.includes('\u00a0'),
  },
];

function selfTest() {
  let failed = 0;
  for (const testCase of SELF_TESTS) {
    const findings = findInvisible(testCase.text);
    const ok = findings.length === testCase.expected && (testCase.check?.(findings) ?? true);
    if (!ok) {
      failed += 1;
      process.stderr.write(
        `  ✖ ${testCase.name}\n    expected ${testCase.expected} finding(s), got ` +
          `${findings.length}: ${JSON.stringify(findings.map((f) => f.name))}\n`,
      );
    }
  }
  if (failed > 0) {
    process.stderr.write(`\nInvisible-character scanner self-test: ${failed} case(s) failed.\n`);
    process.exit(1);
  }
  process.stdout.write(`Invisible-character scanner self-test: ${SELF_TESTS.length} cases pass.\n`);
}

function scan() {
  let files = 0;
  const violations = [];
  for (const file of walk(ROOT)) {
    files += 1;
    for (const finding of findInvisible(readFileSync(file, 'utf8'))) {
      violations.push({ file: relative(ROOT, file), ...finding });
    }
  }

  if (violations.length > 0) {
    process.stderr.write('Invisible characters in source:\n\n');
    for (const v of violations) {
      process.stderr.write(`  ${v.file}:${v.line}:${v.column}  ${v.name}\n    ${v.excerpt}\n`);
    }
    process.stderr.write(
      `\n${violations.length} violation(s) in ${files} files.\n` +
        'Write the escape (\\u00a0, \\u0000) instead of the character. A character\n' +
        'nobody can see is a character nobody can review.\n',
    );
    process.exit(1);
  }

  process.stdout.write(`No invisible characters: ${files} source files clean.\n`);
}

/**
 * Only scan when run as a program. `findInvisible` is exported so other tooling
 * can reuse the exact ban list rather than reimplementing it a second, slightly
 * different way; importing it must not also walk the repo and call `process.exit`.
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  if (process.argv.includes('--self-test')) selfTest();
  else scan();
}
