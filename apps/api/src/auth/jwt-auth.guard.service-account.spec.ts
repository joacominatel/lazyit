import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { UnauthorizedException } from '@nestjs/common';

// Prevent the real jose / generated prisma client from loading in unit tests.
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
}));
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));

import { JwtAuthGuard } from './jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { mintToken } from '../service-accounts/service-account-token';
import type { Principal } from './principal';

// Build a fake ExecutionContext wrapping the given request object (no @Public metadata).
function makeCtx(req: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as never;
}

const SA_ID = 'ckg9z1a2b0000qzrmn831k4d8';
// A real minted token for SA_ID, so the secret actually hashes to the stored tokenHash.
const minted = mintToken(SA_ID);

// A live, active, non-expired service account row with the real tokenHash.
function liveAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: SA_ID,
    name: 'ci-runner',
    description: null,
    tokenHash: minted.tokenHash,
    tokenPrefix: minted.tokenPrefix,
    isActive: true,
    expiresAt: null,
    lastUsedAt: null,
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

/**
 * JwtAuthGuard — SERVICE-ACCOUNT branch (ADR-0048). DB-FIRST: every gate is checked against the DB row,
 * never a token claim. A valid token authenticates; a wrong secret / revoked / expired / inactive
 * account → a generic 401. Humans are untouched (covered by jwt-auth.guard.spec.ts).
 */
describe('JwtAuthGuard — service-account branch (ADR-0048)', () => {
  let guard: JwtAuthGuard;
  let saFindFirst: jest.Mock;
  let saUpdate: jest.Mock;
  let sapFindMany: jest.Mock;

  beforeEach(async () => {
    saFindFirst = jest.fn();
    saUpdate = jest.fn().mockResolvedValue({});
    sapFindMany = jest.fn().mockResolvedValue([{ permission: 'asset:write' }]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        JwtAuthGuard,
        Reflector,
        {
          provide: PrismaService,
          useValue: {
            user: { findFirst: jest.fn() },
            serviceAccount: { findFirst: saFindFirst, update: saUpdate },
            serviceAccountPermission: { findMany: sapFindMany },
          },
        },
      ],
    }).compile();

    guard = moduleRef.get(JwtAuthGuard);
    guard.resetJwks();
    jest.clearAllMocks();
    sapFindMany.mockResolvedValue([{ permission: 'asset:write' }]);
    saUpdate.mockResolvedValue({});
  });

  function req(token: string): Record<string, unknown> {
    return { headers: { authorization: `Bearer ${token}` } };
  }

  it('authenticates a valid token: sets request.principal (service) + serviceAccount, NOT user', async () => {
    saFindFirst.mockResolvedValue(liveAccount());
    const r = req(minted.token);

    await expect(guard.canActivate(makeCtx(r))).resolves.toBe(true);

    const principal = r.principal as Principal;
    expect(principal.kind).toBe('service');
    expect(r.serviceAccount).toBeDefined();
    expect(r.user).toBeUndefined();
    // Looked up by id INCLUDING soft-deleted rows (so a revoked account is seen).
    expect(saFindFirst).toHaveBeenCalledWith({
      where: { id: SA_ID },
      includeSoftDeleted: true,
    });
    // Resolved its direct grants DB-first.
    if (principal.kind === 'service') {
      expect(principal.permissions.has('asset:write')).toBe(true);
    }
  });

  it('stamps lastUsedAt best-effort on success (fire-and-forget, never blocks)', async () => {
    saFindFirst.mockResolvedValue(liveAccount());
    await guard.canActivate(makeCtx(req(minted.token)));
    expect(saUpdate).toHaveBeenCalledWith({
      where: { id: SA_ID },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it('succeeds even if the lastUsedAt write rejects (best-effort)', async () => {
    saFindFirst.mockResolvedValue(liveAccount());
    saUpdate.mockRejectedValue(new Error('db down'));
    await expect(guard.canActivate(makeCtx(req(minted.token)))).resolves.toBe(
      true,
    );
  });

  it('401s a WRONG secret (constant-time compare fails) — and never resolves permissions', async () => {
    saFindFirst.mockResolvedValue(liveAccount());
    // Same id, but a tampered secret segment.
    const tampered = `lzit_sa_${SA_ID}_tamperedSecretValue`;
    await expect(
      guard.canActivate(makeCtx(req(tampered))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sapFindMany).not.toHaveBeenCalled();
  });

  it('401s an UNKNOWN service account id (no row) without a secret compare', async () => {
    saFindFirst.mockResolvedValue(null);
    await expect(
      guard.canActivate(makeCtx(req(minted.token))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('401s a REVOKED (soft-deleted) account', async () => {
    saFindFirst.mockResolvedValue(liveAccount({ deletedAt: new Date() }));
    await expect(
      guard.canActivate(makeCtx(req(minted.token))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sapFindMany).not.toHaveBeenCalled();
  });

  it('401s an INACTIVE (isActive=false) account', async () => {
    saFindFirst.mockResolvedValue(liveAccount({ isActive: false }));
    await expect(
      guard.canActivate(makeCtx(req(minted.token))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('401s an EXPIRED account (expiresAt in the past)', async () => {
    saFindFirst.mockResolvedValue(
      liveAccount({ expiresAt: new Date(Date.now() - 1000) }),
    );
    await expect(
      guard.canActivate(makeCtx(req(minted.token))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts an account whose expiresAt is in the FUTURE', async () => {
    saFindFirst.mockResolvedValue(
      liveAccount({ expiresAt: new Date(Date.now() + 60_000) }),
    );
    await expect(guard.canActivate(makeCtx(req(minted.token)))).resolves.toBe(
      true,
    );
  });

  it('401s a malformed SA token (missing secret segment) before any DB lookup', async () => {
    await expect(
      guard.canActivate(makeCtx(req(`lzit_sa_${SA_ID}`))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(saFindFirst).not.toHaveBeenCalled();
  });

  it('does NOT enter the SA branch for a non-SA bearer (falls through to human auth)', async () => {
    // A plain (non-lzit_sa_) bearer in shim mode → human path, which never touches serviceAccount.
    const prevMode = process.env.AUTH_MODE;
    process.env.AUTH_MODE = 'shim';
    try {
      const r: Record<string, unknown> = {
        headers: { authorization: 'Bearer some.jwt.token', 'x-user-id': '' },
      };
      await guard.canActivate(makeCtx(r));
      expect(saFindFirst).not.toHaveBeenCalled();
    } finally {
      if (prevMode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = prevMode;
    }
  });
});
