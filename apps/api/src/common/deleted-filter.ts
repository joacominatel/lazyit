import { ForbiddenException } from '@nestjs/common';
import type { DeletedFilter } from '@lazyit/shared';
import type { User } from '../../generated/prisma/client';

/**
 * Soft-delete list slice (ADR-0030 addendum / ADR-0041): translate a {@link DeletedFilter} into the
 * pieces a list query needs to scope itself to the right slice, and gate the privileged slice.
 *
 * Two helpers, one for each layer:
 *   - {@link assertCanListDeleted} — the CONTROLLER-side ADMIN gate. The list `GET` routes carry no
 *     `@Roles()` (any authenticated user may list ACTIVE rows), so the RolesGuard can't gate the
 *     `only` slice on its own (it can't see the query string). Instead each list controller calls
 *     this with the parsed `deleted` value and the `@CurrentUser`: asking for `only` as a non-ADMIN
 *     (or anonymous) is a 403, matching the RolesGuard's `@Roles('ADMIN')` semantics elsewhere.
 *   - {@link deletedWhere} — the SERVICE-side `where` fragment. For `active` it returns
 *     `{ deletedAt: null }`; for `only`, `{ deletedAt: { not: null } }`. Spread into the list `where`
 *     (and the paired `count`) so both slices are explicit and identical across all five resources —
 *     it does NOT depend on whether the model is in the ADR-0032 SOFT_DELETABLE_MODELS set, so the
 *     consumable models (deletedAt columns but NOT auto-filtered by the extension) are correct too.
 *
 * The `only` slice must ALSO pass the ADR-0032 `includeSoftDeleted: true` escape hatch on the query
 * args so the read filter doesn't re-hide the soft-deleted rows for the extension-filtered models —
 * see {@link includeSoftDeletedFor}. (For `active` the escape hatch is irrelevant; the filter and the
 * explicit `deletedAt: null` agree.)
 */

/**
 * 403 unless the caller is an ADMIN when they ask for the soft-deleted (`only`) slice. A no-op for
 * the default `active` slice (any authenticated user may list live rows). Call from each list
 * controller BEFORE handing off to the service.
 */
export function assertCanListDeleted(
  deleted: DeletedFilter,
  user?: User,
): void {
  if (deleted === 'only' && user?.role !== 'ADMIN') {
    throw new ForbiddenException(
      'Only an administrator can list archived (soft-deleted) records',
    );
  }
}

/**
 * The `deletedAt` `where` fragment for a soft-delete slice — `{ deletedAt: null }` for `active`,
 * `{ deletedAt: { not: null } }` for `only`. Spread into a Prisma list `where` (and its paired
 * `count`). Returned untyped (a `deletedAt` clause every soft-deletable model accepts) so each
 * service can spread it into its own `Prisma.<Model>WhereInput`.
 */
export function deletedWhere(deleted: DeletedFilter): {
  deletedAt: null | { not: null };
} {
  return deleted === 'only'
    ? { deletedAt: { not: null } }
    : { deletedAt: null };
}

/**
 * Whether a query for this slice must carry the ADR-0032 `includeSoftDeleted: true` escape hatch.
 * Only the `only` slice does: the read filter would otherwise hide the soft-deleted rows for the
 * extension-filtered models. `active` returns `false` (the filter and `deletedAt: null` agree).
 */
export function includeSoftDeletedFor(deleted: DeletedFilter): boolean {
  return deleted === 'only';
}
