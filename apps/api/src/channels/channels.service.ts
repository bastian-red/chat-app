/**
 * The channel read path, plus the two writes that do not belong to a socket.
 *
 * Everything `services/messaging` owns goes through it: create, open a DM, add a
 * member, send, edit, delete, mark read. This service adds only what that module
 * has no opinion about -- the sidebar's aggregate query, the keyset history page,
 * and the rename.
 *
 * **The rename is the exception, and it is deliberate.** `MessagingTx` has no
 * rename method, because renaming a channel is not part of the write path the
 * sequence allocator protects. So it goes through Prisma here. What it must still
 * do is broadcast through the shared `ChannelBroadcast`, not through an ad-hoc
 * emit: a caller that assembles its own envelope is a caller that can put a
 * payload in the wrong room, and every client in that room renders a line from a
 * conversation they are not in.
 *
 * **`unread` and `unreadMentions` are computed, never stored.** Storing them means
 * two writers for one fact -- the send path and the read path -- and every unread
 * counter bug in every chat product is those two disagreeing.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  MessagingError,
  addMember,
  attachmentUrl,
  createChannel,
  loadChannelView,
  openDm,
  presentChannelSummary,
  presentMember,
  presentMessage,
  type MessagingRepository,
} from '@chat/messaging';
import { CHANNEL_DM_KEY_UNIQUE, CHANNEL_SLUG_UNIQUE, isUniqueViolation } from '@chat/db';
import {
  can,
  type ChannelSummary,
  type ChannelView,
  type HistoryPage,
  type Member,
  type PresenceState,
} from '@chat/shared';

import type { z } from 'zod';
import type { createChannelSchema } from '@chat/shared';

import { API_CONFIG, type ApiConfig } from '../config/config';
import { MESSAGING_REPOSITORY } from '../infra/infra.module';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';

/**
 * The classifier both write paths share.
 *
 * On the constraint name, never on the message text. See
 * `apps/realtime/src/gateway.ts` for the same constant and the same reason.
 */
const DM_CLASSIFIER = {
  isDuplicateDmKey: (error: unknown) => isUniqueViolation(error, CHANNEL_DM_KEY_UNIQUE),
};

@Injectable()
export class ChannelsService {
  constructor(
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * The sidebar.
   *
   * Three facts per channel that no single row carries: the unread-mention count,
   * the newest message's timestamp, and (for a DM) who the other person is. They
   * are fetched per channel rather than in one join because the join would be a
   * lateral over three tables for a list that is bounded by how many channels one
   * person is in, which is tens.
   */
  async list(userId: string): Promise<ChannelSummary[]> {
    const rows = await this.repository.channelsFor(userId);

    const summaries = await Promise.all(
      rows.map(async ({ channel, member }) => {
        const [unreadMentions, newest, counterparts] = await Promise.all([
          this.repository.unreadMentions(channel.id, userId, member.lastReadSeq),
          this.prisma.message.findFirst({
            where: { channelId: channel.id },
            orderBy: { seq: 'desc' },
            select: { createdAt: true },
          }),
          this.repository.counterparts(channel.id, userId),
        ]);

        return presentChannelSummary(channel, member, {
          unreadMentions,
          lastMessageAt: newest?.createdAt ?? null,
          counterparts,
        });
      }),
    );

    // Newest conversation first, and channels nobody has written in fall to the
    // bottom by name. Sorting by `unread` instead would make the list reorder
    // itself while somebody reads it, which moves the row they were about to
    // click.
    return summaries.sort((left, right) => {
      const leftAt = left.lastMessageAt ?? '';
      const rightAt = right.lastMessageAt ?? '';
      if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1;
      return (left.name ?? '').localeCompare(right.name ?? '');
    });
  }

  /** The whole channel: header, members with presence, newest page, markers. */
  async view(channelId: string, userId: string): Promise<ChannelView> {
    return loadChannelView(this.repository, {
      channelId,
      userId,
      limit: this.config.historyPageSize,
      presence: await this.presenceOf(channelId),
    });
  }

  /**
   * A page of history, read backwards by keyset.
   *
   * `beforeSeq` is exclusive, so paging is "everything below the oldest line I
   * already have". Never OFFSET: a message arriving mid-scroll shifts every
   * offset by one and the reader sees a line twice or not at all.
   */
  async history(channelId: string, userId: string, beforeSeq?: number): Promise<HistoryPage> {
    const member = await this.repository.member(channelId, userId);
    if (!member) throw new MessagingError('FORBIDDEN', 'You are not in that channel.');

    const limit = this.config.historyPageSize;
    // One more than the page, so `hasMore` is a fact rather than a guess. A COUNT
    // would be a second query over the same index on every page.
    const fetched = await this.repository.history({
      channelId,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      limit,
    });

    const hasMore = fetched.length > limit;
    const page = hasMore ? fetched.slice(0, limit) : fetched;

    return {
      // Oldest first, matching `loadChannelView`. The query runs backwards so the
      // keyset can use the descending index; exactly one of the two has to
      // reverse, and doing it on the server means no client has to know which
      // direction the query ran in.
      messages: [...page].reverse().map((row) => presentMessage(row, { attachmentUrl })),
      hasMore,
    };
  }

  async create(input: z.infer<typeof createChannelSchema>, userId: string): Promise<ChannelView> {
    try {
      const channel = await createChannel(this.repository, {
        kind: input.kind,
        name: input.name,
        slug: input.slug,
        // Omitted rather than nulled. `CreateChannelInput.topic` is optional, and
        // `exactOptionalPropertyTypes` treats "absent" and "explicitly null" as
        // different things.
        ...(input.topic === undefined ? {} : { topic: input.topic }),
        createdById: userId,
      });
      return this.view(channel.id, userId);
    } catch (error) {
      if (isUniqueViolation(error, CHANNEL_SLUG_UNIQUE)) {
        throw new MessagingError('CONFLICT', 'A channel with that address already exists.');
      }
      throw error;
    }
  }

  /**
   * Open the DM with somebody, creating it only if it does not exist.
   *
   * Both people compute the same `dmKey`, so two who click "message" on each
   * other in the same instant produce one INSERT that wins and one that loses,
   * and the loser reads the winner's row back. Not a check-then-insert: that is
   * a race that loses exactly when it matters.
   */
  async openDirect(userId: string, otherUserId: string): Promise<ChannelView> {
    const result = await openDm(this.repository, userId, otherUserId, DM_CLASSIFIER);

    if (!result.existing) {
      // Both sides get the new row in their sidebar. The other person is not in
      // the channel room yet -- they have never opened it -- so a channel-only
      // broadcast would tell nobody.
      const members = await this.membersOf(result.channel.id);
      this.redis.broadcast.memberChanged(result.channel.id, members, [userId, otherUserId]);
    }

    return this.view(result.channel.id, userId);
  }

  /**
   * Rename, or change the topic.
   *
   * Through Prisma rather than `services/messaging`, because `MessagingTx` has no
   * rename: it is not part of the write path the sequence allocator protects. The
   * broadcast still goes through the shared `ChannelBroadcast`, which is the part
   * that matters -- this event reaches clients on gateways in other processes,
   * and its payload has to be byte-identical to the one a gateway would send.
   */
  async rename(
    channelId: string,
    userId: string,
    input: { name?: string; topic?: string },
  ): Promise<ChannelSummary> {
    const member = await this.repository.member(channelId, userId);
    if (!member) throw new MessagingError('FORBIDDEN', 'You are not in that channel.');
    if (!can(member.role, 'channel.rename')) {
      throw new MessagingError('FORBIDDEN', 'You cannot rename that channel.');
    }

    const existing = await this.repository.channel(channelId);
    if (!existing) throw new MessagingError('NOT_FOUND', 'That channel does not exist.');
    if (existing.kind === 'DM') {
      // A DM's name is whoever is in it, resolved per reader. Storing one would
      // make "Ana Ruiz" the label in Ana's own window.
      throw new MessagingError('INVALID', 'A direct message has no name to change.');
    }

    const updated = await this.prisma.channel.update({
      where: { id: channelId },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.topic === undefined ? {} : { topic: input.topic }),
      },
    });

    this.redis.broadcast.channelUpdated(channelId, updated.name, updated.topic);

    const [unreadMentions, counterparts] = await Promise.all([
      this.repository.unreadMentions(channelId, userId, member.lastReadSeq),
      this.repository.counterparts(channelId, userId),
    ]);

    return presentChannelSummary(
      { ...existing, name: updated.name, topic: updated.topic },
      member,
      { unreadMentions, lastMessageAt: null, counterparts },
    );
  }

  /** Add somebody to a channel, and tell both the room and the new member. */
  async addMember(channelId: string, actorId: string, userId: string): Promise<Member[]> {
    await addMember(this.repository, { channelId, actorId, userId, role: 'MEMBER' });

    const members = await this.membersOf(channelId);
    this.redis.broadcast.memberChanged(channelId, members, [userId]);
    return members;
  }

  /**
   * The roster for a channel, as a map.
   *
   * Read from Redis through Prisma's neighbour rather than through
   * `services/presence`, because that package is the gateway's and this process
   * has no heartbeat of its own. What the API needs is the read side, and it is
   * two commands.
   */
  private async presenceOf(channelId: string): Promise<Map<string, PresenceState>> {
    // The API never writes the roster, so it reads the same hash the gateway
    // maintains and applies the same TTL rule. Absent means offline, which is the
    // honest answer for somebody with no entry.
    const raw = await this.redis.client.hgetall(`presence:${channelId}`);
    const now = Date.now();
    const ttlMs = this.config.presenceTtlSeconds * 1000;
    const states = new Map<string, PresenceState>();

    for (const value of Object.values(raw)) {
      try {
        const entry = JSON.parse(value) as { userId?: unknown; at?: unknown };
        if (typeof entry.userId !== 'string' || typeof entry.at !== 'number') continue;
        // No sweep from here. Deleting another process's fields on a read path
        // that has no heartbeat behind it would evict somebody the gateway is
        // about to refresh; the gateway's own read is what prunes.
        const ageMs = now - entry.at;
        if (ageMs >= ttlMs) continue;
        // Half the TTL, the same threshold `services/presence` uses. One missed
        // heartbeat reads as `away`, which is the honest answer: a missed beat
        // genuinely means "I am not sure".
        states.set(entry.userId, ageMs >= ttlMs / 2 ? 'away' : 'online');
      } catch {
        continue;
      }
    }

    return states;
  }

  private async membersOf(channelId: string): Promise<Member[]> {
    const [rows, presence] = await Promise.all([
      this.repository.members(channelId),
      this.presenceOf(channelId),
    ]);
    return rows.map((row) => presentMember(row, presence.get(row.userId) ?? 'offline'));
  }
}
