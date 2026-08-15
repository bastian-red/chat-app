/**
 * The read path's two composite views, built once for both callers.
 *
 * `apps/api` builds a channel view when somebody opens a channel over REST;
 * `apps/realtime` builds the identical view for `channel.state` on
 * `channel.join`. Those are the same screen reached two ways, and two
 * implementations of it drift in the way that is hardest to notice: the socket
 * path and the reload path disagree about the unread divider, or one of them
 * forgets `counterparts` and every DM in the sidebar loses its title.
 *
 * The same argument as `present.ts` one level up. That module maps a row to a
 * contract object; this one decides which rows to read and how the page is
 * bounded.
 *
 * ---------------------------------------------------------------------------
 * The `limit + 1` convention, stated once
 *
 * `repository.history` and `repository.forward` both fetch one row more than
 * asked for and return everything they fetched. The caller decides what the extra
 * row means. That is deliberate: `hasMore` for a backwards page and `complete` for
 * a catch-up are different questions with different answers, and an adapter that
 * sliced for you could only answer one of them.
 *
 * Getting it wrong is invisible in the common case and wrong at exactly one page
 * boundary, which is why it lives here rather than being repeated at each call
 * site.
 */
import { attachmentPath, type ChannelView, type Member, type PresenceState } from '@chat/shared';

import { presentCounterpart, presentMember, presentMessage } from './present';
import { MessagingError, type MessagingRepository } from './ports';

/**
 * The attachment URL every process produces.
 *
 * Injected into `presentMessage` from here rather than at each call site, so the
 * API's REST payload and the gateway's broadcast carry byte-identical strings. A
 * path, not a URL: see `packages/shared/src/attachments.ts`.
 */
export const attachmentUrl = (attachment: { id: string }): string => attachmentPath(attachment.id);

export interface ChannelViewInput {
  channelId: string;
  userId: string;
  /** `HISTORY_PAGE_SIZE`. The newest page is what a freshly opened channel shows. */
  limit: number;
  /**
   * The Redis roster, already read.
   *
   * A map rather than a `services/presence` dependency, because this package must
   * stay free of `ioredis` (`docs/CODESTYLE.md` section 7) and because the caller
   * has usually read the roster already for its own broadcast. Absent means
   * `offline`, which is the honest answer for somebody with no entry.
   */
  presence: ReadonlyMap<string, PresenceState>;
}

export async function loadChannelView(
  repository: MessagingRepository,
  input: ChannelViewInput,
): Promise<ChannelView> {
  const channel = await repository.channel(input.channelId);
  if (!channel) throw new MessagingError('NOT_FOUND', 'That channel does not exist.');

  const member = await repository.member(input.channelId, input.userId);
  // The same answer as "no such channel" would leak the existence of every
  // private channel to anybody who could guess an id, so this is FORBIDDEN and
  // the check above is NOT_FOUND only for a channel that genuinely is not there.
  if (!member) throw new MessagingError('FORBIDDEN', 'You are not in that channel.');

  const [members, counterparts, fetched] = await Promise.all([
    repository.members(input.channelId),
    repository.counterparts(input.channelId, input.userId),
    repository.history({ channelId: input.channelId, limit: input.limit }),
  ]);

  const hasMore = fetched.length > input.limit;
  const page = hasMore ? fetched.slice(0, input.limit) : fetched;

  return {
    id: channel.id,
    kind: channel.kind,
    slug: channel.slug,
    name: channel.name,
    topic: channel.topic,
    role: member.role,
    members: members.map((row): Member =>
      presentMember(row, input.presence.get(row.userId) ?? 'offline'),
    ),
    counterparts: counterparts.map(presentCounterpart),
    // Oldest first. The repository reads backwards from the newest so the keyset
    // can use the index, and a conversation is read downwards, so exactly one of
    // the two has to reverse. Doing it here means every client receives the same
    // order and none of them has to know which direction the query ran in.
    messages: [...page].reverse().map((row) => presentMessage(row, { attachmentUrl })),
    hasMore,
    lastReadSeq: member.lastReadSeq,
    // `nextSeq` is what the channel will hand out next, so the highest that
    // exists is one below it, and an empty channel reports 0 rather than -1.
    lastSeq: Math.max(0, channel.nextSeq - 1),
  };
}
