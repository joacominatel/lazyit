import { ForbiddenException, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { Request } from 'express';

// The controller imports ConfigService at runtime, which loads the generated Prisma client and the
// ESM `meilisearch` package (via SearchService) — both unparseable by ts-jest. The service is never
// instantiated here (a hand-built mock is passed to the controller), so these stubs only stop the
// real modules from loading.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x },
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

// The real authZ guard + resolver token, for the permission-gate e2e block at the bottom. Static
// imports are safe: the prisma/adapter mocks above are hoisted by jest, so these never load the real
// generated client. (Dynamic import() is unavailable under this CommonJS jest config.)
import { RolesGuard } from '../auth/roles.guard';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { ServicePrincipalForbiddenGuard } from '../auth/service-principal-forbidden.guard';
import type { Principal } from '../auth/principal';

import { ConfigController } from './config.controller';
import { ConfigService, type SetupOutcome } from './config.service';
import { PermissionsConfigService } from './permissions-config.service';
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
        requiresAdminPassword: true,
      }),
      issueCsrfToken: jest.fn().mockReturnValue('fresh-token'),
      setup: jest.fn().mockResolvedValue(OUTCOME),
    };
    csrf = { verify: jest.fn() };
    // PermissionsConfigService is exercised by its own controller block below; here a bare stub
    // satisfies the (now three-arg) constructor for the first-run setup tests.
    const permissions = {} as unknown as PermissionsConfigService;
    controller = new ConfigController(
      config as unknown as ConfigService,
      csrf as unknown as SetupCsrfService,
      permissions,
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

describe('ConfigController — permissions (ADR-0046 P5)', () => {
  let controller: ConfigController;
  let permissions: jest.Mocked<
    Pick<PermissionsConfigService, 'getMatrix' | 'updateMatrix' | 'resolveFor'>
  >;

  const MATRIX = {
    ADMIN: ['asset:read'],
    MEMBER: ['asset:read', 'asset:write'],
    VIEWER: ['asset:read'],
  };
  const ADMIN_USER = { id: 'admin-uuid', role: 'ADMIN' } as never;

  beforeEach(() => {
    permissions = {
      getMatrix: jest.fn().mockResolvedValue(MATRIX),
      updateMatrix: jest.fn().mockResolvedValue(MATRIX),
      resolveFor: jest
        .fn()
        .mockResolvedValue({ role: 'MEMBER', permissions: ['asset:read'] }),
    };
    controller = new ConfigController(
      {} as unknown as ConfigService,
      {} as unknown as SetupCsrfService,
      permissions as unknown as PermissionsConfigService,
    );
  });

  it('GET /config/permissions returns the matrix from the service', async () => {
    await expect(controller.getPermissions()).resolves.toEqual(MATRIX);
    expect(permissions.getMatrix).toHaveBeenCalledTimes(1);
  });

  it('PUT /config/permissions forwards the body and the actor id', async () => {
    const body = { MEMBER: ['asset:read'], VIEWER: [] } as never;
    await controller.updatePermissions(body, ADMIN_USER);
    expect(permissions.updateMatrix).toHaveBeenCalledWith(body, 'admin-uuid');
  });

  it('PUT /config/permissions passes a null actor when there is no user (shim edge)', async () => {
    const body = { MEMBER: [], VIEWER: [] } as never;
    await controller.updatePermissions(body, undefined);
    expect(permissions.updateMatrix).toHaveBeenCalledWith(body, null);
  });

  it('GET /config/my-permissions resolves for the caller role', async () => {
    const user = { id: 'u1', role: 'MEMBER' } as never;
    await expect(controller.myPermissions(user)).resolves.toEqual({
      role: 'MEMBER',
      permissions: ['asset:read'],
    });
    expect(permissions.resolveFor).toHaveBeenCalledWith('MEMBER');
  });

  it('GET /config/my-permissions 403s an anonymous (shim) caller with no user', () => {
    // The guard short-circuit throws synchronously before resolving any permission set.
    expect(() => controller.myPermissions(undefined)).toThrow(
      ForbiddenException,
    );
    expect(permissions.resolveFor).not.toHaveBeenCalled();
  });
});

/**
 * Rate-limit propagation through the real HTTP pipeline (ADR-0043 §6 #3 / Fork #7). The unit tests
 * above instantiate the controller directly, which BYPASSES `@UseGuards(SetupRateLimitGuard)` — so
 * they can never prove the 429 actually reaches a client. This block boots a minimal Nest app with the
 * REAL guard wired on `POST /config/setup` and asserts that, once the per-IP cap is exceeded, the
 * endpoint responds **429 Too Many Requests** and the service is NOT invoked (the guard short-circuits
 * before the handler). `MAX_ATTEMPTS = 5` (setup-rate-limit.guard.ts), so the 6th call from one IP trips.
 *
 * SEC-010: `trust proxy` is left at Express's default (off) here — supertest connects over loopback,
 * so every request shares one verified `req.ip` and a client-sent X-Forwarded-For is ignored. The
 * spoofing test below proves a rotating forged XFF can no longer mint a fresh bucket.
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
        // ConfigController also injects PermissionsConfigService (P5); a bare stub satisfies the
        // constructor — the permissions routes are not exercised in this rate-limit e2e block.
        { provide: PermissionsConfigService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('a rotating forged X-Forwarded-For does NOT bypass the cap, then 429s — and never calls the service for the blocked attempt (SEC-010)', async () => {
    const token = csrfService.issue();
    const server = app.getHttpServer();
    // `trust proxy` is off here (Express default), so the client-sent X-Forwarded-For is IGNORED:
    // every request resolves to the same loopback req.ip and shares ONE bucket. The attacker rotates
    // the spoofed leftmost hop on each call hoping each one mints a fresh window — it never works.
    // Pre-SEC-010 the guard keyed on the leftmost XFF token, so each distinct fake hop started a new
    // bucket and the 6th would have returned 201; this test would fail.
    for (let i = 0; i < 5; i++) {
      const ok = await request(server)
        .post('/config/setup')
        .set('X-CSRF-Token', token)
        .set('X-Forwarded-For', `1.2.3.${i}`)
        .send(SETUP_DTO);
      expect(ok.status).toBe(201);
    }
    expect(setup).toHaveBeenCalledTimes(5);

    // 6th with yet another forged hop — still the same verified client → 429, not a fresh 201, and
    // the guard short-circuits before the handler (the service is not called a 6th time).
    const blocked = await request(server)
      .post('/config/setup')
      .set('X-CSRF-Token', token)
      .set('X-Forwarded-For', '9.9.9.9')
      .send(SETUP_DTO);
    expect(blocked.status).toBe(429);
    expect(setup).toHaveBeenCalledTimes(5);
  });
});

/**
 * Permission-gate propagation through the real HTTP pipeline (ADR-0046 P5). The unit tests above call
 * the handlers directly, BYPASSING the `@RequirePermission('settings:manage')` metadata — so they can't
 * prove the gate actually bites. This block boots a minimal Nest app with the REAL {@link RolesGuard}
 * as an APP_GUARD and a stubbed {@link PermissionResolverService}, plus a fake auth guard that sets
 * `req.user` from an `X-Test-Role` header (mimicking JwtAuthGuard). It asserts the real authZ outcomes:
 *   - GET/PUT /config/permissions: ADMIN passes, MEMBER/VIEWER → 403 (settings:manage is ADMIN-only).
 *   - GET /config/my-permissions: any authenticated role passes (no permission gate).
 */
describe('ConfigController — permission gates (e2e pipeline, ADR-0046 P5)', () => {
  let app: INestApplication;

  // Stub the resolver: ADMIN holds everything; MEMBER/VIEWER hold the default-seed sets (NOT
  // settings:manage). hasAll mirrors the real AND-semantics so the guard's decision is authentic.
  const adminSet = new Set<string>(['settings:manage', 'asset:read']);
  const memberSet = new Set<string>(['asset:read', 'asset:write']);
  const resolverStub = {
    resolve: (role: string) =>
      Promise.resolve(role === 'ADMIN' ? adminSet : memberSet),
    hasAll: (role: string, required: string[]) =>
      Promise.resolve(
        role === 'ADMIN' || required.every((p) => memberSet.has(p)),
      ),
    invalidate: jest.fn(),
  };

  // The permissions service is stubbed — the gate, not the business logic, is under test here.
  const permissionsStub = {
    getMatrix: jest.fn().mockResolvedValue({ ADMIN: [], MEMBER: [], VIEWER: [] }),
    updateMatrix: jest.fn().mockResolvedValue({ ADMIN: [], MEMBER: [], VIEWER: [] }),
    resolveFor: jest.fn().mockResolvedValue({ role: 'MEMBER', permissions: [] }),
  };

  beforeAll(async () => {
    // A fake auth guard standing in for JwtAuthGuard: sets req.user from X-Test-Role (anonymous if absent).
    const fakeAuthGuard = {
      canActivate: (ctx: {
        switchToHttp: () => { getRequest: () => Record<string, unknown> };
      }) => {
        const req = ctx.switchToHttp().getRequest();
        const role = (req.headers as Record<string, string>)['x-test-role'];
        if (role) req.user = { id: 'u-' + role, role };
        return true;
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ConfigController],
      providers: [
        { provide: ConfigService, useValue: {} },
        { provide: SetupCsrfService, useValue: {} },
        { provide: PermissionsConfigService, useValue: permissionsStub },
        { provide: PermissionResolverService, useValue: resolverStub },
        // Auth first (populate req.user), then the real authZ guard.
        { provide: APP_GUARD, useValue: fakeAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const roles: Array<['ADMIN' | 'MEMBER' | 'VIEWER', number]> = [
    ['ADMIN', 200],
    ['MEMBER', 403],
    ['VIEWER', 403],
  ];

  it.each(roles)('GET /config/permissions: %s → %d', async (role, status) => {
    const res = await request(app.getHttpServer())
      .get('/config/permissions')
      .set('X-Test-Role', role);
    expect(res.status).toBe(status);
  });

  it.each(roles)('PUT /config/permissions: %s → %d', async (role, status) => {
    const res = await request(app.getHttpServer())
      .put('/config/permissions')
      .set('X-Test-Role', role)
      .send({ MEMBER: ['asset:read'], VIEWER: ['asset:read'] });
    // ADMIN passes the gate (200); MEMBER/VIEWER are blocked at the gate (403).
    expect(res.status).toBe(status);
  });

  it.each(['ADMIN', 'MEMBER', 'VIEWER'])(
    'GET /config/my-permissions: %s passes (any authenticated user)',
    async (role) => {
      const res = await request(app.getHttpServer())
        .get('/config/my-permissions')
        .set('X-Test-Role', role);
      expect(res.status).toBe(200);
    },
  );

  it('GET /config/my-permissions: anonymous (no user) → 403', async () => {
    const res = await request(app.getHttpServer()).get('/config/my-permissions');
    expect(res.status).toBe(403);
  });
});

/**
 * Layer-2 principal-kind guard (INV-SA-3 / SEC-011): a service principal MUST be refused on
 * GET/PUT /config/permissions regardless of its grants. The ServicePrincipalForbiddenGuard is wired
 * method-level on these two handlers; this block verifies it fires in the real HTTP pipeline.
 *
 * A human ADMIN still passes (no regression).
 */
describe('ConfigController — service-principal blocked on permissions routes (INV-SA-3 Layer 2)', () => {
  let app: INestApplication;

  const adminSet = new Set<string>(['settings:manage', 'asset:read']);
  const resolverStub = {
    resolve: (role: string) =>
      Promise.resolve(role === 'ADMIN' ? adminSet : new Set<string>()),
    hasAll: (role: string, required: string[]) =>
      Promise.resolve(role === 'ADMIN' || required.every((p) => adminSet.has(p))),
    invalidate: jest.fn(),
  };

  const permissionsStub = {
    getMatrix: jest.fn().mockResolvedValue({ ADMIN: [], MEMBER: [], VIEWER: [] }),
    updateMatrix: jest.fn().mockResolvedValue({ ADMIN: [], MEMBER: [], VIEWER: [] }),
    resolveFor: jest.fn().mockResolvedValue({ role: 'ADMIN', permissions: [] }),
  };

  beforeAll(async () => {
    // A fake auth guard that sets req.principal from X-Test-Kind.
    // 'service' → a service principal holding settings:manage (the exact pre-existing-grant scenario).
    // 'human'   → a human ADMIN.
    const fakeAuthGuard = {
      canActivate: (ctx: {
        switchToHttp: () => { getRequest: () => Record<string, unknown> };
      }) => {
        const req = ctx.switchToHttp().getRequest();
        const kind = (req.headers as Record<string, string>)['x-test-kind'];
        if (kind === 'service') {
          const principal: Principal = {
            kind: 'service',
            serviceAccount: { id: 'sa_evil' } as never,
            permissions: new Set(['settings:manage']),
          };
          req.principal = principal;
        } else if (kind === 'human') {
          const principal: Principal = {
            kind: 'human',
            user: { id: 'u-admin', role: 'ADMIN' } as never,
          };
          req.principal = principal;
          req.user = { id: 'u-admin', role: 'ADMIN' };
        }
        return true;
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ConfigController],
      providers: [
        { provide: ConfigService, useValue: {} },
        { provide: SetupCsrfService, useValue: {} },
        { provide: PermissionsConfigService, useValue: permissionsStub },
        { provide: PermissionResolverService, useValue: resolverStub },
        ServicePrincipalForbiddenGuard,
        { provide: APP_GUARD, useValue: fakeAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /config/permissions: service principal → 403 even when holding settings:manage', async () => {
    const res = await request(app.getHttpServer())
      .get('/config/permissions')
      .set('X-Test-Kind', 'service');
    expect(res.status).toBe(403);
  });

  it('PUT /config/permissions: service principal → 403 even when holding settings:manage', async () => {
    const res = await request(app.getHttpServer())
      .put('/config/permissions')
      .set('X-Test-Kind', 'service')
      .send({ MEMBER: ['asset:read'], VIEWER: ['asset:read'] });
    expect(res.status).toBe(403);
  });

  it('GET /config/permissions: human ADMIN → 200 (no regression)', async () => {
    const res = await request(app.getHttpServer())
      .get('/config/permissions')
      .set('X-Test-Kind', 'human');
    expect(res.status).toBe(200);
  });

  it('PUT /config/permissions: human ADMIN → 200 (no regression)', async () => {
    const res = await request(app.getHttpServer())
      .put('/config/permissions')
      .set('X-Test-Kind', 'human')
      .send({ MEMBER: ['asset:read'], VIEWER: ['asset:read'] });
    expect(res.status).toBe(200);
  });
});
