/**
 * An in-memory stand-in for the `userSession` Prisma delegate (issue #1420), for the end-to-end session
 * specs. Implements exactly the query shapes UserSessionStore, UserSessionsService and UserSessionSweeper
 * issue — nothing more — so a new query shape fails loudly here instead of silently matching everything.
 * Not a spec itself (the `harness-spec` suffix keeps it out of the build and out of the jest run).
 */

export interface SessionRow {
  id: string;
  userId: string;
  epoch: number;
  rememberMe: boolean;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date | null;
}

interface SessionWhere {
  id?: string | { not: string };
  userId?: string;
  epoch?: number;
  lastSeenAt?: { lte: Date };
  expiresAt?: { lte: Date };
  OR?: Array<{ expiresAt: null | { gt: Date } }>;
}

const KNOWN_KEYS = new Set([
  'id',
  'userId',
  'epoch',
  'lastSeenAt',
  'expiresAt',
  'OR',
]);

function matches(row: SessionRow, where: SessionWhere): boolean {
  for (const key of Object.keys(where)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`in-memory userSession: unsupported where key "${key}"`);
    }
  }
  if (typeof where.id === 'string' && row.id !== where.id) return false;
  if (typeof where.id === 'object' && row.id === where.id.not) return false;
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  if (where.epoch !== undefined && row.epoch !== where.epoch) return false;
  if (where.lastSeenAt && row.lastSeenAt > where.lastSeenAt.lte) return false;
  if (where.expiresAt) {
    if (row.expiresAt === null || row.expiresAt > where.expiresAt.lte) {
      return false;
    }
  }
  if (where.OR) {
    const any = where.OR.some((clause) =>
      clause.expiresAt === null
        ? row.expiresAt === null
        : row.expiresAt !== null && row.expiresAt > clause.expiresAt.gt,
    );
    if (!any) return false;
  }
  return true;
}

/** Build the delegate plus direct access to its rows. */
export function inMemoryUserSessions() {
  const rows = new Map<string, SessionRow>();
  const delegate = {
    create: jest.fn(
      ({ data }: { data: Partial<SessionRow> & { id: string } }) => {
        const now = new Date();
        const row: SessionRow = {
          rememberMe: false,
          userAgent: null,
          ip: null,
          expiresAt: null,
          createdAt: now,
          lastSeenAt: now,
          epoch: 0,
          userId: '',
          ...data,
        };
        rows.set(row.id, row);
        return Promise.resolve({ id: row.id });
      },
    ),
    findUnique: jest.fn(({ where }: { where: { id: string } }) => {
      const row = rows.get(where.id);
      return Promise.resolve(row ? { ...row } : null);
    }),
    findMany: jest.fn(
      ({ where, take }: { where: SessionWhere; take?: number }) => {
        const found = [...rows.values()]
          .filter((row) => matches(row, where))
          .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
          .slice(0, take ?? Infinity)
          .map((row) => ({ ...row }));
        return Promise.resolve(found);
      },
    ),
    updateMany: jest.fn(
      ({ where, data }: { where: SessionWhere; data: Partial<SessionRow> }) => {
        let count = 0;
        for (const row of rows.values()) {
          if (matches(row, where)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return Promise.resolve({ count });
      },
    ),
    deleteMany: jest.fn(({ where }: { where: SessionWhere }) => {
      let count = 0;
      for (const row of [...rows.values()]) {
        if (matches(row, where)) {
          rows.delete(row.id);
          count += 1;
        }
      }
      return Promise.resolve({ count });
    }),
  };
  return { rows, delegate };
}
