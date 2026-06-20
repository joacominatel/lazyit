import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import {
  ConflictException,
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
  // The guard imports Role as a VALUE (Role.ADMIN / Role.MEMBER) for the RBAC bootstrap (ADR-0040),
  // so the mock must expose it or jitProvision dereferences undefined.
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
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
  role: 'MEMBER',
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

// jitProvision calls user.findFirst with three distinguishable shapes:
//   { where: { externalId }, includeSoftDeleted: true } — the sub lookup (includes soft-deleted);
//   { where: { email } }                                — the account-link-by-email lookup (LIVE);
//   { where: { id } }                                   — the post-claim refetch (LIVE).
// `routeFindFirst` builds a findFirst impl from per-shape handlers so the linking tests can return
// different rows for the email lookup vs. the refetch without ordering assumptions.
function routeFindFirst(handlers: {
  byExternalId?: (sub: unknown) => unknown;
  byEmail?: (email: unknown) => unknown;
  byId?: (id: unknown) => unknown;
}) {
  return (args: { where?: Record<string, unknown> }) => {
    const where = args.where ?? {};
    if ('externalId' in where) {
      return handlers.byExternalId
        ? handlers.byExternalId(where.externalId)
        : null;
    }
    if ('email' in where) {
      return handlers.byEmail ? handlers.byEmail(where.email) : null;
    }
    if ('id' in where) {
      return handlers.byId ? handlers.byId(where.id) : null;
    }
    return null;
  };
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let prismaUser: {
    findFirst: jest.Mock;
    upsert: jest.Mock;
    count: jest.Mock;
    updateMany: jest.Mock;
  };
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(async () => {
    prismaUser = {
      findFirst: jest.fn(),
      upsert: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
    };
    // Default: the DB already has users, so a JIT provision defaults to VIEWER (ADR-0043). The
    // first-user test overrides this to 0 to assert the ADMIN bootstrap (ADR-0040).
    prismaUser.count.mockResolvedValue(1);

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
          role: 'VIEWER',
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
          role: 'VIEWER',
        },
        update: {},
      });
    });

    it('uses the email local-part for BOTH names when neither name nor given_name present (hardened: lastName must not be empty)', async () => {
      // Hardening (round-2): the User contract requires lastName .min(1), so the empty-lastName path
      // is coerced to the email local-part instead of persisting a contract-violating row.
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
          lastName: 'dana',
          isActive: true,
          role: 'VIEWER',
        },
        update: {},
      });
    });

    it('coerces a single-token name claim so lastName is non-empty (hardened)', async () => {
      // `name: "Madonna"` → firstName "Madonna", lastName would be "" → coerced to the email
      // local-part so the row satisfies the @lazyit/shared User schema (.min(1)).
      (jose.jwtVerify as jest.Mock).mockResolvedValue({
        payload: {
          sub: 'oidc-sub-mono',
          email: 'star@example.com',
          name: 'Madonna',
        },
      });
      prismaUser.findFirst.mockResolvedValue(null);
      prismaUser.upsert.mockImplementation(echoUpsertedUser);

      await guard.canActivate(
        makeCtx({ headers: { authorization: 'Bearer t' } }),
      );

      const created = (
        prismaUser.upsert.mock.calls[0][0] as {
          create: { firstName: string; lastName: string };
        }
      ).create;
      expect(created.firstName).toBe('Madonna');
      expect(created.lastName).toBe('star');
    });

    it('coerces a whitespace-only given_name so firstName is non-empty (hardened)', async () => {
      // given_name "   " + family_name "Lovelace": firstName would be whitespace → coerced to the
      // email local-part; family_name is kept.
      (jose.jwtVerify as jest.Mock).mockResolvedValue({
        payload: {
          sub: 'oidc-sub-ws',
          email: 'ada@example.com',
          given_name: '   ',
          family_name: 'Lovelace',
        },
      });
      prismaUser.findFirst.mockResolvedValue(null);
      prismaUser.upsert.mockImplementation(echoUpsertedUser);

      await guard.canActivate(
        makeCtx({ headers: { authorization: 'Bearer t' } }),
      );

      const created = (
        prismaUser.upsert.mock.calls[0][0] as {
          create: { firstName: string; lastName: string };
        }
      ).create;
      expect(created.firstName).toBe('ada');
      expect(created.lastName).toBe('Lovelace');
    });

    it('JIT-provisions the FIRST user (User count 0) as ADMIN (ADR-0040 bootstrap)', async () => {
      (jose.jwtVerify as jest.Mock).mockResolvedValue({
        payload: {
          sub: 'oidc-sub-first',
          email: 'founder@example.com',
          given_name: 'Founder',
          family_name: 'Zero',
        },
      });
      prismaUser.findFirst.mockResolvedValue(null);
      // Empty database → this is the very first user, who must become ADMIN.
      prismaUser.count.mockResolvedValue(0);
      prismaUser.upsert.mockImplementation(echoUpsertedUser);

      const req: Record<string, unknown> = {
        headers: { authorization: 'Bearer valid.token.here' },
      };

      const result = await guard.canActivate(makeCtx(req));

      expect(result).toBe(true);
      expect(prismaUser.upsert).toHaveBeenCalledWith({
        where: { externalId: 'oidc-sub-first' },
        create: {
          externalId: 'oidc-sub-first',
          email: 'founder@example.com',
          firstName: 'Founder',
          lastName: 'Zero',
          isActive: true,
          role: 'ADMIN',
        },
        update: {},
      });
      expect((req.user as { role?: string }).role).toBe('ADMIN');
      // ADR-0069 REDESIGN §3.6 / §7: the bootstrap count EXCLUDES directory persons (so a bulk import
      // of login-less rows can never make the first real login fall to VIEWER), while still counting
      // soft-deleted real users (includeSoftDeleted) so an offboarded-then-reprovisioned install can't
      // silently hand ADMIN to the next signup.
      expect(prismaUser.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { directoryOnly: false },
          includeSoftDeleted: true,
        }),
      );
    });

    it('JIT-provisions a NON-first user (User count > 0) as VIEWER (ADR-0043 default flip)', async () => {
      (jose.jwtVerify as jest.Mock).mockResolvedValue({
        payload: {
          sub: 'oidc-sub-second',
          email: 'second@example.com',
          given_name: 'Second',
          family_name: 'Comer',
        },
      });
      prismaUser.findFirst.mockResolvedValue(null);
      // The DB already has at least one user → this signup is NOT the first, so it defaults to VIEWER
      // (least-privilege, uniform with app-created users) rather than MEMBER (the pre-ADR-0043 default).
      prismaUser.count.mockResolvedValue(3);
      prismaUser.upsert.mockImplementation(echoUpsertedUser);

      const req: Record<string, unknown> = {
        headers: { authorization: 'Bearer valid.token.here' },
      };

      const result = await guard.canActivate(makeCtx(req));

      expect(result).toBe(true);
      const upsertCalls = prismaUser.upsert.mock.calls as Array<
        [{ create: { role: string } }]
      >;
      expect(upsertCalls[0][0].create.role).toBe('VIEWER');
      expect((req.user as { role?: string }).role).toBe('VIEWER');
    });

    // -----------------------------------------------------------------------
    // Account linking by verified email (ADR-0038 addendum) — the seed-admin bootstrap fix.
    // -----------------------------------------------------------------------

    describe('account linking by email (ADR-0038 addendum)', () => {
      const SEED_ADMIN = {
        ...DB_USER,
        id: '99999999-9999-9999-9999-999999999999',
        email: 'admin@lazyit.local',
        firstName: 'Admin',
        lastName: 'User',
        role: 'ADMIN',
        externalId: null,
      };

      it('links an unclaimed live user (the seeded ADMIN) on first OIDC login and PRESERVES its role', async () => {
        (jose.jwtVerify as jest.Mock).mockResolvedValue({
          payload: {
            sub: 'zitadel-sub-operator',
            email: 'admin@lazyit.local',
            email_verified: true, // SEC-020: verified email required for account linking
            given_name: 'Real',
            family_name: 'Operator',
          },
        });
        // externalId lookup misses; the email lookup finds the unclaimed seeded admin; the refetch
        // returns the now-claimed row (externalId bound, role preserved).
        const claimedRow = {
          ...SEED_ADMIN,
          externalId: 'zitadel-sub-operator',
          firstName: 'Real',
          lastName: 'Operator',
        };
        let claimed = false;
        prismaUser.findFirst.mockImplementation(
          routeFindFirst({
            byExternalId: () => null,
            byEmail: () => SEED_ADMIN,
            byId: () => (claimed ? claimedRow : SEED_ADMIN),
          }),
        );
        prismaUser.updateMany.mockImplementation(() => {
          claimed = true;
          return Promise.resolve({ count: 1 });
        });

        const req: Record<string, unknown> = {
          headers: { authorization: 'Bearer valid.token.here' },
        };

        const result = await guard.canActivate(makeCtx(req));

        expect(result).toBe(true);
        // The claim binds externalId on the existing row (guarded by externalId: null) — no create.
        expect(prismaUser.updateMany).toHaveBeenCalledWith({
          where: {
            id: SEED_ADMIN.id,
            externalId: null,
          },
          data: {
            externalId: 'zitadel-sub-operator',
            // ADR-0069 REDESIGN §3.5: the claim PROMOTES a directory person (and is a no-op for a row
            // that was already a real account) — directoryOnly is always set false on the bind.
            directoryOnly: false,
            // Seed placeholder "Admin User" + real claims → name refreshed.
            firstName: 'Real',
            lastName: 'Operator',
          },
        });
        expect(prismaUser.upsert).not.toHaveBeenCalled();
        // Role inherited from the seeded ADMIN, not reset to MEMBER.
        expect((req.user as { role?: string }).role).toBe('ADMIN');
        expect((req.user as { externalId?: string }).externalId).toBe(
          'zitadel-sub-operator',
        );
      });

      it('links an unclaimed live user WITHOUT overwriting a real (non-placeholder) name', async () => {
        const liveMember = {
          ...DB_USER,
          id: '88888888-8888-8888-8888-888888888888',
          email: 'jordan@corp.com',
          firstName: 'Jordan',
          lastName: 'Vega',
          role: 'MEMBER',
          externalId: null,
        };
        (jose.jwtVerify as jest.Mock).mockResolvedValue({
          payload: {
            sub: 'zitadel-sub-jordan',
            email: 'jordan@corp.com',
            email_verified: true, // SEC-020: verified email required for account linking
            given_name: 'J',
            family_name: 'V',
          },
        });
        let claimed = false;
        const claimedRow = {
          ...liveMember,
          externalId: 'zitadel-sub-jordan',
        };
        prismaUser.findFirst.mockImplementation(
          routeFindFirst({
            byExternalId: () => null,
            byEmail: () => liveMember,
            byId: () => (claimed ? claimedRow : liveMember),
          }),
        );
        prismaUser.updateMany.mockImplementation(() => {
          claimed = true;
          return Promise.resolve({ count: 1 });
        });

        await guard.canActivate(
          makeCtx({ headers: { authorization: 'Bearer t' } }),
        );

        // The real name is not a seed placeholder → only externalId + the directoryOnly promotion are
        // written (ADR-0069 REDESIGN §3.5), never the name.
        expect(prismaUser.updateMany).toHaveBeenCalledWith({
          where: { id: liveMember.id, externalId: null },
          data: { externalId: 'zitadel-sub-jordan', directoryOnly: false },
        });
        expect(prismaUser.upsert).not.toHaveBeenCalled();
      });

      it('throws ConflictException when the email is already linked to a DIFFERENT sub (no takeover)', async () => {
        (jose.jwtVerify as jest.Mock).mockResolvedValue({
          payload: {
            sub: 'attacker-sub',
            email: 'admin@lazyit.local',
            given_name: 'Mal',
            family_name: 'Lory',
          },
        });
        // externalId lookup misses; email lookup finds a row already bound to a different sub.
        prismaUser.findFirst.mockImplementation(
          routeFindFirst({
            byExternalId: () => null,
            byEmail: () => ({
              ...SEED_ADMIN,
              externalId: 'the-legit-owners-sub',
            }),
          }),
        );

        const req: Record<string, unknown> = {
          headers: { authorization: 'Bearer valid.token.here' },
        };

        await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
          ConflictException,
        );
        // Must NOT re-bind or create.
        expect(prismaUser.updateMany).not.toHaveBeenCalled();
        expect(prismaUser.upsert).not.toHaveBeenCalled();
      });

      it('returns the row defensively when the email owner is already linked to THIS sub', async () => {
        const alreadyLinked = {
          ...SEED_ADMIN,
          externalId: 'zitadel-sub-self',
        };
        (jose.jwtVerify as jest.Mock).mockResolvedValue({
          payload: { sub: 'zitadel-sub-self', email: 'admin@lazyit.local' },
        });
        prismaUser.findFirst.mockImplementation(
          routeFindFirst({
            byExternalId: () => null,
            byEmail: () => alreadyLinked,
          }),
        );

        const req: Record<string, unknown> = {
          headers: { authorization: 'Bearer valid.token.here' },
        };

        const result = await guard.canActivate(makeCtx(req));

        expect(result).toBe(true);
        expect((req.user as { externalId?: string }).externalId).toBe(
          'zitadel-sub-self',
        );
        expect(prismaUser.updateMany).not.toHaveBeenCalled();
        expect(prismaUser.upsert).not.toHaveBeenCalled();
      });

      // -------------------------------------------------------------------
      // SEC-020: email_verified gate on the claim branch
      // -------------------------------------------------------------------

      it('SEC-020: throws ForbiddenException and does NOT claim the row when email_verified is false', async () => {
        // An attacker registers at the IdP with admin@lazyit.local but the IdP does NOT verify
        // the email (email_verified: false). Without the SEC-020 gate, the guard would claim the
        // seeded ADMIN row and the attacker would inherit the ADMIN role.
        (jose.jwtVerify as jest.Mock).mockResolvedValue({
          payload: {
            sub: 'attacker-new-sub',
            email: 'admin@lazyit.local',
            email_verified: false,
            given_name: 'Evil',
            family_name: 'Attacker',
          },
        });
        // externalId lookup misses; email lookup finds the unclaimed seeded admin (the claim target).
        prismaUser.findFirst.mockImplementation(
          routeFindFirst({
            byExternalId: () => null,
            byEmail: () => ({ ...SEED_ADMIN, externalId: null }),
          }),
        );

        const req: Record<string, unknown> = {
          headers: { authorization: 'Bearer attacker.token.here' },
        };

        // Must reject — never claim the ADMIN row on an unverified email.
        await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        // The claim (updateMany) must NOT have been called.
        expect(prismaUser.updateMany).not.toHaveBeenCalled();
        expect(prismaUser.upsert).not.toHaveBeenCalled();
      });

      it('SEC-020: throws ForbiddenException and does NOT claim the row when email_verified is absent', async () => {
        // Some IdPs omit the email_verified claim entirely (treated as unverified per OIDC Core §5.7).
        (jose.jwtVerify as jest.Mock).mockResolvedValue({
          payload: {
            sub: 'attacker-no-verified-claim',
            email: 'admin@lazyit.local',
            // email_verified intentionally absent
            given_name: 'Evil',
            family_name: 'Attacker',
          },
        });
        prismaUser.findFirst.mockImplementation(
          routeFindFirst({
            byExternalId: () => null,
            byEmail: () => ({ ...SEED_ADMIN, externalId: null }),
          }),
        );

        const req: Record<string, unknown> = {
          headers: { authorization: 'Bearer attacker.token.here' },
        };

        await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(prismaUser.updateMany).not.toHaveBeenCalled();
        expect(prismaUser.upsert).not.toHaveBeenCalled();
      });

      it('SEC-020: claims the row when email_verified is true (boolean) — legitimate operator login still works', async () => {
        // The positive path: the IdP has verified the email → the claim is permitted.
        (jose.jwtVerify as jest.Mock).mockResolvedValue({
          payload: {
            sub: 'legit-operator-sub',
            email: 'admin@lazyit.local',
            email_verified: true,
            given_name: 'Real',
            family_name: 'Operator',
          },
        });
        const claimedRow = {
          ...SEED_ADMIN,
          externalId: 'legit-operator-sub',
          firstName: 'Real',
          lastName: 'Operator',
        };
        let claimed = false;
        prismaUser.findFirst.mockImplementation(
          routeFindFirst({
            byExternalId: () => null,
            byEmail: () => ({ ...SEED_ADMIN, externalId: null }),
            byId: () =>
              claimed ? claimedRow : { ...SEED_ADMIN, externalId: null },
          }),
        );
        prismaUser.updateMany.mockImplementation(() => {
          claimed = true;
          return Promise.resolve({ count: 1 });
        });

        const req: Record<string, unknown> = {
          headers: { authorization: 'Bearer valid.token.here' },
        };

        const result = await guard.canActivate(makeCtx(req));

        expect(result).toBe(true);
        // The claim must have fired.
        expect(prismaUser.updateMany).toHaveBeenCalledWith({
          where: { id: SEED_ADMIN.id, externalId: null },
          data: {
            externalId: 'legit-operator-sub',
            // ADR-0069 REDESIGN §3.5: directoryOnly flipped false on the claim/promotion.
            directoryOnly: false,
            firstName: 'Real',
            lastName: 'Operator',
          },
        });
        expect(prismaUser.upsert).not.toHaveBeenCalled();
        expect((req.user as { role?: string }).role).toBe('ADMIN');
      });

      it('SEC-020: claims the row when email_verified is the string "true" (some IdPs emit it as a string)', async () => {
        (jose.jwtVerify as jest.Mock).mockResolvedValue({
          payload: {
            sub: 'string-true-sub',
            email: 'admin@lazyit.local',
            email_verified: 'true',
            given_name: 'String',
            family_name: 'True',
          },
        });
        const claimedRow = {
          ...SEED_ADMIN,
          externalId: 'string-true-sub',
          firstName: 'String',
          lastName: 'True',
        };
        let claimed = false;
        prismaUser.findFirst.mockImplementation(
          routeFindFirst({
            byExternalId: () => null,
            byEmail: () => ({ ...SEED_ADMIN, externalId: null }),
            byId: () =>
              claimed ? claimedRow : { ...SEED_ADMIN, externalId: null },
          }),
        );
        prismaUser.updateMany.mockImplementation(() => {
          claimed = true;
          return Promise.resolve({ count: 1 });
        });

        const req: Record<string, unknown> = {
          headers: { authorization: 'Bearer valid.token.here' },
        };

        const result = await guard.canActivate(makeCtx(req));

        expect(result).toBe(true);
        expect(prismaUser.updateMany).toHaveBeenCalled();
        expect(prismaUser.upsert).not.toHaveBeenCalled();
      });

      it('creates a fresh user as before when there is NO email collision', async () => {
        (jose.jwtVerify as jest.Mock).mockResolvedValue({
          payload: {
            sub: 'oidc-sub-fresh',
            email: 'fresh@corp.com',
            given_name: 'Fresh',
            family_name: 'Hire',
          },
        });
        // Both the externalId lookup AND the email lookup miss → fall through to the create/upsert.
        prismaUser.findFirst.mockImplementation(
          routeFindFirst({ byExternalId: () => null, byEmail: () => null }),
        );
        prismaUser.upsert.mockImplementation(echoUpsertedUser);

        await guard.canActivate(
          makeCtx({ headers: { authorization: 'Bearer valid.token.here' } }),
        );

        expect(prismaUser.updateMany).not.toHaveBeenCalled();
        expect(prismaUser.upsert).toHaveBeenCalledWith({
          where: { externalId: 'oidc-sub-fresh' },
          create: {
            externalId: 'oidc-sub-fresh',
            email: 'fresh@corp.com',
            firstName: 'Fresh',
            lastName: 'Hire',
            isActive: true,
            role: 'VIEWER',
          },
          update: {},
        });
      });

      it('does NOT link (no resurrection) a SOFT-DELETED same-email user — the live email lookup misses', async () => {
        (jose.jwtVerify as jest.Mock).mockResolvedValue({
          payload: {
            sub: 'oidc-sub-rehire',
            email: 'offboarded@corp.com',
            given_name: 'Re',
            family_name: 'Hire',
          },
        });
        // The email lookup uses the soft-delete-FILTERED client, so a soft-deleted same-email user
        // is invisible (returns null). The guard must create a fresh row, never claim/resurrect.
        // (Modeled here by byEmail returning null — exactly what the filtered client yields.)
        prismaUser.findFirst.mockImplementation(
          routeFindFirst({ byExternalId: () => null, byEmail: () => null }),
        );
        prismaUser.upsert.mockImplementation(echoUpsertedUser);

        await guard.canActivate(
          makeCtx({ headers: { authorization: 'Bearer t' } }),
        );

        // The email lookup must NOT pass includeSoftDeleted (it must only see LIVE rows).
        const emailCall = (
          prismaUser.findFirst.mock.calls as Array<[Record<string, unknown>]>
        ).find((c) => 'email' in ((c[0]?.where as object) ?? {}));
        expect(emailCall).toBeDefined();
        expect(emailCall![0]).not.toHaveProperty('includeSoftDeleted');

        expect(prismaUser.updateMany).not.toHaveBeenCalled();
        // A brand-new row is created instead of reviving the offboarded one.
        expect(prismaUser.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { externalId: 'oidc-sub-rehire' },
          }),
        );
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
            role: 'VIEWER',
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
        // Placeholder fallback from the bare sub. Hardened: BOTH names fall back to the email
        // local-part (here the sub, since email is `${sub}@unknown`) so neither violates the
        // @lazyit/shared User schema (.min(1)).
        expect(prismaUser.upsert).toHaveBeenCalledWith({
          where: { externalId: 'oidc-sub-fail' },
          create: {
            externalId: 'oidc-sub-fail',
            email: 'oidc-sub-fail@unknown',
            firstName: 'oidc-sub-fail',
            lastName: 'oidc-sub-fail',
            isActive: true,
            role: 'VIEWER',
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
        // Hardened: both names fall back to the email local-part (the sub here), never empty.
        expect(prismaUser.upsert).toHaveBeenCalledWith({
          where: { externalId: 'oidc-sub-throw' },
          create: {
            externalId: 'oidc-sub-throw',
            email: 'oidc-sub-throw@unknown',
            firstName: 'oidc-sub-throw',
            lastName: 'oidc-sub-throw',
            isActive: true,
            role: 'VIEWER',
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
