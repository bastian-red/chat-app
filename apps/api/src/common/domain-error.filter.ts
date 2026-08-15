/**
 * `MessagingError` to an HTTP status, in one place.
 *
 * `services/messaging` throws typed codes rather than framework exceptions, which
 * is what lets the same function serve a REST call and a socket event
 * (`docs/CODESTYLE.md` section 5). This filter is the REST half of that mapping;
 * `apps/realtime/src/dispatch.ts` is the socket half.
 *
 * The codes map to statuses that are about the **client's next action**, which is
 * not always the obvious status:
 *
 * - `FORBIDDEN` is 403 and is what "you are not in that channel" answers, not 404.
 *   The reverse leaks nothing either way here, because `NOT_FOUND` is reserved for
 *   a channel that genuinely does not exist and `services/messaging` already
 *   returns FORBIDDEN for a private channel the caller cannot see.
 * - `CONFLICT` is 409 and is retryable: the client id makes the retry idempotent.
 * - `TOO_FAR_BEHIND` is 409 as well, and is the one failure whose correct handling
 *   is **not** a retry. The body's `code` is what the client branches on, which is
 *   exactly why the code is on the wire and not only the status.
 *
 * Every response carries `code`, so a client never has to match on prose. The
 * first time somebody improves the wording, a client that matched on it breaks.
 */
import { MessagingError } from '@chat/messaging';
import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';

const STATUS: Record<MessagingError['code'], number> = {
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  INVALID: HttpStatus.BAD_REQUEST,
  CONFLICT: HttpStatus.CONFLICT,
  TOO_FAR_BEHIND: HttpStatus.CONFLICT,
};

@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof MessagingError) {
      response
        .status(STATUS[exception.code])
        .json({ code: exception.code, message: exception.message });
      return;
    }

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      // A `ZodPipe` failure already threw an object with `code` and `fields`;
      // passing it through unchanged is what keeps the field list on a 400.
      // Nest's own string bodies ("Unauthorized") become an object so every
      // error response on this API has the same shape.
      response
        .status(exception.getStatus())
        .json(typeof body === 'object' ? body : { code: 'INVALID', message: exception.message });
      return;
    }

    // Anything unmapped. The message is logged and a fixed sentence is sent: an
    // unclassified error is by definition one nobody has read, so its text could
    // be a connection string.
    console.error('[api] unhandled exception', exception);
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ code: 'INTERNAL', message: 'Something went wrong on the server.' });
  }
}
