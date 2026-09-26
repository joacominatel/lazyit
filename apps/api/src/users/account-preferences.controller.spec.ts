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
import { AccountPreferencesController } from './account-preferences.controller';
import { UserPreferencesService } from './user-preferences.service';

jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

const ME = { id: 'me-1', email: 'me@lazyit.local', role: 'VIEWER' };

// Stand-in for JwtAuthGuard: `human` → request.user + a human principal; `service` → a service principal.
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
        permissions: new Set(),
      };
    }
    return true;
  }
}

describe('AccountPreferencesController /account/preferences (issue #1422)', () => {
  let app: INestApplication;
  const get = jest.fn();
  const update = jest.fn();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AccountPreferencesController],
      providers: [
        { provide: UserPreferencesService, useValue: { get, update } },
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
    get.mockReset();
    update.mockReset();
  });

  it('GET returns the caller’s preferences, keyed on the caller', async () => {
    get.mockResolvedValue({ locale: null, theme: null });
    const res = await request(app.getHttpServer())
      .get('/account/preferences')
      .set('x-test-kind', 'human');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ locale: null, theme: null });
    expect(get).toHaveBeenCalledWith('me-1');
  });

  it('PUT sets one key, clears another with null', async () => {
    update.mockResolvedValue({ locale: 'es', theme: null });
    const res = await request(app.getHttpServer())
      .put('/account/preferences')
      .set('x-test-kind', 'human')
      .send({ locale: 'es', theme: null });
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith('me-1', { locale: 'es', theme: null });
  });

  it.each([
    ['unknown locale', { locale: 'fr' }],
    ['unknown theme', { theme: 'sepia' }],
    ['extra key', { locale: 'en', userId: 'someone-else' }],
    ['empty body', {}],
  ])('PUT 400s on %s', async (_label, body) => {
    const res = await request(app.getHttpServer())
      .put('/account/preferences')
      .set('x-test-kind', 'human')
      .send(body);
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a service account (403)', async () => {
    const r1 = await request(app.getHttpServer())
      .get('/account/preferences')
      .set('x-test-kind', 'service');
    const r2 = await request(app.getHttpServer())
      .put('/account/preferences')
      .set('x-test-kind', 'service')
      .send({ theme: 'dark' });
    expect(r1.status).toBe(403);
    expect(r2.status).toBe(403);
    expect(get).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('401s an anonymous caller', async () => {
    const res = await request(app.getHttpServer()).get('/account/preferences');
    expect(res.status).toBe(401);
  });
});
