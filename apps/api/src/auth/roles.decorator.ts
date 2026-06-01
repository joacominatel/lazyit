import { SetMetadata } from '@nestjs/common';
import type { Role } from '@lazyit/shared';

/** Metadata key under which `@Roles(...)` records the set of roles allowed on a route. */
export const ROLES_KEY = 'roles';

/**
 * Restricts a route (or whole controller) to the given RBAC roles (ADR-0040). The global
 * {@link RolesGuard} (registered after {@link JwtAuthGuard}, so `request.user` is already set)
 * reads this metadata via `Reflector.getAllAndOverride`, so a method-level `@Roles()` overrides a
 * class-level one.
 *
 * Semantics enforced by the guard:
 *   - a route with NO `@Roles()` metadata is open to any authenticated user (preserves the
 *     pre-RBAC behaviour — auth only);
 *   - a route with `@Roles(...)` allows only users whose `role` is in the given set, otherwise 403;
 *   - `@Public()` routes skip authz entirely (the guard short-circuits, like the auth guard does).
 *
 * Usage:
 *   @Roles('ADMIN')
 *   @Post()
 *   create(...) { ... }
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
