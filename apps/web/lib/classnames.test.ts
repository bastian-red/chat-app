/**
 * Class names that exist in a component and nowhere in the stylesheet.
 *
 * **The failure this catches is silence.** `className="messge-row"` compiles,
 * typechecks, renders, and produces an unstyled element in the middle of a styled
 * page. React says nothing, the browser says nothing, and the only signal is that
 * one row looks wrong in a screenshot nobody diffs. It is the same shape of bug as
 * a dangling custom property, one level up.
 *
 * The rule: every class a component names must appear as a selector in
 * `app/globals.css`. This project has no CSS modules and no utility framework, so
 * that is a complete statement rather than an approximation -- there is exactly
 * one stylesheet and it is hand-written.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const WEB = join(__dirname, '..');
const globals = readFileSync(join(WEB, 'app', 'globals.css'), 'utf8');

/**
 * Both directories that hold components, not just `app/`.
 *
 * `components/` is where every client component lives -- the conversation, the
 * composer, the presence chip -- which is to say almost every class in the
 * product. A gate that walked `app/` alone would pass over them and report green,
 * which is exactly the shape of failure this file exists to catch one level down.
 */
const ROOTS = [join(WEB, 'app'), join(WEB, 'components')];

/** Every `.class` that appears as a selector anywhere in the stylesheet. */
const styled = new Set([...globals.matchAll(/\.([a-z][\w-]*)/g)].map((match) => match[1]!));

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

/**
 * Every class name a component asks for, with the file it came from.
 *
 * Only static `className="..."` and `className={\`...\`}` are read. A computed
 * class (`className={styles[state]}`) is deliberately out of scope: this gate is
 * a cheap string check, not a dataflow analysis, and pretending otherwise would
 * either produce false failures or invite an exception list that hides real ones.
 * Where a class is computed, the component gets a unit test instead.
 */
interface Usage {
  file: string;
  name: string;
}

const usages: Usage[] = ROOTS.flatMap(walk).flatMap((file) => {
  const source = readFileSync(file, 'utf8');
  const found: Usage[] = [];

  for (const match of source.matchAll(/className=(?:"([^"]*)"|\{`([^`$]*)`\})/g)) {
    const value = match[1] ?? match[2] ?? '';
    for (const name of value.split(/\s+/u).filter((part) => part.length > 0)) {
      found.push({ file: file.slice(WEB.length + 1), name });
    }
  }

  return found;
});

describe('every class a component names is in the stylesheet', () => {
  it('found some, so a broken regex fails loudly rather than passing over nothing', () => {
    // The guard on the guard. A gate that silently checks an empty list is worse
    // than no gate, because it reports green (`docs/CODESTYLE.md` section 11).
    expect(usages.length).toBeGreaterThan(25);
    expect(styled.size).toBeGreaterThan(10);
  });

  it('has no class that renders nothing', () => {
    const unstyled = usages.filter((usage) => !styled.has(usage.name));

    expect(
      unstyled.map((usage) => `${usage.file}: .${usage.name}`),
      'these classes appear in a component and in no rule in app/globals.css',
    ).toEqual([]);
  });
});
