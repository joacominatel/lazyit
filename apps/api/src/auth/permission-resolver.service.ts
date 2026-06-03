import { Injectable } from '@nestjs/common';
import { PERMISSIONS, type Permission, type Role } from '@lazyit/shared';
import { PrismaService } from '../prisma/prisma.service';

/** The complete catalog as a Set — the ADMIN permission set (immutable/full, ADR-0046 / INV-8). */
const ALL_PERMISSIONS: ReadonlySet<Permission> = new Set(PERMISSIONS);

/**
 * Resolves the fine-grained PERMISSIONS a {@link Role} holds (Roles & Permissions v2, ADR-0046, P2).
 *
 * DB-FIRST (INV-1 / INV-8): the source of truth is the `RolePermission` table — permissions resolve
 * from those rows for `request.user.role`, NEVER from a token claim. The guard injects this service
 * and asks {@link resolve} for the caller's permission set.
 *
 * ADMIN-IS-FULL (ADR-0046 / INV-8): ADMIN ALWAYS resolves to the COMPLETE catalog. This is independent
 * of the DB rows — a future bad seed (P5 config endpoint) that dropped an ADMIN row must NOT be able to
 * lock ADMIN out. The role itself still comes from the DB-resolved `request.user` (never a token), so
 * this short-circuit trusts the DB role, not the token.
 *
 * CACHE: the matrix is static today (no permission-write endpoint exists yet — that is P5), so a lazy
 * in-process `Map<Role, Set<Permission>>` (at most 3 keys) is sufficient. {@link invalidate} is the
 * hook the future config endpoint (P5) will call after writing the matrix; nothing calls it yet.
 *
 * FAIL-CLOSED: if the DB yields NO rows for a non-ADMIN role (an empty/missing seed), {@link resolve}
 * returns an EMPTY set — so the guard denies. It never widens access on a resolution gap. Resolution
 * is an authZ decision only; it never affects authentication (the guard catches and 403s, not 401s).
 */
@Injectable()
export class PermissionResolverService {
  /** Lazy per-role cache of the resolved permission set. ADMIN is never cached from the DB (always full). */
  private readonly cache = new Map<Role, ReadonlySet<Permission>>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The set of permissions the given role holds. ADMIN → the complete catalog (immutable/full, never a
   * DB read). Any other role → its `RolePermission` rows, lazily loaded and cached. Catalog-foreign
   * rows (a permission string not in the frozen catalog) are ignored, so a stray DB row can never mint
   * a capability the code doesn't know about.
   */
  async resolve(role: Role): Promise<ReadonlySet<Permission>> {
    // ADMIN is immutable/full by decision (ADR-0046 / INV-8): never trust the DB to scope it down.
    if (role === 'ADMIN') {
      return ALL_PERMISSIONS;
    }

    const cached = this.cache.get(role);
    if (cached) {
      return cached;
    }

    const rows = await this.prisma.rolePermission.findMany({
      where: { role },
      select: { permission: true },
    });

    // Keep only literals that are in the frozen catalog — a DB typo can never confer a permission.
    const resolved = new Set<Permission>();
    for (const { permission } of rows) {
      if (ALL_PERMISSIONS.has(permission as Permission)) {
        resolved.add(permission as Permission);
      }
    }

    this.cache.set(role, resolved);
    return resolved;
  }

  /**
   * Whether the role holds EVERY one of the required permissions (AND semantics). ADMIN always passes.
   * An empty `required` is vacuously true (no permission constraint).
   */
  async hasAll(role: Role, required: readonly Permission[]): Promise<boolean> {
    if (required.length === 0) {
      return true;
    }
    const held = await this.resolve(role);
    return required.every((p) => held.has(p));
  }

  /**
   * Drop the cached permission set(s). The invalidation HOOK the future config endpoint (P5) calls
   * after editing the matrix so the next request re-reads the DB. With no argument, clears every role.
   * Nothing calls this yet — the seed is static in P2/P3.
   */
  invalidate(role?: Role): void {
    if (role) {
      this.cache.delete(role);
    } else {
      this.cache.clear();
    }
  }
}
