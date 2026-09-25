/**
 * An in-memory stand-in for the slice of PrismaService the OAuth authorization server uses — enough to
 * run the protocol end to end in Jest (no database), with the SAME atomic semantics the code relies on:
 * `updateMany` returns how many rows matched, so a second consumption of a code or a refresh token sees
 * `count: 0` exactly as PostgreSQL would.
 *
 * Supported `where` forms: equality (incl. `null` and `Date`), `{ gt, gte, lt, lte, not, in }`, `OR`, and
 * the two relation filters the OAuth code uses (`grants: { none: {} }`, `user: { deletedAt: null }`).
 * Test support only — it lives under `test/`, outside the build.
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- an in-memory fake mirrors the async Prisma API */

type Row = Record<string, any>;

let counter = 0;
export function fakeCuid(): string {
  counter += 1;
  return `c${counter.toString(36).padStart(8, '0')}${Math.random().toString(36).slice(2, 14).padEnd(12, '0')}`;
}

function equal(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  return a === b;
}

function compare(a: any, b: any): number {
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  return left < right ? -1 : left > right ? 1 : 0;
}

function isOperatorObject(value: unknown): value is Row {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Date) &&
    !Array.isArray(value)
  );
}

export class FakeOAuthPrisma {
  readonly tables: Record<string, Row[]> = {
    oAuthClient: [],
    oAuthGrant: [],
    oAuthAuthorizationCode: [],
    oAuthToken: [],
    oAuthAuditLog: [],
    aiSettings: [],
    user: [],
  };

  readonly oAuthClient = this.model('oAuthClient', {
    lastUsedAt: null,
    fetchedAt: null,
    clientUri: null,
    logoUri: null,
  });
  readonly oAuthGrant = this.model(
    'oAuthGrant',
    {
      kind: 'oauth',
      clientRefId: null,
      label: null,
      expiresAt: null,
      lastUsedAt: null,
      revokeReason: null,
      revokedById: null,
      deletedAt: null,
    },
    true,
  );
  readonly oAuthAuthorizationCode = this.model('oAuthAuthorizationCode', {
    usedAt: null,
  });
  readonly oAuthToken = this.model('oAuthToken', { usedAt: null });
  readonly oAuthAuditLog = this.model('oAuthAuditLog', {
    userId: null,
    actorId: null,
    grantId: null,
    clientId: null,
    ip: null,
    detail: null,
  });
  readonly aiSettings = this.model('aiSettings', {});
  readonly user = this.model('user', { deletedAt: null }, true);

  $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }

  /* ── the generic model ──────────────────────────────────────────────────────────────────────── */

  private matches(table: string, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, condition]) => {
      if (condition === undefined) return true;
      if (key === 'OR') {
        return (condition as Row[]).some((sub) =>
          this.matches(table, row, sub),
        );
      }
      if (table === 'oAuthClient' && key === 'grants') {
        const grants = this.tables.oAuthGrant.filter(
          (grant) => grant.clientRefId === row.id,
        );
        return (condition as Row).none !== undefined
          ? grants.length === 0
          : true;
      }
      if (table === 'oAuthGrant' && key === 'user') {
        const owner = this.tables.user.find((user) => user.id === row.userId);
        return (
          owner !== undefined && this.matches('user', owner, condition as Row)
        );
      }
      const value = row[key];
      if (!isOperatorObject(condition)) return equal(value, condition);
      return Object.entries(condition).every(([op, operand]) => {
        switch (op) {
          case 'gt':
            return value !== null && compare(value, operand) > 0;
          case 'gte':
            return value !== null && compare(value, operand) >= 0;
          case 'lt':
            return value !== null && compare(value, operand) < 0;
          case 'lte':
            return value !== null && compare(value, operand) <= 0;
          case 'not':
            return !equal(value, operand);
          case 'in':
            return (operand as unknown[]).some((item) => equal(value, item));
          default:
            throw new Error(`FakeOAuthPrisma: unsupported operator ${op}`);
        }
      });
    });
  }

  private withIncludes(table: string, row: Row, include?: Row): Row {
    if (!include) return { ...row };
    const out: Row = { ...row };
    if (include.client) {
      out.client =
        this.tables.oAuthClient.find(
          (client) => client.id === row.clientRefId,
        ) ?? null;
    }
    if (include.grant) {
      const grant = this.tables.oAuthGrant.find((g) => g.id === row.grantId);
      out.grant = grant
        ? this.withIncludes(
            'oAuthGrant',
            grant,
            (include.grant as Row).include as Row | undefined,
          )
        : null;
    }
    if (include.user) {
      out.user =
        this.tables.user.find((user) => user.id === row.userId) ?? null;
    }
    return out;
  }

  /**
   * `softDeletable` mirrors the soft-delete extension (ADR-0032): `findFirst` / `findMany` / `count` see
   * only `deletedAt: null` rows unless `includeSoftDeleted` is passed. Relation includes are unfiltered.
   */
  private model(table: string, defaults: Row, softDeletable = false) {
    const rows = () => this.tables[table];
    const scoped = (args: Row = {}): Row | undefined => {
      const { includeSoftDeleted, where } = args;
      if (!softDeletable || includeSoftDeleted) return where as Row | undefined;
      return { deletedAt: null, ...(where as Row | undefined) };
    };
    const create = (data: Row): Row => {
      const now = new Date();
      const row: Row = {
        ...defaults,
        id: table === 'oAuthAuditLog' ? rows().length + 1 : fakeCuid(),
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      rows().push(row);
      return row;
    };
    return {
      create: jest.fn(async ({ data }: { data: Row }) => ({ ...create(data) })),
      createMany: jest.fn(async ({ data }: { data: Row[] }) => {
        data.forEach(create);
        return { count: data.length };
      }),
      findUnique: jest.fn(
        async ({ where, include }: { where: Row; include?: Row }) => {
          const row = rows().find((candidate) =>
            this.matches(table, candidate, where),
          );
          return row ? this.withIncludes(table, row, include) : null;
        },
      ),
      findFirst: jest.fn(async (args: { where?: Row; include?: Row } = {}) => {
        const where = scoped(args);
        const { include } = args;
        const row = rows().find((candidate) =>
          this.matches(table, candidate, where),
        );
        return row ? this.withIncludes(table, row, include) : null;
      }),
      findMany: jest.fn(async (args: { where?: Row; include?: Row } = {}) =>
        rows()
          .filter((candidate) => this.matches(table, candidate, scoped(args)))
          .sort((a, b) => compare(b.createdAt, a.createdAt))
          .map((row) => this.withIncludes(table, row, args.include)),
      ),
      count: jest.fn(
        async (args: { where?: Row } = {}) =>
          rows().filter((candidate) =>
            this.matches(table, candidate, scoped(args)),
          ).length,
      ),
      upsert: jest.fn(
        async ({
          where,
          create: createData,
          update: updateData,
        }: {
          where: Row;
          create: Row;
          update: Row;
        }) => {
          const row = rows().find((candidate) =>
            this.matches(table, candidate, where),
          );
          if (!row) return { ...create(createData) };
          Object.assign(row, updateData, { updatedAt: new Date() });
          return { ...row };
        },
      ),
      update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const row = rows().find((candidate) =>
          this.matches(table, candidate, where),
        );
        if (!row) throw new Error(`FakeOAuthPrisma: ${table} not found`);
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      }),
      updateMany: jest.fn(
        async ({ where, data }: { where: Row; data: Row }) => {
          const matched = rows().filter((candidate) =>
            this.matches(table, candidate, where),
          );
          matched.forEach((row) =>
            Object.assign(row, data, { updatedAt: new Date() }),
          );
          return { count: matched.length };
        },
      ),
      deleteMany: jest.fn(async ({ where }: { where?: Row } = {}) => {
        const before = rows().length;
        const kept = rows().filter(
          (candidate) => !this.matches(table, candidate, where),
        );
        this.tables[table] = kept;
        // Cascades the schema declares: client → codes; grant → tokens.
        if (table === 'oAuthClient') {
          const ids = new Set(kept.map((row) => row.id));
          this.tables.oAuthAuthorizationCode =
            this.tables.oAuthAuthorizationCode.filter((code) =>
              ids.has(code.clientRefId),
            );
        }
        return { count: before - kept.length };
      }),
    };
  }
}
