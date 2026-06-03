import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Permission } from '@lazyit/shared';
import type { User } from '../../generated/prisma/client';
import { IS_PUBLIC_KEY } from './public.decorator';
import { PERMISSION_KEY } from './require-permission.decorator';
import { PermissionResolverService } from './permission-resolver.service';
import { type Principal, isServicePrincipal } from './principal';

/**
 * Authorization guard (ADR-0040 → ADR-0046 → ADR-0048). Composes AFTER {@link JwtAuthGuard} (registered
 * later in the APP_GUARD chain, same slot/order), so `request.principal` (human or service account) is
 * already populated by the time this runs.
 *
 * SINGLE enforcement primitive (ADR-0046 P4): every gated route carries `@RequirePermission`. The guard
 * recognises three route states, but authorizes the two PRINCIPAL KINDS differently (ADR-0048):
 *
 *   1. `@Public()`            → skip authorization entirely (mirrors the auth guard) — health probes.
 *      Both kinds pass.
 *   2. `@RequirePermission()` → 403 unless the caller holds EVERY required permission.
 *        - HUMAN: resolved from the `RolePermission` DB rows for `request.user.role` (DB-FIRST, INV-1 /
 *          INV-8 — never a token claim). ADMIN always resolves to full.
 *        - SERVICE ACCOUNT: resolved from its DIRECT grants (the `ServiceAccountPermission` rows the
 *          auth guard already loaded onto `request.principal.permissions`, DB-first). NEVER a role,
 *          NEVER ADMIN-equivalent (INV-SA-3).
 *   3. no metadata (unannotated, non-@Public) →
 *        - HUMAN: any authenticated user passes (open-by-default — INV-8; adding the guard locks
 *          nothing down unless a route opts into a gate).
 *        - SERVICE ACCOUNT: 403 — FAIL-CLOSED (INV-SA-2). A service account does NOT inherit the human
 *          open-by-default; it passes ONLY @Public routes and routes whose @RequirePermission it fully
 *          holds. This is the single most important difference from a human caller.
 *
 * A gated route with NO authenticated principal (shim mode, anonymous) is 403: a missing actor can
 * never satisfy an authorization requirement.
 *
 * FAIL-CLOSED on the permission check: if resolution yields nothing, the `hasAll` check is false → 403.
 * This NEVER fails AUTHENTICATION — auth is the JwtAuthGuard's job. This guard only ever decides authZ (403).
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

    const hasPermissionGate =
      requiredPermissions !== undefined && requiredPermissions.length > 0;

    const request = context
      .switchToHttp()
      .getRequest<Request & { principal?: Principal; user?: User }>();
    // The JwtAuthGuard sets `principal` for both kinds. Fall back to deriving a human principal from
    // `request.user` if only that is present (defensive — keeps the human path working regardless of
    // which upstream set the request, and preserves the exact pre-ADR-0048 contract for callers/tests
    // that populate `request.user` directly).
    const principal: Principal | undefined =
      request.principal ??
      (request.user ? { kind: 'human', user: request.user } : undefined);

    // SERVICE ACCOUNT (ADR-0048): FAIL-CLOSED. It does NOT inherit the human open-by-default, so an
    // unannotated (state 3) route is 403, NOT a pass. It is authorized ONLY by its direct grants.
    if (isServicePrincipal(principal)) {
      if (!hasPermissionGate) {
        throw new ForbiddenException(
          'Service accounts may only access explicitly permissioned routes',
        );
      }
      const allowed = requiredPermissions.every((p) =>
        principal.permissions.has(p),
      );
      if (!allowed) {
        throw new ForbiddenException(
          'You do not have permission to perform this action',
        );
      }
      return true;
    }

    // HUMAN (or anonymous) below — behaviour UNCHANGED from ADR-0046.

    // (3) No permission gate → any authenticated human passes (open-by-default, INV-8).
    if (!hasPermissionGate) {
      return true;
    }

    // A gated route requires an authenticated actor. A missing actor (anonymous shim) is 403.
    if (!principal) {
      throw new ForbiddenException('Authentication required for this action');
    }

    // (2) @RequirePermission — DB-first permission check (INV-1 / INV-8).
    // `principal.user.role` is the DB-resolved role (JwtAuthGuard set it from the local row, never a
    // token claim — INV-1). The resolver reads the RolePermission rows for that role; ADMIN is full.
    const allowed = await this.permissions.hasAll(
      principal.user.role,
      requiredPermissions,
    );
    if (!allowed) {
      throw new ForbiddenException(
        'You do not have permission to perform this action',
      );
    }
    return true;
  }
}
