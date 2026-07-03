import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

// Keep the real jose / generated prisma client out of these unit tests: the local dispatch is exercised
// via a MOCKED LocalCredentialService (we control verifySession) + a mocked Prisma, and the oidc-branch
// cross-mode test drives a mocked jwtVerify. The credential crypto itself is covered end-to-end in
// local-credential.service.spec.ts (real argon2 + real jose).
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
}));
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));

import * as jose from 'jose';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import type { LocalCredentialService } from './local/local-credential.service';

const VALID_ID = '11111111-1111-1111-1111-111111111111';

const DB_USER = {
  id: VALID_ID,
  email: 'alice@example.com',
  firstName: 'Alice',
  lastName: 'Smith',
  isActive: true,
  directoryOnly: false,
  sessionEpoch: 3,
  role: 'MEMBER',
  externalId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

function makeCtx(req: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as never;
}

function bearer(token: string) {
  return { headers: { authorization: `Bearer ${token}` } } as Record<
    string,
    unknown
  >;
}

describe('JwtAuthGuard — handleLocal (AUTH_MODE=local, ADR-0086)', () => {
  let guard: JwtAuthGuard;
  let findFirst: jest.Mock;
  let verifySession: jest.Mock;
  const originalMode = process.env.AUTH_MODE;

  beforeEach(() => {
    process.env.AUTH_MODE = 'local';
    findFirst = jest.fn();
    verifySession = jest.fn();
    const prisma = { user: { findFirst } } as unknown as PrismaService;
    const credentials = {
      verifySession,
    } as unknown as LocalCredentialService;
    guard = new JwtAuthGuard(prisma, new Reflector(), credentials);
  });

  afterAll(() => {
    process.env.AUTH_MODE = originalMode;
  });

  it('authenticates a valid session token: sets request.user + human principal', async () => {
    verifySession.mockResolvedValue({ sub: VALID_ID, epoch: 3 });
    findFirst.mockResolvedValue(DB_USER);
    const req = bearer('good-token');

    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
    expect((req as { user?: unknown }).user).toEqual(DB_USER);
    expect((req as { principal?: unknown }).principal).toEqual({
      kind: 'human',
      user: DB_USER,
    });
    // The re-load is on the LIVE-filtered client (no includeSoftDeleted) by the user id.
    expect(findFirst).toHaveBeenCalledWith({ where: { id: VALID_ID } });
  });

  it('rejects a missing Bearer token', async () => {
    await expect(guard.canActivate(makeCtx({ headers: {} }))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an invalid/expired session token (verifySession throws)', async () => {
    verifySession.mockRejectedValue(new Error('bad signature'));
    await expect(
      guard.canActivate(makeCtx(bearer('tampered'))),
    ).rejects.toThrow(UnauthorizedException);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('REVOCATION: rejects a token whose epoch is below the live sessionEpoch', async () => {
    verifySession.mockResolvedValue({ sub: VALID_ID, epoch: 2 }); // stale
    findFirst.mockResolvedValue({ ...DB_USER, sessionEpoch: 3 }); // bumped
    await expect(guard.canActivate(makeCtx(bearer('stale')))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects when the user no longer exists (soft-deleted → live-filtered null)', async () => {
    verifySession.mockResolvedValue({ sub: VALID_ID, epoch: 3 });
    findFirst.mockResolvedValue(null);
    await expect(guard.canActivate(makeCtx(bearer('t')))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an inactive account', async () => {
    verifySession.mockResolvedValue({ sub: VALID_ID, epoch: 3 });
    findFirst.mockResolvedValue({ ...DB_USER, isActive: false });
    await expect(guard.canActivate(makeCtx(bearer('t')))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a directoryOnly account', async () => {
    verifySession.mockResolvedValue({ sub: VALID_ID, epoch: 3 });
    findFirst.mockResolvedValue({ ...DB_USER, directoryOnly: true });
    await expect(guard.canActivate(makeCtx(bearer('t')))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a token whose sub is not a uuid (never reaches Prisma)', async () => {
    verifySession.mockResolvedValue({ sub: 'not-a-uuid', epoch: 3 });
    await expect(guard.canActivate(makeCtx(bearer('t')))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(findFirst).not.toHaveBeenCalled();
  });

  describe('cross-mode rejection', () => {
    it('in OIDC mode a local token is NOT accepted by the local path (handleLocal never runs)', async () => {
      process.env.AUTH_MODE = 'oidc';
      process.env.OIDC_ISSUER = 'https://auth.example.com';
      // The oidc branch verifies via jose; a local HS256 token fails RS256 verification → 401.
      (jose.jwtVerify as jest.Mock).mockRejectedValue(new Error('bad alg'));
      await expect(
        guard.canActivate(makeCtx(bearer('local-hs256-token'))),
      ).rejects.toThrow(UnauthorizedException);
      // The LOCAL verifier was never consulted in oidc mode.
      expect(verifySession).not.toHaveBeenCalled();
      delete process.env.OIDC_ISSUER;
    });

    it('in LOCAL mode an OIDC (RS256) token is rejected (verifySession pins HS256 → throws)', async () => {
      process.env.AUTH_MODE = 'local';
      // The real service pins HS256; the mock stands in for that: an RS256/foreign token → throw.
      verifySession.mockRejectedValue(new Error('alg not allowed'));
      await expect(
        guard.canActivate(makeCtx(bearer('oidc-rs256-token'))),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
