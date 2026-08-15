/**
 * Register and sign in.
 *
 * Two properties, each with the mechanism holding it.
 *
 * **1. A wrong password and an unknown email are indistinguishable.** Same
 * message, same status, and the hash is verified even when no row was found. The
 * message alone is not enough: without the dummy verify, a miss returns in a
 * microsecond and a hit takes as long as scrypt does, and that difference is a
 * readable oracle for which addresses have accounts. On a chat, the member
 * directory is the product, so enumerating accounts is worth doing.
 *
 * **2. An email is one account.** `emailSchema` lowercases at the boundary and
 * `users.email` is UNIQUE, so `Ana@example.com` cannot become a second account
 * beside `ana@example.com` that looks identical in every list.
 *
 * This service issues no token. The web app mints the service token for its own
 * session (`packages/shared/src/server/service-token.ts`), and the API only ever
 * verifies. One minter, two verifiers.
 */
import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { USER_EMAIL_UNIQUE, isUniqueViolation } from '@chat/db';
import { hashPassword, verifyPassword } from '@chat/shared/server';
import { initialsOf, type RegisterInput, type SessionUser, type SignInInput } from '@chat/shared';

import { PrismaService } from '../infra/prisma.service';

/**
 * A real scrypt hash of a value nobody can sign in with.
 *
 * Computed once at module load, not per request: the point is to spend the same
 * CPU a real verification spends, and computing the hash itself each time would
 * spend twice as much and make the miss path *slower* than the hit path, which is
 * the same oracle pointing the other way.
 */
const DUMMY_HASH = hashPassword('a-password-no-account-has-0000');

@Injectable()
export class AuthService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async register(input: RegisterInput): Promise<SessionUser> {
    try {
      const user = await this.prisma.user.create({
        data: {
          email: input.email,
          passwordHash: hashPassword(input.password),
          name: input.name,
          ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
        },
      });
      return toSessionUser(user);
    } catch (error) {
      // On the constraint name, never on the message text: Postgres localises and
      // rewords those between versions, so a `String(error).includes('unique')`
      // stops working on a server with a different locale and reports a duplicate
      // signup as a 500.
      if (isUniqueViolation(error, USER_EMAIL_UNIQUE)) {
        throw new ConflictException({
          code: 'CONFLICT',
          message: 'An account with that address already exists.',
        });
      }
      throw error;
    }
  }

  async signIn(input: SignInInput): Promise<SessionUser> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });

    // Verified even on a miss. See the header: the timing difference between "no
    // such row" and "wrong password" is what tells an attacker which addresses
    // have accounts.
    const ok = verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);

    if (!user || !ok) {
      throw new UnauthorizedException({
        code: 'FORBIDDEN',
        message: 'That email and password do not match an account.',
      });
    }

    return toSessionUser(user);
  }

  /** The session behind a verified token, refreshed from the row. */
  async session(userId: string): Promise<SessionUser | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return user ? toSessionUser(user) : null;
  }
}

function toSessionUser(user: {
  id: string;
  email: string;
  name: string;
  timeZone: string;
}): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    // Computed here rather than stored, and by the same function the roster and
    // the message header use. Two implementations of "initials" is two different
    // avatars for one person on one screen.
    initials: initialsOf(user.name),
    timeZone: user.timeZone,
  };
}
