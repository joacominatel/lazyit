import { ForbiddenException, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { Request } from 'express';

// The controller imports ConfigService at runtime, which loads the generated Prisma client and the
// ESM `meilisearch` package (via SearchService) — both unparseable by ts-jest. The service is never
// instantiated here (a hand-built mock is passed to the controller), so these stubs only stop the
// real modules from loading.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import { ConfigController } from './config.controller';
import { ConfigService, type SetupOutcome } from './config.service';
import { SetupCsrfService } from './setup-csrf.service';
import { SetupRateLimitGuard } from './setup-rate-limit.guard';

/** Minimal Express request stub carrying an IP for the audit line. */
function reqWithIp(ip: string): Request {
  return {
    ip,
    headers: {} as Record<string, string | string[] | undefined>,
    socket: { remoteAddress: ip },
  } as unknown as Request;
}

const SETUP_DTO = {
  email: 'admin@example.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
};

describe('ConfigController', () => {
  let controller: ConfigController;
  let config: jest.Mocked<
    Pick<ConfigService, 'getStatus' | 'issueCsrfToken' | 'setup'>
  >;
  let csrf: jest.Mocked<Pick<SetupCsrfService, 'verify'>>;

  const OUTCOME: SetupOutcome = {
    adminId: '11111111-1111-1111-1111-111111111111',
    email: 'admin@example.com',
    mirrored: true,
    setupCompletedAt: new Date('2026-06-01T00:00:00.000Z'),
  };

  beforeEach(() => {
    config = {
      getStatus: jest.fn().mockResolvedValue({
        isConfigured: false,
        adminCount: 0,
        integrationMode: 'zitadel',
        devMode: true,
        csrfToken: 'tok',
      }),
      issueCsrfToken: jest.fn().mockReturnValue('fresh-token'),
      setup: jest.fn().mockResolvedValue(OUTCOME),
    };
    csrf = { verify: jest.fn() };
    controller = new ConfigController(
      config as unknown as ConfigService,
      csrf as unknown as SetupCsrfService,
    );
  });

  it('GET /config/status returns the status payload', async () => {
    const status = await controller.status();
    expect(status.isConfigured).toBe(false);
    expect(status.integrationMode).toBe('zitadel');
  });

  it('GET /config/csrf issues a fresh token', () => {
    expect(controller.csrfToken()).toEqual({ csrfToken: 'fresh-token' });
  });

  it('POST /config/setup rejects a missing/invalid CSRF token with 403 and never calls setup', async () => {
    csrf.verify.mockReturnValue(false);
    await expect(
      controller.setup(SETUP_DTO, undefined, reqWithIp('1.2.3.4')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(config.setup).not.toHaveBeenCalled();
  });

  it('POST /config/setup with a valid CSRF token creates the admin and shapes the result', async () => {
    csrf.verify.mockReturnValue(true);
    const result = await controller.setup(
      SETUP_DTO,
      'valid-token',
      reqWithIp('203.0.113.7'),
    );
    expect(csrf.verify).toHaveBeenCalledWith('valid-token');
    expect(config.setup).toHaveBeenCalledWith(SETUP_DTO, '203.0.113.7');
    expect(result).toEqual({
      success: true,
      adminId: OUTCOME.adminId,
      email: OUTCOME.email,
      mirrored: true,
      setupCompletedAt: '2026-06-01T00:00:00.000Z',
    });
  });
});

/**
 * Rate-limit propagation through the real HTTP pipeline (ADR-0043 §6 #3 / Fork #7). The unit tests
 * above instantiate the controller directly, which BYPASSES `@UseGuards(SetupRateLimitGuard)` — so
 * they can never prove the 429 actually reaches a client. This block boots a minimal Nest app with the
 * REAL guard wired on `POST /config/setup` and asserts that, once the per-IP cap is exceeded, the
 * endpoint responds **429 Too Many Requests** and the service is NOT invoked (the guard short-circuits
 * before the handler). `MAX_ATTEMPTS = 5` (setup-rate-limit.guard.ts), so the 6th call from one IP trips.
 */
describe('POST /config/setup — rate-limit guard 429 propagation (e2e pipeline)', () => {
  let app: INestApplication;

  const OUTCOME: SetupOutcome = {
    adminId: '11111111-1111-1111-1111-111111111111',
    email: 'admin@example.com',
    mirrored: true,
    setupCompletedAt: new Date('2026-06-01T00:00:00.000Z'),
  };

  const setup = jest.fn().mockResolvedValue(OUTCOME);
  // A real CSRF service so a freshly-issued token passes the controller's CSRF gate, leaving the
  // rate-limit guard as the only thing that can reject the request.
  const csrfService = new SetupCsrfService();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ConfigController],
      providers: [
        SetupRateLimitGuard,
        { provide: SetupCsrfService, useValue: csrfService },
        // ConfigController injects ConfigService by class; only `setup` is exercised here.
        { provide: ConfigService, useValue: { setup } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 429 once the per-IP cap is exceeded and never calls the service for the blocked attempt', async () => {
    const token = csrfService.issue();
    const server = app.getHttpServer();
    // 5 attempts are allowed within the window (each 201). A fixed IP keys the bucket.
    for (let i = 0; i < 5; i++) {
      const ok = await request(server)
        .post('/config/setup')
        .set('X-CSRF-Token', token)
        .set('X-Forwarded-For', '198.51.100.9')
        .send(SETUP_DTO);
      expect(ok.status).toBe(201);
    }
    expect(setup).toHaveBeenCalledTimes(5);

    // The 6th from the same IP is rejected by the guard with 429 — before the handler runs.
    const blocked = await request(server)
      .post('/config/setup')
      .set('X-CSRF-Token', token)
      .set('X-Forwarded-For', '198.51.100.9')
      .send(SETUP_DTO);
    expect(blocked.status).toBe(429);
    // The guard short-circuited: the service was not called a 6th time.
    expect(setup).toHaveBeenCalledTimes(5);
  });
});
