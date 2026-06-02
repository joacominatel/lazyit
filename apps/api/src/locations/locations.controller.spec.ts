import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';

jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
// LocationsController pulls LocationsService, which transitively imports the ESM `meilisearch`
// package (via SearchService). The service is mocked below; this stub stops the real load.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

// Stand-in for JwtAuthGuard: populate request.user from a test header, mimicking what the real auth
// guard does in production. The RolesGuard reads request.user.role; the controller's in-route gate
// (assertCanListDeleted) reads the same @CurrentUser. Mirrors users.controller.spec.
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();
    const role = req.headers['x-test-role'];
    req.user = role ? { id: 'me-1', role } : undefined;
    return true;
  }
}

/**
 * GET /locations?deleted=only is the archived slice — ADMIN-gated at the controller (ADR-0041), since
 * the list route has no @Roles (any authenticated user may list ACTIVE rows). These tests pin that
 * gate: the default/active slice is open; only is ADMIN-only (403 for MEMBER/VIEWER/anonymous).
 */
describe('LocationsController — deleted=only ADMIN gate (ADR-0041)', () => {
  let app: INestApplication;
  const findPage = jest.fn();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [LocationsController],
      providers: [
        { provide: LocationsService, useValue: { findPage } },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
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
    findPage.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
  });

  // The `page` (2nd) arg of the first findPage call — the parsed window the controller forwards.
  const firstPageArg = () =>
    (findPage.mock.calls as Array<[unknown, { deleted: string }]>)[0][1];

  it('lists the active slice for any authenticated role (no deleted param)', async () => {
    for (const role of ['ADMIN', 'MEMBER', 'VIEWER']) {
      const res = await request(app.getHttpServer())
        .get('/locations')
        .set('x-test-role', role);
      expect(res.status).toBe(200);
    }
    expect(findPage).toHaveBeenCalledTimes(3);
    // The service receives the default `active` slice.
    expect(firstPageArg().deleted).toBe('active');
  });

  it('allows an ADMIN to list deleted=only and forwards the slice to the service', async () => {
    const res = await request(app.getHttpServer())
      .get('/locations?deleted=only')
      .set('x-test-role', 'ADMIN');
    expect(res.status).toBe(200);
    expect(findPage).toHaveBeenCalledTimes(1);
    expect(firstPageArg().deleted).toBe('only');
  });

  it('403s a MEMBER asking for deleted=only and never reaches the service', async () => {
    const res = await request(app.getHttpServer())
      .get('/locations?deleted=only')
      .set('x-test-role', 'MEMBER');
    expect(res.status).toBe(403);
    expect(findPage).not.toHaveBeenCalled();
  });

  it('403s a VIEWER asking for deleted=only', async () => {
    const res = await request(app.getHttpServer())
      .get('/locations?deleted=only')
      .set('x-test-role', 'VIEWER');
    expect(res.status).toBe(403);
    expect(findPage).not.toHaveBeenCalled();
  });

  it('403s an anonymous caller asking for deleted=only', async () => {
    const res = await request(app.getHttpServer()).get(
      '/locations?deleted=only',
    );
    expect(res.status).toBe(403);
    expect(findPage).not.toHaveBeenCalled();
  });

  it('400s an invalid deleted value (e.g. all) before the gate', async () => {
    const res = await request(app.getHttpServer())
      .get('/locations?deleted=all')
      .set('x-test-role', 'ADMIN');
    expect(res.status).toBe(400);
    expect(findPage).not.toHaveBeenCalled();
  });
});
