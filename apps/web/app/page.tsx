import {
  presenceGlyph,
  presenceSummary,
  presenceWord,
  unreadBadge,
  type RosterEntry,
} from '@chat/shared';

/**
 * The landing page.
 *
 * Deliberately not a chat. The application UI lands in a later stage; this page
 * exists so the design identity has something real to render against, and so the
 * axe suite, the class gate and the contrast gate are measuring a page a reader
 * could actually receive rather than an empty document.
 *
 * The presence specimen at the bottom is the one part that is not decoration. The
 * rule it demonstrates is measured in `lib/contrast.test.ts`: in light mode
 * `--online` and `--offline` sit at a 1.00:1 contrast ratio, which is identical
 * relative luminance, so on a greyscale display or to a reader with deuteranopia
 * they are one pixel. Rendering it here means the rule is visible on a page rather
 * than asserted in a comment, and it uses the real `presenceWord` / `presenceGlyph`
 * out of `@chat/shared` rather than a local copy, which is the whole reason those
 * words live in a shared package.
 *
 * The names below are sample data and say so on the page.
 */
const SPECIMEN: readonly RosterEntry[] = [
  { userId: 'specimen-1', name: 'Ana Ruiz', state: 'online', connections: 2 },
  { userId: 'specimen-2', name: 'Beto Lima', state: 'away' },
  { userId: 'specimen-3', name: 'Cris Dunn', state: 'offline' },
];

/** Nine unread, which is a plausible count and short enough not to need the cap. */
const SPECIMEN_UNREAD = unreadBadge(9);

export default function HomePage(): JSX.Element {
  return (
    <main id="main" className="page">
      <div className="stack">
        <header>
          <p className="eyebrow">Real-time chat</p>
          <h1 className="landing-title">Every message in one order, from more than one gateway.</h1>
          <p className="lede">
            Channels and direct messages, presence, typing indicators and read state. Order comes
            from a sequence number Postgres allocates inside the same transaction that writes the
            row, so two people sending at once cannot produce two messages that disagree about which
            came first, and a client that reconnects can name exactly what it missed.
          </p>
          <p className="actions">
            <a className="button button-primary" href="/status">
              Service status
            </a>
          </p>
        </header>

        <section className="panel">
          <h2 className="panel-title">What it has to get right</h2>
          <ul className="feature-list">
            <li>
              <h3 className="feature-title">One total order per channel</h3>
              <p className="feature-body">
                A sequence number per channel, allocated by Postgres in the send transaction. A
                crash between the allocation and the insert rolls the number back rather than
                burning it.
              </p>
            </li>
            <li>
              <h3 className="feature-title">A resend is not a second message</h3>
              <p className="feature-body">
                The client mints an id before it sends. The same id arriving twice yields one row
                and an acknowledgement carrying the first row&rsquo;s position.
              </p>
            </li>
            <li>
              <h3 className="feature-title">More than one gateway</h3>
              <p className="feature-body">
                Broadcasts travel over Redis pub/sub, so two socket processes serve one channel.
                With a single process everything works whether that is wired or not, which is why
                the integration lane starts two.
              </p>
            </li>
            <li>
              <h3 className="feature-title">Catch-up with a floor</h3>
              <p className="feature-body">
                A reconnecting client asks for everything after the last position it saw. Past two
                hundred messages behind it is told to reload the channel instead.
              </p>
            </li>
          </ul>
        </section>

        <section className="panel">
          <h2 className="panel-title">Presence is never colour alone</h2>
          <p className="feature-body">
            Sample data, to show how a roster row is built. The state is a word and a glyph whose
            shape differs; the dot takes the colour and carries nothing. In light mode the online
            green and the offline grey have identical relative luminance, so a reader on a greyscale
            display sees one colour and two different sentences.
          </p>
          <ul className="roster">
            {SPECIMEN.map((entry) => (
              <li className="roster-row" key={entry.userId}>
                <span className="roster-name">{entry.name}</span>
                <span className="presence-chip" data-state={entry.state}>
                  {/* aria-hidden because `presenceWord` beside it already says the
                      state. A screen reader reading "black circle Online" is worse
                      off than one reading "Online". */}
                  <span className="presence-glyph" aria-hidden="true">
                    {presenceGlyph(entry.state)}
                  </span>
                  <span className="presence-word">{presenceWord(entry.state)}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="status-note">{presenceSummary(SPECIMEN)}.</p>
        </section>

        <section className="panel">
          <h2 className="panel-title">The accent is spent on two things</h2>
          <p className="feature-body">
            Unread state and mentions, and nothing else. An accent drawn from the green and amber
            the roster already spends would be read as a presence dot the first time it appeared
            beside one, so this one is a cold cyan that sits nowhere near them.
          </p>
          <p className="actions">
            {SPECIMEN_UNREAD === null ? null : (
              <>
                {/* The badge is a number a sighted reader counts at a glance and a
                    sentence a screen reader gets in full. "99+" tells somebody
                    listening less than the real number does, and there is no
                    layout to break in speech, so the cap is on the glyph only. */}
                <span className="unread-badge" aria-hidden="true">
                  {SPECIMEN_UNREAD.text}
                </span>
                <span className="sr-only">{SPECIMEN_UNREAD.label}</span>
              </>
            )}
            <span className="mention-marker">Mention</span>
          </p>
        </section>
      </div>
    </main>
  );
}
