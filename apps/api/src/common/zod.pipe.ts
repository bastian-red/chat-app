/**
 * A validation pipe that takes a schema, per argument.
 *
 * **Per argument, not global**, and that is the design rather than a shortcut.
 * Nest's usual pattern is a class-validator DTO class per endpoint, and this
 * codebase already has its shapes: they live in `packages/shared` as zod schemas,
 * imported by the client, the gateway and the E2E suite. Adding a DTO class would
 * be a second definition of every request body, and two definitions of one shape
 * agree until one of them changes.
 *
 * A global zod pipe cannot work either, because it has no way to know which
 * schema belongs to which parameter. So the schema is named at the call site:
 *
 *     @Post()
 *     create(@Body(new ZodPipe(createChannelSchema)) input: CreateChannelInput) {}
 *
 * ---------------------------------------------------------------------------
 * The issue list never reaches the client
 *
 * Same rule as the gateway's `dispatch`. Zod's message names internal field paths
 * and, for a value that failed a length rule, quotes the input back. This is a
 * chat: that input is somebody's message body or their password. The response is a
 * fixed sentence plus the field names, which is enough for a form to highlight
 * what to fix and carries none of the values.
 */
import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

@Injectable()
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;

    // Field names only, de-duplicated, and never the values. An empty path (a
    // whole body of the wrong type) yields no fields rather than the string
    // "undefined".
    const fields = [
      ...new Set(
        parsed.error.issues.map((issue) => issue.path.join('.')).filter((path) => path.length > 0),
      ),
    ];

    throw new BadRequestException({
      code: 'INVALID',
      message: 'That request was not in a shape this server accepts.',
      fields,
    });
  }
}
