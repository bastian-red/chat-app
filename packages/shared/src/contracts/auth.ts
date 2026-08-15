/**
 * Registration, sign-in, and the session shape all three processes agree on.
 *
 * Here rather than in `apps/api` because three of them need it and they are
 * different processes: the API validates the request, the web app builds the form
 * and mints a service token from the result, and the E2E suite signs in through
 * the same shapes. A DTO class in Nest plus an interface in the client is two
 * definitions of one thing, and the one that changes is never the one you are
 * reading.
 */
import { z } from 'zod';

import { idSchema } from './primitives';

/**
 * An email, lowercased at the boundary.
 *
 * The transform is not cosmetic: `users.email` is UNIQUE and Postgres compares it
 * byte for byte, so `Ana@example.com` and `ana@example.com` would be two accounts
 * that look identical in every list and cannot both sign in with the password the
 * person remembers. Normalising in the schema means every path that reaches the
 * column goes through it.
 */
export const emailSchema = z.string().email().max(254).toLowerCase();

/**
 * A password, floor only.
 *
 * Twelve characters and no composition rules. Length is what actually resists an
 * offline attack against the stored hash; a mandatory digit narrows the search
 * space and pushes people toward `Password1!`, which is in every wordlist. The
 * ceiling exists because the hash is computed over the input and an unbounded
 * body would be a free way to spend the server's CPU.
 */
export const passwordSchema = z.string().min(12).max(200);

export const displayNameSchema = z.string().trim().min(1).max(80);

/**
 * An IANA zone, checked against the platform rather than against a list.
 *
 * The reader's own zone decides where the conversation's day dividers go
 * (`schema.prisma`, `User.timeZone`), so an unchecked string here is a message
 * list that throws while rendering. `Intl.supportedValuesOf` is not used: it is
 * the list of zones this runtime knows, and rejecting a zone a newer browser
 * offered would be a sign-up that fails for somebody in a legitimate place.
 * Constructing a formatter is the direct question -- can this runtime format a
 * date in that zone -- and it is what the rendering code will do anyway.
 */
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'That is not a time zone this server recognises');

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: displayNameSchema,
  /** Optional, defaulted by the column. A browser that knows its zone sends it. */
  timeZone: timeZoneSchema.optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;

/**
 * Sign-in, with the password bound only by presence.
 *
 * Deliberately not `passwordSchema`. A stored password that predates a rule
 * change must still be able to sign in, and rejecting it at the schema would tell
 * an attacker that a submitted password was too short to be anybody's real one,
 * which is a free oracle on the shape of the credential.
 */
export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

export type SignInInput = z.infer<typeof signInSchema>;

/**
 * Who is signed in.
 *
 * `timeZone` is on it because the conversation cannot be rendered without it: the
 * day dividers are computed against the reader's stored zone rather than the
 * browser's, so a laptop in Madrid and a phone in Santiago agree about which day
 * a message was sent. No `passwordHash`, obviously, and no `email` beyond what the
 * account settings screen needs.
 */
export const sessionUserSchema = z.object({
  id: idSchema,
  email: emailSchema,
  name: displayNameSchema,
  initials: z.string().min(1).max(4),
  timeZone: z.string().min(1),
});

export type SessionUser = z.infer<typeof sessionUserSchema>;

/**
 * A directory entry, for starting a DM and for the mention picker.
 *
 * No email. The directory is readable by every signed-in account, and a chat's
 * member list is not a reason to hand every colleague's address to anybody who
 * can open the app.
 */
export const directoryUserSchema = z.object({
  id: idSchema,
  name: displayNameSchema,
  initials: z.string().min(1).max(4),
});

export type DirectoryUser = z.infer<typeof directoryUserSchema>;
