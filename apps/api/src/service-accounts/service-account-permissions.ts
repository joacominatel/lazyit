import {
  PERMISSIONS,
  SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS,
  type Permission,
} from '@lazyit/shared';

/** The frozen catalog as a Set, for catalog-membership filtering (a DB typo can't confer a power). */
const ALL_PERMISSIONS: ReadonlySet<Permission> = new Set(PERMISSIONS);

/**
 * The verbs a service account may NEVER hold (INV-SA-3), from the single `@lazyit/shared` source of
 * truth. Write paths refuse them (SEC-011 Layer 1); this read-time strip makes a row persisted before
 * that refinement inert on every route and channel (SEC-073).
 */
const UNGRANTABLE: ReadonlySet<string> = new Set(
  SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS,
);

/** The SA-ungrantable literals present in a grant set — legacy rows the resolver strips (SEC-073). */
export function ungrantableServiceAccountGrants(
  rows: readonly { permission: string }[],
): string[] {
  return rows
    .map(({ permission }) => permission)
    .filter((permission) => UNGRANTABLE.has(permission));
}

/**
 * Resolve a service account's direct permission grants into a clean catalog `Set` (ADR-0048). Takes the
 * raw `ServiceAccountPermission` rows (`{ permission: string }[]`) and keeps ONLY literals that are in
 * the frozen `@lazyit/shared` catalog — exactly like {@link PermissionResolverService.resolve} does for
 * roles, so a catalog-foreign DB row can never mint a capability the code does not know about.
 *
 * It also STRIPS every SA-ungrantable verb (`SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS` — INV-SA-3): a
 * `user:manage` / `settings:manage` / … row written before the SEC-011 refinement is kept in the DB
 * (never deleted; the next admin save of the grant set drops it) but confers nothing (SEC-073).
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
    if (
      ALL_PERMISSIONS.has(permission as Permission) &&
      !UNGRANTABLE.has(permission)
    ) {
      resolved.add(permission as Permission);
    }
  }
  return resolved;
}
