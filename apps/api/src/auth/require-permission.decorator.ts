import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@lazyit/shared';

/** Metadata key under which `@RequirePermission(...)` records the permissions a route requires. */
export const PERMISSION_KEY = 'permissions';

/**
 * Gates a route (or whole controller) on fine-grained PERMISSIONS (Roles & Permissions v2, ADR-0046).
 * The global authorization guard (registered after {@link JwtAuthGuard}, so `request.user` is already
 * set) reads this metadata via `Reflector.getAllAndOverride`, so a method-level `@RequirePermission()`
 * overrides a class-level one.
 *
 * Semantics enforced by the guard (DUAL-MODE during the P2→P4 migration — ADR-0046 §Phased delivery):
 *   - `@Public()` routes skip authorization entirely (the guard short-circuits, like the auth guard).
 *   - A route with `@RequirePermission(...)` is allowed only if the caller's role HOLDS EVERY required
 *     permission. The permission set resolves from the `RolePermission` DB rows for `request.user.role`
 *     — DB-first (INV-1 / INV-8): NEVER from a token claim. Otherwise 403.
 *   - `@RequirePermission` takes precedence over `@Roles` on the same handler (the permission model is
 *     the v2 authorization unit); a route should carry one or the other, not both.
 *   - A route with neither `@RequirePermission` nor `@Roles` stays open to any authenticated user
 *     (preserves the pre-RBAC / open-by-default behaviour — adding the guard locks nothing down
 *     unless a route opts in).
 *
 * The permissions are the frozen `Permission` catalog literals from `@lazyit/shared`
 * (`domain:action`), so a typo is a COMPILE error — the catalog is the single source of truth.
 *
 * Usage:
 *   @RequirePermission('accessGrant:read')
 *   @Get()
 *   findAll(...) { ... }
 *
 * @param perms one or more catalog permissions; the caller must hold ALL of them (AND semantics).
 */
export const RequirePermission = (...perms: Permission[]) =>
  SetMetadata(PERMISSION_KEY, perms);
