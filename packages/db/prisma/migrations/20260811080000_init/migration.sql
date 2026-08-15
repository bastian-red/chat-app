-- CreateEnum
CREATE TYPE "ChannelKind" AS ENUM ('PUBLIC', 'PRIVATE', 'DM');

-- CreateEnum
CREATE TYPE "ChannelRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "time_zone" TEXT NOT NULL DEFAULT 'UTC',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channels" (
    "id" TEXT NOT NULL,
    "kind" "ChannelKind" NOT NULL,
    "slug" TEXT,
    "name" TEXT,
    "topic" TEXT,
    "next_seq" BIGINT NOT NULL DEFAULT 1,
    "dm_key" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_members" (
    "channel_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "ChannelRole" NOT NULL DEFAULT 'MEMBER',
    "last_read_seq" BIGINT NOT NULL DEFAULT 0,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_members_pkey" PRIMARY KEY ("channel_id","user_id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "author_id" TEXT,
    "client_message_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "edited_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mentions" (
    "message_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "mentions_pkey" PRIMARY KEY ("message_id","user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "channels_slug_key" ON "channels"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "channels_dm_key_key" ON "channels"("dm_key");

-- CreateIndex
CREATE INDEX "channel_members_user_id_idx" ON "channel_members"("user_id");

-- CreateIndex
CREATE INDEX "messages_channel_id_seq_idx" ON "messages"("channel_id", "seq" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "messages_channel_id_seq_key" ON "messages"("channel_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "messages_channel_id_client_message_id_key" ON "messages"("channel_id", "client_message_id");

-- CreateIndex
CREATE INDEX "mentions_user_id_idx" ON "mentions"("user_id");

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

