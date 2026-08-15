import { PrismaClient } from '../generated/client';

export * from '../generated/client';
export { PrismaClient };

/**
 * Error codes the services branch on.
 *
 * Two vocabularies, and confusing them fails silently rather than loudly.
 * Prisma's typed client reports its **own** codes -- `P2002` for a unique
 * violation -- while `$queryRaw` and `$executeRaw` surface the underlying
 * Postgres **SQLSTATE**, `23505`. A guard that checks only the SQLSTATE compiles,
 * type-checks, and never fires against an ordinary `create()`.
 *
 * For this app the consequence is the whole send path. A resend carries the
 * client id the first attempt used, trips `@@unique([channelId, clientMessageId])`,
 * and is turned into "here is the message you already sent" -- but only if the
 * catch recognises the violation. A guard that misses one vocabulary turns the
 * ordinary retry-after-a-dropped-ack into a 500, on the exact path the project
 * exists to make safe.
 */
export const PRISMA_UNIQUE_VIOLATION = 'P2002';
export const PRISMA_FOREIGN_KEY_VIOLATION = 'P2003';
export const PRISMA_NOT_FOUND = 'P2025';
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_CHECK_VIOLATION = '23514';

/**
 * Names of the invariants declared in `20260811090000_chat_invariants` and by
 * Prisma's own `@@unique` attributes.
 *
 * Code that catches a constraint violation matches on these rather than on the
 * message text. Postgres error messages are localised and reworded between
 * versions, so a service that greps them breaks on an upgrade, in production, at
 * the exact moment it is trying to report a different error.
 *
 * Three of these are load-bearing rather than defensive:
 *
 * - `MESSAGE_SEQ_UNIQUE` is what makes a duplicated sequence number
 *   *observable*. Without it two messages silently share a seq, the order of the
 *   conversation becomes whatever the query planner produced, and every client's
 *   gap detector sees a hole that will never fill.
 * - `MESSAGE_CLIENT_ID_UNIQUE` is the idempotency of a resend. It is caught, not
 *   avoided: checking first and inserting second is a race, and this is the same
 *   check done atomically by the index.
 * - `CHANNEL_DM_KEY_UNIQUE` is how two people who open a DM with each other at
 *   the same instant end up in one conversation instead of two.
 */
export const MESSAGE_SEQ_UNIQUE = 'messages_channel_id_seq_key';
export const MESSAGE_CLIENT_ID_UNIQUE = 'messages_channel_id_client_message_id_key';
export const CHANNEL_DM_KEY_UNIQUE = 'channels_dm_key_key';
export const CHANNEL_SLUG_UNIQUE = 'channels_slug_key';
export const CHANNEL_SEQ_POSITIVE = 'messages_seq_positive';
export const CHANNEL_NEXT_SEQ_POSITIVE = 'channels_next_seq_positive';
export const CHANNEL_DM_SHAPE = 'channels_dm_shape';
export const CHANNEL_NAMED_SHAPE = 'channels_named_shape';
export const MEMBER_LAST_READ_NOT_NEGATIVE = 'channel_members_last_read_not_negative';
export const CHANNEL_ONE_OWNER = 'channel_members_one_owner_per_channel';
export const ATTACHMENT_SIZE_POSITIVE = 'attachments_byte_size_positive';
export const USER_EMAIL_UNIQUE = 'users_email_key';

interface PgError {
  code?: string;
  message?: string;
  meta?: { constraint?: unknown; target?: unknown; message?: unknown; cause?: unknown };
}

function asError(err: unknown): PgError | null {
  return typeof err === 'object' && err !== null ? (err as PgError) : null;
}

/**
 * The constraint an error is about.
 *
 * Prisma reports it three different ways depending on how the write was made:
 * `meta.constraint` for raw SQL, `meta.target` as a string or as an array of
 * column names for the typed client. Normalising here means every call site asks
 * one question instead of three.
 *
 * The array form matters for this schema specifically. A `message.create()` that
 * trips the idempotency index reports
 * `meta.target: ['channel_id', 'client_message_id']`, not the index name, so a
 * caller comparing against `messages_channel_id_client_message_id_key` would
 * never match -- and the send path would answer 500 to every retry instead of
 * returning the message that is already stored. `matches()` below uses `includes`
 * for that reason, and the constants above are named so that the column-name join
 * is a substring of them.
 */
function constraintName(err: PgError): string {
  const constraint = err.meta?.constraint;
  if (typeof constraint === 'string') return constraint;
  if (Array.isArray(constraint)) return constraint.join(',');
  const target = err.meta?.target;
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) return target.join(',');
  return typeof err.message === 'string' ? err.message : '';
}

/**
 * The SQLSTATE Postgres reported, wherever Prisma happened to put it.
 *
 * There is a third place. When Prisma has no typed code for a constraint kind it
 * raises a `PrismaClientUnknownRequestError` whose `code` is `undefined` and
 * whose message is the raw connector text:
 *
 *   Error occurred during query execution:
 *   ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(
 *     PostgresError { code: "23514", message: "new row for relation \"cards\"
 *     violates check constraint \"cards_position_format\"", ... }) })
 *
 * The SQLSTATE is right there, one level of quoting down. Reading it is not
 * message-grepping in the sense this file warns against: `code: "23514"` is a
 * stable, machine-written field name and a numeric code, not a localised
 * sentence, and the constraint name it is matched against comes from the same
 * structure.
 */
function codeOf(err: PgError): string | null {
  if (typeof err.code === 'string') return err.code;
  if (typeof err.message !== 'string') return null;
  return /\bcode:\s*"([0-9A-Z]{5})"/.exec(err.message)?.[1] ?? null;
}

function hasCode(err: PgError, ...codes: string[]): boolean {
  const code = codeOf(err);
  return code !== null && codes.includes(code);
}

function matches(err: PgError, constraint?: string): boolean {
  if (constraint === undefined) return true;
  const name = constraintName(err);
  if (name.includes(constraint)) return true;
  // The column-name form: `meta.target` is ['channel_id', 'seq'], joined above to
  // 'channel_id,seq'. Prisma's own index name is 'messages_channel_id_seq_key',
  // so ask whether every column named appears in the constraint being tested for.
  // This is what makes a caller able to write
  // `isUniqueViolation(err, MESSAGE_SEQ_UNIQUE)` and have it fire for a write
  // made through the typed client as well as through raw SQL.
  return name.length > 0 && name.split(',').every((part) => constraint.includes(part));
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const error = asError(err);
  if (!error) return false;
  return hasCode(error, PRISMA_UNIQUE_VIOLATION, PG_UNIQUE_VIOLATION) && matches(error, constraint);
}

export function isForeignKeyViolation(err: unknown, constraint?: string): boolean {
  const error = asError(err);
  if (!error) return false;
  return (
    hasCode(error, PRISMA_FOREIGN_KEY_VIOLATION, PG_FOREIGN_KEY_VIOLATION) &&
    matches(error, constraint)
  );
}

export function isCheckViolation(err: unknown, constraint?: string): boolean {
  const error = asError(err);
  if (!error) return false;
  return hasCode(error, PG_CHECK_VIOLATION) && matches(error, constraint);
}

/** A write that expected an existing row and did not find one. */
export function isNotFound(err: unknown): boolean {
  const error = asError(err);
  return error !== null && hasCode(error, PRISMA_NOT_FOUND);
}

/**
 * A sequence collision, specifically.
 *
 * This is the predicate the send path's retry loop is built on, and it is
 * deliberately narrower than `isUniqueViolation`. Retrying is only correct here:
 * the allocator re-reads `next_seq` and the second attempt takes the number the
 * winner did not. Retrying a duplicate `clientMessageId` would be wrong in the
 * opposite direction -- that one is not a collision to resolve, it is the answer,
 * and the caller returns the stored message instead of writing a new one.
 *
 * Under the row lock `UPDATE ... RETURNING next_seq` takes, this should never
 * fire. It exists because "should never" is not an invariant, and because a
 * mistake in the allocator would otherwise present as messages silently vanishing
 * rather than as a retry.
 */
export function isSeqCollision(err: unknown): boolean {
  return isUniqueViolation(err, MESSAGE_SEQ_UNIQUE);
}

/**
 * A resend of a message the server already stored.
 *
 * Not an error at the boundary. `sendMessage` catches exactly this and reads the
 * original row back, so the client's second attempt gets the same id, the same
 * seq and the same body as the first -- which is what makes "the ack never
 * arrived, press send again" safe.
 */
export function isDuplicateClientMessage(err: unknown): boolean {
  return isUniqueViolation(err, MESSAGE_CLIENT_ID_UNIQUE);
}

/**
 * Two people opening the same DM at the same moment.
 *
 * Also not an error. The loser of the INSERT reads the winner's channel back,
 * and both are in one conversation. Answering 409 here would be technically
 * correct and would present as "message failed" for whichever of them clicked
 * second.
 */
export function isDuplicateDmKey(err: unknown): boolean {
  return isUniqueViolation(err, CHANNEL_DM_KEY_UNIQUE);
}

/**
 * Any violation that means "someone else got there first", as opposed to "the
 * request was malformed".
 *
 * The distinction matters at the HTTP boundary: the first is a 409 the user can
 * act on, the second is a 400. Collapsing them into a 500 is how a second person
 * joining a channel becomes a support ticket.
 */
export function isConflict(err: unknown): boolean {
  return isUniqueViolation(err);
}

/**
 * The Prisma adapter for `services/messaging`'s ports.
 *
 * Here rather than in a package of its own, and that placement is forced. The
 * seed writes its conversation through `@chat/messaging` so the messages get real
 * allocated sequence numbers, which means `packages/db` needs the adapter; the
 * adapter needs the generated Prisma client, which lives here. A separate package
 * makes those two facts a cycle, and turbo refuses the task graph outright.
 *
 * Exported last so the constraint-name predicates above are defined before the
 * module that closes over them.
 */
export * from './messaging-repository';
