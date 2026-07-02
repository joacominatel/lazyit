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
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { ArticlesService } from '../articles/articles.service';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so importing the service token never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
// The transitively imported SearchService pulls the ESM `meilisearch` package; jest can't transform
// it. Every service is replaced by a mock below, so this stub just stops the real module loading.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

/**
 * `GET /assets/mine` — the SELF-SCOPE carve-out (issue #947). It answers "what assets do I hold?" for
 * ANY authenticated human (no `asset:read`), scoped to the caller ONLY, and refuses service accounts.
 * This proves the contract end-to-end through the REAL {@link RolesGuard} + {@link PermissionResolverService}
 * (Prisma mocked to return the SEEDED rows):
 *   - a VIEWER (who holds NEITHER `accessGrant:read` NOR `user:read`, and never a directory read) reads
 *     their OWN assets — the route is unannotated, so the human open-by-default (INV-8) lets it through;
 *   - the service is called with `assignedToUserId` = the CALLER's id (taken from the principal, never a
 *     query param), so the response can only ever be the caller's own rows — never another user's;
 *   - a SERVICE principal is 403 (RolesGuard FAIL-CLOSED on an unannotated route, INV-SA-2) and never
 *     reaches the service;
 *   - the STATIC `mine` route wins over `:id` (Nest declaration order): `/assets/mine` hits `findMine`
 *     (delegates to `findPage`), NOT `findOne('mine')`.
 */

// Stand-in for JwtAuthGuard: populate request.user + request.principal from test headers (the real
// auth guard's job). `X-Test-Role` → a human of that role; `X-Test-Service: true` → a service
// principal (no user); neither → anonymous. Registered as the FIRST APP_GUARD.
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

describe('GET /assets/mine — self-scope carve-out authZ (#947)', () => {
  let app: INestApplication;
  const findPage = jest.fn();
  const findOne = jest.fn();

  // Prisma mock returns the SEEDED rows for the requested role (the real seed source of truth).
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
      controllers: [AssetsController],
      providers: [
        Reflector,
        { provide: AssetsService, useValue: { findPage, findOne } },
        { provide: AssetAssignmentsService, useValue: {} },
        { provide: AssetHistoryService, useValue: {} },
        { provide: ArticlesService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        PermissionResolverService,
        // Auth first (sets request.user/principal), then authZ (RolesGuard) — same order as AuthModule.
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

  it('lets a VIEWER read their OWN assets, scoped to their id (no asset:read needed)', async () => {
    const page = { items: [{ id: 'a1' }], total: 1, limit: 50, offset: 0 };
    findPage.mockResolvedValue(page);

    const res = await request(app.getHttpServer())
      .get('/assets/mine')
      .set('X-Test-Role', 'VIEWER')
      .set('X-Test-User-Id', 'viewer-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(page);
    // The where-clause is pinned to the CALLER's id — this is what makes it a self-read, not a
    // cross-user enumeration. It can never return another user's assets.
    expect(findPage).toHaveBeenCalledTimes(1);
    expect(findPage).toHaveBeenCalledWith(
      { assignedToUserId: 'viewer-1' },
      expect.anything(),
    );
    // The `mine` static route won over `:id` — the single-asset read was never invoked.
    expect(findOne).not.toHaveBeenCalled();
  });

  it('refuses a SERVICE account with 403 and never reaches the service (fail-closed, INV-SA-2)', async () => {
    const res = await request(app.getHttpServer())
      .get('/assets/mine')
      .set('X-Test-Service', 'true');

    expect(res.status).toBe(403);
    expect(findPage).not.toHaveBeenCalled();
  });

  it('401s an anonymous caller (no principal) rather than listing nothing', async () => {
    const res = await request(app.getHttpServer()).get('/assets/mine');

    expect(res.status).toBe(401);
    expect(findPage).not.toHaveBeenCalled();
  });
});
