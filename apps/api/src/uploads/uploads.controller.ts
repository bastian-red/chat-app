/**
 * `/uploads` to store, `/attachments/:id` to read back.
 *
 * Two routes on one controller because they are one feature seen from both ends,
 * and because the path a message carries (`attachmentPath` in `@chat/shared`) has
 * to be served by exactly one handler that every process agrees on.
 *
 * **The multipart body is parsed by hand rather than by multer.** Multer's
 * `limits.fileSize` truncates silently by default and its disk storage writes
 * before anything has inspected the bytes, which is the opposite of what
 * `UploadsService` needs: a limit that aborts, and a type sniffed from the stream.
 * Busboy is what multer uses underneath, and using it directly is a dozen lines
 * with no behaviour hidden inside a framework option.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { Controller, Get, Param, Post, Req, Res, PayloadTooLargeException } from '@nestjs/common';
import { MessagingError } from '@chat/messaging';
import Busboy from 'busboy';
import type { Request, Response } from 'express';

import { CurrentUser } from '../common/session.guard';
import { UploadTooLargeError, UploadsService, type StoredUpload } from './uploads.service';
import type { TokenUser } from '@chat/shared/server';

@Controller()
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post('uploads')
  async upload(@CurrentUser() user: TokenUser, @Req() request: Request): Promise<StoredUpload> {
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string' || !contentType.startsWith('multipart/form-data')) {
      throw new MessagingError('INVALID', 'Send the file as multipart/form-data.');
    }

    return new Promise<StoredUpload>((resolve, reject) => {
      // `files: 1`. Not a size limit: the size is counted in the service, where
      // aborting mid-stream is possible. This one stops a body that carries a
      // hundred parts from turning one request into a hundred writes.
      const busboy = Busboy({ headers: request.headers, limits: { files: 1 } });
      let handled = false;

      busboy.on('file', (_field, stream, info) => {
        handled = true;
        this.uploads
          .store(stream, info.filename, user.id)
          .then(resolve)
          .catch((error: unknown) => {
            // Drained rather than left open. An unconsumed busboy file stream
            // stalls the parser, and the request would hang until the client
            // gave up rather than returning the error that is already known.
            stream.resume();
            reject(
              error instanceof UploadTooLargeError
                ? new PayloadTooLargeException({ code: 'INVALID', message: error.message })
                : error,
            );
          });
      });

      busboy.on('close', () => {
        if (!handled) reject(new MessagingError('INVALID', 'No file was attached.'));
      });
      busboy.on('error', (error: unknown) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });

      request.pipe(busboy);
    });
  }

  /**
   * Stream an attachment back, behind the session.
   *
   * `Content-Disposition: attachment` on everything, including images. The
   * filename came from a browser and the bytes came from a stranger, and
   * `inline` on a type this server sniffed as `application/octet-stream` is how a
   * stored file becomes a page in the API's own origin. A client that wants to
   * render an image does so with an `<img src>`, which ignores the disposition.
   *
   * `X-Content-Type-Options: nosniff` for the other half of the same problem: a
   * browser that sniffs the body can decide a file this server called
   * `application/octet-stream` is HTML.
   */
  @Get('attachments/:attachmentId')
  async download(
    @CurrentUser() user: TokenUser,
    @Param('attachmentId') attachmentId: string,
    @Res() response: Response,
  ): Promise<void> {
    const located = await this.uploads.locate(attachmentId, user.id);

    try {
      await stat(located.path);
    } catch {
      // The row exists and the file does not, which means a crash between the
      // write and the row, or a wiped volume. A 404 with the same wording as a
      // missing row is the honest answer to the client; the log line is where
      // the difference is recorded.
      console.error(`[api] attachment ${attachmentId} has no file at ${located.path}`);
      throw new MessagingError('NOT_FOUND', 'No such attachment.');
    }

    response.setHeader('content-type', located.contentType);
    response.setHeader('content-length', located.byteSize);
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader(
      'content-disposition',
      // The filename is already stripped of quotes and control characters by
      // `safeFilename`, so it cannot break out of this header.
      `attachment; filename="${located.filename}"`,
    );

    createReadStream(located.path).pipe(response);
  }
}
