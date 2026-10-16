// Test-only: evaluates the subset of Prisma's where/orderBy language the list and export queries emit,
// so a spec can hold an in-memory table and compare the rows two routes actually select.

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function comparable(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

function matchesField(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date || typeof cond !== 'object') {
    return comparable(value) === comparable(cond);
  }
  const ops = cond as Record<string, unknown>;
  return Object.entries(ops).every(([op, operand]) => {
    switch (op) {
      case 'not':
        return operand === null
          ? value !== null && value !== undefined
          : comparable(value) !== comparable(operand);
      case 'in':
        return (operand as unknown[]).includes(value);
      case 'lt':
        return (comparable(value) as number) < (comparable(operand) as number);
      case 'gt':
        return (comparable(value) as number) > (comparable(operand) as number);
      case 'contains': {
        const text = typeof value === 'string' ? value : '';
        return ops.mode === 'insensitive'
          ? text.toLowerCase().includes(String(operand).toLowerCase())
          : text.includes(String(operand));
      }
      case 'mode':
        return true;
      default:
        throw new Error(`in-memory where: unsupported operator ${op}`);
    }
  });
}

export function matchesWhere(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') {
      const all = Array.isArray(cond) ? cond : [cond];
      return (all as Where[]).every((w) => matchesWhere(row, w));
    }
    if (key === 'OR')
      return (cond as Where[]).some((w) => matchesWhere(row, w));
    if (key === 'NOT') return !matchesWhere(row, cond as Where);
    return matchesField(row[key], cond);
  });
}

export function sortRows<T extends Row>(rows: T[], orderBy: unknown): T[] {
  const keys = (
    Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []
  ) as Record<string, 'asc' | 'desc'>[];
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const [field, dir] = Object.entries(key)[0];
      const x = comparable(a[field]) as string | number;
      const y = comparable(b[field]) as string | number;
      if (x === y) continue;
      const order = x < y ? -1 : 1;
      return dir === 'desc' ? -order : order;
    }
    return 0;
  });
}

interface FindArgs {
  where?: Where;
  orderBy?: unknown;
  take?: number;
  skip?: number;
  includeSoftDeleted?: boolean;
}

/** A model delegate over `rows`; `softDelete` mimics the ADR-0032 read filter and its escape hatch. */
export function inMemoryDelegate<T extends Row>(
  rows: T[],
  { softDelete = false }: { softDelete?: boolean } = {},
) {
  const scoped = (args: FindArgs) =>
    rows.filter(
      (row) =>
        matchesWhere(row, args.where) &&
        (!softDelete ||
          args.includeSoftDeleted === true ||
          row.deletedAt == null),
    );
  return {
    findMany: jest.fn((args: FindArgs = {}) => {
      const sorted = sortRows(scoped(args), args.orderBy);
      const start = args.skip ?? 0;
      return Promise.resolve(
        sorted.slice(
          start,
          args.take === undefined ? undefined : start + args.take,
        ),
      );
    }),
    count: jest.fn((args: FindArgs = {}) =>
      Promise.resolve(scoped(args).length),
    ),
  };
}

/** The CSV body's data rows as cell arrays (BOM and header dropped); enough for the specs' plain cells. */
export function csvRows(body: string): string[][] {
  const lines = body
    .replace(/^\uFEFF/, '')
    .split('\r\n')
    .filter(Boolean);
  return lines.slice(1).map((line) => line.split(','));
}

export function csvHeader(body: string): string {
  return body.replace(/^\uFEFF/, '').split('\r\n')[0];
}
