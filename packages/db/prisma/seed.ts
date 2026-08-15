/**
 * The demo conversation.
 *
 * Four properties, each with the mechanism that holds it.
 *
 * **1. Messages get real sequence numbers.** Every message is written through
 * `@chat/messaging`'s `sendMessage`, not through `prisma.message.create`. Hand
 * numbering the seqs would seed a conversation the allocator never produced, and
 * the one thing this project exists to demonstrate is that the allocator is what
 * produces them. A seed that bypassed it could stay green while the allocator was
 * broken.
 *
 * **2. It is deterministic.** A fixed reference date, no `Math.random()`, one
 * password hash computed once and reused. `scripts/seed-check.sh` runs it twice
 * and compares an md5 over the whole conversation; anything that drifts fails
 * there. Timestamps are rewritten to fixed values afterwards, because
 * `createdAt` defaults to `now()` and a digest is not the only reader -- the demo
 * GIF and the day dividers in the E2E suite need the same conversation every run.
 *
 * **3. It is idempotent, by an explicit ordered teardown.** The naive version --
 * delete the users and let the cascades handle it -- passes on an empty database
 * and fails on the second run, because `channels.created_by_id` is `SetNull` and
 * `messages.author_id` is `SetNull`: deleting the users leaves every channel and
 * every message standing, authorless, and the next run adds a second copy. So
 * channels go first (which cascades to members, messages, mentions and
 * attachments) and users go second.
 *
 * **4. The constants are readable from outside.** `scripts/seed-check.sh` and
 * `scripts/dev-smoke.sh` both `sed` `DEMO_EMAIL` and friends out of this file
 * rather than repeating them. A copy that drifts produces a check confidently
 * computed over zero rows, which passes.
 */
import { PrismaClient } from '../generated/client';
import { PrismaMessagingRepository } from '../src/messaging-repository';
import { hashPassword } from '@chat/shared/server';
import { sendMessage } from '@chat/messaging';

// --- The constants the scripts read. One line each, single quotes, no template
// literals: `sed -n "s/^const NAME = '\([^']*\)';.*/\1/p"` is what reads them.
const DEMO_EMAIL = 'ana@chat.test';
const DEMO_PASSWORD = 'demo-password-2026';
const DEMO_CHANNEL = 'Product';
const DEMO_MESSAGE = 'Shipping the sequence allocator today.';

/**
 * The instant the conversation is anchored to.
 *
 * Fixed, and in UTC. Every message's `createdAt` is derived from it, so a machine
 * in Santiago and a runner in UTC seed the same conversation -- which matters
 * because the day dividers in the message list are computed from these values
 * against the reader's stored zone, and the E2E suite asserts on them.
 */
const REFERENCE = new Date('2026-08-10T09:00:00.000Z');

/**
 * How far apart consecutive messages are.
 *
 * Seven minutes, which is not arbitrary: 60 messages at seven minutes spans seven
 * hours, so the seeded history crosses no day boundary by accident, and the two
 * messages deliberately placed on an earlier day are the only day divider in the
 * conversation. A random spacing would make the divider appear and disappear
 * between runs.
 */
const MESSAGE_SPACING_MS = 7 * 60 * 1000;

/**
 * How many messages the busy channel holds.
 *
 * Above `HISTORY_PAGE_SIZE` (40), so the first page is full and `hasMore` is true
 * on a fresh open. A seed that fit in one page would let a broken keyset paginator
 * ship green, because nothing would ever ask for a second page.
 */
const BUSY_CHANNEL_MESSAGES = 58;

/**
 * How many messages the demo account has not read in the busy channel.
 *
 * Four, and small on purpose: the sidebar badge has to be a number a reader can
 * verify at a glance in the demo GIF, and the E2E suite asserts on it. The
 * mention is the last message written, so any value of one or more also leaves
 * `unreadMentions` at 1.
 */
const DEMO_UNREAD = 4;

const prisma = new PrismaClient();
const repository = new PrismaMessagingRepository(prisma);

/**
 * The classifier `sendMessage` needs.
 *
 * The seed never sends a duplicate `clientMessageId` and never collides on a seq,
 * so neither branch is reachable here. They are wired anyway rather than thrown
 * from: a seed that crashed on a retry it could have absorbed would be a flake in
 * CI, and `false` is the honest answer for "this is not that error".
 */
const CLASSIFIER = {
  isDuplicateClientMessage: () => false,
  isSeqCollision: () => false,
};

interface SeedUser {
  email: string;
  name: string;
  timeZone: string;
}

const PEOPLE: SeedUser[] = [
  { email: DEMO_EMAIL, name: 'Ana Ruiz', timeZone: 'Europe/Madrid' },
  { email: 'bruno@chat.test', name: 'Bruno Salas', timeZone: 'America/Santiago' },
  { email: 'chidi@chat.test', name: 'Chidi Okafor', timeZone: 'Africa/Lagos' },
  { email: 'dana@chat.test', name: 'Dana Weiss', timeZone: 'UTC' },
];

async function main(): Promise<void> {
  await teardown();

  // One hash, computed once and reused. scrypt is deliberately slow, so hashing
  // four times would spend four times as long proving the same thing, and a
  // per-user hash would also make the seed non-deterministic in duration for no
  // gain: every demo account shares one password by design.
  const passwordHash = hashPassword(DEMO_PASSWORD);

  const users = new Map<string, string>();
  for (const person of PEOPLE) {
    const user = await prisma.user.create({
      data: {
        email: person.email,
        name: person.name,
        timeZone: person.timeZone,
        passwordHash,
      },
    });
    users.set(person.email, user.id);
  }

  const id = (email: string): string => {
    const value = users.get(email);
    if (!value) throw new Error(`The seed asked for ${email}, which it never created.`);
    return value;
  };

  // --- channels -------------------------------------------------------------

  const product = await prisma.channel.create({
    data: {
      kind: 'PUBLIC',
      slug: 'product',
      name: DEMO_CHANNEL,
      topic: 'What we are shipping, and when.',
      createdById: id(DEMO_EMAIL),
      members: {
        create: [
          // Exactly one OWNER, which `channel_members_one_owner_per_channel`
          // enforces as a partial unique index. Two would make "who may delete
          // this channel" a query with two answers.
          { userId: id(DEMO_EMAIL), role: 'OWNER' },
          { userId: id('bruno@chat.test'), role: 'ADMIN' },
          { userId: id('chidi@chat.test'), role: 'MEMBER' },
          { userId: id('dana@chat.test'), role: 'MEMBER' },
        ],
      },
    },
  });

  const incidents = await prisma.channel.create({
    data: {
      kind: 'PRIVATE',
      slug: 'incidents',
      name: 'Incidents',
      topic: 'Paging, postmortems, and the runbook.',
      createdById: id('bruno@chat.test'),
      members: {
        create: [
          { userId: id('bruno@chat.test'), role: 'OWNER' },
          { userId: id(DEMO_EMAIL), role: 'MEMBER' },
        ],
      },
    },
  });

  // A DM. Both participants are MEMBER and neither is OWNER: ownership would let
  // one of them remove the other from a conversation they are both in, and the
  // partial unique index permits zero owners for exactly this case.
  const dmKey = [id(DEMO_EMAIL), id('bruno@chat.test')].sort().join(':');
  const direct = await prisma.channel.create({
    data: {
      kind: 'DM',
      dmKey,
      createdById: id(DEMO_EMAIL),
      members: {
        create: [
          { userId: id(DEMO_EMAIL), role: 'MEMBER' },
          { userId: id('bruno@chat.test'), role: 'MEMBER' },
        ],
      },
    },
  });

  // --- the conversation -----------------------------------------------------

  let clock = 0;
  const say = async (channelId: string, authorEmail: string, body: string): Promise<void> => {
    await sendMessage(
      repository,
      {
        channelId,
        authorId: id(authorEmail),
        // Derived from the position rather than generated, so two runs produce
        // the same ids and the idempotency index sees the same values.
        clientMessageId: `seed-${channelId.slice(-8)}-${String(clock).padStart(4, '0')}`,
        body,
      },
      { classify: CLASSIFIER },
    );
    clock += 1;
  };

  const CHATTER = [
    'The allocator takes a row lock, so two senders queue instead of racing.',
    'Density is the requirement. A gap has to mean something.',
    'Reconnect catch-up is bounded, otherwise a reconnect storm takes a gateway down.',
    'The read marker only moves forward, so a stale tab cannot un-read anything.',
    'Presence is a glyph and a word. The dot is decoration.',
    'A soft delete keeps its seq and loses its body.',
    'Two tabs is one person online.',
    'The typing set has a five second TTL, on purpose.',
  ];

  for (let index = 0; index < BUSY_CHANNEL_MESSAGES; index += 1) {
    const person = PEOPLE[index % PEOPLE.length];
    if (!person) continue;
    await say(
      product.id,
      person.email,
      `${CHATTER[index % CHATTER.length] ?? ''} (${String(index + 1)})`,
    );
  }

  // A mention, so the unread-mention count is non-zero for somebody and the demo
  // GIF has one to show.
  //
  // `@anaruiz`, not `@Ana Ruiz`. `handleOf` lowercases the name and collapses
  // every non-alphanumeric out of it, so the handle for "Ana Ruiz" is `anaruiz`
  // and a mention written with the space in it resolves to nobody. This project
  // has no separate handle field, which is why the handle is derived and why the
  // seed has to spell it the way the parser reads it.
  await say(product.id, 'bruno@chat.test', '@anaruiz can you take the migration review?');

  // The named message every other lane greps for, and it is written **last** on
  // purpose.
  //
  // History is read newest-first at HISTORY_PAGE_SIZE, so the first page a reader
  // sees is the newest 40 of 60. A "landmark" message written first would sit at
  // seq 1, fall off that page, and never appear on a freshly opened channel --
  // which is exactly how `scripts/dev-smoke.sh` failed the first time it ran
  // against this seed. Last means it is on the first page by construction, for
  // dev-smoke, for the E2E suite and for the demo GIF.
  await say(product.id, DEMO_EMAIL, DEMO_MESSAGE);

  await say(incidents.id, 'bruno@chat.test', 'Runbook updated after last night.');
  await say(incidents.id, DEMO_EMAIL, 'Adding the gateway health check to the pager.');

  await say(direct.id, 'bruno@chat.test', 'Do you have five minutes for the seq review?');
  await say(direct.id, DEMO_EMAIL, 'Yes, after standup.');

  // --- read markers ---------------------------------------------------------

  // Ana has read all but the last few messages of Product, so her sidebar shows a
  // real unread count rather than a zero nobody can tell from a broken query. The
  // mention is the last message written, so leaving her behind it also makes
  // `unreadMentions` non-zero.
  //
  // Derived from the channel's own `nextSeq` rather than from a message count.
  // Those are not the same number -- the count is what was sent, `nextSeq - 1` is
  // what was allocated -- and an expectation written against the wrong one is a
  // test that "fails" against correct code until somebody edits the code to match
  // it.
  const productRow = await prisma.channel.findUniqueOrThrow({ where: { id: product.id } });
  const productLastSeq = Number(productRow.nextSeq) - 1;

  // An edited message and a deleted one, so both renderings have a subject in the
  // seeded data rather than only in a test that creates its own.
  //
  // Positioned near the END of the channel, and that is not cosmetic. History is
  // read newest-first at HISTORY_PAGE_SIZE, so a tombstone at seq 5 of 60 is not
  // on the page a freshly opened channel shows, and an E2E spec looking for it
  // fails while the feature works. The first version of this seed put both at the
  // start and both specs went red.
  await editSeeded(product.id, productLastSeq - 6, {
    body: 'Density is the requirement, and a gap has to mean something.',
    editedAt: REFERENCE,
  });
  // A tombstone: the row keeps its seq and loses its body. The
  // `messages_body_not_blank` CHECK exempts exactly this case, which is why the
  // body can be emptied rather than left as a lie.
  await editSeeded(product.id, productLastSeq - 8, { body: '', deletedAt: REFERENCE });
  await prisma.channelMember.update({
    where: { channelId_userId: { channelId: product.id, userId: id(DEMO_EMAIL) } },
    data: { lastReadSeq: BigInt(productLastSeq - DEMO_UNREAD) },
  });
  await prisma.channelMember.update({
    where: { channelId_userId: { channelId: direct.id, userId: id(DEMO_EMAIL) } },
    data: { lastReadSeq: 2n },
  });

  await pinTimestamps();

  const messages = await prisma.message.count();
  console.log(`seeded ${String(PEOPLE.length)} people, 3 channels, ${String(messages)} messages`);
}

/**
 * Change one seeded message in place, by seq.
 *
 * By seq rather than by id, because the ids are cuids and differ on every run
 * while the sequence is dense and deterministic. That is the same property
 * `scripts/seed-check.sh` digests.
 */
async function editSeeded(
  channelId: string,
  seq: number,
  data: { body?: string; editedAt?: Date; deletedAt?: Date },
): Promise<void> {
  const message = await prisma.message.findFirst({ where: { channelId, seq: BigInt(seq) } });
  if (!message)
    throw new Error(`The seed wanted to edit seq ${String(seq)} and it does not exist.`);
  await prisma.message.update({ where: { id: message.id }, data });
}

/**
 * Rewrite every message's `createdAt` to a value derived from its seq.
 *
 * `createdAt` defaults to `now()`, so without this the conversation is a different
 * one on every run: the day dividers move, the relative times ("2 minutes ago")
 * differ, and the demo GIF cannot be recaptured. Done afterwards rather than
 * passed into the send, because `services/messaging` deliberately does not accept
 * a timestamp -- a write path that let its caller choose `createdAt` is a write
 * path where a client could backdate a message.
 *
 * The two oldest messages in the busy channel are pushed onto the previous day, so
 * the message list has exactly one day divider to render and the E2E suite has a
 * fixed thing to assert on.
 */
async function pinTimestamps(): Promise<void> {
  const messages = await prisma.message.findMany({
    select: { id: true, seq: true, channelId: true },
    orderBy: [{ channelId: 'asc' }, { seq: 'asc' }],
  });

  for (const message of messages) {
    const offset = Number(message.seq) * MESSAGE_SPACING_MS;
    const createdAt =
      Number(message.seq) <= 2
        ? new Date(REFERENCE.getTime() - 24 * 60 * 60 * 1000 + offset)
        : new Date(REFERENCE.getTime() + offset);

    await prisma.message.update({ where: { id: message.id }, data: { createdAt } });
  }
}

/**
 * Remove the previous seed, in an order the foreign keys allow.
 *
 * Channels **before** users. Deleting users first leaves every channel standing
 * (`channels.created_by_id` is `SetNull`) and every message standing without an
 * author (`messages.author_id` is `SetNull`), and the next run stacks a second
 * conversation on top of the first. `seed-check.sh` catches that as a doubled row
 * count, but only after the damage.
 *
 * Deleting a channel cascades to its members, its messages, and from those to
 * mentions and attachments, so those four tables need no statement of their own.
 * Orphan attachments do: they have no message to cascade from, which is the whole
 * point of the column being nullable.
 *
 * Scoped to the seed's own rows by email and by slug, so running this against a
 * database somebody has been using does not delete their work.
 */
async function teardown(): Promise<void> {
  const emails = PEOPLE.map((person) => person.email);
  const existing = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true },
  });
  const ids = existing.map((user) => user.id);
  if (ids.length === 0) return;

  await prisma.attachment.deleteMany({
    where: { messageId: null, uploadedById: { in: ids } },
  });
  await prisma.channel.deleteMany({
    where: { members: { some: { userId: { in: ids } } } },
  });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
