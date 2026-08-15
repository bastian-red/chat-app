/**
 * Storing an attachment, and serving it back behind the session.
 *
 * Four properties, each with the mechanism that holds it.
 *
 * **1. The size limit is enforced by counting.** Bytes are tallied as they
 * arrive and the stream is destroyed the moment the count passes
 * `UPLOAD_MAX_BYTES`. `Content-Length` is a claim: a client can send a header
 * that says 1 KB and then stream a gigabyte, and a check against the header would
 * pass before the first byte hit the disk.
 *
 * **2. The content type comes from the bytes.** See `sniff.ts`. A declared type is
 * attacker-controlled, and the stored type is what the download route sets.
 *
 * **3. The storage key is generated here.** Never the uploaded filename: that
 * arrives from a browser and can contain `../`, which would make the upload route
 * a write primitive anywhere the process can reach.
 *
 * **4. Downloads go through the session.** The directory is not served statically.
 * An attachment on a message is readable by that channel's members; an orphan --
 * uploaded, never sent -- is readable by its uploader alone.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';

import { Inject, Injectable } from '@nestjs/common';
import { MessagingError } from '@chat/messaging';

import { API_CONFIG, type ApiConfig } from '../config/config';
import { PrismaService } from '../infra/prisma.service';
import { SNIFF_BYTES, safeFilename, sniffContentType } from './sniff';
import { uploadRoot } from '../config/boot';

export class UploadTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`That file is larger than the ${String(limit)} byte limit.`);
    this.name = 'UploadTooLargeError';
  }
}

export interface StoredUpload {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
}

@Injectable()
export class UploadsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * Stream one file to disk, then record it.
   *
   * The row is written **after** the bytes land, not before. A row that pointed at
   * a file the write never finished would be an attachment that 404s for
   * everybody in the channel, and a failed upload would need a compensating
   * delete. This way a crash mid-write leaves a file nobody references, which is
   * a disk-space problem rather than a correctness one.
   */
  async store(source: Readable, rawFilename: string, uploaderId: string): Promise<StoredUpload> {
    const root = uploadRoot(this.config);
    // Two levels of fan-out from a hash of the id. A flat directory with 100,000
    // files is slow to list and slow to stat on most filesystems, and this is the
    // cheapest fix that needs no index.
    const id = randomUUID();
    const shard = createHash('sha256').update(id).digest('hex').slice(0, 4);
    const storageKey = join(shard.slice(0, 2), shard.slice(2, 4), id);
    const target = resolve(root, storageKey);

    await mkdir(dirname(target), { recursive: true });

    const limit = this.config.uploadMaxBytes;
    let byteSize = 0;
    const head: number[] = [];

    // A pass-through that counts and peeks. Both jobs have to happen *during* the
    // stream rather than after it: the limit is meaningless once the bytes are on
    // disk, and the first twelve bytes are gone by the time the file is closed.
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        byteSize += chunk.length;
        if (byteSize > limit) {
          // Erroring here aborts the pipeline, which destroys the write stream.
          // Letting the upload finish and checking the total afterwards means the
          // disk already holds whatever was sent, which is the whole attack.
          callback(new UploadTooLargeError(limit));
          return;
        }
        if (head.length < SNIFF_BYTES) {
          for (const byte of chunk.subarray(0, SNIFF_BYTES - head.length)) head.push(byte);
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(source, meter, createWriteStream(target));
    } catch (error) {
      // The partial file goes, whatever the failure was. The unlink's own failure
      // is swallowed on purpose: the pipeline may never have created the file, and
      // an ENOENT here would replace the real error with a misleading one.
      await unlink(target).catch(() => undefined);
      throw error;
    }

    if (byteSize === 0) {
      await unlink(target).catch(() => undefined);
      throw new MessagingError('INVALID', 'That file is empty.');
    }

    const attachment = await this.prisma.attachment.create({
      data: {
        id,
        filename: safeFilename(rawFilename),
        // From the bytes, never from the request header.
        contentType: sniffContentType(Uint8Array.from(head)),
        byteSize,
        storageKey,
        uploadedById: uploaderId,
      },
    });

    return {
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.contentType,
      byteSize: attachment.byteSize,
    };
  }

  /**
   * Locate an attachment the caller is allowed to read.
   *
   * Two cases, and both are real:
   *
   * - **Attached.** Readable by the members of the message's channel. That is a
   *   membership lookup, not a check on the message's author: everybody in the
   *   channel can see the message, so everybody in it can see its file.
   * - **Orphan.** Uploaded and never sent, because somebody attached a file and
   *   closed the tab. Readable by its uploader alone, since there is no channel
   *   to ask about.
   *
   * `NOT_FOUND` for both "no such row" and "not allowed", deliberately: a 403 on
   * an id somebody guessed confirms the id exists.
   */
  async locate(
    attachmentId: string,
    userId: string,
  ): Promise<{
    path: string;
    filename: string;
    contentType: string;
    byteSize: number;
  }> {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      select: {
        filename: true,
        contentType: true,
        byteSize: true,
        storageKey: true,
        messageId: true,
        uploadedById: true,
        message: { select: { channelId: true } },
      },
    });

    if (!attachment) throw new MessagingError('NOT_FOUND', 'No such attachment.');

    const allowed =
      attachment.message === null
        ? attachment.uploadedById === userId
        : (await this.prisma.channelMember.findUnique({
            where: {
              channelId_userId: { channelId: attachment.message.channelId, userId },
            },
            select: { userId: true },
          })) !== null;

    if (!allowed) throw new MessagingError('NOT_FOUND', 'No such attachment.');

    return {
      // Resolved against the root. The key was generated by `store` from a UUID
      // and never from the uploaded filename, so it cannot contain a traversal;
      // that is the invariant this line depends on, and it is why the filename is
      // stored as a label rather than used as a path.
      path: resolve(uploadRoot(this.config), attachment.storageKey),
      filename: attachment.filename,
      contentType: attachment.contentType,
      byteSize: attachment.byteSize,
    };
  }
}
