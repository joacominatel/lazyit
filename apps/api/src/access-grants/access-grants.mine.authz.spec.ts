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
import { AccessGrantsController } from './access-grants.controller';
import { AccessGrantsService } from './access-grants.service';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so importing the service token never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
// The service transitively imports the ESM `meilisearch` package; jest can't transform it. The
// service is replaced by a mock below, so this stub just stops the real module from loading.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

/**
 * `GET /access-grants/mine` — the SELF-SCOPE carve-out (issue #947). It answers "what applications can
 * I access?" for ANY authenticated human, WITHOUT `accessGrant:read` (which a VIEWER does NOT hold),
 * scoped to the caller ONLY, and refuses service accounts. Proven end-to-end through the REAL
 * {@link RolesGuard} + {@link PermissionResolverService} (Prisma mocked to the SEEDED rows):
 *   - a VIEWER (no `accessGrant:read`) reads their OWN grants — the unannotated route rides the human
 *     open-by-default (INV-8); the ADMIN-gated `GET /access-grants` would 403 the same VIEWER;
 *   - the service is called with `userId` = the CALLER's id (from the principal, never a query param),
 *     so the response can only be the caller's own grants — never another user's;
 *   - history is included by default (`activeOnly: false`) so active + revoked show in one read;
 *   - a SERVICE principal is 403 (RolesGuard FAIL-CLOSED on an unannotated route, INV-SA-2);
 *   - the STATIC `mine` route wins over `:id`: `/access-grants/mine` hits `findMine` (→ `findPage`),
 *     NOT `findOne('mine')`.
 */

// Stand-in for JwtAuthGuard (see the assets twin): headers pick the principal. `X-Test-Role` → a human
// of that role; `X-Test-Service: true` → a service principal; neither → anonymous.
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string>;
      user?: unknown;
      principal?: unknown;
    }>();
    const role = req.headers['x-test-role'];
    const isService = req.headers['x-test-service'] === 'true';
    if (isService) {
      req.user = undefined;
      req.principal = {
        kind: 'service',
        serviceAccount: { id: 'sa1' },
        permissions: new Set(),
      };
      return true;
    }
    if (role) {
      const user = { id: req.headers['x-test-user-id'] ?? 'viewer-1', role };
      req.user = user;
      req.principal = { kind: 'human', user };
      return true;
    }
    req.user = undefined;
    req.principal = undefined;
    return true;
  }
}

describe('GET /access-grants/mine — self-scope carve-out authZ (#947)', () => {
  let app: INestApplication;
  const findPage = jest.fn();
  const findOne = jest.fn();

  const findMany = jest.fn(({ where }: { where: { role: Role } }) =>
    Promise.resolve(
      DEFAULT_ROLE_PERMISSIONS[where.role].map((permission) => ({
        permission,
      })),
    ),
  );
  const prisma = {
    rolePermission: { findMany },
  } as unknown as PrismaService;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AccessGrantsController],
      providers: [
        Reflector,
        { provide: AccessGrantsService, useValue: { findPage, findOne } },
        { provide: PrismaService, useValue: prisma },
        PermissionResolverService,
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
    findPage.mockReset();
    findOne.mockReset();
  });

  it('lets a VIEWER read their OWN grants (active + history), scoped to their id (no accessGrant:read)', async () => {
    const page = { items: [{ id: 'g1' }], total: 1, limit: 50, offset: 0 };
    findPage.mockResolvedValue(page);

    const res = await request(app.getHttpServer())
      .get('/access-grants/mine')
      .set('X-Test-Role', 'VIEWER')
      .set('X-Test-User-Id', 'viewer-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(page);
    // Pinned to the CALLER's id; history included by default (activeOnly false).
    expect(findPage).toHaveBeenCalledTimes(1);
    expect(findPage).toHaveBeenCalledWith(
      { userId: 'viewer-1', activeOnly: false, includeExpired: true },
      expect.anything(),
    );
    expect(findOne).not.toHaveBeenCalled();
  });

  it('refuses a SERVICE account with 403 and never reaches the service (fail-closed, INV-SA-2)', async () => {
    const res = await request(app.getHttpServer())
      .get('/access-grants/mine')
      .set('X-Test-Service', 'true');

    expect(res.status).toBe(403);
    expect(findPage).not.toHaveBeenCalled();
  });

  it('401s an anonymous caller (no principal)', async () => {
    const res = await request(app.getHttpServer()).get('/access-grants/mine');

    expect(res.status).toBe(401);
    expect(findPage).not.toHaveBeenCalled();
  });
});
