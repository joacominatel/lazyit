import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import {
  ForbiddenException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { IS_PUBLIC_KEY } from './public.decorator';
import { PrismaService } from '../prisma/prisma.service';

// Prevent the real jose / generated prisma client from loading in unit tests.
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
}));
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

// Convenient import after the mock is set up.
import * as jose from 'jose';

// A minimal User row returned from the mocked DB.
const DB_USER = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'alice@example.com',
  firstName: 'Alice',
  lastName: 'Smith',
  isActive: true,
  externalId: 'oidc-sub-001',
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

// Build a fake ExecutionContext wrapping the given request object. getHandler/getClass return
// stable stubs so the (default, non-mocked) Reflector reads no @Public() metadata off them.
function makeCtx(req: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as never;
}

// A minimal Response-like shape for the mocked global.fetch.
interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

// Build a Response-like object for the mocked global.fetch.
function jsonResponse(body: unknown, ok = true, status = 200): FakeResponse {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  };
}

// Typed accessor for a recorded fetch call: [url, init].
type FetchCall = [unknown, RequestInit | undefined];
function findCall(mock: jest.Mock, fragment: string): FetchCall | undefined {
  return (mock.mock.calls as FetchCall[]).find((c) =>
    String(c[0]).includes(fragment),
  );
}

// prisma.user.upsert stub: echo the would-be-created row back (DB_USER overlaid with the `create`
// payload), so request.user reflects what was persisted on first login.
function echoUpsertedUser(args: { create: Record<string, unknown> }) {
  return { ...DB_USER, ...args.create };
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let prismaUser: { findFirst: jest.Mock; upsert: jest.Mock };
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(async () => {
    prismaUser = { findFirst: jest.fn(), upsert: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        JwtAuthGuard,
        Reflector,
        {
          provide: PrismaService,
          useValue: { user: prismaUser },
        },
      ],
    }).compile();

    guard = moduleRef.get(JwtAuthGuard);
    guard.resetJwks();

    // Mock global.fetch (discovery + userinfo). Default: discovery resolves the userinfo endpoint
    // and userinfo returns no profile, so the OIDC tests that don't override it keep their old
    // token-claim behaviour. Individual tests override per call as needed.
    fetchMock = jest.fn((input: unknown): Promise<FakeResponse> => {
      const url = String(input);
      if (url.includes('/.well-known/openid-configuration')) {
        return Promise.resolve(
          jsonResponse({
            userinfo_endpoint: 'https://auth.example.com/oidc/v1/userinfo',
          }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    // Reset jose mocks between tests.
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // @Public() bypass (applies in every mode)
  // -------------------------------------------------------------------------

  it('lets a @Public() route through without auth (no token, no DB lookup)', async () => {
    // Flag the handler with the @Public() metadata the guard reads via Reflector.
    function publicHandler() {}
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, publicHandler);

    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
      getHandler: () => publicHandler,
      getClass: () => class PublicController {},
    } as never;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(prismaUser.findFirst).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Shim mode (AUTH_MODE=shim)
  // -------------------------------------------------------------------------

  describe('AUTH_MODE=shim', () => {
    const originalMode = process.env.AUTH_MODE;

    beforeEach(() => {
      process.env.AUTH_MODE = 'shim';
    });
    afterEach(() => {
      process.env.AUTH_MODE = originalMode;
    });

    it('resolves X-User-Id to the User and sets request.user', async () => {
      prismaUser.findFirst.mockResolvedValue(DB_USER);
      const req: Record<string, unknown> = {
        headers: { 'x-user-id': DB_USER.id },
      };

      const result = await guard.canActivate(makeCtx(req));

      expect(result).toBe(true);
      expect(req.user).toEqual(DB_USER);
      expect(prismaUser.findFirst).toHaveBeenCalledWith({
        where: { id: DB_USER.id },
      });
    });

    it('sets request.user = undefined when X-User-Id is absent (anonymous, no 401)', async () => {
      const req: Record<string, unknown> = { headers: {} };

      const result = await guard.canActivate(makeCtx(req));

      expect(result).toBe(true);
      expect(req.user).toBeUndefined();
      expect(prismaUser.findFirst).not.toHaveBeenCalled();
    });

    it('sets request.user = undefined when X-User-Id is not a valid UUID (graceful fallback)', async () => {
      const req: Record<string, unknown> = {
        headers: { 'x-user-id': 'not-a-uuid' },
      };

      const result = await guard.canActivate(makeCtx(req));

      expect(result).toBe(true);
      expect(req.user).toBeUndefined();
      expect(prismaUser.findFirst).not.toHaveBeenCalled();
    });

    it('sets request.user = undefined when the UUID does not match a live user', async () => {
      prismaUser.findFirst.mockResolvedValue(null);
      const req: Record<string, unknown> = {
        headers: { 'x-user-id': DB_USER.id },
      };

      const result = await guard.canActivate(makeCtx(req));

      expect(result).toBe(true);
      expect(req.user).toBeUndefined();
    });

    it('treats a disabled (isActive=false) account as anonymous (shim never 401s)', async () => {
      prismaUser.findFirst.mockResolvedValue({ ...DB_USER, isActive: false });
      const req: Record<string, unknown> = {
        headers: { 'x-user-id': DB_USER.id },
      };

      const result = await guard.canActivate(makeCtx(req));

      expect(result).toBe(true);
      expect(req.user).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // OIDC mode (default — AUTH_MODE unset / not 'shim')
  // -------------------------------------------------------------------------

  describe('OIDC mode', () => {
    const originalMode = process.env.AUTH_MODE;
    const originalIssuer = process.env.OIDC_ISSUER;

    beforeEach(() => {
      delete process.env.AUTH_MODE;
      process.env.OIDC_ISSUER = 'https://auth.example.com';
    });
    afterEach(() => {
      if (originalMode === undefined) {
        delete process.env.AUTH_MODE;
      } else {
        process.env.AUTH_MODE = originalMode;
      }
      if (originalIssuer === undefined) {
        delete process.env.OIDC_ISSUER;
      } else {
        process.env.OIDC_ISSUER = originalIssuer;
      }
    });

    it('throws UnauthorizedException when Authorization header is missing', async () => {
      const req: Record<string, unknown> = { headers: {} };

      await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException when token is invalid or expired', async () => {
      (jose.jwtVerify as jest.Mock).mockRejectedValue(new Error('JWTExpired'));
      const req: Record<string, unknown> = {
        headers: { authorization: 'Bearer bad.token.here' },
      };

      await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('returns existing User when sub matches an existing externalId (no JIT)', async () => {
      (jose.jwtVerify as jest.Mock).mockResolvedValue({
        payload: {
          sub: 'oidc-sub-001',
          email: 'alice@example.com',
          given_name: 'Alice',
          family_name: 'Smith',
        },
      });
      prismaUser.findFirst.mockResolvedValue(DB_USER);

      const req: Record<string, unknown> = {
        headers: { authorization: 'Bearer valid.token.here' },
      };

      const result = await guard.canActivate(makeCtx(req));

      expect(result).toBe(true);
      expect(req.user).toEqual(DB_USER);
      expect(prismaUser.upsert).not.toHaveBeenCalled();
      // The existing-user lookup INCLUDES soft-deleted rows (no-resurrect).
      expect(prismaUser.findFirst).toHaveBeenCalledWith({
        where: { externalId: 'oidc-sub-001' },
        includeSoftDeleted: true,
      });
    });

    it('pins the JWT verification algorithm to RS256', async () => {
      (jose.jwtVerify as jest.Mock).mockResolvedValue({
        payload: { sub: 'oidc-sub-001' },
      });
      prismaUser.findFirst.mockResolvedValue(DB_USER);

      await guard.canActivate(
        makeCtx({ headers: { authorization: 'Bearer valid.token.here' } }),
      );

      const verifyOptions = (jose.jwtVerify as jest.Mock).mock
        .calls[0][2] as Record<string, unknown>;
      expect(verifyOptions.algorithms).toEqual(['RS256']);
    });

    it('rejects a disabled (isActive=false) account with 401 (offboarding/disable sticks)', async () => {
      (jose.jwtVerify as jest.Mock).mockResolvedValue({
        payload: { sub: 'oidc-sub-001' },
      });
      // A live but deactivated user.
      prismaUser.findFirst.mockResolvedValue({ ...DB_USER, isActive: false });

      const req: Record<string, unknown> = {
        headers: { authorization: 'Bearer valid.token.here' },
      };

      await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(req.user).toBeUndefined();
    });

    it('returns 403 (no re-provision) when the externalId matches a SOFT-DELETED user', async () => {
      (jose.jwtVerify as jest.Mock).mockResolvedValue({
        payload: { sub: 'oidc-sub-001' },
      });
      // The soft-delete escape hatch surfaces the offboarded row (deletedAt set).
      prismaUser.findFirst.mockResolvedValue({
        ...DB_USER,
        deletedAt: new Date(),
      });

      const req: Record<string, unknown> = {
        headers: { authorization: 'Bearer valid.token.here' },
      };

      await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      // Must NOT resurrect the account.
      expect(prismaUser.upsert).not.toHaveBeenCalled();
    });

    it('JIT-creates a new User (via upsert) when sub is unknown (first login)', async () => {
      (jose.jwtVerify as jest.Mock).mockResolvedValue({
        payload: {
          sub: 'oidc-sub-new',
          email: 'bob@example.com',
          given_name: 'Bob',
          family_name: 'Jones',
        },
      });
      // No existing user by externalId.
      prismaUser.findFirst.mockResolvedValue(null);
      const newUser = {
        ...DB_USER,
        id: 'new-uuid',
        externalId: 'oidc-sub-new',
        email: 'bob@example.com',
        firstName: 'Bob',
        lastName: 'Jones',
      };
      prismaUser.upsert.mockResolvedValue(newUser);

      const req: Record<string, unknown> = {
        headers: { authorization: 'Bearer valid.token.here' },
      };

      const result = await guard.canActivate(makeCtx(req));

      expect(result).toBe(true);
      expect(req.user).toEqual(newUser);
      // Race-proof upsert on externalId (not a check-then-act create).
      expect(prismaUser.upsert).toHaveBeenCalledWith({
        where: { externalId: 'oidc-sub-new' },
        create: {
          externalId: 'oidc-sub-new',
          email: 'bob@example.com',
          firstName: 'Bob',
          lastName: 'Jones',
          isActive: true,
        },
        update: {},
      });
    });

    it('falls back to splitting name claim when given_name / family_name are absent', async () => {
      (jose.jwtVerify as jest.Mock).mockResolvedValue({
        payload: {
          sub: 'oidc-sub-x',
          email: 'carol@example.com',
          name: 'Carol Chen',
        },
      });
      prismaUser.findFirst.mockResolvedValue(null);
      prismaUser.upsert.mockResolvedValue({
        ...DB_USER,
        externalId: 'oidc-sub-x',
      });

      await guard.canActivate(
        makeCtx({
          headers: { authorization: 'Bearer t' },
        }),
      );

      expect(prismaUser.upsert).toHaveBeenCalledWith({
        where: { externalId: 'oidc-sub-x' },
        create: {
          externalId: 'oidc-sub-x',
          email: 'carol@example.com',
          firstName: 'Carol',
          lastName: 'Chen',
          isActive: true,
        },
        update: {},
      });
    });

    it('uses email local-part as firstName when neither name nor given_name present', async () => {
      (jose.jwtVerify as jest.Mock).mockResolvedValue({
        payload: {
          sub: 'oidc-sub-y',
          email: 'dana@example.com',
        },
      });
      prismaUser.findFirst.mockResolvedValue(null);
      prismaUser.upsert.mockResolvedValue({
        ...DB_USER,
        externalId: 'oidc-sub-y',
      });

      await guard.canActivate(
        makeCtx({
          headers: { authorization: 'Bearer t' },
        }),
      );

      expect(prismaUser.upsert).toHaveBeenCalledWith({
        where: { externalId: 'oidc-sub-y' },
        create: {
          externalId: 'oidc-sub-y',
          email: 'dana@example.com',
          firstName: 'dana',
          lastName: '',
          isActive: true,
        },
        update: {},
      });
    });

    it('throws UnauthorizedException when OIDC_ISSUER is not configured', async () => {
      delete process.env.OIDC_ISSUER;
      const req: Record<string, unknown> = {
        headers: { authorization: 'Bearer some.token.here' },
      };

      await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    // -----------------------------------------------------------------------
    // userinfo enrichment on the JIT path (ADR-0038, issue #59)
    // -----------------------------------------------------------------------

    describe('userinfo enrichment (JIT path)', () => {
      const originalJwksUri = process.env.OIDC_JWKS_URI;

      afterEach(() => {
        if (originalJwksUri === undefined) {
          delete process.env.OIDC_JWKS_URI;
        } else {
          process.env.OIDC_JWKS_URI = originalJwksUri;
        }
      });

      it('uses the real profile from userinfo when the access token lacks profile claims', async () => {
        delete process.env.OIDC_JWKS_URI;
        // Access token carries authorization only (sub), no email/name.
        (jose.jwtVerify as jest.Mock).mockResolvedValue({
          payload: { sub: 'oidc-sub-jit' },
        });
        prismaUser.findFirst.mockResolvedValue(null);
        prismaUser.upsert.mockImplementation(echoUpsertedUser);

        // discovery → userinfo_endpoint; userinfo → full profile.
        fetchMock.mockImplementation(
          (input: unknown): Promise<FakeResponse> => {
            const url = String(input);
            if (url.includes('/.well-known/openid-configuration')) {
              return Promise.resolve(
                jsonResponse({
                  userinfo_endpoint:
                    'https://auth.example.com/oidc/v1/userinfo',
                }),
              );
            }
            return Promise.resolve(
              jsonResponse({
                sub: 'oidc-sub-jit',
                email: 'real.user@corp.com',
                given_name: 'Real',
                family_name: 'User',
              }),
            );
          },
        );

        await guard.canActivate(
          makeCtx({ headers: { authorization: 'Bearer access.token' } }),
        );

        expect(prismaUser.upsert).toHaveBeenCalledWith({
          where: { externalId: 'oidc-sub-jit' },
          create: {
            externalId: 'oidc-sub-jit',
            email: 'real.user@corp.com',
            firstName: 'Real',
            lastName: 'User',
            isActive: true,
          },
          update: {},
        });
        // userinfo was called with the access token as Bearer.
        const userinfoCall = findCall(fetchMock, '/oidc/v1/userinfo');
        expect(userinfoCall).toBeDefined();
        expect(userinfoCall![1]?.headers).toMatchObject({
          Authorization: 'Bearer access.token',
        });
      });

      it('falls back to placeholders and warns when userinfo returns non-2xx (provisioning still succeeds)', async () => {
        delete process.env.OIDC_JWKS_URI;
        (jose.jwtVerify as jest.Mock).mockResolvedValue({
          payload: { sub: 'oidc-sub-fail' },
        });
        prismaUser.findFirst.mockResolvedValue(null);
        prismaUser.upsert.mockImplementation(echoUpsertedUser);

        const warnSpy = jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);

        fetchMock.mockImplementation(
          (input: unknown): Promise<FakeResponse> => {
            const url = String(input);
            if (url.includes('/.well-known/openid-configuration')) {
              return Promise.resolve(
                jsonResponse({
                  userinfo_endpoint:
                    'https://auth.example.com/oidc/v1/userinfo',
                }),
              );
            }
            return Promise.resolve(jsonResponse({}, false, 401));
          },
        );

        const result = await guard.canActivate(
          makeCtx({ headers: { authorization: 'Bearer access.token' } }),
        );

        expect(result).toBe(true);
        // Placeholder fallback from the bare sub.
        expect(prismaUser.upsert).toHaveBeenCalledWith({
          where: { externalId: 'oidc-sub-fail' },
          create: {
            externalId: 'oidc-sub-fail',
            email: 'oidc-sub-fail@unknown',
            firstName: 'oidc-sub-fail',
            lastName: '',
            isActive: true,
          },
          update: {},
        });
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      it('falls back to placeholders and warns when the userinfo fetch rejects', async () => {
        delete process.env.OIDC_JWKS_URI;
        (jose.jwtVerify as jest.Mock).mockResolvedValue({
          payload: { sub: 'oidc-sub-throw' },
        });
        prismaUser.findFirst.mockResolvedValue(null);
        prismaUser.upsert.mockImplementation(echoUpsertedUser);

        const warnSpy = jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);

        fetchMock.mockImplementation(
          (input: unknown): Promise<FakeResponse> => {
            const url = String(input);
            if (url.includes('/.well-known/openid-configuration')) {
              return Promise.resolve(
                jsonResponse({
                  userinfo_endpoint:
                    'https://auth.example.com/oidc/v1/userinfo',
                }),
              );
            }
            return Promise.reject(new Error('ECONNREFUSED'));
          },
        );

        const result = await guard.canActivate(
          makeCtx({ headers: { authorization: 'Bearer access.token' } }),
        );

        expect(result).toBe(true);
        expect(prismaUser.upsert).toHaveBeenCalledWith({
          where: { externalId: 'oidc-sub-throw' },
          create: {
            externalId: 'oidc-sub-throw',
            email: 'oidc-sub-throw@unknown',
            firstName: 'oidc-sub-throw',
            lastName: '',
            isActive: true,
          },
          update: {},
        });
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      it('does not call discovery or userinfo for a known externalId (no JIT)', async () => {
        delete process.env.OIDC_JWKS_URI;
        (jose.jwtVerify as jest.Mock).mockResolvedValue({
          payload: { sub: 'oidc-sub-001' },
        });
        prismaUser.findFirst.mockResolvedValue(DB_USER);

        const result = await guard.canActivate(
          makeCtx({ headers: { authorization: 'Bearer access.token' } }),
        );

        expect(result).toBe(true);
        expect(prismaUser.upsert).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('rewrites discovery + userinfo to the internal origin with X-Forwarded-* when OIDC_JWKS_URI is set', async () => {
        process.env.OIDC_JWKS_URI = 'http://zitadel:8080/oauth/v2/keys';
        (jose.jwtVerify as jest.Mock).mockResolvedValue({
          payload: { sub: 'oidc-sub-internal' },
        });
        prismaUser.findFirst.mockResolvedValue(null);
        prismaUser.upsert.mockImplementation(echoUpsertedUser);

        fetchMock.mockImplementation(
          (input: unknown): Promise<FakeResponse> => {
            const url = String(input);
            if (url.includes('/.well-known/openid-configuration')) {
              // Discovery advertises the EXTERNAL userinfo endpoint.
              return Promise.resolve(
                jsonResponse({
                  userinfo_endpoint:
                    'https://auth.example.com/oidc/v1/userinfo',
                }),
              );
            }
            return Promise.resolve(
              jsonResponse({ email: 'internal@corp.com' }),
            );
          },
        );

        await guard.canActivate(
          makeCtx({ headers: { authorization: 'Bearer access.token' } }),
        );

        // Both requests must target the internal origin (zitadel:8080), not auth.example.com.
        const discoveryCall = findCall(
          fetchMock,
          '/.well-known/openid-configuration',
        );
        const userinfoCall = findCall(fetchMock, '/oidc/v1/userinfo');
        expect(String(discoveryCall![0])).toBe(
          'http://zitadel:8080/.well-known/openid-configuration',
        );
        expect(String(userinfoCall![0])).toBe(
          'http://zitadel:8080/oidc/v1/userinfo',
        );
        // X-Forwarded-* derived from the external issuer host.
        expect(discoveryCall![1]?.headers).toMatchObject({
          'X-Forwarded-Host': 'auth.example.com',
        });
        expect(userinfoCall![1]?.headers).toMatchObject({
          'X-Forwarded-Host': 'auth.example.com',
          Authorization: 'Bearer access.token',
        });
      });
    });
  });
});
