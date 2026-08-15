/**
 * The key that makes a DM one conversation instead of two.
 *
 * Two people click "message" on each other at the same instant. Each request
 * looks for an existing DM, finds none, and creates one. Without a shared key
 * they create two rows, both of which are visible to both people, each holding
 * half the conversation, with no constraint violated and nothing to report.
 *
 * The fix is to make the two requests compute the **same** string, and to put a
 * UNIQUE on it: both insert, one wins with 23505, and the loser reads the
 * winner's row back. That is the whole mechanism, and it is four lines -- the
 * hard part is that the four lines have to be correct, which is what this module
 * and its tests are for.
 */

/**
 * `least(a, b) : greatest(a, b)`.
 *
 * **Sorted**, which is the entire point and the one thing an implementation can
 * get wrong while looking right. `${a}:${b}` is a perfectly good unique key that
 * produces `ana:bruno` for one caller and `bruno:ana` for the other, so both
 * inserts succeed and the product has the exact bug the key was introduced to
 * prevent.
 *
 * Compared with `<` on the raw strings rather than with `localeCompare`, and this
 * matters: `localeCompare` is locale-sensitive and ICU-version-sensitive, so two
 * processes with different ICU data could order the same pair differently and
 * produce two keys for one pair. Postgres's own `least`/`greatest` under the C
 * collation compare bytes, and `<` on a JavaScript string compares UTF-16 code
 * units; for the cuid alphabet those agree, and the property test pins it.
 *
 * The colon is the separator because a cuid cannot contain one, so the key can be
 * split back apart unambiguously -- which the CHECK constraint in
 * `20260811090000_chat_invariants` relies on to reject a malformed key.
 */
export function dmKeyFor(a: string, b: string): string {
  if (a === '' || b === '') {
    throw new Error('A DM needs two user ids; one of them was empty.');
  }
  if (a.includes(':') || b.includes(':')) {
    throw new Error('A user id cannot contain a colon; it would make the DM key ambiguous.');
  }
  if (a === b) {
    // A note to self is a real feature in some chat products. It is not one here,
    // and the failure mode of allowing it silently is a "DM" with one member that
    // renders with no counterpart and no name.
    throw new Error('A DM needs two different people.');
  }
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** The two ids in a key, in sorted order. Null when the key is malformed. */
export function participantsOf(dmKey: string): [string, string] | null {
  const parts = dmKey.split(':');
  if (parts.length !== 2) return null;
  const [first, second] = parts as [string, string];
  if (first === '' || second === '') return null;
  return [first, second];
}
