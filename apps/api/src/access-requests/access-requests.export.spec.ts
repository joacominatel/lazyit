import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '@lazyit/shared';
import { AccessRequestsController } from './access-requests.controller';
import { AccessRequestsService } from './access-requests.service';
import { AccessGrantsService } from '../access-grants/access-grants.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { RolesGuard } from '../auth/roles.guard';
import { ActorService } from '../common/actor.service';
import { ExportService } from '../common/export';
import { ExportLimiter } from '../common/export/export-limiter';
import { keysetBatches } from '../common/export/keyset';
import {
  csvHeader,
  csvRows,
  inMemoryDelegate,
  splitsATie,
} from '../common/in-memory-where.harness-spec';

jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

const ANA = '00000000-0000-4000-8000-000000000001';
const BEN = '00000000-0000-4000-8000-000000000002';
const ADA = '00000000-0000-4000-8000-000000000009';
const APP1 = 'capp1aaaaaaaaaaaaaaaaaaaa';
const APP2 = 'capp2aaaaaaaaaaaaaaaaaaaa';

const PEOPLE: Record<
  string,
  { firstName: string; lastName: string; email: string }
> = {
  [ANA]: { firstName: 'Ana', lastName: 'Diaz', email: 'ana@lazyit.local' },
  [BEN]: { firstName: 'Ben', lastName: 'Ruiz', email: 'ben@lazyit.local' },
  [ADA]: { firstName: 'Ada', lastName: 'Admin', email: 'ada@lazyit.local' },
};
const APPS: Record<string, string> = { [APP1]: 'Jira', [APP2]: 'GitHub' };

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
let seq = 0;
function accessRequest(over: {
  requesterId: string;
  applicationId: string;
  status?: 'PENDING' | 'APPROVED' | 'DENIED';
  filedById?: string;
}) {
  seq += 1;
  const status = over.status ?? 'PENDING';
  const decided = status !== 'PENDING';
  const row = {
    id: `creq${String(seq).padStart(21, '0')}`,
    filedById: null as string | null,
    accessLevel: seq % 2 ? 'admin' : null,
    justification: `because ${seq}`,
    decidedById: decided ? ADA : null,
    decidedAt: decided ? new Date(T0 + seq * DAY) : null,
    deniedReason: status === 'DENIED' ? 'not needed' : null,
    grantId:
      status === 'APPROVED' ? `cgrant${String(seq).padStart(19, '0')}` : null,
    // Pairs share a createdAt; the batch-of-2 walk below splits them across batch boundaries.
    createdAt: new Date(T0 - (20 - Math.floor(seq / 2)) * DAY),
    ...over,
    status,
  };
  return {
    ...row,
    requester: PEOPLE[row.requesterId],
    application: { name: APPS[row.applicationId] },
    decidedBy: row.decidedById ? PEOPLE[row.decidedById] : null,
    filedBy: row.filedById ? PEOPLE[row.filedById] : null,
  };
}

const REQUESTS = [
  accessRequest({ requesterId: ANA, applicationId: APP1 }),
  accessRequest({ requesterId: ANA, applicationId: APP2, status: 'APPROVED' }),
  accessRequest({ requesterId: BEN, applicationId: APP1, status: 'DENIED' }),
  accessRequest({ requesterId: BEN, applicationId: APP2, filedById: ADA }),
  accessRequest({ requesterId: BEN, applicationId: APP1, status: 'APPROVED' }),
  accessRequest({ requesterId: ANA, applicationId: APP1, status: 'DENIED' }),
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

describe('GET /access-requests/export (ADR-0103)', () => {
  let app: INestApplication<App>;
  const auditCreate = jest.fn().mockResolvedValue({});
  const prisma = {
    accessRequest: inMemoryDelegate(REQUESTS),
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

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AccessRequestsController],
      providers: [
        Reflector,
        AccessRequestsService,
        ExportService,
        ExportLimiter,
        ActorService,
        PermissionResolverService,
        { provide: PrismaService, useValue: prisma },
        { provide: AccessGrantsService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
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
    'Application,Requester,Requester email,Access level,Justification,Status,Filed by,Requested at,' +
    'Decided by,Decided at,Denial reason,Grant ID,Request ID';

  it('pins the header for a caller who can read users and applications', async () => {
    const res = await get('/access-requests/export', 'MEMBER');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csvHeader(res.text)).toBe(FULL_HEADER);
  });

  it.each([
    ['ADMIN', ''],
    ['ADMIN', 'status=PENDING'],
    ['ADMIN', `applicationId=${APP1}`],
    ['MEMBER', `requesterId=${BEN}`],
    ['MEMBER', `status=DENIED&applicationId=${APP1}&requesterId=${ANA}`],
  ] as const)(
    'as %s with "%s" holds exactly the ids the list returns',
    async (role, query) => {
      const list = await get(`/access-requests?limit=200&${query}`, role);
      expect(list.status).toBe(200);
      const listed = (list.body as { items: { id: string }[] }).items.map(
        (r) => r.id,
      );
      expect(listed.length).toBeGreaterThan(0);
      const res = await get(`/access-requests/export?${query}`, role);
      expect(res.status).toBe(200);
      const exported = exportedIds(res.text);
      expect(new Set(exported)).toEqual(new Set(listed));
      expect(exported).toHaveLength(listed.length);
    },
  );

  it('refuses a VIEWER (accessRequest:read is VIEWER-denied by default) before any read or audit row', async () => {
    expect((await get('/access-requests', 'VIEWER')).status).toBe(403);
    expect((await get('/access-requests/export', 'VIEWER')).status).toBe(403);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('400 on a malformed filter, like the list', async () => {
    expect(
      (await get('/access-requests/export?status=OPEN', 'ADMIN')).status,
    ).toBe(400);
    expect(
      (await get('/access-requests/export?requesterId=nope', 'ADMIN')).status,
    ).toBe(400);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('renders names, the decision and the grant readably', async () => {
    const res = await get('/access-requests/export', 'ADMIN');
    const byId = new Map(csvRows(res.text).map((cells) => [cells[12], cells]));
    const approved = byId.get(REQUESTS[1].id)!;
    expect(approved.slice(0, 3)).toEqual([
      'GitHub',
      'Ana Diaz',
      'ana@lazyit.local',
    ]);
    expect(approved[5]).toBe('APPROVED');
    expect(approved[6]).toBe('');
    expect(approved[8]).toBe('Ada Admin');
    expect(approved[11]).toBe(REQUESTS[1].grantId);
    const denied = byId.get(REQUESTS[2].id)!;
    expect(denied[10]).toBe('not needed');
    const pending = byId.get(REQUESTS[0].id)!;
    expect(pending[8]).toBe('');
    const onBehalf = byId.get(REQUESTS[3].id)!;
    expect(onBehalf[1]).toBe('Ben Ruiz');
    expect(onBehalf[6]).toBe('Ada Admin');
  });

  it('a caller with accessRequest:read alone gets ids, not names, and no email column', async () => {
    const res = await request(app.getHttpServer())
      .get('/access-requests/export')
      .set('X-Test-Sa-Permissions', 'accessRequest:read');
    expect(res.status).toBe(200);
    expect(csvHeader(res.text)).toBe(
      FULL_HEADER.replace(',Requester email', ''),
    );
    expect(res.text).not.toContain('@lazyit.local');
    expect(res.text).not.toContain('Ana Diaz');
    expect(res.text).not.toContain('Jira');
    const approved = csvRows(res.text).find(
      (cells) => cells[11] === REQUESTS[1].id,
    )!;
    expect(approved.slice(0, 2)).toEqual([APP2, ANA]);
    expect(approved[7]).toBe(ADA);
    const onBehalf = csvRows(res.text).find(
      (cells) => cells[11] === REQUESTS[3].id,
    )!;
    expect(onBehalf[5]).toBe(ADA);
  });

  it('a service account without accessRequest:read is refused', async () => {
    const res = await request(app.getHttpServer())
      .get('/access-requests/export')
      .set('X-Test-Sa-Permissions', 'user:read,application:read');
    expect(res.status).toBe(403);
  });

  it('exportSource walked in batches of 2 sends every matching request once', async () => {
    const source = app.get(AccessRequestsService).exportSource({});
    const batches: { id: string; createdAt: Date }[][] = [];
    for await (const batch of keysetBatches(source.fetchBatch, 2)) {
      batches.push(batch);
    }
    const sent = batches.flat().map((r) => r.id);
    expect(sent).toHaveLength(new Set(sent).size);
    expect(new Set(sent)).toEqual(new Set(REQUESTS.map((r) => r.id)));
    expect(await source.count()).toBe(REQUESTS.length);
    expect(splitsATie(batches)).toBe(true);
  });

  it('audits each export as ACCESS_REQUESTS with its filters', async () => {
    await get(`/access-requests/export?status=PENDING`, 'ADMIN');
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        resource: 'ACCESS_REQUESTS',
        filters: { status: 'PENDING' },
        rowCount: 2,
      }) as unknown,
    });
  });
});
