import type { Prisma } from '../../../generated/prisma/client';
import {
  keysetBatches,
  keysetOrderBy,
  keysetWhere,
  type KeysetCursor,
} from './keyset';
import { matchesWhere } from '../in-memory-where.harness-spec';

type Row = {
  id: string;
  createdAt: Date;
  live: boolean;
};

function newestFirst(a: Row, b: Row): number {
  const t = b.createdAt.getTime() - a.createdAt.getTime();
  if (t !== 0) return t;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function table(rows: Row[]) {
  const fetchBatch = jest.fn(
    (after: KeysetCursor | null, take: number): Promise<Row[]> =>
      Promise.resolve(
        rows
          .filter((r) => matchesWhere(r, keysetWhere({ live: true }, after)))
          .sort(newestFirst)
          .slice(0, take),
      ),
  );
  return { rows, fetchBatch };
}

const at = (iso: string) => new Date(`2026-10-16T${iso}.000Z`);

describe('keysetBatches', () => {
  it('sends every row exactly once while newer rows are inserted mid-export', async () => {
    // Three rows share a timestamp across the batch boundary, so `id` must break the tie.
    const seed: Row[] = [
      { id: 'a01', createdAt: at('10:00:05'), live: true },
      { id: 'a02', createdAt: at('10:00:04'), live: true },
      { id: 'a03', createdAt: at('10:00:03'), live: true },
      { id: 'a04', createdAt: at('10:00:03'), live: true },
      { id: 'a05', createdAt: at('10:00:03'), live: true },
      { id: 'a06', createdAt: at('10:00:02'), live: false },
      { id: 'a07', createdAt: at('10:00:01'), live: true },
    ];
    const { rows, fetchBatch } = table([...seed]);

    const seen: string[] = [];
    let inserted = 0;
    for await (const batch of keysetBatches(fetchBatch, 2)) {
      seen.push(...batch.map((r) => r.id));
      rows.push({
        id: `z0${inserted++}`,
        createdAt: at('11:00:00'),
        live: true,
      });
    }

    expect(seen).toEqual(['a01', 'a02', 'a05', 'a04', 'a03', 'a07']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('stops on a short batch without an extra round trip', async () => {
    const { fetchBatch } = table([
      { id: 'a01', createdAt: at('10:00:01'), live: true },
    ]);
    const batches: Row[][] = [];
    for await (const batch of keysetBatches(fetchBatch, 2)) batches.push(batch);
    expect(batches).toHaveLength(1);
    expect(fetchBatch).toHaveBeenCalledTimes(1);
  });

  it('fails instead of looping when a fetch ignores the cursor', async () => {
    const same = [
      { id: 'a01', createdAt: at('10:00:02') },
      { id: 'a02', createdAt: at('10:00:01') },
    ];
    const run = async () => {
      for await (const batch of keysetBatches(() => Promise.resolve(same), 2)) {
        void batch;
      }
    };
    await expect(run()).rejects.toThrow('the cursor did not advance');
  });
});

describe('keysetWhere / keysetOrderBy', () => {
  it('returns the list where untouched on the first batch', () => {
    const where = { deletedAt: null };
    expect(keysetWhere(where, null)).toBe(where);
  });

  it('fits a Prisma findMany as is', () => {
    const args = {
      where: keysetWhere(
        { isActive: true },
        { createdAt: new Date(), id: 'u1' },
      ),
      orderBy: keysetOrderBy(),
      take: 1000,
    } satisfies Prisma.UserFindManyArgs;
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });
});
