import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
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

// Build a fake ExecutionContext wrapping the given request object.
function makeCtx(req: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as never;
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let prismaUser: { findFirst: jest.Mock; create: jest.Mock };

  beforeEach(async () => {
    prismaUser = { findFirst: jest.fn(), create: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        JwtAuthGuard,
        {
          provide: PrismaService,
          useValue: { user: prismaUser },
        },
      ],
    }).compile();

    guard = moduleRef.get(JwtAuthGuard);
    guard.resetJwks();

    // Reset jose mocks between tests.
    jest.clearAllMocks();
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
      (jose.jwtVerify as jest.Mock).mockRejectedValue(
        new Error('JWTExpired'),
      );
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
      expect(prismaUser.create).not.toHaveBeenCalled();
    });

    it('JIT-creates a new User when sub is unknown (first login)', async () => {
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
      const newUser = { ...DB_USER, id: 'new-uuid', externalId: 'oidc-sub-new', email: 'bob@example.com', firstName: 'Bob', lastName: 'Jones' };
      prismaUser.create.mockResolvedValue(newUser);

      const req: Record<string, unknown> = {
        headers: { authorization: 'Bearer valid.token.here' },
      };

      const result = await guard.canActivate(makeCtx(req));

      expect(result).toBe(true);
      expect(req.user).toEqual(newUser);
      expect(prismaUser.create).toHaveBeenCalledWith({
        data: {
          externalId: 'oidc-sub-new',
          email: 'bob@example.com',
          firstName: 'Bob',
          lastName: 'Jones',
          isActive: true,
        },
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
      prismaUser.create.mockResolvedValue({ ...DB_USER, externalId: 'oidc-sub-x' });

      await guard.canActivate(makeCtx({
        headers: { authorization: 'Bearer t' },
      }));

      expect(prismaUser.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ firstName: 'Carol', lastName: 'Chen' }),
        }),
      );
    });

    it('uses email local-part as firstName when neither name nor given_name present', async () => {
      (jose.jwtVerify as jest.Mock).mockResolvedValue({
        payload: {
          sub: 'oidc-sub-y',
          email: 'dana@example.com',
        },
      });
      prismaUser.findFirst.mockResolvedValue(null);
      prismaUser.create.mockResolvedValue({ ...DB_USER, externalId: 'oidc-sub-y' });

      await guard.canActivate(makeCtx({
        headers: { authorization: 'Bearer t' },
      }));

      expect(prismaUser.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ firstName: 'dana', lastName: '' }),
        }),
      );
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
  });
});
