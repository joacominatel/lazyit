export const EXPORT_BATCH_SIZE = 1000;

/** The immutable `(createdAt, id)` position of the last row sent. */
export interface KeysetCursor<I extends string | number = string | number> {
  createdAt: Date;
  id: I;
}

/** Newest first, `id` breaking `createdAt` ties: the only order an export walks. */
export function keysetOrderBy(): [{ createdAt: 'desc' }, { id: 'desc' }] {
  return [{ createdAt: 'desc' }, { id: 'desc' }];
}

// An explicit predicate, not Prisma `cursor`: a soft-deleted cursor row would break the latter.
export function keysetWhere<W extends object, I extends string | number>(
  where: W,
  after: KeysetCursor<I> | null,
):
  | W
  | {
      AND: [
        W,
        {
          OR: [{ createdAt: { lt: Date } }, { createdAt: Date; id: { lt: I } }];
        },
      ];
    } {
  if (!after) return where;
  return {
    AND: [
      where,
      {
        OR: [
          { createdAt: { lt: after.createdAt } },
          { createdAt: after.createdAt, id: { lt: after.id } },
        ],
      },
    ],
  };
}

/** Newest first, `batchSize` rows at a time; a row inserted mid-export sorts ahead of the cursor. */
export async function* keysetBatches<T extends KeysetCursor>(
  fetchBatch: (after: KeysetCursor | null, take: number) => Promise<T[]>,
  batchSize: number = EXPORT_BATCH_SIZE,
): AsyncGenerator<T[]> {
  let after: KeysetCursor | null = null;
  for (;;) {
    const rows = await fetchBatch(after, batchSize);
    if (rows.length === 0) return;
    yield rows;
    const last = rows[rows.length - 1];
    // A fetch that ignores the cursor returns the same batch forever.
    if (
      after &&
      last.id === after.id &&
      last.createdAt.getTime() === after.createdAt.getTime()
    ) {
      throw new Error('keysetBatches: the cursor did not advance');
    }
    after = { createdAt: last.createdAt, id: last.id };
    if (rows.length < batchSize) return;
  }
}
