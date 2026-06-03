import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  type Permission,
} from '@lazyit/shared';

// The service + resolver import PrismaService, which loads the generated Prisma client (ESM `.js`
// re-exports jest can't resolve). The DB is faked here with an in-memory store, so stub the client and
// adapter to keep the real modules from loading — but expose a REAL `Role` enum the service uses.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x },
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));

import { PermissionsConfigService } from './permissions-config.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import type { PrismaService } from '../prisma/prisma.service';

type Row = { role: string; permission: string };
type AuditRow = {
  actorId: string | null;
  role: string;
  permission: string;
  action: 'GRANT' | 'REVOKE';
};

/**
 * An in-memory Prisma double backing `rolePermission` + `permissionAuditLog`, just enough for the
 * service: findMany/deleteMany/createMany on the matrix table, createMany on the append-only audit
 * table, and a `$transaction` that runs the callback against the SAME store (so the real resolver,
 * sharing this prisma, sees the post-write state on its next read). This exercises the full chain —
 * diff → write → audit → cache-invalidate → re-resolve — without a database.
 */
class FakePrisma {
  rows: Row[] = [];
  audit: AuditRow[] = [];

  private readonly api = {
    rolePermission: {
      findMany: ({ where }: { where: { role: string } }) =>
        Promise.resolve(
          this.rows
            .filter((r) => r.role === where.role)
            .map((r) => ({ permission: r.permission })),
        ),
      deleteMany: ({
        where,
      }: {
        where: { role: string; permission: { in: string[] } };
      }) => {
        const drop = new Set(where.permission.in);
        this.rows = this.rows.filter(
          (r) => !(r.role === where.role && drop.has(r.permission)),
        );
        return Promise.resolve({ count: drop.size });
      },
      createMany: ({ data }: { data: Row[] }) => {
        this.rows.push(...data);
        return Promise.resolve({ count: data.length });
      },
    },
    permissionAuditLog: {
      createMany: ({ data }: { data: AuditRow[] }) => {
        this.audit.push(...data);
        return Promise.resolve({ count: data.length });
      },
    },
  };

  // The matrix read the service issues for getMatrix (filtered to the editable roles in one call).
  get rolePermission() {
    return {
      findMany: ({
        where,
      }: {
        where: { role: string | { in: string[] } };
      }) => {
        const filter = where.role;
        const match =
          typeof filter === 'string'
            ? (r: Row) => r.role === filter
            : (r: Row) => filter.in.includes(r.role);
        return Promise.resolve(
          this.rows.filter(match).map((r) => ({
            role: r.role,
            permission: r.permission,
          })),
        );
      },
    };
  }

  get permissionAuditLog() {
    return this.api.permissionAuditLog;
  }

  // Interactive transaction: hand the callback a `tx` exposing the per-role findMany / mutate ops.
  $transaction<T>(fn: (tx: typeof this.api) => Promise<T>): Promise<T> {
    return fn(this.api);
  }
}

const asPrisma = (f: FakePrisma) => f as unknown as PrismaService;

/** Seed the store with the default matrix rows for MEMBER + VIEWER (ADMIN is never stored). */
function seedDefault(store: FakePrisma): void {
  store.rows = [];
  for (const role of ['MEMBER', 'VIEWER'] as const) {
    for (const permission of DEFAULT_ROLE_PERMISSIONS[role]) {
      store.rows.push({ role, permission });
    }
  }
}

describe('PermissionsConfigService (ADR-0046 P5)', () => {
  let store: FakePrisma;
  let resolver: PermissionResolverService;
  let service: PermissionsConfigService;

  beforeEach(() => {
    store = new FakePrisma();
    seedDefault(store);
    resolver = new PermissionResolverService(asPrisma(store));
    service = new PermissionsConfigService(asPrisma(store), resolver);
  });

  // ── GET — the materialized matrix ────────────────────────────────────────────────────────────────

  it('getMatrix reports the seeded MEMBER/VIEWER sets and ADMIN as the COMPLETE catalog', async () => {
    const matrix = await service.getMatrix();
    expect(new Set(matrix.ADMIN)).toEqual(new Set(PERMISSIONS));
    expect(new Set(matrix.MEMBER)).toEqual(new Set(DEFAULT_ROLE_PERMISSIONS.MEMBER));
    expect(new Set(matrix.VIEWER)).toEqual(new Set(DEFAULT_ROLE_PERMISSIONS.VIEWER));
  });

  it('getMatrix ignores catalog-foreign rows (a stray DB literal never surfaces)', async () => {
    store.rows.push({ role: 'MEMBER', permission: 'asset:teleport' });
    const matrix = await service.getMatrix();
    expect(matrix.MEMBER).not.toContain('asset:teleport' as Permission);
  });

  // ── PUT — round-trip, transactional replace ─────────────────────────────────────────────────────

  it('a MEMBER/VIEWER set round-trips through getMatrix after updateMatrix', async () => {
    const body = {
      MEMBER: ['asset:read', 'asset:write', 'asset:delete'] as Permission[],
      VIEWER: ['asset:read', 'location:read'] as Permission[],
    };
    const returned = await service.updateMatrix(body, 'actor-1');
    expect(new Set(returned.MEMBER)).toEqual(new Set(body.MEMBER));
    expect(new Set(returned.VIEWER)).toEqual(new Set(body.VIEWER));

    const reread = await service.getMatrix();
    expect(new Set(reread.MEMBER)).toEqual(new Set(body.MEMBER));
    expect(new Set(reread.VIEWER)).toEqual(new Set(body.VIEWER));
  });

  it('updateMatrix never writes ADMIN rows (ADMIN stays the resolver-enforced full catalog)', async () => {
    await service.updateMatrix(
      { MEMBER: ['asset:read'] as Permission[], VIEWER: [] },
      'actor-1',
    );
    expect(store.rows.some((r) => r.role === 'ADMIN')).toBe(false);
    const matrix = await service.getMatrix();
    expect(new Set(matrix.ADMIN)).toEqual(new Set(PERMISSIONS));
  });

  // ── AUDIT — one row per added / removed permission, attributed to the actor ──────────────────────

  it('writes a GRANT audit row per added permission and a REVOKE per removed, with the actor', async () => {
    // From the default MEMBER set, grant a brand-new `asset:delete` and revoke an existing `asset:write`.
    const next: Permission[] = [
      ...DEFAULT_ROLE_PERMISSIONS.MEMBER.filter((p) => p !== 'asset:write'),
      'asset:delete',
    ];

    await service.updateMatrix(
      { MEMBER: next as Permission[], VIEWER: DEFAULT_ROLE_PERMISSIONS.VIEWER },
      'actor-42',
    );

    const memberAudit = store.audit.filter((a) => a.role === 'MEMBER');
    expect(memberAudit).toContainEqual({
      actorId: 'actor-42',
      role: 'MEMBER',
      permission: 'asset:delete',
      action: 'GRANT',
    });
    expect(memberAudit).toContainEqual({
      actorId: 'actor-42',
      role: 'MEMBER',
      permission: 'asset:write',
      action: 'REVOKE',
    });
    // Exactly those two changes for MEMBER (no spurious rows for unchanged permissions).
    expect(memberAudit).toHaveLength(2);
  });

  it('a no-op PUT (identical sets) writes NO audit rows', async () => {
    await service.updateMatrix(
      {
        MEMBER: DEFAULT_ROLE_PERMISSIONS.MEMBER,
        VIEWER: DEFAULT_ROLE_PERMISSIONS.VIEWER,
      },
      'actor-1',
    );
    expect(store.audit).toHaveLength(0);
  });

  it('records a null actor when there is no authenticated user', async () => {
    await service.updateMatrix(
      { MEMBER: ['asset:read'] as Permission[], VIEWER: [] },
      null,
    );
    expect(store.audit.every((a) => a.actorId === null)).toBe(true);
  });

  // ── CACHE COHERENCE — a granted permission is visible to the NEXT authZ decision ─────────────────

  it('a PUT that grants MEMBER a new permission is reflected in a subsequent authZ decision', async () => {
    // Prime the resolver cache: MEMBER does NOT hold asset:delete in the default seed.
    expect(await resolver.hasAll('MEMBER', ['asset:delete'])).toBe(false);

    // Grant it via the config endpoint (which calls resolver.invalidate()).
    const next: Permission[] = [
      ...DEFAULT_ROLE_PERMISSIONS.MEMBER,
      'asset:delete',
    ];
    await service.updateMatrix(
      { MEMBER: next, VIEWER: DEFAULT_ROLE_PERMISSIONS.VIEWER },
      'actor-1',
    );

    // The next authorization decision must now SEE the grant — proof the cache was invalidated.
    expect(await resolver.hasAll('MEMBER', ['asset:delete'])).toBe(true);
  });

  it('a PUT that revokes a MEMBER permission is reflected in a subsequent authZ decision', async () => {
    expect(await resolver.hasAll('MEMBER', ['asset:write'])).toBe(true);

    const next = DEFAULT_ROLE_PERMISSIONS.MEMBER.filter(
      (p) => p !== 'asset:write',
    );
    await service.updateMatrix(
      { MEMBER: next as Permission[], VIEWER: DEFAULT_ROLE_PERMISSIONS.VIEWER },
      'actor-1',
    );

    expect(await resolver.hasAll('MEMBER', ['asset:write'])).toBe(false);
  });

  // ── my-permissions — the caller's effective set, via the resolver ────────────────────────────────

  it('resolveFor(ADMIN) returns the complete catalog', async () => {
    const mine = await service.resolveFor('ADMIN');
    expect(mine.role).toBe('ADMIN');
    expect(new Set(mine.permissions)).toEqual(new Set(PERMISSIONS));
  });

  it('resolveFor(MEMBER) returns exactly the MEMBER DB set', async () => {
    const mine = await service.resolveFor('MEMBER');
    expect(mine.role).toBe('MEMBER');
    expect(new Set(mine.permissions)).toEqual(
      new Set(DEFAULT_ROLE_PERMISSIONS.MEMBER),
    );
  });

  it('resolveFor(VIEWER) reflects a prior edit (post-invalidate consistency)', async () => {
    await service.updateMatrix(
      {
        MEMBER: DEFAULT_ROLE_PERMISSIONS.MEMBER,
        VIEWER: ['asset:read'] as Permission[],
      },
      'actor-1',
    );
    const mine = await service.resolveFor('VIEWER');
    expect(mine.permissions).toEqual(['asset:read']);
  });
});
