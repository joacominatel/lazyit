import { PERMISSIONS, type Permission } from '@lazyit/shared';

/** The frozen catalog as a Set, for catalog-membership filtering (a DB typo can't confer a power). */
const ALL_PERMISSIONS: ReadonlySet<Permission> = new Set(PERMISSIONS);

/**
 * Resolve a service account's direct permission grants into a clean catalog `Set` (ADR-0048). Takes the
 * raw `ServiceAccountPermission` rows (`{ permission: string }[]`) and keeps ONLY literals that are in
 * the frozen `@lazyit/shared` catalog — exactly like {@link PermissionResolverService.resolve} does for
 * roles, so a catalog-foreign DB row can never mint a capability the code does not know about.
 *
 * This is the authorization source for a service account: it holds a permission iff that permission is
 * in this set. There is NO role, NO ADMIN short-circuit, NO open-by-default — a service account is
 * fail-closed by construction (INV-SA-2). Pure + framework-agnostic so the guard and tests share it.
 */
export function resolveServiceAccountPermissions(
  rows: readonly { permission: string }[],
): ReadonlySet<Permission> {
  const resolved = new Set<Permission>();
  for (const { permission } of rows) {
    if (ALL_PERMISSIONS.has(permission as Permission)) {
      resolved.add(permission as Permission);
    }
  }
  return resolved;
}
