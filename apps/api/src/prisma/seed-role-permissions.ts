/**
 * Seed-once application of the default role→permission grants (issue #1314, ADR-0046 §4 note).
 * Lives under `src/` (not `prisma/`) so it is unit-testable — `prisma/seed.ts` runs `main()` on
 * import, which a jest spec must not trigger (same reason as `seed-categories.ts`).
 *
 * The seed runs on EVERY deploy. It used to upsert every pair of `DEFAULT_ROLE_PERMISSIONS`, which
 * silently re-granted any default an admin had revoked (a revoke deletes the `RolePermission` row).
 * Now each (role, permission) pair is applied at most once per instance: a pair is granted only when
 * the `AppliedRolePermissionDefault` ledger has no row for it, and the ledger row is written in the
 * same transaction. A revoke deletes the grant and leaves the ledger alone, so it stays revoked; a
 * permission newly added to the catalog has no ledger row yet, so it receives its defaults once.
 *
 * The seed never deletes a grant: rows an admin added, and rows for permissions dropped from the
 * defaults, are left as they are.
 */
import type { Role } from '../../generated/prisma/client';

export type RolePermissionPair = { role: Role; permission: string };

/** The minimal transaction-client surface this helper needs; the real Prisma `tx` satisfies it. */
export interface SeedRolePermissionsClient {
  appliedRolePermissionDefault: {
    findMany(args: {
      select: { role: true; permission: true };
    }): Promise<RolePermissionPair[]>;
    createMany(args: {
      data: RolePermissionPair[];
      skipDuplicates: boolean;
    }): Promise<{ count: number }>;
  };
  rolePermission: {
    createMany(args: {
      data: RolePermissionPair[];
      skipDuplicates: boolean;
    }): Promise<{ count: number }>;
  };
}

export interface SeedRolePermissionsResult {
  /** Default pairs granted by this run (never applied on this instance before). */
  applied: number;
  /** Default pairs skipped because they were already settled (applied, pre-existing, or revoked). */
  settled: number;
}

const pairKey = (role: string, permission: string): string =>
  `${role}\u0000${permission}`;

/**
 * Grant every default pair that was never applied on this instance, and record it in the ledger.
 * Call it inside one transaction so a grant and its ledger row land together. Idempotent: a second
 * run with the same defaults finds every pair settled and writes nothing.
 */
export async function applyDefaultRolePermissionsOnce(
  client: SeedRolePermissionsClient,
  defaults: Readonly<Record<Role, readonly string[]>>,
): Promise<SeedRolePermissionsResult> {
  const ledger = await client.appliedRolePermissionDefault.findMany({
    select: { role: true, permission: true },
  });
  const settledKeys = new Set(
    ledger.map(({ role, permission }) => pairKey(role, permission)),
  );

  const pending: RolePermissionPair[] = [];
  const seen = new Set<string>();
  let settled = 0;
  for (const [role, permissions] of Object.entries(defaults) as [
    Role,
    readonly string[],
  ][]) {
    for (const permission of permissions) {
      const key = pairKey(role, permission);
      if (seen.has(key)) continue;
      seen.add(key);
      if (settledKeys.has(key)) {
        settled += 1;
      } else {
        pending.push({ role, permission });
      }
    }
  }

  if (pending.length > 0) {
    // skipDuplicates: a pair may already be held without a ledger row (e.g. an admin granted it before
    // the permission became a default) — keep that row and just record the pair as settled.
    await client.rolePermission.createMany({
      data: pending,
      skipDuplicates: true,
    });
    await client.appliedRolePermissionDefault.createMany({
      data: pending,
      skipDuplicates: true,
    });
  }

  return { applied: pending.length, settled };
}
