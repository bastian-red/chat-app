/**
 * A fresh service token for the browser's socket handshake.
 *
 * A route rather than a value baked into the page, for two reasons that both
 * matter: a token is a credential and HTML is cached, screenshotted and stored;
 * and a token lives 120 seconds, so one rendered into a page is stale before the
 * first reconnect. The socket asks for a new one on every connection attempt.
 *
 * It mints for the **caller's own session** and takes no parameters. A route that
 * accepted a user id would be an oracle that hands anybody a token for anybody.
 */
import { NextResponse } from 'next/server';
import { SERVICE_TOKEN_TTL_SECONDS, mintServiceToken } from '@chat/shared/server';

import { auth } from '../../../auth';
import { authSecret } from '../../../lib/config';

export async function GET(): Promise<NextResponse> {
  const session = await auth();
  const user = session?.user;
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const token = mintServiceToken({ id: user.id, email: user.email, name: user.name }, authSecret());

  return NextResponse.json(
    { token, expiresInSeconds: SERVICE_TOKEN_TTL_SECONDS },
    // Never cached, by any layer. A shared cache holding one person's token and
    // handing it to the next caller is the worst outcome this route has.
    { headers: { 'cache-control': 'no-store, private' } },
  );
}
