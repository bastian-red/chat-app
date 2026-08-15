/**
 * The other half of the brief: horizontal scaling.
 *
 * **A message sent through the gateway on :4100 reaches a client connected to the
 * gateway on :4101.** That is the only assertion that proves the Redis adapter is
 * real. With one process every socket shares one in-memory adapter and every
 * broadcast works whether `@socket.io/redis-adapter` is wired or not, so a
 * single-process suite passes with the adapter deleted. Two processes is the
 * smallest number at which the pub/sub path can fail, which is why
 * `scripts/integration.sh` starts two.
 *
 * The rest of this file is the socket protocol against real infrastructure:
 * presence expiring through a real Redis TTL, the typing set, the catch-up bound,
 * and the handshake refusing a token it cannot verify.
 */
import { CLIENT_EVENTS, SERVER_EVENTS } from '@chat/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isDuplicateClientMessage, isSeqCollision } from '@chat/db';
import { sendMessage } from '@chat/messaging';
import type { Socket } from 'socket.io-client';

import {
  AUTH_SECRET,
  GATEWAY_1,
  GATEWAY_2,
  closeAll,
  connect,
  emit,
  expectOk,
  person,
  prisma,
  repository,
  scratchChannel,
  waitFor,
  type Person,
} from './harness';

const CLASSIFIER = { isDuplicateClientMessage, isSeqCollision };

/** Sockets opened by whichever test is running, closed in `afterEach`. */
let open: Socket[] = [];

function track(socket: Socket): Socket {
  open.push(socket);
  return socket;
}

afterEach(() => {
  closeAll(...open);
  open = [];
});

describe('cross-replica broadcast', () => {
  let ana: Person;
  let bruno: Person;
  let channelId: string;

  beforeAll(async () => {
    ana = await person('ana@chat.test');
    bruno = await person('bruno@chat.test');
    channelId = (await scratchChannel('xrep', [ana.id, bruno.id])).id;
  });

  afterAll(async () => {
    await prisma.channel.deleteMany({ where: { id: channelId } });
  });

  it('is running two distinct gateways, or says so', () => {
    // Stated as an assertion rather than a skip. A suite that quietly tested one
    // process against itself would report the headline claim as proven while
    // proving nothing, and that is worse than a red line telling somebody to
    // start the second replica.
    expect(
      GATEWAY_2,
      'REALTIME_BASE_URL_2 must point at a second gateway. Run this through scripts/integration.sh.',
    ).not.toBe(GATEWAY_1);
  });

  it('delivers a message sent on gateway 1 to a client on gateway 2', async () => {
    const sender = track(await connect(GATEWAY_1, ana.token));
    const receiver = track(await connect(GATEWAY_2, bruno.token));

    expectOk(await emit(sender, CLIENT_EVENTS.channelJoin, { channelId }), 'sender join');
    expectOk(await emit(receiver, CLIENT_EVENTS.channelJoin, { channelId }), 'receiver join');

    const body = `crossing replicas ${String(Date.now())}`;
    const arrival = waitFor<{ message: { body: string; seq: number } }>(
      receiver,
      SERVER_EVENTS.messageNew,
      (payload) => payload.message.body === body,
    );

    const ack = expectOk(
      await emit<{ message: { seq: number }; duplicate: boolean }>(
        sender,
        CLIENT_EVENTS.messageSend,
        { channelId, clientMessageId: `xrep-${String(Date.now())}`, body },
      ),
      'send',
    );

    const delivered = await arrival;

    // The same seq on both sides. The ack and the broadcast are two paths for one
    // write, and where they disagree the server's stored value wins; asserting
    // they agree is what makes convergence a property rather than a hope.
    expect(delivered.message.seq).toBe(ack.message.seq);
  });

  it('does not send the author their own message back', async () => {
    // The author learns the seq from the ack, so a second delivery is a duplicate
    // the reorder buffer discards on every single send. Asserted by waiting for a
    // window in which it would have arrived if the exclusion were missing.
    const sender = track(await connect(GATEWAY_1, ana.token));
    expectOk(await emit(sender, CLIENT_EVENTS.channelJoin, { channelId }), 'join');

    const body = `own message ${String(Date.now())}`;
    let echoed = false;
    sender.on(SERVER_EVENTS.messageNew, (payload: { message: { body: string } }) => {
      if (payload.message.body === body) echoed = true;
    });

    expectOk(
      await emit(sender, CLIENT_EVENTS.messageSend, {
        channelId,
        clientMessageId: `own-${String(Date.now())}`,
        body,
      }),
      'send',
    );

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(echoed).toBe(false);
  });

  it('reaches a member who has the channel closed, through their user room', async () => {
    // The second room kind, and the one that is easy to leave out. A DM arriving
    // in a conversation the recipient does not have open still has to bump their
    // sidebar. Bruno connects and never joins the channel.
    const sender = track(await connect(GATEWAY_1, ana.token));
    const idle = track(await connect(GATEWAY_2, bruno.token));

    expectOk(await emit(sender, CLIENT_EVENTS.channelJoin, { channelId }), 'join');

    const body = `user room ${String(Date.now())}`;
    const arrival = waitFor<{ message: { body: string } }>(
      idle,
      SERVER_EVENTS.messageNew,
      (payload) => payload.message.body === body,
    );

    expectOk(
      await emit(sender, CLIENT_EVENTS.messageSend, {
        channelId,
        clientMessageId: `room-${String(Date.now())}`,
        body,
      }),
      'send',
    );

    await expect(arrival).resolves.toBeDefined();
  });
});

describe('the handshake', () => {
  it('refuses a socket with no token', async () => {
    await expect(connect(GATEWAY_1, '')).rejects.toThrow();
  });

  it('refuses a token signed with the wrong secret', async () => {
    // A close, not a `server.error`: an unauthenticated socket has no session to
    // send an error to, and answering an application-level error invites a client
    // to retry forever.
    const { mintServiceToken } = await import('@chat/shared/server');
    const forged = mintServiceToken(
      { id: 'nobody', email: 'nobody@chat.test', name: 'Nobody' },
      `${AUTH_SECRET}-wrong`,
    );

    await expect(connect(GATEWAY_1, forged)).rejects.toThrow();
  });
});

describe('presence and typing against a real Redis', () => {
  let ana: Person;
  let bruno: Person;
  let channelId: string;

  beforeAll(async () => {
    ana = await person('ana@chat.test');
    bruno = await person('bruno@chat.test');
    channelId = (await scratchChannel('presence', [ana.id, bruno.id])).id;
  });

  afterAll(async () => {
    await prisma.channel.deleteMany({ where: { id: channelId } });
  });

  it('puts a joiner on the roster and tells the others', async () => {
    const first = track(await connect(GATEWAY_1, ana.token));
    expectOk(await emit(first, CLIENT_EVENTS.channelJoin, { channelId }), 'ana join');

    const roster = waitFor<{ members: { userId: string }[] }>(
      first,
      SERVER_EVENTS.presenceChanged,
      (payload) => payload.members.some((member) => member.userId === bruno.id),
    );

    const second = track(await connect(GATEWAY_2, bruno.token));
    expectOk(await emit(second, CLIENT_EVENTS.channelJoin, { channelId }), 'bruno join');

    await expect(roster).resolves.toBeDefined();
  });

  it('forgets a client that stops heartbeating, within the TTL', async () => {
    // A real key expiry, which is why this cannot be a gate test. The lane
    // compresses PRESENCE_TTL_SECONDS to 3 while preserving the >2x ratio the
    // gateway's own `assertPresenceConfig` requires, so the wait is seconds
    // rather than half a minute.
    const ttlSeconds = Number(process.env.PRESENCE_TTL_SECONDS ?? '3');

    const watcher = track(await connect(GATEWAY_1, ana.token));
    expectOk(await emit(watcher, CLIENT_EVENTS.channelJoin, { channelId }), 'ana join');

    const leaver = await connect(GATEWAY_2, bruno.token);
    expectOk(await emit(leaver, CLIENT_EVENTS.channelJoin, { channelId }), 'bruno join');

    // Closed without a `channel.leave`, which is what a dropped connection looks
    // like. The `disconnecting` handler covers a clean close; this asserts the
    // TTL is what covers the rest.
    leaver.removeAllListeners();
    leaver.close();

    const gone = waitFor<{ members: { userId: string }[] }>(
      watcher,
      SERVER_EVENTS.presenceChanged,
      (payload) => !payload.members.some((member) => member.userId === bruno.id),
      (ttlSeconds + 5) * 1000,
    );

    await expect(gone).resolves.toBeDefined();
  });

  it('broadcasts the complete typing set, not a delta', async () => {
    const watcher = track(await connect(GATEWAY_1, ana.token));
    const typist = track(await connect(GATEWAY_2, bruno.token));

    expectOk(await emit(watcher, CLIENT_EVENTS.channelJoin, { channelId }), 'ana join');
    expectOk(await emit(typist, CLIENT_EVENTS.channelJoin, { channelId }), 'bruno join');

    const started = waitFor<{ typing: { userId: string }[] }>(
      watcher,
      SERVER_EVENTS.typingChanged,
      (payload) => payload.typing.some((entry) => entry.userId === bruno.id),
    );

    expectOk(await emit(typist, CLIENT_EVENTS.typingStart, { channelId }), 'typing.start');

    const payload = await started;
    // The whole set. A delta would require every client to hold state that drifts
    // and never repairs itself: one missed "stopped" leaves somebody typing
    // forever.
    expect(Array.isArray(payload.typing)).toBe(true);

    const stopped = waitFor<{ typing: { userId: string }[] }>(
      watcher,
      SERVER_EVENTS.typingChanged,
      (next) => !next.typing.some((entry) => entry.userId === bruno.id),
    );
    expectOk(await emit(typist, CLIENT_EVENTS.typingStop, { channelId }), 'typing.stop');

    await expect(stopped).resolves.toBeDefined();
  });
});

describe('catch-up', () => {
  let ana: Person;
  let channelId: string;
  const max = Number(process.env.CATCHUP_MAX_MESSAGES ?? '200');

  beforeAll(async () => {
    ana = await person('ana@chat.test');
    channelId = (await scratchChannel('catchup', [ana.id])).id;

    // One more than the ceiling, so the bound has something to refuse. Written
    // directly through `services/messaging` rather than over a socket, because
    // this is fixture setup and the socket path is what the assertion is about.
    for (let index = 0; index < max + 1; index += 1) {
      await sendMessage(
        repository,
        {
          channelId,
          authorId: ana.id,
          clientMessageId: `catchup-${String(index).padStart(4, '0')}`,
          body: `backlog ${String(index)}`,
        },
        { classify: CLASSIFIER },
      );
    }
  }, 180_000);

  afterAll(async () => {
    await prisma.channel.deleteMany({ where: { id: channelId } });
  });

  it('returns everything after the given seq when the gap is small', async () => {
    const socket = track(await connect(GATEWAY_1, ana.token));
    expectOk(await emit(socket, CLIENT_EVENTS.channelJoin, { channelId }), 'join');

    const result = expectOk(
      await emit<{ messages: { seq: number }[]; complete: boolean; lastSeq: number }>(
        socket,
        CLIENT_EVENTS.channelCatchUp,
        { channelId, afterSeq: max - 3 },
      ),
      'catchup',
    );

    expect(result.complete).toBe(true);
    expect(result.messages.map((message) => message.seq)).toEqual([max - 2, max - 1, max, max + 1]);
    expect(result.lastSeq).toBe(max + 1);
  });

  it('answers complete: false past the ceiling rather than streaming the backlog', async () => {
    // The client's correct response is a channel reload, not a splice. Streaming
    // a week of backlog through a socket to a client that will render forty lines
    // of it is how a reconnect storm takes a gateway down.
    const socket = track(await connect(GATEWAY_1, ana.token));
    expectOk(await emit(socket, CLIENT_EVENTS.channelJoin, { channelId }), 'join');

    const result = expectOk(
      await emit<{ messages: { seq: number }[]; complete: boolean }>(
        socket,
        CLIENT_EVENTS.channelCatchUp,
        { channelId, afterSeq: 0 },
      ),
      'catchup',
    );

    expect(result.complete).toBe(false);
    expect(result.messages).toHaveLength(max);
  });
});

describe('permission refusal on the socket path', () => {
  let outsider: Person;
  let channelId: string;

  beforeAll(async () => {
    const ana = await person('ana@chat.test');
    outsider = await person('dana@chat.test');
    channelId = (await scratchChannel('closed', [ana.id])).id;
  });

  afterAll(async () => {
    await prisma.channel.deleteMany({ where: { id: channelId } });
  });

  it('refuses a join from somebody who is not a member', async () => {
    const socket = track(await connect(GATEWAY_1, outsider.token));

    const ack = await emit(socket, CLIENT_EVENTS.channelJoin, { channelId });

    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe('FORBIDDEN');
  });

  it('refuses a send into a channel the sender is not in', async () => {
    const socket = track(await connect(GATEWAY_1, outsider.token));

    const ack = await emit(socket, CLIENT_EVENTS.messageSend, {
      channelId,
      clientMessageId: `outsider-${String(Date.now())}`,
      body: 'let me in',
    });

    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe('FORBIDDEN');

    // And nothing was written. A refusal that still allocated a sequence number
    // would leave a hole every client chases forever.
    const count = await prisma.message.count({ where: { channelId } });
    expect(count).toBe(0);
  });

  it('answers INVALID for a payload that fails its schema', async () => {
    const socket = track(await connect(GATEWAY_1, outsider.token));

    const ack = await emit(socket, CLIENT_EVENTS.messageSend, { channelId });

    expect(ack.ok).toBe(false);
    if (!ack.ok) {
      expect(ack.error.code).toBe('INVALID');
      // The zod issue list never reaches the wire: it names internal field paths
      // and quotes the input back, and the input here is somebody's message.
      expect(ack.error.message).not.toContain('clientMessageId');
    }
  });
});
