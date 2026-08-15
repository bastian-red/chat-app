#!/usr/bin/env node
/**
 * Turn a Playwright JSON report into an accessibility baseline.
 *
 * Called by scripts/a11y-baseline.sh; separate because a hundred lines of JSON
 * walking embedded in a heredoc inside a bash script is unreadable and
 * untestable, and this is deterministic work either way: one report in, one
 * table and one file out, same answer every time.
 *
 * The contract with e2e/tests/a11y.spec.ts
 * ----------------------------------------
 * Each axe run attaches its result to the test:
 *
 *   await testInfo.attach('a11y', {
 *     contentType: 'application/json',
 *     body: JSON.stringify({ route: '/dashboard', scheme: 'dark', violations }),
 *   });
 *
 * where `violations` is the array axe returns unchanged. Route and scheme come
 * from the payload rather than from the test title, because a title is prose and
 * prose gets rewritten; if the attachment is missing this falls back to reading
 * them out of the title, and says so, rather than silently reporting zero.
 *
 * Usage: node scripts/a11y-summary.mjs <playwright-report.json> <out.json>
 * Exit:  0 summary written, 1 the report could not be read or held no results.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [reportPath, outPath] = process.argv.slice(2);

if (!reportPath || !outPath) {
  console.error('Usage: node scripts/a11y-summary.mjs <playwright-report.json> <out.json>');
  process.exit(1);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  console.error(`Cannot read ${reportPath}: ${error.message}`);
  process.exit(1);
}

/** Every test in the report, flattened out of Playwright's suite tree. */
function* eachTest(suite) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      yield { title: spec.title, test };
    }
  }
  for (const child of suite.suites ?? []) yield* eachTest(child);
}

/**
 * An attachment's payload, whichever way Playwright chose to carry it.
 *
 * The JSON reporter inlines a body as base64 when the attachment was created
 * from a Buffer or a string, and writes a path when it was created from a file.
 * Handling only one of the two is how this returns "no data" against a report
 * that plainly contains it.
 */
function attachmentBody(attachment) {
  if (typeof attachment.body === 'string') {
    return Buffer.from(attachment.body, 'base64').toString('utf8');
  }
  if (attachment.path) {
    try {
      return readFileSync(attachment.path, 'utf8');
    } catch {
      return null;
    }
  }
  return null;
}

/** `/dashboard (dark)` and `dashboard dark mode` both resolve. */
function fromTitle(title) {
  const route = /(\/[\w\-/[\]]*)/.exec(title)?.[1] ?? title.trim();
  const scheme = /\bdark\b/i.test(title) ? 'dark' : /\blight\b/i.test(title) ? 'light' : 'unknown';
  return { route, scheme };
}

const routes = new Map(); // route -> scheme -> { violations, nodes }
const ruleCounts = new Map(); // axe rule id -> node count
let attachmentsSeen = 0;
let testsSeen = 0;
const inferred = [];

const record = (route, scheme, violations) => {
  if (!routes.has(route)) routes.set(route, new Map());
  const byScheme = routes.get(route);
  const nodes = violations.reduce((sum, violation) => sum + (violation.nodes?.length ?? 0), 0);
  byScheme.set(scheme, { violations: violations.length, nodes });
  for (const violation of violations) {
    const id = violation.id ?? 'unknown';
    ruleCounts.set(id, (ruleCounts.get(id) ?? 0) + (violation.nodes?.length ?? 0));
  }
};

for (const suite of report.suites ?? []) {
  for (const { title, test } of eachTest(suite)) {
    testsSeen += 1;
    let handled = false;
    for (const result of test.results ?? []) {
      for (const attachment of result.attachments ?? []) {
        if (attachment.name !== 'a11y') continue;
        const raw = attachmentBody(attachment);
        if (!raw) continue;
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          continue;
        }
        attachmentsSeen += 1;
        handled = true;
        const fallback = fromTitle(title);
        record(
          payload.route ?? fallback.route,
          payload.scheme ?? fallback.scheme,
          Array.isArray(payload.violations) ? payload.violations : [],
        );
      }
    }
    if (!handled) {
      // No attachment. The only honest thing the report still says is whether
      // the test passed, so a pass is recorded as zero and a failure as an
      // unknown count rather than as a number nobody measured.
      const { route, scheme } = fromTitle(title);
      const passed = (test.results ?? []).some((result) => result.status === 'passed');
      if (!routes.has(route)) routes.set(route, new Map());
      routes.get(route).set(scheme, { violations: passed ? 0 : null, nodes: passed ? 0 : null });
      inferred.push(title);
    }
  }
}

if (testsSeen === 0) {
  console.error('The report contains no tests. Did the a11y spec match anything?');
  process.exit(1);
}

const totals = { violations: 0, nodes: 0, unknown: 0 };
for (const byScheme of routes.values()) {
  for (const counts of byScheme.values()) {
    if (counts.violations === null) totals.unknown += 1;
    else {
      totals.violations += counts.violations;
      totals.nodes += counts.nodes;
    }
  }
}

const baseline = {
  recordedAt: new Date().toISOString(),
  source: reportPath,
  tests: testsSeen,
  attachments: attachmentsSeen,
  totals,
  rules: Object.fromEntries([...ruleCounts].sort((a, b) => b[1] - a[1])),
  routes: Object.fromEntries(
    [...routes]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([route, byScheme]) => [route, Object.fromEntries([...byScheme].sort())]),
  ),
};

writeFileSync(outPath, `${JSON.stringify(baseline, null, 2)}\n`);

// --- The table -------------------------------------------------------------

const schemes = [
  ...new Set([...routes.values()].flatMap((byScheme) => [...byScheme.keys()])),
].sort();
const routeWidth = Math.max(5, ...[...routes.keys()].map((route) => route.length));
// Three states, deliberately distinct on the page: a number, "-" for a
// route/scheme pair the run never covered, and "?" for one it covered but could
// not count. Collapsing the last two into one glyph is how a spec that silently
// stopped running looks like a spec that found nothing.
const cell = (counts) => {
  if (counts === undefined) return '-';
  if (counts.violations === null) return '?';
  return String(counts.violations);
};

console.log('');
console.log(`axe violations, ${new Date().toISOString().slice(0, 10)}`);
console.log('');
console.log(`  ${'route'.padEnd(routeWidth)}  ${schemes.map((s) => s.padStart(7)).join('  ')}`);
console.log(`  ${'-'.repeat(routeWidth)}  ${schemes.map(() => '-'.repeat(7)).join('  ')}`);
for (const [route, byScheme] of [...routes].sort(([a], [b]) => a.localeCompare(b))) {
  const cells = schemes.map((scheme) => cell(byScheme.get(scheme)).padStart(7));
  console.log(`  ${route.padEnd(routeWidth)}  ${cells.join('  ')}`);
}
console.log('');
console.log(`  total   ${totals.violations} violations over ${totals.nodes} nodes`);

if (ruleCounts.size > 0) {
  console.log('');
  console.log('  rules failing, by node count');
  for (const [id, count] of [...ruleCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(4)}  ${id}`);
  }
}

if (attachmentsSeen === 0) {
  console.log('');
  console.log(`  note: no "a11y" attachments in the report, so ${inferred.length} row(s) are`);
  console.log('        pass/fail only. See the contract at the top of scripts/a11y-summary.mjs.');
}

console.log('');
console.log(`Baseline written to ${outPath} (docs/ is gitignored and stays local).`);
