import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import request from 'supertest';
import { AccessGrantsController } from './access-grants.controller';
import { AccessGrantsService } from './access-grants.service';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionResolverService } from '../auth/permission-resolver.service';

// Mock the generated Prisma client so importing the service token never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
// The service transitively imports the ESM `meilisearch` package; jest can't transform it. The
// service is replaced by a mock below, so this stub just stops the real module from loading.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

/**
 * RBAC gating (ADR-0040, still enforced under the ADR-0046 P2 dual-mode guard) — proves the RolesGuard
 * enforces `@Roles('ADMIN')` on an AccessGrant WRITE end-to-end through the HTTP pipeline: a MEMBER is
 * rejected with 403 and never reaches the service, while an ADMIN succeeds. This is the `@Roles` half
 * of the dual-mode guard — the write sites were NOT migrated to `@RequirePermission` (that is P4), so
 * the permission resolver is never consulted on this path (a stub provider satisfies DI only). A
 * stand-in auth guard sets `request.user.role` from an `X-Test-Role` header (the real JwtAuthGuard's
 * job in production); the RolesGuard runs after it.
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

describe('AccessGrants RBAC gating (ADR-0040)', () => {
  let app: INestApplication;
  const create = jest.fn();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AccessGrantsController],
      providers: [
        Reflector,
        { provide: AccessGrantsService, useValue: { create } },
        // The dual-mode RolesGuard injects the permission resolver; the @Roles path under test never
        // calls it, so a never-invoked stub satisfies DI without a DB.
        { provide: PermissionResolverService, useValue: { hasAll: jest.fn() } },
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

  it('rejects a MEMBER opening a grant with 403 and never reaches the service', async () => {
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
