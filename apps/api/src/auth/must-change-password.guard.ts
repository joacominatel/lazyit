import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PASSWORD_CHANGE_REQUIRED_CODE } from '@lazyit/shared';
import type { User } from '../../generated/prisma/client';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ALLOW_PASSWORD_CHANGE_REQUIRED_KEY } from './allow-password-change-required.decorator';

/**
 * MustChangePasswordGuard — forces a user holding a one-time credential to change it before doing anything
 * else (ADR-0086 §F4, F4a control 2). Registered as an APP_GUARD AFTER JwtAuthGuard (which already loaded
 * `request.user` this request) and BEFORE RolesGuard, so the forced-change wall comes ahead of any
 * permission check. When the caller's `mustChangePassword` flag is set, EVERY non-exempt route is refused
 * with a distinct, machine-readable `403 { code: 'PASSWORD_CHANGE_REQUIRED' }` until they change it.
 *
 * FAIL-SAFE + narrow by construction:
 *   - Only acts in AUTH_MODE=local (the flag only exists there); a no-op in shim/oidc mode.
 *   - Only acts on an authenticated HUMAN with the flag set. A service principal (request.user undefined)
 *     and an anonymous request are never gated. A missing flag (the overwhelming majority) passes through.
 *   - EXEMPT: `@Public()` routes (no authenticated user to gate) and routes marked
 *     `@AllowPasswordChangeRequired()` — the change-password endpoint itself + `GET /users/me` (so the
 *     web can detect the state and render the forced-change screen). Logout is client-side (Auth.js drops
 *     the cookie), so there is no server route to exempt.
 *
 * The 403 body carries `code` explicitly (a bare `ForbiddenException(string)` would not), so the web can
 * branch on the code rather than parse a message.
 */
@Injectable()
export class MustChangePasswordGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Only local mode has the credential this gate protects; a cheap short-circuit everywhere else.
    if (process.env.AUTH_MODE !== 'local') {
      return true;
    }

    // Exempt: public routes (no authenticated user) and explicitly-allowed routes (change-password, /me).
    // A method-level decorator overrides a class-level one (getAllAndOverride).
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    const isAllowed = this.reflector.getAllAndOverride<boolean>(
      ALLOW_PASSWORD_CHANGE_REQUIRED_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isAllowed) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: User }>();
    const user = request.user;
    // No human user (service principal / anonymous), or no pending forced change → allow. Only a human
    // with the flag set is walled off.
    if (!user || user.mustChangePassword !== true) {
      return true;
    }

    throw new HttpException(
      {
        statusCode: HttpStatus.FORBIDDEN,
        code: PASSWORD_CHANGE_REQUIRED_CODE,
        message:
          'You must change your password before continuing. Call POST /auth/change-password.',
      },
      HttpStatus.FORBIDDEN,
    );
  }
}
