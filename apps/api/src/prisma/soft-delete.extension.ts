/**
 * Soft-delete query filter (ADR-0032) — the pure logic.
 *
 * Reads on a soft-deletable model are automatically scoped to `deletedAt: null`, so feature
 * services no longer carry per-query `where: { deletedAt: null }` guards. Callers that genuinely
 * need to see soft-deleted rows (restore, audit) pass `{ includeSoftDeleted: true }` — a custom
 * arg stripped before handing off to Prisma. Writes are left untouched on purpose: the soft delete
 * itself is an `update` that stamps `deletedAt`, and a future restore must be able to target an
 * already-deleted row.
 *
 * This module is framework-pure (no Prisma import) so it can be unit-tested in isolation. The
 * Prisma client extension that calls {@link withSoftDeleteFilter} is wired in `prisma.service.ts`.
 */

// Mutable domain entities that carry a `deletedAt` column (ADR-0006). Append-only tables and
// lifecycle joins (AssetAssignment, AccessGrant, AssetHistory, ConsumableMovement) are NOT here.
export const SOFT_DELETABLE_MODELS: ReadonlySet<string> = new Set([
  'User',
  'Location',
  'AssetCategory',
  'AssetModel',
  'Asset',
  'ArticleCategory',
  'Article',
  'ApplicationCategory',
  'Application',
]);

// Read operations whose results must hide soft-deleted rows. `findUnique`/`findUniqueOrThrow` are
// intentionally excluded: their `where` only accepts unique fields, so `deletedAt` cannot be added
// there. The codebase convention is to use `findFirst` for soft-delete-aware lookups by id.
export const FILTERED_READS: ReadonlySet<string> = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/**
 * Inject `deletedAt: null` into a read's `where` for soft-deletable models, honoring the
 * `includeSoftDeleted` escape hatch. Pure and exported for unit testing. Always strips the custom
 * `includeSoftDeleted` arg (Prisma would reject it). Non-reads and non-soft-deletable models pass
 * through unchanged (minus the custom arg).
 */
export function withSoftDeleteFilter(
  model: string | undefined,
  operation: string,
  args: unknown,
): Record<string, unknown> {
  const { includeSoftDeleted, ...rest } = (args ?? {}) as {
    where?: Record<string, unknown>;
    includeSoftDeleted?: boolean;
  };
  if (
    includeSoftDeleted === true ||
    model === undefined ||
    !SOFT_DELETABLE_MODELS.has(model) ||
    !FILTERED_READS.has(operation)
  ) {
    return rest;
  }
  return { ...rest, where: { ...(rest.where ?? {}), deletedAt: null } };
}
