/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method -- jest matchers are typed any; handler references are read for their metadata only */
jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(() => Promise.reject(new Error('not a JWT'))),
}));

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD, APP_PIPE, Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { LocalCredentialService } from '../../auth/local/local-credential.service';
import { PERMISSION_KEY } from '../../auth/require-permission.decorator';
import { ServicePrincipalForbiddenGuard } from '../../auth/service-principal-forbidden.guard';
import type { PrismaService } from '../../prisma/prisma.service';
import { mintOpaqueToken } from '../oauth-crypto';
import { PersonalTokensController } from './personal-tokens.controller';
import { PersonalTokensService } from './personal-tokens.service';

/**
 * The personal-token routes over real HTTP (Express, Nest routing, the global zod pipe): the contract's
 * bounds are enforced on write, the minted token is `no-store`, and the route metadata keeps them
 * human-only and `ai:connect`-gated. And the REST guard refuses a `lzit_pat_` token everywhere — it is
 * accepted only on `/mcp` (INV-AI-9).
 */

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  role: 'MEMBER',
  sessionEpoch: 0,
};

/** Stands in for the global guard chain: a signed-in human. */
class SignedInGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Record<string, unknown>>();
    req.user = USER;
    req.principal = { kind: 'human', user: USER };
    return true;
  }
}

describe('PersonalTokensController — HTTP', () => {
  let app: INestApplication<App>;
  const service = {
    create: jest.fn(),
    listMine: jest.fn(),
    revokeMine: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PersonalTokensController],
      providers: [
        { provide: PersonalTokensService, useValue: service },
        { provide: APP_GUARD, useClass: SignedInGuard },
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
    jest.clearAllMocks();
    service.create.mockResolvedValue({
      token: 'lzit_pat_secret',
      grant: { id: 'ckgrant000000000000000000' },
    });
  });

  it('mints with no-store and passes the parsed contract (defaults applied)', async () => {
    const res = await request(app.getHttpServer())
      .post('/oauth/personal-tokens')
      .send({ label: '  laptop  ' })
      .expect(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(service.create).toHaveBeenCalledWith(
      USER,
      {
        label: 'laptop',
        expiresInDays: 90,
        scopes: ['lazyit.read', 'lazyit.write'],
      },
      expect.objectContaining({ ip: expect.any(String) }),
    );
  });

  it.each([
    [{ label: 'x', expiresInDays: 366 }],
    [{ label: 'x', expiresInDays: 0 }],
    [{ label: 'x', scopes: ['lazyit.admin'] }],
    [{ label: '' }],
    [{ label: 'x', userId: USER.id }],
  ])('refuses %j with 400 before the service runs', async (body) => {
    await request(app.getHttpServer())
      .post('/oauth/personal-tokens')
      .send(body)
      .expect(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('lists and revokes the caller’s own tokens', async () => {
    service.listMine.mockResolvedValue([]);
    await request(app.getHttpServer())
      .get('/oauth/personal-tokens')
      .expect(200, []);
    await request(app.getHttpServer())
      .delete('/oauth/personal-tokens/ckgrant000000000000000000')
      .expect(204);
    expect(service.revokeMine).toHaveBeenCalledWith(
      USER,
      'ckgrant000000000000000000',
      expect.any(Object),
    );
  });

  it('is human-only and gated on ai:connect (route metadata)', () => {
    const reflector = new Reflector();
    expect(
      Reflect.getMetadata(GUARDS_METADATA, PersonalTokensController),
    ).toContain(ServicePrincipalForbiddenGuard);
    const proto = PersonalTokensController.prototype;
    expect(reflector.get(PERMISSION_KEY, proto.create)).toEqual(['ai:connect']);
    expect(reflector.get(PERMISSION_KEY, proto.list)).toEqual(['ai:connect']);
    // Revoking your own token needs no permission (reducing your own delegation), like DELETE /oauth/grants/:id.
    expect(reflector.get(PERMISSION_KEY, proto.revoke)).toBeUndefined();
  });
});

describe('personal tokens are refused by the REST guard (no token passthrough)', () => {
  const originalMode = process.env.AUTH_MODE;
  afterAll(() => {
    process.env.AUTH_MODE = originalMode;
  });

  it.each(['local', 'oidc'])(
    'rejects a lzit_pat_ token in %s mode without touching the user table',
    async (mode) => {
      process.env.AUTH_MODE = mode;
      const findFirst = jest.fn();
      const guard = new JwtAuthGuard(
        {
          user: { findFirst },
          serviceAccount: { findFirst },
        } as unknown as PrismaService,
        new Reflector(),
        new LocalCredentialService(),
      );
      const ctx = {
        switchToHttp: () => ({
          getRequest: () => ({
            headers: {
              authorization: `Bearer ${mintOpaqueToken('lzit_pat_').value}`,
            },
          }),
        }),
        getHandler: () => function handler() {},
        getClass: () => class Controller {},
      } as never;
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(findFirst).not.toHaveBeenCalled();
    },
  );
});
