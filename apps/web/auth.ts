/**
 * The session, and the one place a password is ever handled.
 *
 * The split with `apps/api` is deliberate and is why this file is short. The API
 * owns the user table, the scrypt hash and the comparison; it exposes
 * `POST /auth/sign-in`, which answers either a `SessionUser` or a 401. This file
 * owns the cookie. Nothing here hashes, compares or stores a credential: it
 * forwards one, once, and keeps the answer.
 *
 * A JWT session rather than a database one, for the same reason: a database
 * session would need this app to hold a Postgres connection, and the whole point
 * of the service-token design is that the web tier talks to the API and the
 * gateway and to nothing else.
 *
 * `trustHost: true` because the app is only ever reached over the host it was
 * configured with (`AUTH_URL`). Without it Auth.js refuses to run outside Vercel
 * and the failure is a 500 with no useful message.
 */
import { sessionUserSchema, signInSchema, type SessionUser } from '@chat/shared';
import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';

import { ApiError, apiFetch } from './lib/api';

/**
 * How a wrong password fails.
 *
 * Auth.js turns anything thrown out of `authorize` into a generic
 * `CredentialsSignin`, so the reason never reaches the browser, which is correct:
 * "no such account" and "wrong password" are the same answer to anyone who is not
 * the account holder. Returning `null` produces exactly that.
 */
async function verifyCredentials(raw: unknown): Promise<SessionUser | null> {
  const parsed = signInSchema.safeParse(raw);
  if (!parsed.success) return null;

  try {
    // A token has to be minted to call the API at all, and there is no session
    // yet, so this call is made as nobody: the sign-in route is `@Public()` and
    // ignores the header. The placeholder identity never reaches a database.
    return await apiFetch(
      { id: 'anonymous', email: parsed.data.email, name: 'anonymous' },
      '/auth/sign-in',
      sessionUserSchema,
      { method: 'POST', body: parsed.data },
    );
  } catch (error) {
    // A 401 is a wrong password and is not worth a log line. Anything else is the
    // API being unreachable or answering something the contract rejects, which is
    // an operational fault whoever reads the logs needs to see. The symptom in the
    // browser is identical either way, which is exactly why the log matters.
    if (!(error instanceof ApiError) || error.status !== 401) {
      console.error('[auth] sign-in could not be completed:', error);
    }
    return null;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: 'jwt' },
  // Auth.js's own sign-in page is never rendered: this app has one that matches
  // the rest of it, and an unstyled framework page is a visible seam.
  pages: { signIn: '/login', error: '/login' },
  providers: [
    Credentials({
      // Declared so Auth.js knows which fields the credentials callback carries.
      // The real validation is `signInSchema` above; this is metadata.
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      authorize: (raw) => verifyCredentials(raw),
    }),
  ],
  callbacks: {
    /**
     * `user` is populated only on the sign-in pass; every later call gets the
     * token alone.
     *
     * Parsed rather than cast, which is what makes the type in
     * `types/next-auth.d.ts` true. A response that has drifted from the contract
     * produces no session instead of a session whose `name` is undefined, and
     * `name` is not cosmetic here: it is a claim in the service token and the
     * author on every message this person sends.
     */
    jwt({ token, user }) {
      if (!user) return token;
      const parsed = sessionUserSchema.safeParse(user);
      if (!parsed.success) return null;
      token.chat = parsed.data;
      return token;
    },
    session({ session, token }) {
      const parsed = sessionUserSchema.safeParse(token.chat);
      // No user rather than a half-built one. Every caller treats a missing user
      // as "not signed in", which is the safe reading; a session carrying an
      // object with undefined fields would render a conversation for nobody and
      // mint a token with an empty `sub`.
      if (!parsed.success) return { ...session, user: undefined as never };
      return { ...session, user: parsed.data };
    },
  },
});
