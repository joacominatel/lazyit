import type { Permission } from '@lazyit/shared';
import type { ServiceAccount, User } from '../../generated/prisma/client';

/**
 * The unified PRINCIPAL the request carries after authentication (ADR-0048). lazyit has two kinds of
 * authenticated caller:
 *   - a HUMAN (`kind: 'human'`) — authorized by their DB `Role` (resolved to permissions by the
 *     RolePermission matrix), open-by-default on unannotated routes (INV-8).
 *   - a SERVICE ACCOUNT (`kind: 'service'`) — authorized by its DIRECT permission grants, NEVER a
 *     role, and FAIL-CLOSED (it passes only @Public routes and routes whose @RequirePermission it
 *     fully holds — it does NOT inherit the human open-by-default; INV-SA-2).
 *
 * `request.user` is still set for humans (every existing controller/decorator keeps working
 * unchanged). `request.principal` is the new unified accessor the authorization guard + the
 * ActorService read so they can treat both kinds uniformly without each caller branching on the type.
 *
 * The service-account principal carries its resolved permission SET (computed DB-first in the guard,
 * from the ServiceAccountPermission rows — never a token claim) so the authorization guard does not
 * re-query per request.
 */
export type Principal = HumanPrincipal | ServicePrincipal;

/** An authenticated human. Authorized by `user.role` via the RolePermission matrix (unchanged). */
export interface HumanPrincipal {
  kind: 'human';
  user: User;
}

/**
 * An authenticated service account. Authorized SOLELY by `permissions` (its direct grants, resolved
 * DB-first in the guard). Never has a Role; never ADMIN-equivalent; fail-closed.
 */
export interface ServicePrincipal {
  kind: 'service';
  serviceAccount: ServiceAccount;
  /** The direct permission grants this service account holds (catalog literals). */
  permissions: ReadonlySet<Permission>;
}

/** Narrowing helper: is this principal a service account? */
export function isServicePrincipal(
  principal: Principal | undefined,
): principal is ServicePrincipal {
  return principal?.kind === 'service';
}

/** Narrowing helper: is this principal a human? */
export function isHumanPrincipal(
  principal: Principal | undefined,
): principal is HumanPrincipal {
  return principal?.kind === 'human';
}
