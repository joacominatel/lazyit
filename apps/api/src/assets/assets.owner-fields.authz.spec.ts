import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import request from 'supertest';
import { DEFAULT_ROLE_PERMISSIONS, type Role } from '@lazyit/shared';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { AssetAssignmentsController } from '../asset-assignments/asset-assignments.controller';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { ArticlesService } from '../articles/articles.service';
import { ExportService } from '../common/export';
import { ActorService } from '../common/actor.service';
import { SearchService } from '../search/search.service';
import { AssetTagSchemeService } from '../asset-tag-scheme/asset-tag-scheme.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { PrismaService } from '../prisma/prisma.service';

// No DB: the generated client is stubbed, and the ESM `meilisearch` (pulled in by SearchService) too.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

/**
 * #1685 end to end, through the REAL controllers, AssetsService, AssetAssignmentsService, RolesGuard and
 * PermissionResolverService (the role matrix is the seeded default). Prisma is a fake that honours the
 * `select` it is handed, so what reaches the wire is exactly what the services chose to read:
 *   - a VIEWER (asset:read, no user:read) gets each owner as id, name, email and deletedAt only — on the
 *     asset detail and on the assignment read — and 403 on both by-person filters (and the export's);
 *   - a MEMBER and an ADMIN (both hold user:read) get the owner's full public columns, and may filter.
 */

const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const ASSET_ID = 'ckg9z1a2b0000qzrmn831k4d8';

/** Every public column of the owner, as the database holds them. */
const OWNER_ROW: Record<string, unknown> = {
  id: OWNER_ID,
  email: 'ana@corp.io',
  firstName: 'Ana',
  lastName: 'Ops',
  isActive: true,
  role: 'MEMBER',
  externalId: 'idp-sub-ana',
  legajo: 'E-1001',
  username: 'ana.ops',
  directoryOnly: false,
  directoryAttrs: { department: 'IT', phone: '555-0101' },
  directorySource: null,
  locale: 'en',
  theme: 'dark',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  deletedAt: null,
  passwordHash: 'never-on-the-wire',
};

const DIRECTORY_FIELDS = [
  'role',
  'legajo',
  'username',
  'directoryAttrs',
  'externalId',
  'isActive',
  'directoryOnly',
];

/** Apply a Prisma `select` the way the database would: only the selected columns come back. */
function project(
  row: Record<string, unknown>,
  select: Record<string, unknown>,
) {
  return Object.fromEntries(
    Object.keys(select)
      .filter((key) => select[key] === true)
      .map((key) => [key, row[key]]),
  );
}

const ASSIGNMENT_ROW = {
  id: 'ckg9z1a2b0001qzrmn831k4d8',
  assetId: ASSET_ID,
  userId: OWNER_ID,
  assignedAt: new Date('2026-02-01T00:00:00.000Z'),
  releasedAt: null,
  assignedById: null,
  releasedById: null,
  notes: null,
  createdAt: new Date('2026-02-01T00:00:00.000Z'),
  updatedAt: new Date('2026-02-01T00:00:00.000Z'),
};

type UserInclude = { user: { select: Record<string, unknown> } };

const prisma = {
  rolePermission: {
    findMany: jest.fn(({ where }: { where: { role: Role } }) =>
      Promise.resolve(
        DEFAULT_ROLE_PERMISSIONS[where.role].map((permission) => ({
          permission,
        })),
      ),
    ),
  },
  asset: {
    findFirst: jest.fn(
      (args: {
        select?: unknown;
        include?: { assignments: { include: UserInclude } };
      }) => {
        if (!args.include) return Promise.resolve({ id: ASSET_ID });
        const userSelect = args.include.assignments.include.user.select;
        return Promise.resolve({
          id: ASSET_ID,
          name: 'LT-1',
          purchaseCost: null,
          salvageValue: null,
          usefulLifeMonths: null,
          purchaseDate: null,
          model: null,
          location: null,
          statusLabel: null,
          assignments: [
            { ...ASSIGNMENT_ROW, user: project(OWNER_ROW, userSelect) },
          ],
        });
      },
    ),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  },
  assetAssignment: {
    findMany: jest.fn((args: { include?: UserInclude }) =>
      Promise.resolve([
        args.include
          ? {
              ...ASSIGNMENT_ROW,
              user: project(OWNER_ROW, args.include.user.select),
            }
          : { ...ASSIGNMENT_ROW },
      ]),
    ),
  },
  $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
};

// Stand-in for JwtAuthGuard: `X-Test-Role` → a human of that role.
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string>;
      user?: unknown;
      principal?: unknown;
    }>();
    const role = req.headers['x-test-role'];
    if (role) {
      const user = { id: `${role.toLowerCase()}-1`, role };
      req.user = user;
      req.principal = { kind: 'human', user };
    }
    return true;
  }
}

describe('asset owner fields and by-person filters need user:read (#1685)', () => {
  let app: INestApplication;
  const exportCsv = jest.fn();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AssetsController, AssetAssignmentsController],
      providers: [
        Reflector,
        AssetsService,
        AssetAssignmentsService,
        PermissionResolverService,
        { provide: PrismaService, useValue: prisma },
        { provide: ActorService, useValue: new ActorService() },
        { provide: AssetHistoryService, useValue: {} },
        { provide: SearchService, useValue: {} },
        { provide: AssetTagSchemeService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        { provide: ArticlesService, useValue: {} },
        { provide: ExportService, useValue: { exportCsv } },
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

  beforeEach(() => {
    exportCsv.mockReset();
    exportCsv.mockResolvedValue(undefined);
    prisma.asset.findMany.mockClear();
    prisma.assetAssignment.findMany.mockClear();
  });

  const server = () => app.getHttpServer() as Parameters<typeof request>[0];

  describe('VIEWER (asset:read, no user:read)', () => {
    it('GET /assets/:id — each owner is id, name, email and deletedAt only', async () => {
      const res = await request(server())
        .get(`/assets/${ASSET_ID}`)
        .set('X-Test-Role', 'VIEWER');

      expect(res.status).toBe(200);
      const body = res.body as {
        activeAssignments: { user: Record<string, unknown> }[];
      };
      expect(body.activeAssignments[0].user).toEqual({
        id: OWNER_ID,
        email: 'ana@corp.io',
        firstName: 'Ana',
        lastName: 'Ops',
        deletedAt: null,
      });
      for (const field of DIRECTORY_FIELDS) {
        expect(JSON.stringify(res.body)).not.toContain(`"${field}"`);
      }
    });

    it('GET /assets/:id/assignments — the same trimmed owner', async () => {
      const res = await request(server())
        .get(`/assets/${ASSET_ID}/assignments?activeOnly=false`)
        .set('X-Test-Role', 'VIEWER');

      expect(res.status).toBe(200);
      const body = res.body as { user: Record<string, unknown> }[];
      expect(Object.keys(body[0].user).sort()).toEqual(
        ['deletedAt', 'email', 'firstName', 'id', 'lastName'].sort(),
      );
      expect(body[0].user).not.toHaveProperty('legajo');
      expect(body[0].user).not.toHaveProperty('directoryAttrs');
    });

    it('GET /assets?assignedToUserId= → 403, and the list is never queried', async () => {
      const res = await request(server())
        .get(`/assets?assignedToUserId=${OWNER_ID}`)
        .set('X-Test-Role', 'VIEWER');

      expect(res.status).toBe(403);
      expect(prisma.asset.findMany).not.toHaveBeenCalled();
    });

    it('GET /assets/export?assignedToUserId= → 403, and nothing is exported', async () => {
      const res = await request(server())
        .get(`/assets/export?assignedToUserId=${OWNER_ID}`)
        .set('X-Test-Role', 'VIEWER');

      expect(res.status).toBe(403);
      expect(exportCsv).not.toHaveBeenCalled();
    });

    it('GET /asset-assignments?userId= → 403, and no assignment is read', async () => {
      const res = await request(server())
        .get(`/asset-assignments?userId=${OWNER_ID}`)
        .set('X-Test-Role', 'VIEWER');

      expect(res.status).toBe(403);
      expect(prisma.assetAssignment.findMany).not.toHaveBeenCalled();
    });

    it('a malformed userId is still a 400, before the permission check', async () => {
      const res = await request(server())
        .get('/asset-assignments?userId=not-a-uuid')
        .set('X-Test-Role', 'VIEWER');

      expect(res.status).toBe(400);
    });

    it('GET /asset-assignments?assetId= (no person filter) still works with asset:read', async () => {
      const res = await request(server())
        .get(`/asset-assignments?assetId=${ASSET_ID}`)
        .set('X-Test-Role', 'VIEWER');

      expect(res.status).toBe(200);
    });

    it('GET /assets without a person filter still works', async () => {
      const res = await request(server())
        .get('/assets')
        .set('X-Test-Role', 'VIEWER');

      expect(res.status).toBe(200);
    });
  });

  describe.each(['MEMBER', 'ADMIN'] as const)(
    '%s (holds user:read)',
    (role) => {
      it('GET /assets/:id — the owner keeps its full public columns', async () => {
        const res = await request(server())
          .get(`/assets/${ASSET_ID}`)
          .set('X-Test-Role', role);

        expect(res.status).toBe(200);
        const user = (
          res.body as { activeAssignments: { user: Record<string, unknown> }[] }
        ).activeAssignments[0].user;
        expect(user).toMatchObject({
          id: OWNER_ID,
          email: 'ana@corp.io',
          role: 'MEMBER',
          legajo: 'E-1001',
          username: 'ana.ops',
          directoryAttrs: { department: 'IT', phone: '555-0101' },
        });
        expect(user).not.toHaveProperty('passwordHash');
      });

      it('GET /assets/:id/assignments — the full owner', async () => {
        const res = await request(server())
          .get(`/assets/${ASSET_ID}/assignments`)
          .set('X-Test-Role', role);

        expect(res.status).toBe(200);
        expect((res.body as { user: unknown }[])[0].user).toMatchObject({
          legajo: 'E-1001',
          role: 'MEMBER',
        });
      });

      it('may filter by person on the list, the export and the assignments', async () => {
        const list = await request(server())
          .get(`/assets?assignedToUserId=${OWNER_ID}`)
          .set('X-Test-Role', role);
        expect(list.status).toBe(200);

        const csv = await request(server())
          .get(`/assets/export?assignedToUserId=${OWNER_ID}`)
          .set('X-Test-Role', role);
        expect(csv.status).toBe(200);
        expect(exportCsv).toHaveBeenCalledTimes(1);

        const assignments = await request(server())
          .get(`/asset-assignments?userId=${OWNER_ID}`)
          .set('X-Test-Role', role);
        expect(assignments.status).toBe(200);
      });
    },
  );
});
