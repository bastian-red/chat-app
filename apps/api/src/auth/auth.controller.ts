/**
 * `/auth`: register, sign in, read the session back, and the user directory.
 *
 * Register and sign in are `@Public()` because they are how a caller gets a
 * session in the first place. Everything else on this API is authenticated by
 * default (`SessionGuard` is global), which is the direction that fails safely: a
 * route added later without a decorator is closed rather than open.
 *
 * `@Throttle` on both, at `RATE_LIMIT_AUTH` rather than the global budget. Auth is
 * the credential-stuffing surface, and 5 per minute per address is generous for a
 * person and useless for a list.
 */
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  directoryUserSchema,
  initialsOf,
  registerSchema,
  signInSchema,
  type DirectoryUser,
  type RegisterInput,
  type SessionUser,
  type SignInInput,
} from '@chat/shared';
import type { TokenUser } from '@chat/shared/server';
import { NotFoundException } from '@nestjs/common';

import { AuthService } from './auth.service';
import { CurrentUser, Public } from '../common/session.guard';
import { PrismaService } from '../infra/prisma.service';
import { ZodPipe } from '../common/zod.pipe';

/** The named throttler bucket configured in `app.module.ts`. */
const AUTH_BUCKET = { auth: {} };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Throttle(AUTH_BUCKET)
  @Post('register')
  register(@Body(new ZodPipe(registerSchema)) input: RegisterInput): Promise<SessionUser> {
    return this.auth.register(input);
  }

  @Public()
  @Throttle(AUTH_BUCKET)
  @Post('sign-in')
  signIn(@Body(new ZodPipe(signInSchema)) input: SignInInput): Promise<SessionUser> {
    return this.auth.signIn(input);
  }

  /**
   * The session behind the caller's token.
   *
   * Read from the row rather than from the token's claims. The token carries a
   * name for the broadcast path's benefit and is good for 120 seconds; the
   * account settings screen needs the current row, and a rename would otherwise
   * take two minutes to appear on the page that just performed it.
   */
  @Get('session')
  async session(@CurrentUser() user: TokenUser): Promise<SessionUser> {
    const session = await this.auth.session(user.id);
    if (!session) throw new NotFoundException({ code: 'NOT_FOUND', message: 'No such account.' });
    return session;
  }

  /**
   * The directory, for starting a DM and for the mention picker.
   *
   * No email on the way out (`directoryUserSchema`). Every signed-in account can
   * read this, and a chat's member list is not a reason to hand every colleague's
   * address to anybody who can open the app.
   *
   * The caller is excluded: "message yourself" is not a feature here, and a DM
   * whose two participants are the same person would compute a `dmKey` of
   * `id:id`, which the `channels_dm_shape` CHECK accepts and which nothing else
   * in the product knows how to render.
   */
  @Get('directory')
  async directory(
    @CurrentUser() user: TokenUser,
    @Query('q') query?: string,
  ): Promise<DirectoryUser[]> {
    const term = (query ?? '').trim();
    const rows = await this.prisma.user.findMany({
      where: {
        id: { not: user.id },
        ...(term === ''
          ? {}
          : {
              OR: [
                { name: { contains: term, mode: 'insensitive' } },
                { email: { contains: term, mode: 'insensitive' } },
              ],
            }),
      },
      orderBy: { name: 'asc' },
      // Bounded, because this is a public-to-members endpoint over the whole user
      // table. Without it, `?q=` is a full dump on every keystroke of a picker.
      take: 20,
    });

    return rows.map((row) =>
      directoryUserSchema.parse({ id: row.id, name: row.name, initials: initialsOf(row.name) }),
    );
  }
}
