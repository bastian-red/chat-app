/**
 * Initials and a palette slot for a person.
 *
 * Both exist for the same reason: presence in this product is never colour alone.
 * A presence chip carries a swatch **and** two initials **and** an accessible
 * name, because the swatch on its own is meaningless to a deuteranopic reader and
 * silent to a screen reader, and because two people whose avatars differ only in
 * hue are two people you cannot tell apart at a glance in a busy channel.
 *
 * Computed on the server, once, and sent in the payload rather than derived in a
 * component. Three surfaces show the same person -- the roster, the member list,
 * the avatar beside every message -- and three independent derivations is three
 * chances for the same person to appear with different initials in the same
 * viewport.
 */

/**
 * Up to two initials from a display name.
 *
 * Segmented by **grapheme**, not by code unit. `name[0]` on a name beginning with
 * an astral character -- an emoji ZWJ sequence such as U+1F9D1 U+200D U+1F680, or
 * any single astral letter -- returns half a surrogate pair, which renders as
 * U+FFFD; and `.split('')` on a name with a combining accent separates the letter
 * from its diacritic. `Intl.Segmenter` is in the standard library (Node 18+) and
 * already knows all of this. Layer 1 of search-before-building.
 *
 * The code points are named rather than pasted here on purpose. A ZWJ is
 * invisible in every editor and every diff, so `scripts/invisible-chars.mjs`
 * refuses one anywhere in the source -- including in the comment explaining it.
 *
 * Two words give two initials; one word gives one. Deliberately not "first two
 * letters of a single word": "Ana" as "AN" reads as a different person's initials
 * rather than as one name, and a single letter is honest about what is known.
 */
export function initialsOf(name: string): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

  const words = name
    .split(/\s+/u)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);

  const firstGrapheme = (word: string): string => {
    for (const { segment } of segmenter.segment(word)) return segment;
    return '';
  };

  const picked = [
    firstGrapheme(words[0] ?? ''),
    words.length > 1 ? firstGrapheme(words.at(-1)!) : '',
  ]
    .filter((part) => part.length > 0)
    .join('');

  // `toLocaleUpperCase` with no locale, not `toUpperCase`: the two disagree in
  // Turkish, where the uppercase of "i" is "İ". An empty name yields "?" rather
  // than an empty chip, so the avatar is never a blank square nobody can name.
  return picked.length > 0 ? picked.toLocaleUpperCase() : '?';
}

/** How many distinct presence colours the stylesheet defines. */
export const PRESENCE_COLOR_SLOTS = 8;

/**
 * A stable palette slot for a user.
 *
 * Stable across processes and across restarts, which rules out a counter or a
 * `Math.random()`: the same person must be the same colour on two gateways and in
 * two browsers, or the presence bar disagrees with itself the moment a second
 * replica serves a client.
 *
 * FNV-1a over the id. A cryptographic hash would be pointless here (this is not a
 * secret and not a lookup key) and `String.prototype.hashCode` does not exist in
 * JavaScript. The `>>> 0` on each round is what keeps the value an unsigned
 * 32-bit integer: JavaScript's bitwise operators produce signed 32-bit results,
 * so without it the final modulo can return a negative slot and index off the end
 * of the palette.
 */
export function presenceColorSlot(userId: string, slots = PRESENCE_COLOR_SLOTS): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < userId.length; index += 1) {
    hash ^= userId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % slots;
}
