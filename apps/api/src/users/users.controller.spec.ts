import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { AccessGrantsService } from '../access-grants/access-grants.service';
import { ActorService } from '../common/actor.service';

jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
// UsersService transitively imports the ESM `meilisearch` package (via SearchService); jest can't
// transform it. The service is mocked below, so this stub just stops the real module from loading.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

/**
 * SEC-004 — `User.id` is a uuid PK. A malformed `:id` used to flow straight into Prisma and 500.
 * ParseUUIDPipe must reject it with 400 at the edge, before the service (and the DB) are touched.
 */
describe('UsersController :id uuid validation (SEC-004)', () => {
  let app: INestApplication;
  const findOne = jest.fn();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: {
            findOne,
            findAll: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            remove: jest.fn(),
          },
        },
        { provide: AssetAssignmentsService, useValue: { findAll: jest.fn() } },
        { provide: AccessGrantsService, useValue: { findAll: jest.fn() } },
        {
          provide: ActorService,
          useValue: { resolve: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => findOne.mockReset());

  it('rejects a malformed :id with 400 and never reaches the service', async () => {
    const res = await request(app.getHttpServer()).get('/users/not-a-uuid');
    expect(res.status).toBe(400);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('passes a well-formed uuid through to the service', async () => {
    findOne.mockResolvedValue({ id: 'ok' });
    const res = await request(app.getHttpServer()).get(
      '/users/11111111-1111-4111-8111-111111111111',
    );
    expect(res.status).toBe(200);
    expect(findOne).toHaveBeenCalledTimes(1);
  });
});

// Stand-in for JwtAuthGuard: populate request.user from a test header, mimicking what the real auth
// guard does in production (sets request.user before the controller runs). Mirrors the pattern in
// access-grants.authz.spec.ts.
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();
    const role = req.headers['x-test-role'];
    req.user = role
      ? { id: 'me-1', email: 'me@lazyit.local', role }
      : undefined;
    return true;
  }
}

/**
 * GET /users/me (ADR-0040). The OIDC token does not carry the lazyit role, so the frontend reads the
 * caller's role here. The route must (1) return the @CurrentUser the auth guard resolved, including
 * its role, and (2) 401 when there is no authenticated actor (shim anonymous). The route also must
 * come BEFORE GET /users/:id so the literal `me` is not swallowed by the uuid param pipe.
 */
describe('UsersController GET /users/me (ADR-0040)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: {
            findOne: jest.fn(),
            findAll: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            remove: jest.fn(),
          },
        },
        { provide: AssetAssignmentsService, useValue: { findAll: jest.fn() } },
        { provide: AccessGrantsService, useValue: { findAll: jest.fn() } },
        {
          provide: ActorService,
          useValue: { resolve: jest.fn().mockReturnValue(undefined) },
        },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns the current authenticated user including their role', async () => {
    const res = await request(app.getHttpServer())
      .get('/users/me')
      .set('x-test-role', 'ADMIN');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: 'me-1',
      email: 'me@lazyit.local',
      role: 'ADMIN',
    });
  });

  it('does NOT collide with GET /users/:id (me is not parsed as a uuid)', async () => {
    const res = await request(app.getHttpServer())
      .get('/users/me')
      .set('x-test-role', 'VIEWER');
    // A 400 here would mean the uuid pipe on :id swallowed `me`; 200 proves the literal route wins.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: 'me-1',
      email: 'me@lazyit.local',
      role: 'VIEWER',
    });
  });

  it('401 when there is no authenticated actor (shim anonymous)', async () => {
    const res = await request(app.getHttpServer()).get('/users/me');
    expect(res.status).toBe(401);
  });
});
