/**
 * Who a message mentions.
 *
 * Parsed from the body on the server, never taken from the client. A client that
 * sent its own mention list could mention somebody the body does not name -- which
 * is a notification a person cannot trace back to any message they can see.
 *
 * Mentions resolve against the **channel's membership**, so `@ana` in a channel
 * Ana is not in is text and nothing else. That is not a nicety: resolving against
 * every user in the database would let anybody notify anybody by typing their
 * handle into a private channel they share with nobody.
 */

/** A person a mention can resolve to. */
export interface Mentionable {
  userId: string;
  name: string;
}

/**
 * The handle a name is mentioned by: lowercase, non-alphanumerics collapsed out.
 *
 * `Ana Ruiz` -> `anaruiz`. Derived rather than stored because this product has no
 * separate handle field, and deriving it in one place is what keeps the parser
 * and the rendering agreeing about what `@anaruiz` refers to.
 *
 * `NFKD` first, so `José` and `Jose` produce the same handle. A reader typing
 * `@jose` on a keyboard with no accents is trying to mention José, and telling
 * them otherwise is a bug they cannot diagnose.
 */
export function handleOf(name: string): string {
  return (
    name
      .normalize('NFKD')
      // U+0300-U+036F, the combining diacritical marks NFKD splits off. Written
      // as escapes rather than as the characters themselves: a combining mark
      // pasted into a literal renders on top of the bracket before it and is
      // invisible in every editor and every diff, which is what
      // `scripts/invisible-chars.mjs` exists to refuse.
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
  );
}

/**
 * Every `@handle` in the body, as user ids.
 *
 * The regex requires a boundary before the `@` so an email address does not
 * mention anybody: `ana@chat.local` contains `@chat` and must not notify a person
 * whose handle is `chat`. That case is not hypothetical in a product where people
 * paste addresses into conversations constantly.
 *
 * `@everyone` is deliberately absent. It is a moderation feature with its own
 * permission and its own rate limit, and quietly treating it as a mention of the
 * whole channel would be a notification storm nobody asked for.
 *
 * The result is deduplicated and excludes the author: a message that names its
 * own sender should not notify them, and a message that names one person three
 * times should notify them once.
 */
export function mentionsIn(
  body: string,
  members: readonly Mentionable[],
  authorId: string,
): string[] {
  const byHandle = new Map<string, string>();
  for (const member of members) {
    const handle = handleOf(member.name);
    // First writer wins, so two members whose names collapse to one handle
    // resolve deterministically rather than by iteration order. Ambiguity here is
    // a real possibility ("Ana Ruiz" and "Ana-Ruiz"), and the alternative --
    // notifying both -- means one of them gets a mention for a message that was
    // not about them.
    if (handle !== '' && !byHandle.has(handle)) byHandle.set(handle, member.userId);
  }

  const found = new Set<string>();
  // (^|[^\w@]) so `@` after a word character (an email) does not match, and `@@`
  // does not produce a mention of whatever follows.
  const pattern = /(^|[^\w@])@([a-z0-9]+)/gi;
  for (const match of body.matchAll(pattern)) {
    const userId = byHandle.get(match[2]!.toLowerCase());
    if (userId !== undefined && userId !== authorId) found.add(userId);
  }

  return [...found];
}
