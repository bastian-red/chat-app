/**
 * What must be true before `NestFactory.create` is called.
 *
 * Same property as the gateway's `boot.ts`: **every reason this process will not
 * work is discovered before it is listening.** An API that binds :4000 and then
 * fails on the first upload looks healthy to a container runtime, gets traffic,
 * and produces a user-facing error for an operational fact that was true before
 * the process started.
 *
 * Called from `main.ts` before the Nest application exists, so a failure here is
 * a plain sentence on stderr rather than a framework stack with the one useful
 * line in the middle of it.
 */
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ApiConfig } from './config';

export class BootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootError';
  }
}

/** Relative `UPLOAD_DIR` values resolve against the process's working directory. */
export function uploadRoot(config: ApiConfig): string {
  return resolve(process.cwd(), config.uploadDir);
}

export function assertConsistent(config: ApiConfig): void {
  // Auth is the credential-stuffing surface, so its budget is deliberately far
  // below the global one. A configuration where auth is the looser of the two is
  // almost certainly a copy-paste, and it is the exact mistake that turns a rate
  // limit into decoration.
  if (config.rateLimitAuth >= config.rateLimitGlobal) {
    throw new BootError(
      `RATE_LIMIT_AUTH (${String(config.rateLimitAuth)}) must be below RATE_LIMIT_GLOBAL ` +
        `(${String(config.rateLimitGlobal)}). Auth is the credential-stuffing surface; a budget ` +
        'at or above the general one is not a limit.',
    );
  }

  // The socket frame ceiling is 64 KB and an upload is 10 MB, so they are not the
  // same knob and must not be confused. A ceiling below a kilobyte is a
  // configuration where no real file can be attached, which presents as an upload
  // that always fails with "too large" for a 4 KB PNG.
  if (config.uploadMaxBytes < 1024) {
    throw new BootError(
      `UPLOAD_MAX_BYTES (${String(config.uploadMaxBytes)}) is below one kilobyte, so no real ` +
        'file could be attached.',
    );
  }
}

/**
 * Prove the upload directory is writable, by writing to it.
 *
 * Not `existsSync`, and not a permissions bitmask. The question `/health` answers
 * is "can this process store a file", and the only honest way to ask it is to
 * store one. A directory that exists but is owned by root, or a read-only mount,
 * passes every cheaper check and fails on the first upload.
 *
 * Creating it is part of the check: a fresh clone has no `var/uploads`, and
 * refusing to boot over a directory the process is about to create itself would
 * make the documented `pnpm dev` fail on a clean checkout.
 */
export async function assertUploadsWritable(config: ApiConfig): Promise<void> {
  const root = uploadRoot(config);
  const probe = resolve(root, '.write-probe');

  try {
    await mkdir(root, { recursive: true });
    await writeFile(probe, 'ok');
    await unlink(probe);
  } catch (error) {
    throw new BootError(
      `UPLOAD_DIR (${root}) is not writable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function assertBootable(config: ApiConfig): Promise<void> {
  assertConsistent(config);
  await assertUploadsWritable(config);
}
