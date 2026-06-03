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
 * Access-grant write authorization (ADR-0046 P4). After the migration, the AccessGrant mutations are
 * gated by `@RequirePermission('accessGrant:grant')` — the ADMIN-only coarse verb — NOT
 * `accessGrant:write` (which MEMBER holds as an intentional orphan slot). This proves the gate
 * end-to-end through the REAL {@link RolesGuard} + {@link PermissionResolverService} (Prisma mocked to
 * return the SEEDED rows): a MEMBER and a VIEWER are 403 and never reach the service, while an ADMIN
 * succeeds. Were the controller wrongly gated on `accessGrant:write`, the MEMBER case would 201 and
 * this test would fail — so it is the regression guard against that exact mistake.
 *
 * A stand-in auth guard sets `request.user.role` from an `X-Test-Role` header (the real JwtAuthGuard's
 * job in production); the RolesGuard runs after it and consults the seeded permission matrix.
 */

// Stand-in for JwtAuthGuard: populate request.user from a test header, mimicking what the real auth
// guard does (sets request.user before RolesGuard runs). Registered as the FIRST APP_GUARD.
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();
    const role = req.headers['x-test-role'];
    req.user = role ? { id: 'u1', role } : undefined;
    return true;
  }
}

describe('AccessGrant write authZ — accessGrant:grant, NOT :write (ADR-0046 P4)', () => {
  let app: INestApplication;
  const create = jest.fn();

  // Prisma mock returns the SEEDED rows for the requested role (the real seed source of truth). The
  // resolver short-circuits ADMIN to the full catalog, so its findMany is only hit for MEMBER/VIEWER.
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
        { provide: AccessGrantsService, useValue: { create } },
        { provide: PrismaService, useValue: prisma },
        PermissionResolverService,
        // Auth first (sets request.user), then authZ (RolesGuard) — same order as AuthModule.
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
    create.mockReset();
  });

  const body = { userId: 'u9', applicationId: 'app1' };

  it('rejects a MEMBER opening a grant with 403 and never reaches the service (proves :grant, not :write)', async () => {
    const res = await request(app.getHttpServer())
      .post('/access-grants')
      .set('X-Test-Role', 'MEMBER')
      .send(body);

    expect(res.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a VIEWER opening a grant with 403', async () => {
    const res = await request(app.getHttpServer())
      .post('/access-grants')
      .set('X-Test-Role', 'VIEWER')
      .send(body);

    expect(res.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it('lets an ADMIN open a grant (reaches the service, 201)', async () => {
    create.mockResolvedValue({ id: 'g1' });

    const res = await request(app.getHttpServer())
      .post('/access-grants')
      .set('X-Test-Role', 'ADMIN')
      .send(body);

    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
