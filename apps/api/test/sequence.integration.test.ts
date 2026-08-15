/**
 * The assertion this whole project exists for.
 *
 * **N simultaneous sends into one channel produce exactly the seq set `1..N`, with
 * no duplicate and no gap, and every body present once.**
 *
 * Against real Postgres, and it has to be: the mechanism is the row lock that
 * `UPDATE channels SET next_seq = next_seq + 1 ... RETURNING` takes, and a mocked
 * database cannot take a lock, cannot serialise two writers, and cannot refuse a
 * duplicate. `services/messaging`'s in-memory repository returns whatever its
 * counter says, so a suite that used it would pass against a `SELECT` then
 * `UPDATE` allocator, which is the exact implementation this design rejects.
 *
 * The other half is idempotency: the same `clientMessageId` sent twice
 * concurrently must yield one row, and the second answer must carry
 * `duplicate: true` with the first row's seq.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { isDuplicateClientMessage, isSeqCollision } from '@chat/db';
import { sendMessage } from '@chat/messaging';

import { person, prisma, repository, scratchChannel, type Person } from './harness';

const CLASSIFIER = { isDuplicateClientMessage, isSeqCollision };

/**
 * How many writers race.
 *
 * Twenty-four. Enough that the row lock genuinely has a queue behind it on a
 * laptop and on a CI runner, and small enough that the whole file stays well
 * inside the lane's budget. A number in the low single digits would let a broken
 * allocator pass by luck.
 */
const WRITERS = 24;

describe('sequence allocation under concurrency', () => {
  let ana: Person;
  let bruno: Person;
  let channelId: string;

  beforeAll(async () => {
    ana = await person('ana@chat.test');
    bruno = await person('bruno@chat.test');
    channelId = (await scratchChannel('seq', [ana.id, bruno.id])).id;
  });

  afterAll(async () => {
    await prisma.channel.deleteMany({ where: { id: channelId } });
  });

  it(`gives ${String(WRITERS)} simultaneous senders the set 1..${String(WRITERS)}`, async () => {
    const sends = Array.from({ length: WRITERS }, (_, index) =>
      sendMessage(
        repository,
        {
          channelId,
          // Alternating authors, so the test also covers two people writing at
          // once rather than one client retrying.
          authorId: index % 2 === 0 ? ana.id : bruno.id,
          clientMessageId: `race-${String(index).padStart(3, '0')}`,
          body: `concurrent ${String(index)}`,
        },
        { classify: CLASSIFIER },
      ),
    );

    // `Promise.all`, not a loop. A loop would await each send before starting the
    // next, which is the sequential case and proves nothing about the lock.
    const results = await Promise.all(sends);

    const seqs = results.map((result) => result.message.seq).sort((a, b) => a - b);

    // The set, stated as the set. Asserting `length === WRITERS` and `max ===
    // WRITERS` separately would pass on a duplicate paired with a gap.
    expect(seqs).toEqual(Array.from({ length: WRITERS }, (_, index) => index + 1));
  });

  it('leaves the channel with no duplicate and no gap, read back from the database', async () => {
    // Read back rather than trusting the return values. The assertion above is
    // about what the allocator handed out; this one is about what is actually
    // stored, and a write path that returned a correct seq while storing a
    // different one would pass the first and fail this.
    const rows = await prisma.message.findMany({
      where: { channelId },
      orderBy: { seq: 'asc' },
      select: { seq: true, body: true },
    });

    expect(rows).toHaveLength(WRITERS);
    expect(rows.map((row) => Number(row.seq))).toEqual(
      Array.from({ length: WRITERS }, (_, index) => index + 1),
    );

    // Every body present exactly once. A retry loop that replayed a send would
    // produce a correct seq set with one body written twice and another missing.
    const bodies = new Set(rows.map((row) => row.body));
    expect(bodies.size).toBe(WRITERS);
  });

  it('leaves next_seq one past the highest allocated', async () => {
    // The invariant the unread count and `lastSeq` are both computed from. Off by
    // one here is an unread badge that is permanently wrong for everybody.
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });

    expect(Number(channel.nextSeq)).toBe(WRITERS + 1);
  });
});

describe('idempotency under a lost ack', () => {
  let ana: Person;
  let channelId: string;

  beforeAll(async () => {
    ana = await person('ana@chat.test');
    channelId = (await scratchChannel('idem', [ana.id])).id;
  });

  afterAll(async () => {
    await prisma.channel.deleteMany({ where: { id: channelId } });
  });

  it('yields one row when the same client id is sent twice concurrently', async () => {
    // The real case: a client whose ack was dropped retries while the first
    // attempt is still in flight. `sendMessage` inserts optimistically and catches
    // the unique violation rather than checking first, because checking first is a
    // race that loses exactly here.
    const input = {
      channelId,
      authorId: ana.id,
      clientMessageId: 'lost-ack-0001',
      body: 'sent once, delivered once',
    };

    const [first, second] = await Promise.all([
      sendMessage(repository, input, { classify: CLASSIFIER }),
      sendMessage(repository, input, { classify: CLASSIFIER }),
    ]);

    const rows = await prisma.message.findMany({ where: { channelId } });
    expect(rows).toHaveLength(1);

    // Exactly one of the two answers is the duplicate. Which one is a race and is
    // deliberately not asserted; that both report the same row is the property.
    expect([first.duplicate, second.duplicate].sort()).toEqual([false, true]);
    expect(first.message.id).toBe(second.message.id);
    expect(first.message.seq).toBe(second.message.seq);
  });

  it('answers a later retry with the original row rather than a new seq', async () => {
    const input = {
      channelId,
      authorId: ana.id,
      clientMessageId: 'lost-ack-0002',
      body: 'and again, much later',
    };

    const first = await sendMessage(repository, input, { classify: CLASSIFIER });
    const retry = await sendMessage(repository, input, { classify: CLASSIFIER });

    expect(retry.duplicate).toBe(true);
    expect(retry.message.seq).toBe(first.message.seq);

    // And the allocation was not burned. A retry that consumed a sequence number
    // would leave a permanent hole that every client's gap detector chases
    // forever, which is precisely what the dense sequence exists to make
    // impossible.
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channelId } });
    expect(Number(channel.nextSeq)).toBe(first.message.seq + 1);
  });
});
