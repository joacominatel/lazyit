import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { getLoggerToken } from 'nestjs-pino';
import request from 'supertest';
import { DEFAULT_ROLE_PERMISSIONS, type Role } from '@lazyit/shared';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { UserHistoryService } from '../user-history/user-history.service';
import { WorkflowTriggerService } from '../workflow-engine/run/workflow-trigger.service';
import { AccessGrantsService } from '../access-grants/access-grants.service';
import { LocalProvisioningService } from '../auth/local/local-provisioning.service';
import { PasswordLifecycleService } from '../auth/local/password-lifecycle.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { RolesGuard } from '../auth/roles.guard';
import { ActorService } from '../common/actor.service';
import { ExportService } from '../common/export';
import { ExportLimiter } from '../common/export/export-limiter';
import { VaultSetupNudgeService } from '../notifications/vault-setup-nudge.service';
import {
  csvHeader,
  csvRows,
  inMemoryDelegate,
} from '../common/in-memory-where.harness-spec';

jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

const SECRET_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA';
const SECRET_SUB = 'idp-sub-should-never-leave';

let seq = 0;
function user(over: Record<string, unknown>) {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  return {
    id,
    email: `user${seq}@lazyit.local`,
    firstName: `First${seq}`,
    lastName: `Last${seq}`,
    isActive: true,
    role: 'MEMBER',
    externalId: SECRET_SUB,
    legajo: null,
    username: null,
    managerId: null,
    managerName: null,
    directoryOnly: false,
    directoryAttrs: null,
    directorySource: null,
    directorySourceId: null,
    directoryOffboardedAt: null,
    directoryReenabledAt: null,
    passwordHash: SECRET_HASH,
    passwordUpdatedAt: null,
    sessionEpoch: 4,
    mcpCredentialEpoch: 2,
    mustChangePassword: true,
    notificationEmailOptOutTypes: [],
    locale: null,
    theme: null,
    // Two rows share a timestamp so the keyset tie-break is exercised.
    createdAt: new Date(Date.UTC(2026, 0, 1 + Math.floor(seq / 2))),
    updatedAt: new Date(Date.UTC(2026, 0, 1)),
    deletedAt: null,
    ...over,
  };
}

const USERS = [
  user({ firstName: 'Ana', lastName: 'Admin', role: 'ADMIN' }),
  user({ firstName: 'Bruno', role: 'VIEWER', isActive: false }),
  user({ firstName: 'Carla', directoryOnly: true, role: 'VIEWER' }),
  user({
    firstName: 'Ana',
    lastName: 'Gone',
    deletedAt: new Date(Date.UTC(2026, 5, 1)),
  }),
  user({ firstName: 'Dario', managerName: 'Outside Boss', legajo: 'E-17' }),
  user({ firstName: 'Eva', role: 'ADMIN', isActive: false }),
  user({ firstName: 'Fede', directorySource: 'ad', username: 'fede' }),
  user({
    firstName: 'Gina',
    deletedAt: new Date(Date.UTC(2026, 6, 1)),
    role: 'VIEWER',
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
    const role = req.headers['x-test-role'];
    // A fresh caller per request keeps the per-principal export limiter out of the way.
    caller += 1;
    const u = { id: `caller-${caller}`, role };
    req.user = u;
    req.principal = { kind: 'human', user: u };
    return true;
  }
}

describe('GET /users/export (ADR-0103)', () => {
  let app: INestApplication;
  const auditCreate = jest.fn().mockResolvedValue({});
  const prisma = {
    user: inMemoryDelegate(USERS, { softDelete: true }),
    assetAssignment: { groupBy: jest.fn().mockResolvedValue([]) },
    accessGrant: { groupBy: jest.fn().mockResolvedValue([]) },
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
      controllers: [UsersController],
      providers: [
        Reflector,
        UsersService,
        ExportService,
        ExportLimiter,
        ActorService,
        PermissionResolverService,
        { provide: PrismaService, useValue: prisma },
        { provide: SearchService, useValue: {} },
        { provide: AssetAssignmentsService, useValue: {} },
        { provide: AssetHistoryService, useValue: {} },
        { provide: UserHistoryService, useValue: {} },
        { provide: WorkflowTriggerService, useValue: {} },
        { provide: AccessGrantsService, useValue: {} },
        { provide: LocalProvisioningService, useValue: {} },
        { provide: PasswordLifecycleService, useValue: {} },
        { provide: getLoggerToken(UsersService.name), useValue: {} },
        { provide: VaultSetupNudgeService, useValue: {} },
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

  async function listIds(role: Role, query: string): Promise<string[]> {
    const res = await request(app.getHttpServer())
      .get(`/users?limit=200&${query}`)
      .set('X-Test-Role', role);
    expect(res.status).toBe(200);
    return (res.body as { items: { id: string }[] }).items.map((u) => u.id);
  }

  async function exportCsv(role: Role, query: string) {
    return request(app.getHttpServer())
      .get(`/users/export?${query}`)
      .set('X-Test-Role', role);
  }

  it('pins the header: the list projection only, no credential or IdP column', async () => {
    const res = await exportCsv('ADMIN', '');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csvHeader(res.text)).toBe(
      'ID,First name,Last name,Email,Username,Employee number,Role,Active,Directory person,' +
        'Directory source,Manager,Assets held,Active grants,Created,Archived',
    );
    expect(res.text).not.toContain(SECRET_HASH);
    expect(res.text).not.toContain(SECRET_SUB);
  });

  it.each([
    ['ADMIN', ''],
    ['ADMIN', 'q=ana'],
    ['ADMIN', 'role=VIEWER'],
    ['ADMIN', 'isActive=false'],
    ['ADMIN', 'directoryOnly=true'],
    ['ADMIN', 'deleted=only'],
    ['ADMIN', 'deleted=only&role=VIEWER'],
    ['MEMBER', ''],
    ['MEMBER', 'role=ADMIN&isActive=true'],
  ] as const)(
    '%s with "%s": the export holds exactly the ids the list returns',
    async (role, query) => {
      const listed = await listIds(role, query);
      const res = await exportCsv(role, query);
      expect(res.status).toBe(200);
      const exported = csvRows(res.text).map((cells) => cells[0]);
      expect(new Set(exported)).toEqual(new Set(listed));
      expect(exported).toHaveLength(listed.length);
    },
  );

  it('the default slice leaves archived users out, deleted=only holds only them', async () => {
    const live = csvRows((await exportCsv('ADMIN', '')).text).map((c) => c[0]);
    const archived = csvRows((await exportCsv('ADMIN', 'deleted=only')).text);
    expect(live).not.toContain(USERS[3].id);
    expect(archived.map((c) => c[0]).sort()).toEqual(
      [USERS[3].id, USERS[7].id].sort(),
    );
    expect(archived.every((c) => c[14] !== '')).toBe(true);
  });

  it('refuses deleted=only to a non-admin, like the list, and writes no audit row', async () => {
    const res = await exportCsv('MEMBER', 'deleted=only');
    expect(res.status).toBe(403);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a VIEWER (no user:read), like the list', async () => {
    expect((await exportCsv('VIEWER', '')).status).toBe(403);
    expect(
      (
        await request(app.getHttpServer())
          .get('/users')
          .set('X-Test-Role', 'VIEWER')
      ).status,
    ).toBe(403);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('rejects a bad filter with 400, like the list', async () => {
    expect((await exportCsv('ADMIN', 'role=ROOT')).status).toBe(400);
    expect((await exportCsv('ADMIN', 'isActive=maybe')).status).toBe(400);
  });

  it('audits the export as USERS with its filters and the pre-count', async () => {
    await exportCsv('ADMIN', 'role=VIEWER&isActive=false');
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        resource: 'USERS',
        filters: { role: 'VIEWER', isActive: false, deleted: 'active' },
        rowCount: 1,
      }) as unknown,
    });
  });

  it('renders the manager, the counts and the booleans readably', async () => {
    const rows = csvRows((await exportCsv('ADMIN', 'q=dario')).text);
    expect(rows).toHaveLength(1);
    const [cells] = rows;
    expect(cells[5]).toBe('E-17');
    expect(cells[7]).toBe('true');
    expect(cells[8]).toBe('false');
    expect(cells[10]).toBe('Outside Boss');
    expect(cells[11]).toBe('0');
    expect(cells[12]).toBe('0');
  });
});
