/**
 * The values every other contract is built from.
 *
 * Kept in their own module because both the REST DTOs and the socket protocol
 * import them, and a shape defined twice is a shape that drifts. A message's
 * `seq` in particular has to mean the same thing to a history page and to a
 * `message.new` broadcast, or the client reconciling one against the other will
 * disagree with itself about what it has already seen.
 */
import { z } from 'zod';

import { CHANNEL_ROLES } from '../roles';
import { day, type CalendarDay } from '../time/day';

/** A cuid from the database. Never parsed for structure, only for presence. */
export const idSchema = z.string().min(1).max(64);

/**
 * `YYYY-MM-DD`, parsed into the branded `CalendarDay`.
 *
 * The brand is produced **here**, at the boundary that validates it, rather than
 * cast at each call site. That is the whole point of a brand: `CalendarDay` means
 * "this string has been checked", and a `value as CalendarDay` sprinkled through
 * the API and the message list is a claim nobody verified.
 *
 * `day()` rather than the regex alone, because the regex is the cheap half: it
 * accepts `2026-02-31` and `2026-13-01`.
 */
export const calendarDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a calendar day, YYYY-MM-DD')
  .refine((value) => {
    try {
      day(value);
      return true;
    } catch {
      return false;
    }
  }, 'That day does not exist in that month')
  .transform((value): CalendarDay => day(value));

/**
 * A message's position in its channel.
 *
 * A **number**, not a string, and unlike the sibling project's fractional indices
 * it is dense: 1, 2, 3, with no gaps and no room between two of them. That is not
 * a simplification, it is the requirement -- "have I missed anything?" is
 * answerable only if the absence of `n + 1` means something, and a scheme with
 * room between keys can never answer it.
 *
 * The database column is `BIGINT`, so the value can exceed `Number.MAX_SAFE_INTEGER`
 * in theory. It is carried over the wire as a JSON number anyway, deliberately:
 * 2^53 messages in one channel is 285,000 years of one message per second, and a
 * string seq would mean every client-side comparison (`seq > lastSeen`) becomes a
 * BigInt parse in the hot path of rendering a conversation. The repository
 * narrows the BigInt at the boundary and `seqSchema` is what rejects anything
 * that did not survive the narrowing.
 */
export const seqSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * The same, but allowing zero.
 *
 * `lastReadSeq` counts from zero because "has read nothing" needs a value, and
 * seq counts from one so that the two are distinguishable. Sharing one schema
 * between them would make a read marker of 0 fail validation on the way out and
 * an unread count of `nextSeq - 0 - 1` unreachable.
 */
export const readMarkerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * The id a client stamps on a message before it sends it.
 *
 * Opaque to the server, which only ever compares it for equality against
 * `(channel_id, client_message_id)`. Bounded because it reaches an index: an
 * unbounded string here is an unbounded key in a hot B-tree, and Postgres refuses
 * index entries over roughly 2700 bytes with an error about the index rather than
 * about the message.
 *
 * A UUID from `crypto.randomUUID()` is what the client actually sends; the schema
 * does not require that shape, because the server has no reason to care and a
 * stricter rule here would break a client that used a different generator.
 */
export const clientMessageIdSchema = z.string().min(8).max(64);

export const channelKindSchema = z.enum(['PUBLIC', 'PRIVATE', 'DM']);
export type ChannelKind = z.infer<typeof channelKindSchema>;

/**
 * Built from `CHANNEL_ROLES` rather than repeating the three strings.
 *
 * The permission matrix in `roles.ts` is the definition; this is the parser for
 * it. Two independent lists would let a role exist in the matrix and be rejected
 * at the boundary -- a member whose role the API refuses to serialise, which
 * presents as a 500 on their own channel list.
 *
 * `ChannelRole` is re-exported from `roles.ts`, not declared again here, so
 * `import type { ChannelRole }` resolves to one type wherever it comes from.
 */
export const channelRoleSchema = z.enum(CHANNEL_ROLES);
export type { ChannelRole } from '../roles';

/**
 * A channel's URL-safe name.
 *
 * Lowercase, digits and single hyphens, and it must start and end with an
 * alphanumeric. The same expression is a CHECK constraint in
 * `20260811090000_chat_invariants`, because a slug that reaches the database
 * through a path that skipped this schema still ends up in a URL.
 */
export const channelSlugSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'Use lowercase letters, digits and hyphens; start and end with a letter or digit',
  );

export const channelNameSchema = z.string().min(1).max(80);
export const channelTopicSchema = z.string().max(200);

/**
 * A message body.
 *
 * 4000 characters, which is generous for a chat line and far below
 * `SOCKET_MAX_PAYLOAD_BYTES`. The two limits are not the same check and both are
 * needed: this one produces a message a person can act on ("that is too long"),
 * the socket one closes a connection that is sending frames nobody asked for.
 *
 * Trimmed before length is measured, so a body of 4000 spaces is empty rather
 * than at the limit.
 */
export const messageBodySchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1, 'A message needs something in it').max(4000));

/** What somebody is doing in a channel right now. Ephemeral, never stored. */
export const activitySchema = z.enum(['viewing', 'typing']);
export type PresenceActivity = z.infer<typeof activitySchema>;

/**
 * How a member is reachable, for the roster.
 *
 * `online` and `away` are computed from the presence TTL, `offline` is the
 * absence of an entry. Three states rather than two because a chat's roster is
 * read as "can I expect an answer now", and collapsing away into offline makes
 * every colleague at lunch look like they have gone home.
 */
export const presenceStateSchema = z.enum(['online', 'away', 'offline']);
export type PresenceState = z.infer<typeof presenceStateSchema>;
