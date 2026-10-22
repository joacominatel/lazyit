import type { Prisma } from '../../generated/prisma/client';

/** The parent tables a delete-with-resolution archives while other writes point rows at them (#1604). */
export type ParentTable =
  | 'locations'
  | 'asset_categories'
  | 'application_categories'
  | 'consumable_categories';

/**
 * Lock the parent row a write points at `FOR SHARE`, inside the caller's transaction, and say whether it is
 * LIVE (#1604). The soft-deleted check is part of the locking statement, so under READ COMMITTED a lock that
 * waited on a concurrent delete re-reads the committed row and finds it archived.
 *
 * It pairs with the parent's delete, which locks its own row `FOR UPDATE` before it scans the rows that point
 * at it: `FOR SHARE` conflicts with that lock, so either the write commits first and the delete then finds and
 * resolves the new row, or the delete commits first and the write sees the parent archived. Concurrent writes
 * never wait on each other (shared locks do not conflict).
 *
 * Lock order, everywhere: the parent rows a write names first, then the write's own row. A delete takes the
 * parent first and its dependents after, so no transaction holds a child while it waits for a parent.
 *
 * Writes only: reads never lock. Callers keep their own rule on which writes are checked (an unchanged legacy
 * reference stays editable) — this only makes the check and the write atomic.
 */
export async function lockLiveParent(
  tx: Prisma.TransactionClient,
  table: ParentTable,
  id: string,
): Promise<boolean> {
  const rows = await lockQuery(tx, table, id);
  return rows.length > 0;
}

// One literal statement per table: the table name is never interpolated.
function lockQuery(
  tx: Prisma.TransactionClient,
  table: ParentTable,
  id: string,
): Promise<{ id: string }[]> {
  switch (table) {
    case 'locations':
      return tx.$queryRaw`SELECT "id" FROM "locations" WHERE "id" = ${id} AND "deletedAt" IS NULL FOR SHARE`;
    case 'asset_categories':
      return tx.$queryRaw`SELECT "id" FROM "asset_categories" WHERE "id" = ${id} AND "deletedAt" IS NULL FOR SHARE`;
    case 'application_categories':
      return tx.$queryRaw`SELECT "id" FROM "application_categories" WHERE "id" = ${id} AND "deletedAt" IS NULL FOR SHARE`;
    case 'consumable_categories':
      return tx.$queryRaw`SELECT "id" FROM "consumable_categories" WHERE "id" = ${id} AND "deletedAt" IS NULL FOR SHARE`;
  }
}
