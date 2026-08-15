import { channelViewSchema } from '@chat/shared';
import { notFound } from 'next/navigation';

import { ApiError, apiFetch } from '../../../../lib/api';
import { Conversation } from '../../../../components/conversation';
import { auth } from '../../../../auth';

/**
 * One channel.
 *
 * The whole view is fetched on the server and handed to the client component as
 * props, so the first paint carries real messages rather than a spinner that
 * fills in after the socket connects. The socket then takes over: everything
 * after this render arrives as a broadcast.
 *
 * A `FORBIDDEN` from the API becomes a 404 here on purpose. The API already
 * refuses to distinguish "no such channel" from "not a member" -- doing otherwise
 * would leak the existence of every private channel to anybody who could guess an
 * id -- and rendering a 403 page would put that distinction back in the browser.
 */
export default async function ChannelPage({ params }: { params: { channelId: string } }) {
  const session = await auth();
  const user = session!.user;

  try {
    const view = await apiFetch(
      { id: user.id, email: user.email, name: user.name },
      `/channels/${params.channelId}`,
      channelViewSchema,
    );

    return (
      <Conversation
        view={view}
        viewer={{ id: user.id, name: user.name, timeZone: user.timeZone }}
      />
    );
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) notFound();
    throw error;
  }
}
