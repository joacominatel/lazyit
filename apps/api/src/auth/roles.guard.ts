import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Permission, Role } from '@lazyit/shared';
import type { User } from '../../generated/prisma/client';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ROLES_KEY } from './roles.decorator';
import { PERMISSION_KEY } from './require-permission.decorator';
import { PermissionResolverService } from './permission-resolver.service';

/**
 * Authorization guard (ADR-0040 → evolved by ADR-0046, Roles & Permissions v2 P2). Composes AFTER
 * {@link JwtAuthGuard} (registered later in the APP_GUARD chain, same slot/order as before), so
 * `request.user` is already populated by the time this runs.
 *
 * DUAL-MODE during the P2→P4 migration (ADR-0046 §Phased delivery) — it understands BOTH the new
 * fine-grained `@RequirePermission` and the existing coarse `@Roles`, so the 63 existing `@Roles`
 * write-gates keep working unchanged while the read endpoints adopt permissions:
 *
 *   1. `@Public()`            → skip authorization entirely (mirrors the auth guard) — health probes.
 *   2. `@RequirePermission()` → resolve the caller's permission set from the `RolePermission` DB rows
 *                               (DB-FIRST, INV-1 / INV-8 — never a token claim) and 403 unless the
 *                               role holds EVERY required permission. ADMIN always resolves to full.
 *                               Takes precedence over `@Roles` if both are somehow present.
 *   3. `@Roles(...)`          → the existing role-membership check, UNCHANGED: allow only if
 *                               `request.user.role` is in the required set, else 403.
 *   4. no metadata            → any authenticated user passes (open-by-default — adding the guard
 *                               locks nothing down unless a route opts into a gate).
 *
 * A gated route (permission OR role) with no authenticated user (shim mode, anonymous) is 403: a
 * missing actor can never satisfy an authorization requirement.
 *
 * FAIL-CLOSED on the permission check: if resolution yields nothing for the role, the `hasAll` check
 * is false → 403. But this NEVER fails AUTHENTICATION — auth is the JwtAuthGuard's job; in OIDC mode
 * an unauthenticated request is already 401'd upstream. This guard only ever decides authZ (403).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionResolverService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // (1) @Public() short-circuit — a method-level decorator overrides a class-level one.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const requiredPermissions = this.reflector.getAllAndOverride<
      Permission[] | undefined
    >(PERMISSION_KEY, [context.getHandler(), context.getClass()]);

    const requiredRoles = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    const hasPermissionGate =
      requiredPermissions !== undefined && requiredPermissions.length > 0;
    const hasRoleGate = requiredRoles !== undefined && requiredRoles.length > 0;

    // (4) No gate of either kind → any authenticated user passes (pre-RBAC / open-by-default).
    if (!hasPermissionGate && !hasRoleGate) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: User }>();
    const user = request.user;

    // A gated route requires an authenticated actor (permission or role). A missing actor is 403.
    if (!user) {
      throw new ForbiddenException('Authentication required for this action');
    }

    // (2) @RequirePermission — DB-first permission check (INV-1 / INV-8). Takes precedence over @Roles.
    if (hasPermissionGate) {
      // `request.user.role` is the DB-resolved role (JwtAuthGuard set it from the local row, never a
      // token claim — INV-1). The resolver reads the RolePermission rows for that role; ADMIN is full.
      const allowed = await this.permissions.hasAll(
        user.role,
        requiredPermissions,
      );
      if (!allowed) {
        throw new ForbiddenException(
          'You do not have permission to perform this action',
        );
      }
      return true;
    }

    // (3) @Roles — the existing coarse role-membership check, UNCHANGED (dual-mode for the @Roles sites).
    if (!requiredRoles!.includes(user.role)) {
      throw new ForbiddenException(
        'You do not have permission to perform this action',
      );
    }
    return true;
  }
}
