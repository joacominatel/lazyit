import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(() => Promise.reject(new Error('not a JWT'))),
}));
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LocalCredentialService } from '../auth/local/local-credential.service';
import type { PrismaService } from '../prisma/prisma.service';
import { mintOpaqueToken } from './oauth-crypto';

/**
 * INV-AI-9 / INV-MCP-1: OAuth tokens are accepted ONLY on `/mcp`. The REST API's global guard must
 * reject `lzit_oat_` and `lzit_ort_` tokens on every route by construction — they are neither a local
 * HS256 session nor an IdP JWT nor a service-account token — so a leaked MCP token can never drive the
 * REST API. This pins that with the REAL local credential verifier.
 */
describe('OAuth tokens are refused by the REST guard (no token passthrough)', () => {
  const originalMode = process.env.AUTH_MODE;
  let findFirst: jest.Mock;
  let guard: JwtAuthGuard;

  const ctx = (token: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization: `Bearer ${token}` } }),
      }),
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
    }) as never;

  beforeEach(() => {
    findFirst = jest.fn();
    const prisma = {
      user: { findFirst },
      serviceAccount: { findFirst },
    } as unknown as PrismaService;
    guard = new JwtAuthGuard(
      prisma,
      new Reflector(),
      new LocalCredentialService(),
    );
  });

  afterAll(() => {
    process.env.AUTH_MODE = originalMode;
  });

  it.each(['local', 'oidc'])(
    'rejects access and refresh tokens in %s mode without touching the user table',
    async (mode) => {
      process.env.AUTH_MODE = mode;
      for (const prefix of ['lzit_oat_', 'lzit_ort_']) {
        await expect(
          guard.canActivate(ctx(mintOpaqueToken(prefix).value)),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      }
      expect(findFirst).not.toHaveBeenCalled();
    },
  );
});
