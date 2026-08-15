-- Invariants Prisma's schema language cannot express.
--
-- Every constraint here exists because application code alone would let a
-- specific bad state reach the database. They are the last line of defence, not
-- the first: services/messaging is supposed to make them unreachable, so a
-- violation surfacing at runtime means there is a bug to fix rather than a case
-- to swallow -- with two deliberate exceptions, the duplicate `client_message_id`
-- in section 2 and the duplicate `dm_key` in section 3, which are *expected*
-- under concurrency and are what the idempotent paths are built on.
--
-- The names are exported from `packages/db/src/index.ts`, because code that
-- catches a violation must match on the constraint name and never on the message
-- text, which Postgres localises and rewords between versions.

-- ---------------------------------------------------------------------------
-- 1. A sequence number counts from one, and never stops counting.
--
-- This is the constraint the whole ordering design rests on, and its absence is
-- the hardest thing here to notice.
--
-- `messages_channel_id_seq_key` is declared by Prisma's @@unique and this
-- migration inherits it. It is what makes a duplicated seq *observable*: without
-- it, two messages silently share a number, "order by seq" becomes whatever the
-- planner produced that day, and every client's gap detector reports a hole that
-- can never fill. Unlike the sibling project's position collisions this should
-- never fire -- the allocator holds a row lock -- which is precisely why it must
-- be an error rather than a silent success if it ever does.
--
-- The CHECK is the other half. Seq counts from 1 so that `last_read_seq = 0` can
-- mean "has read nothing"; a zero or negative seq would make "unread" and "read
-- the first message" the same state, and the unread badge would be permanently
-- wrong by one for every member who has never opened the channel.
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_seq_positive"
  CHECK ("seq" >= 1);

ALTER TABLE "channels"
  ADD CONSTRAINT "channels_next_seq_positive"
  CHECK ("next_seq" >= 1);

-- A read marker cannot point behind the beginning. `last_read_seq` is compared
-- against `next_seq - 1` to produce the unread count, and a negative marker
-- inflates that count for as long as the row exists.
ALTER TABLE "channel_members"
  ADD CONSTRAINT "channel_members_last_read_not_negative"
  CHECK ("last_read_seq" >= 0);

-- ---------------------------------------------------------------------------
-- 2. A resend is not a second message.
--
-- `messages_channel_id_client_message_id_key` comes from Prisma's @@unique.
-- Called out here because it is the one constraint in this file the application
-- deliberately trips: `sendMessage` inserts optimistically and catches 23505 to
-- read the original row back. Checking first and inserting second is a race that
-- loses exactly when it matters -- two tabs retrying the same failed send in the
-- same instant -- and the index is that check done atomically.
--
-- The client id is opaque to the server but it must not be empty: an empty
-- string would collapse every message in the channel onto one idempotency key,
-- and the second message anybody sent would be answered with the first.
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_client_message_id_not_blank"
  CHECK (btrim("client_message_id") <> '');

-- ---------------------------------------------------------------------------
-- 3. A DM is between exactly two people, addressed by a key both of them compute.
--
-- `dm_key` is `least(a, b) || ':' || greatest(a, b)` over the two user ids,
-- computed by the caller. Its UNIQUE (Prisma's @unique) is what makes two people
-- clicking "message" on each other at the same instant end up in one
-- conversation: both compute the same key, one INSERT wins, and the loser reads
-- the winner's row back.
--
-- The shape check is what stops that from being a convention. A key that is not
-- `id:id` still satisfies the UNIQUE, so a caller that forgot to sort the pair
-- would create `b:a` alongside `a:b` -- two DM rows, each visible to both people,
-- each holding half the conversation, and no constraint violated. Requiring a
-- colon with non-empty sides on both is not the same as requiring sortedness, but
-- it rejects the malformed keys; `services/messaging` has the property test for
-- the ordering itself.
ALTER TABLE "channels"
  ADD CONSTRAINT "channels_dm_shape"
  CHECK (
    "kind" <> 'DM'
    OR ("dm_key" IS NOT NULL AND "dm_key" ~ '^[^:]+:[^:]+$')
  );

-- And the converse: only a DM has a key. A public channel with a `dm_key` would
-- occupy a slot in that unique index and block the real DM between those two
-- people from ever being created, with an error that names neither of them.
ALTER TABLE "channels"
  ADD CONSTRAINT "channels_named_shape"
  CHECK (
    ("kind" = 'DM' AND "name" IS NULL AND "slug" IS NULL)
    OR ("kind" <> 'DM' AND "dm_key" IS NULL AND "name" IS NOT NULL AND btrim("name") <> ''
        AND "slug" IS NOT NULL AND "slug" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$')
  );

-- ---------------------------------------------------------------------------
-- 4. A channel has exactly one owner.
--
-- A partial unique index, the only way to say "at most one row per channel where
-- role = OWNER" in Postgres. Prisma cannot express a WHERE on a unique index, so
-- it lives here.
--
-- There is no `owner_id` column on `channels`: the owner *is* the membership with
-- role OWNER, so "who may delete this channel" is a query, and a query with two
-- answers is a permission check that depends on row order.
--
-- A DM has no owner at all -- both participants are MEMBERs, because neither of
-- them may remove the other from a conversation they are both in -- so the index
-- is written to permit zero as well as one.
CREATE UNIQUE INDEX "channel_members_one_owner_per_channel"
  ON "channel_members" ("channel_id")
  WHERE "role" = 'OWNER';

-- ---------------------------------------------------------------------------
-- 5. A message says something, or says it was deleted.
--
-- A blank body renders as a line with a name and a timestamp beside nothing,
-- which reads as a rendering failure rather than as a message. The zod schema
-- already requires min(1) after trimming; this is the same rule at the one layer
-- every write passes through.
--
-- Deletion is exempt, and that is the point of writing it this way: `deletedAt`
-- keeps the row and its seq -- a hole in the sequence is indistinguishable from a
-- message a client has not received yet, so a hard delete would send every reader
-- into a permanent catch-up loop -- and the body is emptied rather than kept.
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_body_not_blank"
  CHECK ("deleted_at" IS NOT NULL OR btrim("body") <> '');

-- ---------------------------------------------------------------------------
-- 6. An attachment has bytes and a name.
--
-- Zero bytes is an upload that failed halfway and was recorded anyway: the row
-- exists, the download returns nothing, and the reader sees a broken file with no
-- error to report. `storage_key` is generated server-side and must never be
-- empty, because an empty key resolves to the upload directory itself.
ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_byte_size_positive"
  CHECK ("byte_size" > 0);

ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_storage_key_not_blank"
  CHECK (btrim("storage_key") <> '');

ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_filename_not_blank"
  CHECK (btrim("filename") <> '');

-- ---------------------------------------------------------------------------
-- 7. The unread query, as an index.
--
-- "Which channels am I in, and how many messages have I not read?" runs on every
-- page load for every member. It reads `channel_members` by user and joins each
-- row's channel for `next_seq`; Prisma declares @@index([userId]), which this
-- inherits. Adding `last_read_seq` to it makes the index cover the read, so the
-- count comes out of the index without touching the table.
CREATE INDEX "channel_members_user_unread"
  ON "channel_members" ("user_id", "channel_id", "last_read_seq");

-- ---------------------------------------------------------------------------
-- 8. History reads live-side-first, and catch-up reads forwards.
--
-- Prisma declares @@index([channelId, seq(sort: Desc)]) for the first page and
-- for scrolling back. Catch-up after a reconnect walks the other way -- "give me
-- everything after seq N, in order" -- and a descending index serves that as a
-- backwards scan, which is fine, but the partial index below is what keeps the
-- common case cheap: the vast majority of messages are not deleted, and every
-- read filters them.
CREATE INDEX "messages_channel_seq_live"
  ON "messages" ("channel_id", "seq")
  WHERE "deleted_at" IS NULL;
