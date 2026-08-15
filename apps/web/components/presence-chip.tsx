import { presenceGlyph, presenceLabel, presenceWord, type PresenceState } from '@chat/shared';

/**
 * Somebody's presence, as a glyph, a word and a dot.
 *
 * **The word is the state. The dot is decoration.** The three presence colours
 * clear AA against the canvas individually and are useless against each other:
 * light-mode `online` and `offline` differ by a contrast ratio of exactly 1.00,
 * which means identical relative luminance -- the same pixel to a reader with
 * deuteranopia and on any greyscale display. `lib/contrast.test.ts` pins that
 * collision deliberately, so the reason for this component stays visible in the
 * test suite rather than becoming folklore.
 *
 * The glyph shapes differ (filled, hollow, dash) rather than the same shape in
 * three colours, and it is `aria-hidden` because `presenceWord` already says it:
 * a screen reader announcing "black circle Online" is worse off than one
 * announcing "Online".
 *
 * All three strings come from `packages/shared/src/presence-words.ts`. One
 * implementation, because a screen-reader user hearing "Ana Ruiz, online" while a
 * sighted colleague reads "Ana (available)" is two descriptions of one fact.
 */
export function PresenceChip({
  name,
  state,
  connections,
}: {
  name: string;
  state: PresenceState;
  connections?: number;
}) {
  return (
    <span
      className="presence-chip"
      data-state={state}
      // The accessible name carries the person and the state together, so a
      // screen reader reading the roster does not announce three bare words in a
      // row with no idea which name they belong to.
      title={presenceLabel({
        userId: '',
        name,
        state,
        ...(connections === undefined ? {} : { connections }),
      })}
    >
      <span className="presence-glyph" aria-hidden="true">
        {presenceGlyph(state)}
      </span>
      <span className="presence-word">{presenceWord(state)}</span>
    </span>
  );
}
