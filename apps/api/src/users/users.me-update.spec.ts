import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
} from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { AccessGrantsService } from '../access-grants/access-grants.service';
import { ActorService } from '../common/actor.service';
import { VaultSetupNudgeService } from '../notifications/vault-setup-nudge.service';

jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
// UsersService transitively imports the ESM `meilisearch` package (via SearchService); the service is
// mocked below, so this stub just stops the real module from loading.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

const ME = { id: 'me-1', email: 'me@lazyit.local', role: 'VIEWER' };

// Stand-in for JwtAuthGuard: `x-test-kind: human` → a human principal + request.user; `service` → a
// service principal (no request.user); absent → anonymous.
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string>;
      user?: unknown;
      principal?: unknown;
    }>();
    const kind = req.headers['x-test-kind'];
    if (kind === 'human') {
      req.user = ME;
      req.principal = { kind: 'human', user: ME };
    } else if (kind === 'service') {
      req.principal = {
        kind: 'service',
        serviceAccount: { id: 'sa-1' },
        permissions: new Set(['user:manage']),
      };
    }
    return true;
  }
}

/**
 * PATCH /users/me (issue #1421) — the self-service name edit. Proves the strict body (only
 * firstName/lastName), the refusals (service account, anonymous) and that the route never collides
 * with the ADMIN `PATCH /users/:id`.
 */
describe('UsersController PATCH /users/me (issue #1421)', () => {
  let app: INestApplication;
  const updateOwnProfile = jest.fn();
  const update = jest.fn();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: { updateOwnProfile, update, serializeUser: jest.fn() },
        },
        { provide: AssetAssignmentsService, useValue: {} },
        { provide: AccessGrantsService, useValue: {} },
        {
          provide: ActorService,
          useValue: { resolve: jest.fn(), resolveActor: jest.fn() },
        },
        { provide: VaultSetupNudgeService, useValue: {} },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    updateOwnProfile.mockReset();
    update.mockReset();
  });

  it('lets a signed-in human rename themselves (trimmed), keyed on the caller', async () => {
    updateOwnProfile.mockResolvedValue({ ...ME, firstName: 'Ada' });
    const res = await request(app.getHttpServer())
      .patch('/users/me')
      .set('x-test-kind', 'human')
      .send({ firstName: '  Ada ', lastName: 'Lovelace' });

    expect(res.status).toBe(200);
    expect(updateOwnProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'me-1' }),
      { firstName: 'Ada', lastName: 'Lovelace' },
    );
    // Never the admin route.
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    ['email', { email: 'x@y.com' }],
    ['role', { role: 'ADMIN' }],
    ['legajo', { legajo: '123' }],
    ['username', { username: 'ada' }],
    ['manager', { manager: null }],
    ['isActive', { isActive: false }],
    ['externalId', { externalId: 'sub' }],
  ])('400s on any other key (%s), even alongside a name', async (_k, extra) => {
    const res = await request(app.getHttpServer())
      .patch('/users/me')
      .set('x-test-kind', 'human')
      .send({ firstName: 'Ada', ...extra });
    expect(res.status).toBe(400);
    expect(updateOwnProfile).not.toHaveBeenCalled();
  });

  it('400s on an empty body and on a blank name', async () => {
    const empty = await request(app.getHttpServer())
      .patch('/users/me')
      .set('x-test-kind', 'human')
      .send({});
    expect(empty.status).toBe(400);
    const blank = await request(app.getHttpServer())
      .patch('/users/me')
      .set('x-test-kind', 'human')
      .send({ lastName: '   ' });
    expect(blank.status).toBe(400);
    expect(updateOwnProfile).not.toHaveBeenCalled();
  });

  it('refuses a service account (403 SERVICE_ACCOUNT_NOT_ALLOWED)', async () => {
    const res = await request(app.getHttpServer())
      .patch('/users/me')
      .set('x-test-kind', 'service')
      .send({ firstName: 'Bot' });
    expect(res.status).toBe(403);
    expect((res.body as { code?: string }).code).toBe(
      'SERVICE_ACCOUNT_NOT_ALLOWED',
    );
    expect(updateOwnProfile).not.toHaveBeenCalled();
  });

  it('401s an anonymous caller', async () => {
    const res = await request(app.getHttpServer())
      .patch('/users/me')
      .send({ firstName: 'Ada' });
    expect(res.status).toBe(401);
    expect(updateOwnProfile).not.toHaveBeenCalled();
  });
});
