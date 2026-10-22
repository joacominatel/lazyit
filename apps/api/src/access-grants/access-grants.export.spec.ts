import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import request from 'supertest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '@lazyit/shared';
import { AccessGrantsController } from './access-grants.controller';
import { AccessGrantsService } from './access-grants.service';
import { AccessGrantsExportService } from './access-grants-export.service';
import { ApplicationsController } from '../applications/applications.controller';
import { ApplicationsService } from '../applications/applications.service';
import { ArticlesService } from '../articles/articles.service';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { RolesGuard } from '../auth/roles.guard';
import { ActorService } from '../common/actor.service';
import { ExportService } from '../common/export';
import { ExportLimiter } from '../common/export/export-limiter';
import { WorkflowTriggerService } from '../workflow-engine/run/workflow-trigger.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  csvHeader,
  csvRows,
  inMemoryDelegate,
  splitsATie,
} from '../common/in-memory-where.harness-spec';
import { keysetBatches } from '../common/export/keyset';

jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

const ANA = '00000000-0000-4000-8000-000000000001';
const BEN = '00000000-0000-4000-8000-000000000002';
const ADMIN_ID = '00000000-0000-4000-8000-000000000009';
const APP1 = 'capp1aaaaaaaaaaaaaaaaaaaa';
const APP2 = 'capp2aaaaaaaaaaaaaaaaaaaa';
const SA = 'csa1aaaaaaaaaaaaaaaaaaaaa';

const PEOPLE: Record<
  string,
  { firstName: string; lastName: string; email: string }
> = {
  [ANA]: { firstName: 'Ana', lastName: 'Diaz', email: 'ana@lazyit.local' },
  [BEN]: { firstName: 'Ben', lastName: 'Ruiz', email: 'ben@lazyit.local' },
  [ADMIN_ID]: {
    firstName: 'Ada',
    lastName: 'Admin',
    email: 'ada@lazyit.local',
  },
};
const APPS: Record<string, string> = { [APP1]: 'Jira', [APP2]: 'GitHub' };

const NOW = Date.now();
const DAY = 86_400_000;
let seq = 0;
function grant(over: {
  userId: string;
  applicationId: string;
  revokedAt?: Date | null;
  expiresAt?: Date | null;
  grantedById?: string | null;
  grantedBySaId?: string | null;
  revokedById?: string | null;
}) {
  seq += 1;
  const row = {
    id: `cgrant${String(seq).padStart(19, '0')}`,
    accessLevel: seq % 2 ? 'admin' : null,
    grantedAt: new Date(NOW - 30 * DAY),
    revokedAt: null as Date | null,
    expiresAt: null as Date | null,
    grantedById: ADMIN_ID as string | null,
    revokedById: null as string | null,
    grantedBySaId: null as string | null,
    revokedBySaId: null as string | null,
    notes: `note ${seq}`,
    // Pairs share a createdAt; the batch-of-2 walk below splits them across batch boundaries.
    createdAt: new Date(NOW - (20 - Math.floor(seq / 2)) * DAY),
    updatedAt: new Date(NOW),
    ...over,
  };
  const person = (id: string | null) =>
    id
      ? { firstName: PEOPLE[id].firstName, lastName: PEOPLE[id].lastName }
      : null;
  return {
    ...row,
    user: PEOPLE[row.userId],
    application: { name: APPS[row.applicationId] },
    grantedBy: person(row.grantedById),
    revokedBy: person(row.revokedById),
    grantedBySa: row.grantedBySaId ? { name: 'Okta sync' } : null,
    revokedBySa: null,
  };
}

const GRANTS = [
  grant({ userId: ANA, applicationId: APP1 }),
  grant({
    userId: ANA,
    applicationId: APP2,
    revokedAt: new Date(NOW - DAY),
    revokedById: ADMIN_ID,
  }),
  grant({ userId: BEN, applicationId: APP1, expiresAt: new Date(NOW - DAY) }),
  grant({
    userId: BEN,
    applicationId: APP2,
    grantedById: null,
    grantedBySaId: SA,
  }),
  grant({
    userId: BEN,
    applicationId: APP1,
    expiresAt: new Date(NOW + 10 * DAY),
  }),
  grant({
    userId: ANA,
    applicationId: APP1,
    revokedAt: new Date(NOW - 2 * DAY),
  }),
];

let caller = 0;
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string>;
      user?: unknown;
      principal?: unknown;
    }>();
    // A fresh caller per request keeps the per-principal export limiter out of the way.
    caller += 1;
    const sa = req.headers['x-test-sa-permissions'];
    if (sa !== undefined) {
      req.principal = {
        kind: 'service',
        serviceAccount: { id: `sa-${caller}` },
        permissions: new Set(sa.split(',') as Permission[]),
      };
      return true;
    }
    const u = { id: `caller-${caller}`, role: req.headers['x-test-role'] };
    req.user = u;
    req.principal = { kind: 'human', user: u };
    return true;
  }
}

describe('Access-grant CSV exports (ADR-0103)', () => {
  let app: INestApplication;
  const auditCreate = jest.fn().mockResolvedValue({});
  const prisma = {
    accessGrant: inMemoryDelegate(GRANTS),
    rolePermission: {
      findMany: jest.fn(({ where }: { where: { role: Role } }) =>
        Promise.resolve(
          DEFAULT_ROLE_PERMISSIONS[where.role].map((permission) => ({
            permission,
          })),
        ),
      ),
    },
    dataExportLog: { create: auditCreate },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const applications = {
    findOne: jest.fn((id: string) =>
      APPS[id]
        ? Promise.resolve({ id })
        : Promise.reject(new NotFoundException()),
    ),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AccessGrantsController, ApplicationsController],
      providers: [
        Reflector,
        AccessGrantsService,
        AccessGrantsExportService,
        ExportService,
        ExportLimiter,
        ActorService,
        PermissionResolverService,
        { provide: PrismaService, useValue: prisma },
        { provide: WorkflowTriggerService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        { provide: ApplicationsService, useValue: applications },
        { provide: ArticlesService, useValue: {} },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => auditCreate.mockClear());

  const get = (path: string, role: Role) =>
    request(app.getHttpServer()).get(path).set('X-Test-Role', role);

  const exportedIds = (text: string) =>
    csvRows(text).map((cells) => cells[cells.length - 1]);

  const FULL_HEADER =
    'Application,User,User email,Access level,Status,Granted at,Granted by,Expires at,' +
    'Revoked at,Revoked by,Notes,Grant ID';

  it('pins the header for a caller who can read users and applications', async () => {
    const res = await get('/access-grants/export', 'MEMBER');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csvHeader(res.text)).toBe(FULL_HEADER);
  });

  it.each([
    ['ADMIN', ''],
    ['ADMIN', 'activeOnly=false'],
    ['ADMIN', 'includeExpired=false'],
    ['ADMIN', `userId=${BEN}&activeOnly=false`],
    ['ADMIN', `applicationId=${APP1}`],
    ['MEMBER', `applicationId=${APP2}&activeOnly=false&includeExpired=false`],
  ] as const)(
    'GET /access-grants/export as %s with "%s" holds exactly the ids the list returns',
    async (role, query) => {
      const list = await get(`/access-grants?limit=200&${query}`, role);
      expect(list.status).toBe(200);
      const listed = (list.body as { items: { id: string }[] }).items.map(
        (g) => g.id,
      );
      expect(listed.length).toBeGreaterThan(0);
      const res = await get(`/access-grants/export?${query}`, role);
      expect(res.status).toBe(200);
      const exported = exportedIds(res.text);
      expect(new Set(exported)).toEqual(new Set(listed));
      expect(exported).toHaveLength(listed.length);
    },
  );

  it.each([
    [''],
    ['activeOnly=false'],
    ['activeOnly=false&includeExpired=false'],
  ])(
    'GET /applications/:id/access-grants/export with "%s" holds that application only, the ids its list returns',
    async (query) => {
      const list = await get(
        `/applications/${APP1}/access-grants?${query}`,
        'ADMIN',
      );
      expect(list.status).toBe(200);
      const listed = (list.body as { id: string }[]).map((g) => g.id);
      expect(listed.length).toBeGreaterThan(0);
      const res = await get(
        `/applications/${APP1}/access-grants/export?${query}`,
        'ADMIN',
      );
      expect(res.status).toBe(200);
      const exported = exportedIds(res.text);
      expect(new Set(exported)).toEqual(new Set(listed));
      expect(csvRows(res.text).every((cells) => cells[0] === 'Jira')).toBe(
        true,
      );
      const app2Ids = GRANTS.filter((g) => g.applicationId === APP2).map(
        (g) => g.id,
      );
      expect(exported.some((id) => app2Ids.includes(id))).toBe(false);
    },
  );

  // #1660: the paged per-application list filters server-side, and its export follows the same filters.
  const [ANA_ACTIVE, , BEN_EXPIRED, , BEN_EXPIRING, ANA_REVOKED] = GRANTS.map(
    (g) => g.id,
  );

  it.each([
    ['', [ANA_ACTIVE, BEN_EXPIRED, BEN_EXPIRING]],
    ['status=active', [ANA_ACTIVE, BEN_EXPIRED, BEN_EXPIRING]],
    // Soonest expiry first; an already-expired, not yet swept grant is the most urgent.
    ['status=expiring', [BEN_EXPIRED, BEN_EXPIRING]],
    ['status=revoked', [ANA_REVOKED]],
    ['status=all&accessLevel=admin', [ANA_ACTIVE, BEN_EXPIRED, BEN_EXPIRING]],
    ['status=all&noAccessLevel=true', [ANA_REVOKED]],
    ['status=all&q=ben', [BEN_EXPIRED, BEN_EXPIRING]],
    // Token-wise across columns; by person, active before revoked.
    ['status=all&q=ana%20DIAZ', [ANA_ACTIVE, ANA_REVOKED]],
    ['status=expiring&q=ana', []],
  ] as const)(
    "GET /applications/:id/access-grants/page?%s returns that application's matching grants, and the export holds the same",
    async (query, expected) => {
      const list = await get(
        `/applications/${APP1}/access-grants/page?limit=200&${query}`,
        'ADMIN',
      );
      expect(list.status).toBe(200);
      const body = list.body as { items: { id: string }[]; total: number };
      expect(body.items.map((g) => g.id)).toEqual(expected);
      expect(body.total).toBe(expected.length);

      const res = await get(
        `/applications/${APP1}/access-grants/export?${query}`,
        'ADMIN',
      );
      expect(res.status).toBe(200);
      expect(new Set(exportedIds(res.text))).toEqual(new Set(expected));
      expect(exportedIds(res.text)).toHaveLength(expected.length);
    },
  );

  it('pages the per-application list with a stable total', async () => {
    const first = await get(
      `/applications/${APP1}/access-grants/page?status=all&limit=2`,
      'ADMIN',
    );
    const second = await get(
      `/applications/${APP1}/access-grants/page?status=all&limit=2&offset=2`,
      'ADMIN',
    );
    const ids = [
      ...(first.body as { items: { id: string }[] }).items,
      ...(second.body as { items: { id: string }[] }).items,
    ].map((g) => g.id);
    expect((first.body as { total: number }).total).toBe(4);
    expect(new Set(ids).size).toBe(4);
  });

  it.each([
    ['status=expired'],
    ['accessLevel=admin&noAccessLevel=true'],
    ['accessLevel=%20'],
    [`q=${'x'.repeat(201)}`],
    ['sort=grantedAt'],
    ['limit=201'],
  ])('the per-application page rejects "%s" with 400', async (query) => {
    const res = await get(
      `/applications/${APP1}/access-grants/page?${query}`,
      'ADMIN',
    );
    expect(res.status).toBe(400);
  });

  it('the per-application export refuses mixing status with activeOnly/includeExpired (400), auditing nothing', async () => {
    for (const query of [
      'status=active&activeOnly=false',
      'status=all&includeExpired=false',
    ]) {
      const res = await get(
        `/applications/${APP1}/access-grants/export?${query}`,
        'ADMIN',
      );
      expect(res.status).toBe(400);
    }
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('a person search needs user:read on top of accessGrant:read (403 on the page and the export)', async () => {
    const asGrantReader = (path: string) =>
      request(app.getHttpServer())
        .get(path)
        .set('X-Test-Sa-Permissions', 'accessGrant:read');
    expect(
      (await asGrantReader(`/applications/${APP1}/access-grants/page?q=ana`))
        .status,
    ).toBe(403);
    expect(
      (await asGrantReader(`/applications/${APP1}/access-grants/export?q=ana`))
        .status,
    ).toBe(403);
    expect(auditCreate).not.toHaveBeenCalled();
    // Without a search the same caller still pages and filters.
    const page = await asGrantReader(
      `/applications/${APP1}/access-grants/page?status=revoked`,
    );
    expect(page.status).toBe(200);
    expect(
      (page.body as { items: { id: string }[] }).items.map((g) => g.id),
    ).toEqual([ANA_REVOKED]);
  });

  it('the per-application page 404s on an unknown application and refuses a VIEWER', async () => {
    expect(
      (
        await get(
          '/applications/cmissingaaaaaaaaaaaaaaaaa/access-grants/page',
          'ADMIN',
        )
      ).status,
    ).toBe(404);
    expect(
      (await get(`/applications/${APP1}/access-grants/page`, 'VIEWER')).status,
    ).toBe(403);
    expect(
      (await get(`/applications/${APP1}/access-grants/summary`, 'VIEWER'))
        .status,
    ).toBe(403);
  });

  it('audits a filtered per-application export with its filters', async () => {
    await get(
      `/applications/${APP1}/access-grants/export?status=expiring&accessLevel=admin&q=ben`,
      'ADMIN',
    );
    // With `status`, the defaulted activeOnly/includeExpired are NOT recorded (ADR-0103 §10).
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        resource: 'ACCESS_GRANTS',
        filters: {
          applicationId: APP1,
          status: 'expiring',
          accessLevel: 'admin',
          q: 'ben',
        },
      }) as unknown,
    });
  });

  it('audits a no-level export as noAccessLevel: true, not as "any level"', async () => {
    await get(
      `/applications/${APP1}/access-grants/export?status=all&noAccessLevel=true`,
      'ADMIN',
    );
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        resource: 'ACCESS_GRANTS',
        filters: { applicationId: APP1, status: 'all', noAccessLevel: true },
      }) as unknown,
    });
  });

  it('audits a no-level export on the legacy filters with activeOnly/includeExpired', async () => {
    await get(
      `/applications/${APP1}/access-grants/export?activeOnly=false&noAccessLevel=true`,
      'ADMIN',
    );
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        filters: {
          applicationId: APP1,
          activeOnly: false,
          includeExpired: true,
          noAccessLevel: true,
        },
      }) as unknown,
    });
  });

  it('the per-application export 404s on an unknown application and audits nothing', async () => {
    const res = await get(
      '/applications/cmissingaaaaaaaaaaaaaaaaa/access-grants/export',
      'ADMIN',
    );
    expect(res.status).toBe(404);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a VIEWER on both routes (accessGrant:read is VIEWER-denied by default)', async () => {
    expect((await get('/access-grants/export', 'VIEWER')).status).toBe(403);
    expect(
      (await get(`/applications/${APP1}/access-grants/export`, 'VIEWER'))
        .status,
    ).toBe(403);
    expect((await get('/access-grants', 'VIEWER')).status).toBe(403);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('renders names, actors and status readably for an admin', async () => {
    const res = await get('/access-grants/export?activeOnly=false', 'ADMIN');
    const byId = new Map(csvRows(res.text).map((cells) => [cells[11], cells]));
    const [active, revoked, expired, viaSa] = GRANTS.map((g) =>
      byId.get(g.id)!,
    );
    expect(active.slice(0, 5)).toEqual([
      'Jira',
      'Ana Diaz',
      'ana@lazyit.local',
      'admin',
      'active',
    ]);
    expect(active[6]).toBe('Ada Admin');
    expect(revoked[4]).toBe('revoked');
    expect(revoked[9]).toBe('Ada Admin');
    expect(expired[4]).toBe('expired');
    expect(viaSa[6]).toBe('Okta sync (service account)');
  });

  it('keeps the service-account name from a caller without settings:manage', async () => {
    const res = await get('/access-grants/export', 'MEMBER');
    const viaSa = csvRows(res.text).find(
      (cells) => cells[11] === GRANTS[3].id,
    )!;
    expect(viaSa[6]).toBe(`${SA} (service account)`);
  });

  it('a caller with accessGrant:read alone gets ids, not names, and no email column', async () => {
    const res = await request(app.getHttpServer())
      .get('/access-grants/export')
      .set('X-Test-Sa-Permissions', 'accessGrant:read');
    expect(res.status).toBe(200);
    expect(csvHeader(res.text)).toBe(FULL_HEADER.replace(',User email', ''));
    expect(res.text).not.toContain('@lazyit.local');
    expect(res.text).not.toContain('Ana Diaz');
    const first = csvRows(res.text).find(
      (cells) => cells[10] === GRANTS[0].id,
    )!;
    expect(first.slice(0, 2)).toEqual([APP1, ANA]);
    expect(first[5]).toBe(ADMIN_ID);
  });

  it.each([
    [{ activeOnly: false }, GRANTS.map((g) => g.id), true],
    [
      { applicationId: APP1, activeOnly: false },
      GRANTS.filter((g) => g.applicationId === APP1).map((g) => g.id),
      false,
    ],
  ] as const)(
    'exportSource(%o) walked in batches of 2 sends every matching grant once',
    async (filters, expected, splitsTie) => {
      const source = app.get(AccessGrantsService).exportSource(filters);
      const batches: { id: string; createdAt: Date }[][] = [];
      for await (const batch of keysetBatches(source.fetchBatch, 2)) {
        batches.push(batch);
      }
      const sent = batches.flat().map((g) => g.id);
      expect(sent).toHaveLength(new Set(sent).size);
      expect(new Set(sent)).toEqual(new Set(expected));
      expect(await source.count()).toBe(expected.length);
      expect(batches.length).toBeGreaterThan(1);
      expect(splitsATie(batches)).toBe(splitsTie);
    },
  );

  it('audits each export as ACCESS_GRANTS with its filters', async () => {
    await get(
      `/applications/${APP1}/access-grants/export?activeOnly=false`,
      'ADMIN',
    );
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        resource: 'ACCESS_GRANTS',
        filters: {
          applicationId: APP1,
          activeOnly: false,
          includeExpired: true,
        },
      }) as unknown,
    });
  });
});
