'use client';

/**
 * The conversation: the message list, the composer, and the one socket that feeds
 * both.
 *
 * Four behaviours here are the product rather than the chrome.
 *
 * **The optimistic send.** A `clientMessageId` is generated before the request
 * leaves, the line renders immediately, and `reconcile` replaces it with the
 * stored message when the ack or the broadcast arrives. The id is what makes a
 * retry after a dropped ack return the original row rather than posting twice.
 *
 * **The gap detector.** `firstGap` is recomputed after every arrival. A hole means
 * frames were dropped -- a reconnect, a slow tab -- and the client asks for a
 * `channel.catchup` from the seq below the hole. `complete: false` in the answer
 * means the gap was wider than `CATCHUP_MAX_MESSAGES` and the correct response is
 * a channel reload, not a splice.
 *
 * **Day dividers against the reader's stored zone**, not the browser's. Two people
 * in Madrid and Santiago reading one conversation must each see their own day
 * boundaries, and a browser-derived zone would make the divider move when somebody
 * travels. The E2E suite pins `timezoneId: 'UTC'` precisely so a spec cannot pass
 * by the browser agreeing with the database.
 *
 * **The read marker follows what is on screen.** It only ever moves forward, and
 * the server clamps it; the ack carries what was actually stored, so a stale tab
 * corrects itself rather than un-reading anything.
 */
import { CLIENT_EVENTS, SERVER_EVENTS } from '@chat/shared';
import { formatDay, formatTimeOfDay, today } from '@chat/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChannelView, Message, MessageSendAck } from '@chat/shared';

import { PresenceChip } from './presence-chip';
import {
  addPending,
  firstGap,
  highestSeq,
  markFailed,
  reconcile,
  replace,
  type Line,
} from '../lib/reconcile';
import { useChatSocket } from '../lib/use-chat-socket';

interface Props {
  view: ChannelView;
  viewer: { id: string; name: string; timeZone: string };
}

/** Who is typing, as the complete set the server sends. */
interface TypingEntry {
  userId: string;
  name: string;
}

export function Conversation({ view, viewer }: Props) {
  const [lines, setLines] = useState<Line[]>(() =>
    view.messages.map((message) => ({ kind: 'stored', message })),
  );
  const [members, setMembers] = useState(view.members);
  const [typing, setTyping] = useState<TypingEntry[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [lastReadSeq, setLastReadSeq] = useState(view.lastReadSeq);

  const socket = useChatSocket(true);
  const bottomRef = useRef<HTMLLIElement | null>(null);
  const typingSentAt = useRef(0);

  // --- socket wiring --------------------------------------------------------

  useEffect(() => {
    if (socket.state !== 'connected') return;

    void socket.send(CLIENT_EVENTS.channelJoin, { channelId: view.id });

    const offNew = socket.on(SERVER_EVENTS.messageNew, (payload: { message: Message }) => {
      if (payload.message.channelId !== view.id) return;
      setLines((current) => reconcile(current, payload.message));
    });
    const offUpdated = socket.on(SERVER_EVENTS.messageUpdated, (payload: { message: Message }) => {
      setLines((current) => replace(current, payload.message));
    });
    const offDeleted = socket.on(SERVER_EVENTS.messageDeleted, (payload: { message: Message }) => {
      setLines((current) => replace(current, payload.message));
    });
    const offTyping = socket.on(
      SERVER_EVENTS.typingChanged,
      (payload: { channelId: string; typing: TypingEntry[] }) => {
        if (payload.channelId !== view.id) return;
        // The complete set, always. Holding a delta is what leaves somebody
        // typing forever after one missed "stopped".
        setTyping(payload.typing.filter((entry) => entry.userId !== viewer.id));
      },
    );
    const offPresence = socket.on(
      SERVER_EVENTS.presenceChanged,
      (payload: { channelId: string; members: { userId: string; state: string }[] }) => {
        if (payload.channelId !== view.id) return;
        setMembers((current) =>
          current.map((member) => {
            const entry = payload.members.find((row) => row.userId === member.userId);
            return entry === undefined
              ? { ...member, presence: 'offline' as const }
              : { ...member, presence: entry.state as typeof member.presence };
          }),
        );
      },
    );

    return () => {
      offNew();
      offUpdated();
      offDeleted();
      offTyping();
      offPresence();
    };
  }, [socket, socket.state, view.id, viewer.id]);

  // --- the gap detector -----------------------------------------------------

  useEffect(() => {
    if (socket.state !== 'connected') return;

    const gap = firstGap(lines);
    if (gap === null) return;

    void (async () => {
      const ack = await socket.send<{ messages: Message[]; complete: boolean }>(
        CLIENT_EVENTS.channelCatchUp,
        { channelId: view.id, afterSeq: gap - 1 },
      );
      if (!ack.ok) {
        if (ack.error.code === 'TOO_FAR_BEHIND') {
          // Reload, never splice. Streaming a week of backlog through a socket
          // to a client that renders forty lines of it is how a reconnect storm
          // takes a gateway down.
          setNotice('This conversation moved on a long way. Reload to catch up.');
        }
        return;
      }

      if (!ack.data.complete) {
        setNotice('This conversation moved on a long way. Reload to catch up.');
        return;
      }
      setLines((current) => ack.data.messages.reduce(reconcile, current));
    })();
  }, [lines, socket, socket.state, view.id]);

  // --- the read marker ------------------------------------------------------

  const highest = highestSeq(lines);

  useEffect(() => {
    if (socket.state !== 'connected' || highest <= lastReadSeq) return;

    void (async () => {
      const ack = await socket.send<{ seq: number }>(CLIENT_EVENTS.messageRead, {
        channelId: view.id,
        seq: highest,
      });
      // What the server stored, which can be lower than what was asked for. The
      // marker only moves forward, so a stale tab corrects itself here rather
      // than rolling anybody's marker back.
      if (ack.ok) setLastReadSeq(ack.data.seq);
    })();
  }, [highest, lastReadSeq, socket, socket.state, view.id]);

  // Scrolled after every arrival, not on a timer. `block: 'end'` rather than
  // `scrollTop = scrollHeight` so a reader who has scrolled up is not yanked back
  // by their own browser's smooth-scroll setting.
  useEffect(() => {
    // The list is scrolled, not the page. `scrollIntoView` walks up to whichever
    // ancestor scrolls, so with a page-level overflow it moves the whole document
    // and takes the header and the composer off-screen with it. `.shell` sets
    // `height: 100dvh; overflow: hidden` to make `.messages` that ancestor, and
    // this line depends on it.
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [lines.length]);

  // --- sending --------------------------------------------------------------

  const send = useCallback(
    async (body: string) => {
      const trimmed = body.trim();
      if (trimmed === '') return;

      // Generated before the send and reused by every retry. This is the whole
      // idempotency mechanism: `@@unique([channelId, clientMessageId])` is what
      // makes a retry after a dropped ack return the original row.
      const clientMessageId = crypto.randomUUID();

      setLines((current) =>
        addPending(current, {
          kind: 'pending',
          clientMessageId,
          body: trimmed,
          authorId: viewer.id,
          authorName: viewer.name,
          createdAt: new Date().toISOString(),
        }),
      );
      setDraft('');

      const ack = await socket.send<MessageSendAck>(CLIENT_EVENTS.messageSend, {
        channelId: view.id,
        clientMessageId,
        body: trimmed,
      });

      if (!ack.ok) {
        setLines((current) => markFailed(current, clientMessageId));
        setNotice(ack.error.message);
        return;
      }

      setLines((current) => reconcile(current, ack.data.message));
    },
    [socket, view.id, viewer.id, viewer.name],
  );

  /**
   * Typing, throttled.
   *
   * One event every two seconds rather than one per keystroke. The TTL is five
   * seconds, so two is comfortably inside it, and the alternative is 240 events a
   * minute from one person typing normally, which is the entire per-socket budget
   * spent on an indicator.
   */
  const onDraftChange = useCallback(
    (value: string) => {
      setDraft(value);
      const now = Date.now();
      if (value !== '' && now - typingSentAt.current > 2000) {
        typingSentAt.current = now;
        void socket.send(CLIENT_EVENTS.typingStart, { channelId: view.id });
      }
      if (value === '') {
        typingSentAt.current = 0;
        void socket.send(CLIENT_EVENTS.typingStop, { channelId: view.id });
      }
    },
    [socket, view.id],
  );

  // --- rendering ------------------------------------------------------------

  const rows = useMemo(
    () => withDividers(lines, viewer.timeZone, lastReadSeq),
    [lines, viewer.timeZone, lastReadSeq],
  );

  return (
    <div className="conversation">
      <header className="conversation-header">
        <h1 className="conversation-title">{view.name ?? counterpartName(view)}</h1>
        {view.topic === null ? null : <p className="conversation-topic">{view.topic}</p>}
        <ul className="roster" aria-label="Members">
          {members.map((member) => (
            <li className="roster-row" key={member.userId}>
              <span className="roster-name">{member.name}</span>
              <PresenceChip name={member.name} state={member.presence} />
            </li>
          ))}
        </ul>
      </header>

      {/*
        A live region, so a screen-reader user is told the connection dropped.
        `polite` rather than `assertive`: it must not interrupt somebody
        mid-sentence, and a reconnect that resolves in a second should not
        announce twice.
      */}
      <p className="connection" role="status" data-state={socket.state}>
        {socket.state === 'connected' ? 'Live' : 'Reconnecting'}
      </p>

      {notice === null ? null : (
        <p className="notice" role="alert">
          {notice}
        </p>
      )}

      {/*
        `tabIndex={0}` on a scrollable region, and it is not decoration.
        A region that scrolls but cannot be focused is unreachable to anybody
        driving the page from the keyboard: there is no way to put the caret
        inside it, so there is no way to page through the conversation without a
        mouse. axe reports it as `scrollable-region-focusable`, impact serious,
        and it is a WCAG 2.1.1 failure.
        It appeared the moment `.shell` stopped letting the page scroll and made
        this element the scroll container instead, which is why the fix and the
        layout change belong together.
        The `aria-label` is what stops the focusable element being an unnamed
        stop in the tab order.
      */}
      <ol className="messages" aria-label="Conversation" tabIndex={0}>
        {rows.map((row) =>
          row.kind === 'divider' ? (
            <li className="day-divider" key={`day-${row.label}`}>
              {row.label}
            </li>
          ) : row.kind === 'unread' ? (
            <li className="unread-divider" key="unread">
              New messages
            </li>
          ) : (
            <MessageRow key={rowKey(row.line)} line={row.line} timeZone={viewer.timeZone} />
          ),
        )}
        {/* The scroll sentinel, inside the list rather than after it. Outside, it
            is not a descendant of the scroll container, so scrolling it into view
            moves the page instead of the conversation. */}
        <li ref={bottomRef} className="scroll-sentinel" aria-hidden="true" />
      </ol>

      {/*
        The typing indicator carries names, not a count. "Somebody is typing" is
        the version that tells a reader nothing they can act on.
      */}
      <p className="typing" role="status">
        {/*
          An empty string, not a spacer character. `.typing` reserves the line
          with `min-height`, so nothing has to be rendered to hold it open, and
          the no-break space that was here originally is exactly what
          `scripts/invisible-chars.mjs` exists to refuse: it is
          indistinguishable from a plain space in every editor and every diff.
        */}
        {typing.length === 0
          ? ''
          : `${typing.map((entry) => entry.name).join(', ')} ${typing.length === 1 ? 'is' : 'are'} typing`}
      </p>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <label className="sr-only" htmlFor="composer-input">
          Message
        </label>
        <input
          id="composer-input"
          className="composer-input"
          value={draft}
          onChange={(event) => {
            onDraftChange(event.target.value);
          }}
          placeholder="Write a message"
          autoComplete="off"
        />
        <button className="button button-primary" type="submit" disabled={draft.trim() === ''}>
          Send
        </button>
      </form>
    </div>
  );
}

function MessageRow({ line, timeZone }: { line: Line; timeZone: string }) {
  if (line.kind === 'pending') {
    return (
      <li
        className="message message-pending"
        data-failed={line.failed === true ? 'true' : undefined}
      >
        <span className="message-author">{line.authorName}</span>
        <span className="message-body">{line.body}</span>
        {/* A word, not a spinner: "sending" and "failed" have to be tellable
            apart without colour and without motion. */}
        <span className="message-state">{line.failed === true ? 'Failed' : 'Sending'}</span>
      </li>
    );
  }

  const { message } = line;
  const deleted = message.deletedAt !== null;

  return (
    <li className="message" data-deleted={deleted ? 'true' : undefined}>
      <span className="message-author">{message.author?.name ?? 'Deleted account'}</span>
      <time className="message-time mono" dateTime={message.createdAt}>
        {formatTimeOfDay(new Date(message.createdAt), timeZone)}
      </time>
      <span className="message-body">{deleted ? 'This message was deleted' : message.body}</span>
      {/* "edited" as a word rather than a tint. Same rule as presence: state is
          never carried by colour alone. */}
      {message.editedAt === null || deleted ? null : <span className="message-state">edited</span>}
    </li>
  );
}

type Row =
  { kind: 'divider'; label: string } | { kind: 'unread' } | { kind: 'message'; line: Line };

/**
 * Interleave day dividers and the unread marker into the list.
 *
 * The day is computed **in the reader's stored zone**, not the browser's. A
 * conversation open on a laptop in Madrid and a phone in Santiago must put the
 * dividers where each reader's calendar says, and deriving the zone from the
 * browser would move them when somebody travels.
 */
function withDividers(lines: readonly Line[], timeZone: string, lastReadSeq: number): Row[] {
  const rows: Row[] = [];
  let previousDay: string | null = null;
  let unreadPlaced = false;

  for (const line of lines) {
    if (line.kind === 'stored') {
      // `today(instant, zone)` is "which calendar day is this instant, there".
      // The reader's stored zone, never the browser's: two people in Madrid and
      // Santiago must each see their own day boundaries, and a browser-derived
      // zone would move the dividers when somebody travels.
      const day = today(new Date(line.message.createdAt), timeZone);
      if (day !== previousDay) {
        rows.push({ kind: 'divider', label: formatDay(day, 'en-GB') });
        previousDay = day;
      }
      if (!unreadPlaced && lastReadSeq > 0 && line.message.seq === lastReadSeq + 1) {
        rows.push({ kind: 'unread' });
        unreadPlaced = true;
      }
    }
    rows.push({ kind: 'message', line });
  }

  return rows;
}

const rowKey = (line: Line): string =>
  line.kind === 'stored' ? line.message.id : `pending-${line.clientMessageId}`;

/** A DM has no name; its label is whoever else is in it, resolved per reader. */
const counterpartName = (view: ChannelView): string =>
  view.counterparts.map((person) => person.name).join(', ') || 'Direct message';
