import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Role } from '@lazyit/shared';
import type { User } from '../../generated/prisma/client';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ROLES_KEY } from './roles.decorator';

/**
 * Authorization guard (ADR-0040). Composes AFTER {@link JwtAuthGuard} (registered later in the
 * APP_GUARD chain), so `request.user` is already populated by the time this runs.
 *
 * Rules:
 *   - `@Public()` routes skip authz entirely (mirrors the auth guard's short-circuit) — health probes.
 *   - A route with NO `@Roles()` metadata is allowed for any authenticated user. This preserves the
 *     pre-RBAC behaviour: every endpoint stays reachable unless it explicitly opts into a role gate,
 *     so adding RBAC does not silently lock down unannotated routes.
 *   - A route with `@Roles(...)` is allowed only if `request.user.role` is in the required set;
 *     otherwise 403 Forbidden.
 *   - A `@Roles()`-gated route with no authenticated user (shim mode, anonymous) is 403: a missing
 *     actor can never satisfy a role requirement.
 *
 * The guard never throws 401 — authentication is the JwtAuthGuard's job. In OIDC mode an
 * unauthenticated request is already rejected upstream with 401; this guard only decides authZ.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // @Public() short-circuit — a method-level decorator overrides a class-level one.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No @Roles() metadata → any authenticated user passes (pre-RBAC behaviour).
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: User }>();
    const user = request.user;

    // A role-gated route requires an authenticated actor with a sufficient role.
    if (!user) {
      throw new ForbiddenException('Authentication required for this action');
    }
    if (!requiredRoles.includes(user.role as Role)) {
      throw new ForbiddenException(
        'You do not have permission to perform this action',
      );
    }
    return true;
  }
}
