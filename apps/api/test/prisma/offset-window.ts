type SortDir = 'asc' | 'desc';
type OrderBy = Record<string, SortDir> | Record<string, SortDir>[];
type WindowArgs = { orderBy: OrderBy; take: number; skip: number };

function compare(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (x === y) return 0;
  return (x as string | number) < (y as string | number) ? -1 : 1;
}

// Like Postgres, rows tied on every ORDER BY key come back in a new order on each read (seeded).
export function postgresLikeFindMany<T extends Record<string, unknown>>(
  rows: T[],
  seed = 7,
): (args: WindowArgs) => Promise<T[]> {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
  return ({ orderBy, take, skip }) => {
    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).map(
      (key) => Object.entries(key)[0],
    );
    const shuffled = rows
      .map((row) => ({ row, at: random() }))
      .sort((a, b) => a.at - b.at)
      .map(({ row }) => row);
    shuffled.sort((a, b) => {
      for (const [field, dir] of keys) {
        const c = compare(a[field], b[field]);
        if (c !== 0) return dir === 'desc' ? -c : c;
      }
      return 0;
    });
    return Promise.resolve(shuffled.slice(skip, skip + take));
  };
}

export async function walkAllPages(
  fetchPage: (
    offset: number,
  ) => Promise<{ items: { id: unknown }[]; total: number }>,
  limit: number,
): Promise<unknown[]> {
  const ids: unknown[] = [];
  for (let offset = 0; ; offset += limit) {
    const page = await fetchPage(offset);
    ids.push(...page.items.map((item) => item.id));
    if (offset + limit >= page.total) return ids;
  }
}
