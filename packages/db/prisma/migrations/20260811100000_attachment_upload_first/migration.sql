-- An attachment exists before the message that carries it.
--
-- `message_id` was NOT NULL, which made the documented upload flow impossible to
-- express: the client POSTs the bytes to the API, gets an id back, and only then
-- names that id in `message.send`'s `attachmentIds`. There is no message to point
-- at at upload time. The alternative -- uploading inside the send -- would put a
-- ten-megabyte multipart body inside the transaction that holds the channel's
-- sequence row lock, which is the one lock every other sender in that channel is
-- queueing behind.
--
-- `uploaded_by_id` is the authorisation input that nullability then requires. With
-- `message_id` nullable, an orphan attachment has no channel membership to check
-- against, so without an owner anybody could attach a file somebody else uploaded
-- by guessing its id, and the API could not decide who may stream an orphan's
-- bytes. ON DELETE SET NULL for the same reason `messages.author_id` is: a
-- conversation is a record and outlives the account that wrote it.
--
-- NOTE: `prisma migrate diff` also proposed `DROP INDEX channel_members_user_unread`.
-- That index is created by 20260811090000_chat_invariants and is invisible to the
-- Prisma schema, so the diff reads it as drift rather than as intent. It is
-- deliberately not included here. Re-generating this file with `migrate diff` will
-- propose it again; drop that line again.

-- AlterTable
ALTER TABLE "attachments" ADD COLUMN     "uploaded_by_id" TEXT,
ALTER COLUMN "message_id" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "attachments_message_id_idx" ON "attachments"("message_id");

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
