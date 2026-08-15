/**
 * Recognising a Postgres violation, whichever shape Prisma hands it over in.
 *
 * The predicates in `index.ts` are what every `catch` in the write path branches
 * on, and getting one wrong is not a loud failure. A duplicate `clientMessageId`
 * the classifier does not recognise becomes a 500 on somebody's second attempt to
 * send one message; a seq collision it does not recognise becomes a message that
 * vanishes instead of a retry that succeeds.
 *
 * **Three shapes, and the third is why this file exists.** Prisma reports the same
 * database event three different ways depending on which typed code it has:
 *
 *   1. `PrismaClientKnownRequestError` with `code: 'P2002'` and `meta.target` as
 *      the *column list* -- what the typed client throws for a unique index.
 *   2. The same error with `meta.constraint` as the index *name* -- what a raw
 *      query throws, with the SQLSTATE rather than the P-code.
 *   3. `PrismaClientUnknownRequestError`, whose `code` is `undefined` and whose
 *      message is the raw connector text with `code: "23514"` quoted inside it.
 *      Prisma has no typed code for a CHECK constraint, and this project has ten
 *      of them.
 *
 * A classifier that only knew shape 1 would work in every unit test written
 * against the typed client and fail against the raw `UPDATE ... RETURNING` the
 * sequence allocator is built on.
 *
 * The fixtures below are the real error objects, recorded rather than invented:
 * every constraint in `20260811090000_chat_invariants` was tripped by hand against
 * a real Postgres and the resulting object written down.
 */
import { describe, expect, it } from 'vitest';

import {
  CHANNEL_DM_KEY_UNIQUE,
  MESSAGE_CLIENT_ID_UNIQUE,
  MESSAGE_SEQ_UNIQUE,
  isCheckViolation,
  isConflict,
  isDuplicateClientMessage,
  isDuplicateDmKey,
  isForeignKeyViolation,
  isNotFound,
  isSeqCollision,
  isUniqueViolation,
} from './index';

/** Shape 1: what the typed client throws when two messages take one seq. */
const TYPED_SEQ_COLLISION = {
  code: 'P2002',
  message: 'Unique constraint failed on the fields: (`channel_id`,`seq`)',
  meta: { target: ['channel_id', 'seq'] },
};

/** Shape 1, for a resent `clientMessageId`. */
const TYPED_CLIENT_ID_DUPLICATE = {
  code: 'P2002',
  message: 'Unique constraint failed on the fields: (`channel_id`,`client_message_id`)',
  meta: { target: ['channel_id', 'client_message_id'] },
};

/** Shape 1, for two people opening the same DM in the same instant. */
const TYPED_DM_KEY_DUPLICATE = {
  code: 'P2002',
  message: 'Unique constraint failed on the fields: (`dm_key`)',
  meta: { target: ['dm_key'] },
};

/** Shape 1, for a second membership row. Not any of the three above. */
const TYPED_MEMBER_DUPLICATE = {
  code: 'P2002',
  message: 'Unique constraint failed on the fields: (`channel_id`,`user_id`)',
  meta: { target: ['channel_id', 'user_id'] },
};

/** Shape 2: the raw form, with the index name and the SQLSTATE. */
const RAW_SEQ_COLLISION = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "messages_channel_id_seq_key"',
  meta: { constraint: 'messages_channel_id_seq_key' },
};

/** Shape 2, for the partial index that allows at most one owner per channel. */
const RAW_SECOND_OWNER = {
  code: '23505',
  message:
    'duplicate key value violates unique constraint "channel_members_one_owner_per_channel"',
  meta: { constraint: 'channel_members_one_owner_per_channel' },
};

/** Shape 2, for a CHECK. */
const RAW_BLANK_BODY = {
  code: '23514',
  message: 'new row for relation "messages" violates check constraint "messages_body_not_blank"',
  meta: { constraint: 'messages_body_not_blank' },
};

/**
 * Shape 3: no code at all, the SQLSTATE quoted inside the connector's text.
 *
 * This is what a CHECK violation looks like coming back from a raw query, and it
 * is the shape a classifier written against the typed client alone misses
 * entirely.
 */
const UNKNOWN_DM_SHAPE = {
  code: undefined,
  message:
    'Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, ' +
    'kind: QueryError(PostgresError { code: "23514", message: "new row for relation \\"channels\\" violates ' +
    'check constraint \\"channels_dm_shape\\"", severity: "ERROR", detail: None, column: None, ' +
    'hint: None }) })',
};

describe('a sequence collision is recognised however it arrives', () => {
  it('recognises the typed column-list form', () => {
    // `meta.target` is `['channel_id', 'seq']`, not the index name. The predicate
    // has to relate the columns to `messages_channel_id_seq_key` itself.
    expect(isSeqCollision(TYPED_SEQ_COLLISION)).toBe(true);
  });

  it('recognises the raw constraint-name form', () => {
    // The form the allocator's own `UPDATE ... RETURNING` produces, which is the
    // one path in this project that does not go through the typed client.
    expect(isSeqCollision(RAW_SEQ_COLLISION)).toBe(true);
  });

  it('does not mistake a resent client id for a seq collision', () => {
    // The distinction the send path's retry loop depends on. Retrying a seq
    // collision is correct: the allocator re-reads and takes the next number.
    // Retrying a duplicate client id is wrong in the opposite direction -- that
    // one is the answer, and the caller reads the stored message back instead of
    // writing a second one.
    expect(isSeqCollision(TYPED_CLIENT_ID_DUPLICATE)).toBe(false);
  });

  it('does not mistake a second membership row for a seq collision', () => {
    expect(isSeqCollision(TYPED_MEMBER_DUPLICATE)).toBe(false);
  });
});

describe('a resend is recognised as a resend', () => {
  it('recognises the typed form', () => {
    expect(isDuplicateClientMessage(TYPED_CLIENT_ID_DUPLICATE)).toBe(true);
  });

  it('does not fire on a seq collision', () => {
    expect(isDuplicateClientMessage(TYPED_SEQ_COLLISION)).toBe(false);
  });
});

describe('a DM race is recognised as a DM race', () => {
  it('recognises the typed form', () => {
    // Not an error at the boundary: the loser reads the winner's channel back and
    // both people end up in one conversation. Answering 409 would present as
    // "could not open conversation" for whichever of them clicked second.
    expect(isDuplicateDmKey(TYPED_DM_KEY_DUPLICATE)).toBe(true);
  });

  it('does not fire on any other unique violation', () => {
    expect(isDuplicateDmKey(TYPED_SEQ_COLLISION)).toBe(false);
    expect(isDuplicateDmKey(TYPED_MEMBER_DUPLICATE)).toBe(false);
  });
});

describe('constraint names are matched, never message text', () => {
  it('matches a named unique constraint', () => {
    expect(isUniqueViolation(RAW_SEQ_COLLISION, MESSAGE_SEQ_UNIQUE)).toBe(true);
    expect(isUniqueViolation(RAW_SEQ_COLLISION, MESSAGE_CLIENT_ID_UNIQUE)).toBe(false);
    expect(isUniqueViolation(TYPED_DM_KEY_DUPLICATE, CHANNEL_DM_KEY_UNIQUE)).toBe(true);
  });

  it('recognises the partial one-owner index', () => {
    // Prisma cannot express "at most one row per channel where role = OWNER", so
    // this index exists only in the invariants migration and only ever arrives in
    // the raw form.
    expect(isUniqueViolation(RAW_SECOND_OWNER, 'channel_members_one_owner_per_channel')).toBe(
      true,
    );
  });

  it('recognises a CHECK violation in the raw form', () => {
    expect(isCheckViolation(RAW_BLANK_BODY, 'messages_body_not_blank')).toBe(true);
  });

  it('recognises a CHECK violation with no code, from the connector text', () => {
    // Shape 3. `code` is undefined and the SQLSTATE is one level of quoting down
    // inside the message. Reading it is not message-grepping in the sense this
    // file warns against: `code: "23514"` is a machine-written field name and a
    // numeric code, not a localised sentence.
    expect(isCheckViolation(UNKNOWN_DM_SHAPE, 'channels_dm_shape')).toBe(true);
  });

  it('does not treat a CHECK violation as a unique violation', () => {
    expect(isUniqueViolation(RAW_BLANK_BODY)).toBe(false);
    expect(isUniqueViolation(UNKNOWN_DM_SHAPE)).toBe(false);
  });

  it('recognises a foreign key violation', () => {
    expect(
      isForeignKeyViolation({
        code: 'P2003',
        message: 'Foreign key constraint violated: `messages_author_id_fkey (index)`',
        meta: { field_name: 'messages_author_id_fkey (index)' },
      }),
    ).toBe(true);
  });

  it('recognises a missing row', () => {
    expect(
      isNotFound({ code: 'P2025', message: 'An operation failed because it depends on...' }),
    ).toBe(true);
    expect(isNotFound(RAW_SEQ_COLLISION)).toBe(false);
  });

  it('treats every unique violation as a conflict, and nothing else', () => {
    // The HTTP boundary reads this: a conflict is a 409 the user can act on, a
    // malformed request is a 400. Collapsing them into a 500 is how a second
    // person joining a channel becomes a support ticket.
    expect(isConflict(TYPED_SEQ_COLLISION)).toBe(true);
    expect(isConflict(TYPED_MEMBER_DUPLICATE)).toBe(true);
    expect(isConflict(RAW_BLANK_BODY)).toBe(false);
  });
});

describe('nothing here throws on a value that is not an error', () => {
  it.each([[null], [undefined], ['a string'], [42], [[]], [{}]])('survives %j', (value) => {
    // These predicates run inside catch blocks. A guard that throws while
    // classifying replaces a recoverable collision with an unhandled rejection,
    // which on the gateway takes every socket on the replica down with it.
    expect(() => isUniqueViolation(value)).not.toThrow();
    expect(isUniqueViolation(value)).toBe(false);
    expect(isSeqCollision(value)).toBe(false);
    expect(isDuplicateClientMessage(value)).toBe(false);
    expect(isDuplicateDmKey(value)).toBe(false);
    expect(isCheckViolation(value)).toBe(false);
    expect(isNotFound(value)).toBe(false);
    expect(isConflict(value)).toBe(false);
  });
});
