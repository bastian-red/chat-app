/**
 * The mapper is checked against the **real schemas**, not against a fixture.
 *
 * A test that asserts `presented.createdAt === '2026-08-11T09:00:00.000Z'` proves
 * the mapper agrees with the test author. Running the output through
 * `messageSchema.parse` proves it agrees with the contract every other process
 * imports, which is the only agreement that matters -- and it is what catches a
 * `Date` surviving onto the wire, because `instantSchema` is `z.string()` and a
 * `Date` is not one.
 */
import {
  channelSummarySchema,
  memberSchema,
  messageSchema,
  type PresenceState,
} from '@chat/shared';
import { describe, expect, it } from 'vitest';

import type { AttachmentRow, ChannelRow, MemberRow, MessageRow } from './ports';
import {
  presentChannelSummary,
  presentCounterpart,
  presentMember,
  presentMessage,
  type PresentMessageOptions,
} from './present';

const AT = new Date('2026-08-11T09:00:00.000Z');
const LATER = new Date('2026-08-11T09:30:00.000Z');

/** What `apps/api` does: the id, never the storage key. */
const options: PresentMessageOptions = {
  attachmentUrl: (attachment) => `/api/uploads/${attachment.id}`,
};

const attachment = (over: Partial<AttachmentRow> = {}): AttachmentRow => ({
  id: 'att_1',
  messageId: 'msg_1',
  filename: 'diagram.png',
  contentType: 'image/png',
  byteSize: 4096,
  storageKey: 'var/uploads/2026/08/abc123.bin',
  ...over,
});

const message = (over: Partial<MessageRow> = {}): MessageRow => ({
  id: 'msg_1',
  channelId: 'chan_1',
  seq: 7,
  authorId: 'usr_ana',
  authorName: 'Ana Ruiz',
  clientMessageId: 'cmid-0000-0001',
  body: 'The gateway is up.',
  editedAt: null,
  deletedAt: null,
  createdAt: AT,
  attachments: [],
  mentions: [],
  ...over,
});

const member = (over: Partial<MemberRow> = {}): MemberRow => ({
  channelId: 'chan_1',
  userId: 'usr_ana',
  name: 'Ana Ruiz',
  email: 'ana@chat.local',
  role: 'OWNER',
  lastReadSeq: 3,
  joinedAt: AT,
  ...over,
});

const channel = (over: Partial<ChannelRow> = {}): ChannelRow => ({
  id: 'chan_1',
  kind: 'PUBLIC',
  slug: 'general',
  name: 'General',
  topic: 'Everything else',
  nextSeq: 8,
  dmKey: null,
  createdById: 'usr_ana',
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

describe('presentMessage', () => {
  it('produces something messageSchema accepts', () => {
    expect(() => messageSchema.parse(presentMessage(message(), options))).not.toThrow();
  });

  it('sends instants as strings, never as Dates', () => {
    const presented = presentMessage(message({ editedAt: LATER, deletedAt: null }), options);
    expect(typeof presented.createdAt).toBe('string');
    expect(typeof presented.editedAt).toBe('string');
    // The exact serialisation matters: instantSchema rejects a UTC offset, so a
    // formatter emitting +00:00 instead of Z would be refused by every client.
    expect(presented.createdAt).toBe('2026-08-11T09:00:00.000Z');
    expect(presented.createdAt.endsWith('Z')).toBe(true);
  });

  it('keeps a null editedAt and deletedAt null rather than defaulting them', () => {
    const presented = presentMessage(message(), options);
    expect(presented.editedAt).toBeNull();
    expect(presented.deletedAt).toBeNull();
  });

  it('addresses an attachment by URL and never leaks the storage key', () => {
    const presented = presentMessage(message({ attachments: [attachment()] }), options);
    expect(presented.attachments).toHaveLength(1);
    expect(presented.attachments[0]!.url).toBe('/api/uploads/att_1');
    expect(JSON.stringify(presented)).not.toContain('var/uploads');
  });

  it('blanks a tombstone even when the row still carries a body', () => {
    // The adapter is supposed to have cleared these. This asserts the mapper does
    // not depend on that: a tombstone that reached the wire with its body would
    // make every deleted message readable by the whole channel.
    const presented = presentMessage(
      message({ deletedAt: LATER, body: 'the words being retracted', attachments: [attachment()] }),
      options,
    );
    expect(presented.body).toBe('');
    expect(presented.attachments).toEqual([]);
    expect(presented.deletedAt).toBe('2026-08-11T09:30:00.000Z');
    expect(() => messageSchema.parse(presented)).not.toThrow();
  });

  it('derives the author initials rather than expecting the row to carry them', () => {
    const presented = presentMessage(message(), options);
    expect(presented.author).toEqual({ id: 'usr_ana', name: 'Ana Ruiz', initials: 'AR' });
  });

  it('reports a deleted account as no author at all', () => {
    const presented = presentMessage(message({ authorId: null, authorName: null }), options);
    expect(presented.author).toBeNull();
    expect(() => messageSchema.parse(presented)).not.toThrow();
  });

  it('collapses a half-resolved author instead of throwing on the broadcast path', () => {
    // Unreachable through the adapter, but this runs after a committed write:
    // throwing here would lose the message for everybody else in the channel.
    expect(presentMessage(message({ authorName: null }), options).author).toBeNull();
  });

  it('copies the mention list rather than aliasing the row', () => {
    const row = message({ mentions: ['usr_bruno'] });
    const presented = presentMessage(row, options);
    presented.mentions.push('usr_carla');
    expect(row.mentions).toEqual(['usr_bruno']);
  });
});

describe('presentMember', () => {
  it('produces something memberSchema accepts, for every presence state', () => {
    const states: PresenceState[] = ['online', 'away', 'offline'];
    for (const state of states) {
      expect(() => memberSchema.parse(presentMember(member(), state))).not.toThrow();
    }
  });

  it('takes presence as an argument, because it comes from Redis and not the row', () => {
    expect(presentMember(member(), 'away').presence).toBe('away');
  });

  it('derives initials once, so no surface can disagree about them', () => {
    expect(presentMember(member(), 'online').initials).toBe('AR');
    expect(presentCounterpart(member()).initials).toBe('AR');
  });
});

describe('presentChannelSummary', () => {
  const extras = { unreadMentions: 1, lastMessageAt: LATER, counterparts: [] };

  it('produces something channelSummarySchema accepts', () => {
    expect(() =>
      channelSummarySchema.parse(presentChannelSummary(channel(), member(), extras)),
    ).not.toThrow();
  });

  it('computes unread from the same function the read path uses', () => {
    // nextSeq 8 means seq 7 is the highest that exists; the reader is at 3.
    expect(presentChannelSummary(channel(), member(), extras).unread).toBe(4);
  });

  it('reports lastSeq as one below nextSeq', () => {
    expect(presentChannelSummary(channel(), member(), extras).lastSeq).toBe(7);
  });

  it('reports an empty channel as lastSeq 0 and unread 0, not -1', () => {
    // The origin difference between seq (from 1) and lastReadSeq (from 0) is what
    // makes this the boundary worth pinning: a channel nobody has spoken in must
    // not show a badge to a member who has never opened it.
    const summary = presentChannelSummary(
      channel({ nextSeq: 1 }),
      member({ lastReadSeq: 0 }),
      extras,
    );
    expect(summary.lastSeq).toBe(0);
    expect(summary.unread).toBe(0);
    expect(() => channelSummarySchema.parse(summary)).not.toThrow();
  });

  it('carries a DM its counterparts, which is where its label comes from', () => {
    const summary = presentChannelSummary(
      channel({ kind: 'DM', slug: null, name: null, topic: null, dmKey: 'usr_ana:usr_bruno' }),
      member({ role: 'MEMBER' }),
      {
        ...extras,
        counterparts: [member({ userId: 'usr_bruno', name: 'Bruno Sala', role: 'MEMBER' })],
      },
    );
    expect(summary.counterparts).toEqual([
      { userId: 'usr_bruno', name: 'Bruno Sala', initials: 'BS' },
    ]);
    expect(() => channelSummarySchema.parse(summary)).not.toThrow();
  });

  it('sends lastMessageAt as a string and keeps a silent channel null', () => {
    expect(presentChannelSummary(channel(), member(), extras).lastMessageAt).toBe(
      '2026-08-11T09:30:00.000Z',
    );
    expect(
      presentChannelSummary(channel(), member(), { ...extras, lastMessageAt: null }).lastMessageAt,
    ).toBeNull();
  });
});
