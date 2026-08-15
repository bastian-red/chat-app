#!/usr/bin/env node
/**
 * Install the git hooks, but only where that makes sense.
 *
 * npm lifecycle `prepare` runs on every install, including inside a Docker build
 * and on a CI runner with no working tree. `simple-git-hooks` there either
 * errors out ("fatal: --local can only be used inside a git repository") or is
 * not installed at all because devDependencies were skipped, and either way it
 * fails the install for no reason.
 *
 * So this checks first and exits quietly when there is nothing to do.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (!existsSync(join(root, '.git'))) {
  process.exit(0);
}

// Skipped devDependencies (a production install) mean the binary is absent.
const binary = join(root, 'node_modules', '.bin', 'simple-git-hooks');
if (!existsSync(binary)) {
  process.exit(0);
}

const result = spawnSync(binary, { stdio: 'inherit', cwd: root });
if (result.status !== 0) {
  console.warn('[hooks] could not install git hooks; commits will not be gated locally');
}
// Deliberately exit 0: a missing hook is a local inconvenience, not a reason to
// fail somebody's install. CI runs the same checks independently.
process.exit(0);
