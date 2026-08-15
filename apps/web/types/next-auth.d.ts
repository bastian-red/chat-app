/**
 * The session shape, taught to Auth.js.
 *
 * Auth.js types `session.user` as its own `User`, which is `{ name?, email?,
 * image? }` and has none of what this app needs: the id every permission check
 * reads, the initials the avatar renders, and the time zone the conversation's
 * day dividers are computed against. Without this file every one of those is a
 * type error at the call site, and the usual "fix" is a cast, which is a claim
 * nobody checked.
 *
 * `SessionUser` is the contract from `@chat/shared`, so this declaration cannot
 * drift from what `auth.ts` actually parses into the token.
 */
import type { SessionUser } from '@chat/shared';

declare module 'next-auth' {
  interface Session {
    user: SessionUser;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    /** Namespaced, so it cannot collide with a claim Auth.js owns. */
    chat?: SessionUser;
  }
}
