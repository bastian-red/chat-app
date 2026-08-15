/**
 * `/channels`: the sidebar, one channel, its history, and the writes REST owns.
 *
 * The message writes (`send`, `edit`, `delete`, `read`) are here as well as on the
 * socket, and that is not duplication: they are the same `services/messaging`
 * functions reached two ways. A client with a dead socket must still be able to
 * send, and the E2E suite drives both paths to prove they produce the same rows
 * and the same broadcasts.
 *
 * Every write broadcasts through the shared `ChannelBroadcast` on the Redis
 * emitter, so a message posted over REST reaches a client holding a socket on
 * either gateway replica.
 */
import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  MessagingError,
  attachmentUrl,
  deleteMessage,
  editMessage,
  markRead,
  presentMessage,
  sendMessage,
  type MessagingRepository,
} from '@chat/messaging';
import { Inject } from '@nestjs/common';
import { isDuplicateClientMessage, isSeqCollision } from '@chat/db';
import {
  createChannelSchema,
  deleteMessageSchema,
  editMessageSchema,
  markReadSchema,
  openDmSchema,
  seqSchema,
  sendMessageSchema,
  type ChannelSummary,
  type ChannelView,
  type HistoryPage,
  type Member,
  type Message,
  type MessageSendAck,
} from '@chat/shared';
import type { TokenUser } from '@chat/shared/server';
import { z } from 'zod';

import { API_CONFIG, type ApiConfig } from '../config/config';
import { ChannelsService } from './channels.service';
import { CurrentUser } from '../common/session.guard';
import { MESSAGING_REPOSITORY } from '../infra/infra.module';
import { RedisService } from '../infra/redis.service';
import { ZodPipe } from '../common/zod.pipe';

const CLASSIFIER = { isDuplicateClientMessage, isSeqCollision };

/** The two fields a rename may change. At least one, or the call does nothing. */
const renameSchema = z
  .object({ name: z.string().min(1).max(80).optional(), topic: z.string().max(200).optional() })
  .refine(
    (value) => value.name !== undefined || value.topic !== undefined,
    'Send a name, a topic, or both',
  );

const addMemberSchema = z.object({ userId: z.string().min(1).max(64) });

/**
 * `beforeSeq` off the query string.
 *
 * A query parameter is a string or absent, so it is coerced here rather than by
 * `seqSchema`, which is deliberately a `z.number()` because everywhere else in the
 * codebase a seq arrives as JSON. Coercing inside the shared schema would make
 * `seqSchema.parse('7')` succeed on the socket path too, where a string seq is a
 * client bug worth catching.
 */
const beforeSeqSchema: z.ZodType<number | undefined, z.ZodTypeDef, unknown> = z
  .string()
  .regex(/^\d+$/u)
  .transform(Number)
  .pipe(seqSchema)
  .optional();

@Controller('channels')
export class ChannelsController {
  constructor(
    private readonly channels: ChannelsService,
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    private readonly redis: RedisService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get()
  list(@CurrentUser() user: TokenUser): Promise<ChannelSummary[]> {
    return this.channels.list(user.id);
  }

  @Post()
  create(
    @CurrentUser() user: TokenUser,
    @Body(new ZodPipe(createChannelSchema)) input: z.infer<typeof createChannelSchema>,
  ): Promise<ChannelView> {
    return this.channels.create(input, user.id);
  }

  @Post('direct')
  openDirect(
    @CurrentUser() user: TokenUser,
    @Body(new ZodPipe(openDmSchema)) input: { userId: string },
  ): Promise<ChannelView> {
    return this.channels.openDirect(user.id, input.userId);
  }

  @Get(':channelId')
  view(
    @CurrentUser() user: TokenUser,
    @Param('channelId') channelId: string,
  ): Promise<ChannelView> {
    return this.channels.view(channelId, user.id);
  }

  @Patch(':channelId')
  rename(
    @CurrentUser() user: TokenUser,
    @Param('channelId') channelId: string,
    @Body(new ZodPipe(renameSchema)) input: { name?: string; topic?: string },
  ): Promise<ChannelSummary> {
    return this.channels.rename(channelId, user.id, input);
  }

  @Post(':channelId/members')
  addMember(
    @CurrentUser() user: TokenUser,
    @Param('channelId') channelId: string,
    @Body(new ZodPipe(addMemberSchema)) input: { userId: string },
  ): Promise<Member[]> {
    return this.channels.addMember(channelId, user.id, input.userId);
  }

  @Get(':channelId/messages')
  history(
    @CurrentUser() user: TokenUser,
    @Param('channelId') channelId: string,
    @Query('beforeSeq', new ZodPipe(beforeSeqSchema)) beforeSeq?: number,
  ): Promise<HistoryPage> {
    return this.channels.history(channelId, user.id, beforeSeq);
  }

  /**
   * Send, over REST.
   *
   * The channel id comes from the path and the body carries it too, because the
   * body is the shared `sendMessageSchema` that the socket path also parses. They
   * must agree: a body naming a different channel than the path is a client bug,
   * and letting the body win would make the path decorative.
   */
  @Post(':channelId/messages')
  async send(
    @CurrentUser() user: TokenUser,
    @Param('channelId') channelId: string,
    @Body(new ZodPipe(sendMessageSchema)) input: z.infer<typeof sendMessageSchema>,
  ): Promise<MessageSendAck> {
    assertSameChannel(channelId, input.channelId);

    const result = await sendMessage(
      this.repository,
      {
        channelId,
        authorId: user.id,
        clientMessageId: input.clientMessageId,
        body: input.body,
        ...(input.attachmentIds === undefined ? {} : { attachmentIds: input.attachmentIds }),
      },
      { attempts: this.config.sendRetryAttempts, classify: CLASSIFIER },
    );

    const message: Message = presentMessage(result.message, { attachmentUrl });

    // Not re-broadcast on a duplicate: the message is already on every client
    // that was going to receive it, and a second copy is a line the reorder
    // buffer has to discard on a path where nothing went wrong.
    if (!result.duplicate) {
      this.redis.broadcast.messageNew(channelId, message, result.recipients);
    }

    return { message, duplicate: result.duplicate };
  }

  @Patch(':channelId/messages/:messageId')
  async edit(
    @CurrentUser() user: TokenUser,
    @Param('channelId') channelId: string,
    @Param('messageId') messageId: string,
    @Body(new ZodPipe(editMessageSchema)) input: z.infer<typeof editMessageSchema>,
  ): Promise<Message> {
    assertSameChannel(channelId, input.channelId);

    const row = await editMessage(this.repository, {
      channelId,
      messageId,
      actorId: user.id,
      body: input.body,
    });
    const message = presentMessage(row, { attachmentUrl });
    this.redis.broadcast.messageUpdated(channelId, message);
    return message;
  }

  /**
   * Delete, as a tombstone.
   *
   * `POST .../delete` rather than `DELETE`, because the body carries the shared
   * `deleteMessageSchema` and a DELETE with a body is inconsistently supported by
   * proxies and by `fetch` in older browsers. The row is not removed either way: a
   * hole in `seq` is indistinguishable from a message a client has not received.
   */
  @Post(':channelId/messages/:messageId/delete')
  async remove(
    @CurrentUser() user: TokenUser,
    @Param('channelId') channelId: string,
    @Param('messageId') messageId: string,
    @Body(new ZodPipe(deleteMessageSchema)) input: z.infer<typeof deleteMessageSchema>,
  ): Promise<Message> {
    assertSameChannel(channelId, input.channelId);

    const row = await deleteMessage(this.repository, { channelId, messageId, actorId: user.id });
    const message = presentMessage(row, { attachmentUrl });
    this.redis.broadcast.messageDeleted(channelId, message);
    return message;
  }

  /**
   * Move the read marker.
   *
   * Returns what the server stored, which can be lower than what was asked for:
   * the marker only moves forward, so a stale request from a second tab is a no-op
   * and this answer corrects the client rather than rolling anybody's marker back.
   */
  @Post(':channelId/read')
  async read(
    @CurrentUser() user: TokenUser,
    @Param('channelId') channelId: string,
    @Body(new ZodPipe(markReadSchema)) input: z.infer<typeof markReadSchema>,
  ): Promise<{ seq: number }> {
    assertSameChannel(channelId, input.channelId);

    const seq = await markRead(this.repository, { channelId, userId: user.id, seq: input.seq });
    this.redis.broadcast.readChanged(channelId, user.id, seq);
    return { seq };
  }
}

/**
 * The path and the body must name the same channel.
 *
 * Without this the body would win, and a caller who is a member of channel A
 * could POST to A's path with B's id in the body. `services/messaging` checks
 * membership against whichever id it is handed, so the check would pass against
 * the wrong channel.
 */
function assertSameChannel(fromPath: string, fromBody: string): void {
  if (fromPath !== fromBody) {
    // A real `MessagingError`, not an ad-hoc throw: `DomainErrorFilter` maps it
    // by `instanceof`, so anything else here would fall through to the 500 branch
    // and report a client mistake as a server fault.
    throw new MessagingError(
      'INVALID',
      'The channel in the path and the channel in the body must match.',
    );
  }
}
