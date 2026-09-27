import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type RolePermissionMatrix,
} from '@lazyit/shared';

// The config service + resolver import PrismaService, which loads the generated Prisma client (ESM
// `.js` re-exports jest can't resolve). The DB is faked in memory, so stub the client and adapter and
// expose a real `Role` enum (same approach as permissions-config.service.spec.ts).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x },
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));

import { applyDefaultRolePermissionsOnce } from './seed-role-permissions';
import { PermissionsConfigService } from '../config/permissions-config.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import type { PrismaService } from './prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';

type Pair = { role: 'ADMIN' | 'MEMBER' | 'VIEWER'; permission: string };
type RoleFilter = string | { in: string[] };

const key = (p: { role: string; permission: string }) =>
  `${p.role}|${p.permission}`;

/**
 * One in-memory database shared by the seed helper AND the real `PermissionsConfigService`, so a
 * revocation goes through the same code an admin's `PUT /config/permissions` runs. It implements
 * exactly the calls those two make — if the config service ever touched the ledger, this fake would
 * throw and the durability tests would fail.
 */
class FakeDb {
  grants = new Map<string, Pair>();
  ledger = new Map<string, Pair>();
  audit: { role: string; permission: string; action: 'GRANT' | 'REVOKE' }[] =
    [];

  readonly rolePermission = {
    findMany: ({ where }: { where: { role: RoleFilter } }) => {
      const match = (role: string) =>
        typeof where.role === 'string'
          ? role === where.role
          : where.role.in.includes(role);
      return Promise.resolve(
        [...this.grants.values()]
          .filter((p) => match(p.role))
          .map((p) => ({ ...p })),
      );
    },
    deleteMany: ({
      where,
    }: {
      where: { role: string; permission: { in: string[] } };
    }) => {
      let count = 0;
      for (const permission of where.permission.in) {
        if (this.grants.delete(key({ role: where.role, permission }))) count++;
      }
      return Promise.resolve({ count });
    },
    createMany: ({
      data,
      skipDuplicates,
    }: {
      data: Pair[];
      skipDuplicates?: boolean;
    }) => this.insert(this.grants, data, skipDuplicates),
  };

  readonly appliedRolePermissionDefault = {
    findMany: () =>
      Promise.resolve([...this.ledger.values()].map((p) => ({ ...p }))),
    createMany: ({
      data,
      skipDuplicates,
    }: {
      data: Pair[];
      skipDuplicates?: boolean;
    }) => this.insert(this.ledger, data, skipDuplicates),
  };

  readonly permissionAuditLog = {
    createMany: ({ data }: { data: FakeDb['audit'] }) => {
      this.audit.push(...data);
      return Promise.resolve({ count: data.length });
    },
  };

  $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }

  /** Composite-PK insert: a duplicate throws unless skipDuplicates (ON CONFLICT DO NOTHING). */
  private insert(
    table: Map<string, Pair>,
    data: Pair[],
    skipDuplicates?: boolean,
  ) {
    let count = 0;
    for (const row of data) {
      if (table.has(key(row))) {
        if (!skipDuplicates) throw new Error(`duplicate key ${key(row)}`);
        continue;
      }
      table.set(key(row), { role: row.role, permission: row.permission });
      count++;
    }
    return Promise.resolve({ count });
  }

  held(role: Pair['role']): Set<string> {
    return new Set(
      [...this.grants.values()]
        .filter((p) => p.role === role)
        .map((p) => p.permission),
    );
  }
}

/** Run the seed step exactly as `prisma/seed.ts` does: one transaction around the helper. */
const runSeed = (db: FakeDb, defaults: RolePermissionMatrix) =>
  db.$transaction((tx) => applyDefaultRolePermissionsOnce(tx, defaults));

function configService(db: FakeDb): PermissionsConfigService {
  const prisma = db as unknown as PrismaService;
  return new PermissionsConfigService(
    prisma,
    new PermissionResolverService(prisma),
    {
      emit: jest.fn().mockResolvedValue('id'),
    } as unknown as NotificationsService,
  );
}

/** An admin removes one permission from a role through the real matrix editor. */
async function revokeViaConfig(
  db: FakeDb,
  role: 'MEMBER' | 'VIEWER',
  permission: Permission,
): Promise<void> {
  const matrix = await configService(db).getMatrix();
  await configService(db).updateMatrix(
    {
      MEMBER: matrix.MEMBER,
      VIEWER: matrix.VIEWER,
      [role]: matrix[role].filter((p) => p !== permission),
    },
    'admin-id',
  );
}

const totalDefaultPairs = Object.values(DEFAULT_ROLE_PERMISSIONS).reduce(
  (n, perms) => n + perms.length,
  0,
);

describe('applyDefaultRolePermissionsOnce (#1314 seed-once default grants)', () => {
  it('a fresh install receives the full default matrix, and a re-run changes nothing', async () => {
    const db = new FakeDb();

    const first = await runSeed(db, DEFAULT_ROLE_PERMISSIONS);

    expect(first).toEqual({ applied: totalDefaultPairs, settled: 0 });
    for (const role of ['ADMIN', 'MEMBER', 'VIEWER'] as const) {
      expect(db.held(role)).toEqual(new Set(DEFAULT_ROLE_PERMISSIONS[role]));
    }
    expect(db.ledger.size).toBe(totalDefaultPairs);

    const second = await runSeed(db, DEFAULT_ROLE_PERMISSIONS);
    expect(second).toEqual({ applied: 0, settled: totalDefaultPairs });
    expect(db.grants.size).toBe(totalDefaultPairs);
  });

  it('a default an admin revoked stays revoked across every later seed run', async () => {
    const db = new FakeDb();
    await runSeed(db, DEFAULT_ROLE_PERMISSIONS);
    expect(db.held('MEMBER')).toContain('asset:write');

    await revokeViaConfig(db, 'MEMBER', 'asset:write');
    expect(db.held('MEMBER')).not.toContain('asset:write');
    expect(db.audit).toContainEqual(
      expect.objectContaining({
        role: 'MEMBER',
        permission: 'asset:write',
        action: 'REVOKE',
      }),
    );

    // Two deploys later, the revocation still holds.
    await runSeed(db, DEFAULT_ROLE_PERMISSIONS);
    await runSeed(db, DEFAULT_ROLE_PERMISSIONS);
    expect(db.held('MEMBER')).not.toContain('asset:write');
    expect((await configService(db).getMatrix()).MEMBER).not.toContain(
      'asset:write',
    );
  });

  it('a permission newly added to the defaults is granted once, then revocable durably', async () => {
    const db = new FakeDb();
    // An older release whose defaults did not yet give VIEWER `asset:read`.
    const olderDefaults: RolePermissionMatrix = {
      ...DEFAULT_ROLE_PERMISSIONS,
      VIEWER: DEFAULT_ROLE_PERMISSIONS.VIEWER.filter((p) => p !== 'asset:read'),
    };
    await runSeed(db, olderDefaults);
    expect(db.held('VIEWER')).not.toContain('asset:read');

    // The release that adds it: applied exactly once.
    const upgrade = await runSeed(db, DEFAULT_ROLE_PERMISSIONS);
    expect(upgrade.applied).toBe(1);
    expect(db.held('VIEWER')).toContain('asset:read');

    await revokeViaConfig(db, 'VIEWER', 'asset:read');
    const after = await runSeed(db, DEFAULT_ROLE_PERMISSIONS);
    expect(after.applied).toBe(0);
    expect(db.held('VIEWER')).not.toContain('asset:read');
  });

  it('after the upgrade backfill, only never-seen defaults are applied and nothing is removed', async () => {
    const db = new FakeDb();
    // An existing instance right after the migration: its current rows are all marked settled, plus
    // one pair the audit log shows was revoked (now absent). One default pair was never applied here.
    for (const role of ['ADMIN', 'MEMBER', 'VIEWER'] as const) {
      for (const permission of DEFAULT_ROLE_PERMISSIONS[role]) {
        const pair = { role, permission };
        if (key(pair) === 'MEMBER|asset:write') continue; // revoked before the upgrade
        if (key(pair) === 'VIEWER|asset:read') continue; // never applied (skipped release)
        db.grants.set(key(pair), pair);
        db.ledger.set(key(pair), pair);
      }
    }
    const revoked: Pair = { role: 'MEMBER', permission: 'asset:write' };
    db.ledger.set(key(revoked), revoked);
    // A non-default grant an admin added: must survive.
    const custom: Pair = { role: 'MEMBER', permission: 'asset:delete' };
    db.grants.set(key(custom), custom);
    db.ledger.set(key(custom), custom);

    const result = await runSeed(db, DEFAULT_ROLE_PERMISSIONS);

    expect(result.applied).toBe(1);
    expect(db.held('VIEWER')).toContain('asset:read');
    expect(db.held('MEMBER')).not.toContain('asset:write');
    expect(db.held('MEMBER')).toContain('asset:delete');
  });

  it('keeps a pair an admin already granted, and records it as settled', async () => {
    const db = new FakeDb();
    // Held without a ledger row (e.g. granted by hand before it became a default).
    const pre: Pair = { role: 'VIEWER', permission: 'asset:read' };
    db.grants.set(key(pre), pre);

    await runSeed(db, DEFAULT_ROLE_PERMISSIONS);

    expect(db.held('VIEWER')).toContain('asset:read');
    expect(db.ledger.has(key(pre))).toBe(true);
  });
});

describe('add_applied_role_permission_defaults migration (#1314 backfill)', () => {
  const migrationsDir = join(__dirname, '../../prisma/migrations');
  const dir = readdirSync(migrationsDir).find((d) =>
    d.endsWith('_add_applied_role_permission_defaults'),
  );
  const sql = dir
    ? readFileSync(join(migrationsDir, dir, 'migration.sql'), 'utf8')
    : '';
  const statements = sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  it('exists', () => {
    expect(dir).toBeDefined();
  });

  it('marks every currently held pair as settled', () => {
    expect(statements).toContainEqual(
      expect.stringMatching(
        /INSERT INTO "applied_role_permission_defaults" \("role", "permission"\) SELECT "role", "permission" FROM "role_permissions"/,
      ),
    );
  });

  it('marks every pair the audit log shows was revoked as settled', () => {
    expect(statements).toContainEqual(
      expect.stringMatching(
        /UNION SELECT "role", "permission" FROM "permission_audit_log" WHERE "action" = 'REVOKE'/,
      ),
    );
  });

  it('is idempotent and never deletes or rewrites an existing grant', () => {
    expect(sql).toMatch(/ON CONFLICT \("role", "permission"\) DO NOTHING/);
    for (const statement of statements) {
      expect(statement).not.toMatch(/\b(DELETE|UPDATE|DROP|TRUNCATE|ALTER)\b/i);
    }
  });
});
