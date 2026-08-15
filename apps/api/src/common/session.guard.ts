/**
 * The service-token guard, and the session it puts on the request.
 *
 * **Default closed.** Registered globally in `app.module.ts`, so a route added
 * next year is authenticated unless somebody writes `@Public()` on it. The
 * opposite default -- a guard applied per controller -- fails silently in the one
 * direction that matters: a forgotten decorator is an open endpoint, and nothing
 * about the code looks wrong.
 *
 * The token is the same HS256 service token the socket handshake carries, minted
 * by the web app for the signed-in session. One secret, three verifiers: web
 * mints, API checks, gateway checks. That is why `scripts/dev.sh` refuses to start
 * without `AUTH_SECRET` -- a missing one does not merely break sign-in, it makes
 * every authenticated call and every socket handshake fail at once.
 *
 * The verifier's `reason` (`expired` versus `signature`) goes to the log and never
 * to the response. Telling a caller which half of the token to keep working on is
 * a hint nobody legitimate needs.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { readBearer, verifyServiceToken, type TokenUser } from '@chat/shared/server';
import type { Request } from 'express';
import { Inject } from '@nestjs/common';

import { API_CONFIG, type ApiConfig } from '../config/config';

export const IS_PUBLIC = 'chat:isPublic';

/**
 * The escape hatch, named for what it means rather than for what it disables.
 *
 * Three routes carry it: register, sign in, and `/health`. Health is public on
 * purpose -- a probe that needed a credential is a probe a container runtime
 * cannot run, and the endpoint reports dependency status, not data.
 */
export const Public = (): MethodDecorator => SetMetadata(IS_PUBLIC, true);

/** What the token proved, hung off the request by the guard. */
export interface RequestWithUser extends Request {
  user?: TokenUser;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    // Handler before class, so a `@Public()` method inside an otherwise
    // authenticated controller works, which is what auth's own controller needs.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = readBearer(request.headers.authorization);
    if (token === null) throw new UnauthorizedException('This endpoint needs a service token.');

    const result = verifyServiceToken(token, this.config.authSecret);
    if (!result.ok) {
      console.warn(`[api] token rejected: ${result.reason}`);
      throw new UnauthorizedException('That token was not accepted.');
    }

    request.user = result.user;
    return true;
  }
}

/**
 * The signed-in user, as a parameter.
 *
 * Throws rather than returning undefined when the guard did not run. A handler
 * that reads `user.id` from an unauthenticated request would otherwise scope a
 * query by `undefined`, which in Prisma is not "no rows" but "no filter".
 */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<RequestWithUser>();
  if (!request.user) {
    throw new UnauthorizedException('This endpoint needs a service token.');
  }
  return request.user;
});
