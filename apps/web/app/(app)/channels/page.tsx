import Link from 'next/link';
import { channelSummarySchema, unreadBadge } from '@chat/shared';
import { z } from 'zod';

import { apiFetch } from '../../../lib/api';
import { auth } from '../../../auth';

/**
 * The sidebar, as a page.
 *
 * `unread` and `unreadMentions` are computed by the API on every read rather than
 * stored, which is why they can be trusted here: storing them would mean two
 * writers for one fact, and every unread-counter bug in every chat product is
 * those two disagreeing.
 *
 * A DM has no name. Its label is whoever else is in it, resolved per reader,
 * because "Ana Ruiz" is the wrong title for Ana's own window.
 */
export default async function ChannelsPage() {
  const session = await auth();
  const user = session!.user;

  const channels = await apiFetch(
    { id: user.id, email: user.email, name: user.name },
    '/channels',
    z.array(channelSummarySchema),
  );

  return (
    <div className="stack">
      <h1 className="panel-title">Channels</h1>
      <ul className="channel-list">
        {channels.map((channel) => {
          const badge = unreadBadge(channel.unread);
          const label = channel.name ?? channel.counterparts.map((p) => p.name).join(', ');
          return (
            <li className="channel-row" key={channel.id}>
              <Link className="channel-link" href={`/channels/${channel.id}`}>
                {label}
              </Link>
              {/* A count and a word, never a tint. Same rule as presence: state
                  is never carried by colour alone. */}
              {badge === null ? null : (
                <span className="unread-badge" aria-label={badge.label}>
                  {badge.text}
                </span>
              )}
              {channel.unreadMentions === 0 ? null : (
                <span
                  className="mention-marker"
                  aria-label={`${String(channel.unreadMentions)} mentioning you`}
                >
                  @
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
