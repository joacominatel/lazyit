import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

// Keep the real jose / generated Prisma client from loading (the DB is mocked).
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
import { LocalCredentialService } from './local/local-credential.service';
import { PrismaService } from '../prisma/prisma.service';
import { mintToken } from '../service-accounts/service-account-token';
import { attachDelegatedIdentity } from './delegated-identity';
import { CurrentPrincipal } from './current-principal.decorator';
import { PrincipalLoaderService } from './principal-loader.service';
import { ServiceAccountAuthenticator } from './service-account-authenticator';
import type { Principal } from './principal';

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const SA_ID = 'ckg9z1a2b0000qzrmn831k4d8';
const minted = mintToken(SA_ID);

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_A,
    email: 'a@example.com',
    role: 'MEMBER',
    isActive: true,
    directoryOnly: false,
    mustChangePassword: false,
    sessionEpoch: 3,
    deletedAt: null,
    ...overrides,
  };
}

function saRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SA_ID,
    name: 'ci-runner',
    tokenHash: minted.tokenHash,
    tokenPrefix: minted.tokenPrefix,
    isActive: true,
    expiresAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function makeCtx(req: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as never;
}

/** A synthetic request as the AI tool dispatcher builds it (no headers, the identity on the symbol). */
function delegated(identity: Parameters<typeof attachDelegatedIdentity>[1]) {
  const req: Record<string, unknown> = { headers: {} };
  attachDelegatedIdentity(req, identity);
  return req;
}

function network(token: string): Record<string, unknown> {
  return { headers: { authorization: `Bearer ${token}` } };
}

describe('JwtAuthGuard — delegated-identity branch (ADR-0097, R1)', () => {
  const originalMode = process.env.AUTH_MODE;
  let guard: JwtAuthGuard;
  let userFindFirst: jest.Mock;
  let saFindFirst: jest.Mock;
  let sapFindMany: jest.Mock;
  let verifySession: jest.Mock;

  beforeEach(() => {
    process.env.AUTH_MODE = 'local';
    userFindFirst = jest.fn();
    saFindFirst = jest.fn();
    sapFindMany = jest.fn().mockResolvedValue([{ permission: 'asset:read' }]);
    // The local session token used by the network branch: `<userId>` with epoch 3.
    verifySession = jest.fn((token: string) =>
      Promise.resolve({ sub: token, epoch: 3, rememberMe: false }),
    );
    const prisma = {
      user: { findFirst: userFindFirst },
      serviceAccount: {
        findFirst: saFindFirst,
        update: jest.fn().mockResolvedValue({}),
      },
      serviceAccountPermission: { findMany: sapFindMany },
    } as unknown as PrismaService;
    const loader = new PrincipalLoaderService(prisma);
    guard = new JwtAuthGuard(
      prisma,
      new Reflector(),
      { verifySession } as unknown as LocalCredentialService,
      loader,
      new ServiceAccountAuthenticator(prisma, loader),
    );
  });

  afterAll(() => {
    process.env.AUTH_MODE = originalMode;
  });

  it('authenticates a delegated human: re-loads the live row and sets user + human principal', async () => {
    const row = userRow();
    userFindFirst.mockResolvedValue(row);
    const req = delegated({ kind: 'human', userId: USER_A, sessionEpoch: 3 });

    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);

    expect(userFindFirst).toHaveBeenCalledWith({ where: { id: USER_A } });
    expect(req.user).toBe(row);
    expect(req.principal).toEqual({ kind: 'human', user: row });
    expect(verifySession).not.toHaveBeenCalled();
  });

  it('authenticates a delegated service account: re-loads it (incl. revoked rows) and its grants', async () => {
    saFindFirst.mockResolvedValue(saRow());
    const req = delegated({ kind: 'service', serviceAccountId: SA_ID });

    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);

    expect(saFindFirst).toHaveBeenCalledWith({
      where: { id: SA_ID },
      includeSoftDeleted: true,
    });
    const principal = req.principal as Principal;
    expect(principal.kind).toBe('service');
    expect(req.user).toBeUndefined();
    if (principal.kind === 'service') {
      expect([...principal.permissions]).toEqual(['asset:read']);
    }
  });

  it('prefers the delegated identity over any header the request carries', async () => {
    userFindFirst.mockResolvedValue(userRow());
    const req = delegated({ kind: 'human', userId: USER_A, sessionEpoch: 3 });
    (req.headers as Record<string, string>).authorization =
      `Bearer ${minted.token}`;

    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
    expect(saFindFirst).not.toHaveBeenCalled();
    expect((req.principal as Principal).kind).toBe('human');
  });

  it('refuses a malformed delegated identity without touching the DB', async () => {
    const req = delegated({ kind: 'human', userId: USER_A } as never);
    await expect(guard.canActivate(makeCtx(req))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(userFindFirst).not.toHaveBeenCalled();
  });

  it('refuses a non-uuid delegated user id without touching the DB', async () => {
    const req = delegated({ kind: 'human', userId: 'admin', sessionEpoch: 3 });
    await expect(guard.canActivate(makeCtx(req))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(userFindFirst).not.toHaveBeenCalled();
  });

  /**
   * DB-RELOAD PARITY: the delegated branch refuses exactly what the network branch refuses, for the same
   * principal state. Humans are compared with the local session branch (`handleLocal`), service accounts
   * with the `lzit_sa_` token branch.
   */
  describe('DB-reload parity with the network branches', () => {
    const humanCases: Array<[string, unknown, boolean]> = [
      ['a live, active user', userRow(), true],
      ['an offboarded (soft-deleted, invisible) user', null, false],
      ['a sessionEpoch mismatch', userRow({ sessionEpoch: 4 }), false],
      ['an inactive user', userRow({ isActive: false }), false],
      ['a directory-only person', userRow({ directoryOnly: true }), false],
    ];

    it.each(humanCases)(
      'human — %s: network and delegated agree',
      async (_label, row, allowed) => {
        userFindFirst.mockResolvedValue(row);
        const outcome = (req: Record<string, unknown>) =>
          guard.canActivate(makeCtx(req)).then(
            () => true,
            (err: unknown) => {
              expect(err).toBeInstanceOf(UnauthorizedException);
              return false;
            },
          );

        const viaNetwork = await outcome(network(USER_A));
        const viaDelegation = await outcome(
          delegated({ kind: 'human', userId: USER_A, sessionEpoch: 3 }),
        );

        expect(viaNetwork).toBe(allowed);
        expect(viaDelegation).toBe(allowed);
      },
    );

    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    const saCases: Array<[string, unknown, boolean]> = [
      ['a live account', saRow(), true],
      ['a live account expiring later', saRow({ expiresAt: future }), true],
      ['a revoked (soft-deleted) account', saRow({ deletedAt: past }), false],
      ['an inactive account', saRow({ isActive: false }), false],
      ['an expired account', saRow({ expiresAt: past }), false],
      ['an unknown account', null, false],
    ];

    it.each(saCases)(
      'service account — %s: network and delegated agree',
      async (_label, row, allowed) => {
        saFindFirst.mockResolvedValue(row);
        const outcome = async (req: Record<string, unknown>) => {
          try {
            await guard.canActivate(makeCtx(req));
            const principal = req.principal as Principal;
            return principal.kind === 'service'
              ? [...principal.permissions]
              : null;
          } catch (err) {
            expect(err).toBeInstanceOf(UnauthorizedException);
            return false;
          }
        };

        const viaNetwork = await outcome(network(minted.token));
        const viaDelegation = await outcome(
          delegated({ kind: 'service', serviceAccountId: SA_ID }),
        );

        expect(viaDelegation).toEqual(viaNetwork);
        expect(viaNetwork !== false).toBe(allowed);
      },
    );
  });
});

@Controller('probe')
class ProbeController {
  /** Echo who the guard authenticated and whether any delegated-identity symbol is on the request. */
  @Get()
  whoAmI(@CurrentPrincipal() principal?: Principal, @Req() req?: object) {
    return whoAmIResult(principal, req);
  }

  @Post()
  whoAmIPost(
    @Body() _body: unknown,
    @CurrentPrincipal() principal?: Principal,
    @Req() req?: object,
  ) {
    return whoAmIResult(principal, req);
  }
}

function whoAmIResult(
  principal: Principal | undefined,
  req: object | undefined,
) {
  return {
    kind: principal?.kind ?? null,
    id:
      principal?.kind === 'human'
        ? principal.user.id
        : (principal?.serviceAccount.id ?? null),
    delegatedSymbols: Object.getOwnPropertySymbols(req ?? {}).filter(
      (s) => s.description === 'lazyit.delegatedIdentity',
    ).length,
  };
}

/**
 * NETWORK UNREACHABILITY: over real HTTP (Express body/query parsing, the real global guard), no header,
 * query string or JSON body can put a delegated identity on a request. Anonymous attempts stay 401; an
 * authenticated caller stays exactly who their token says, and the identity they tried to smuggle in is
 * never even looked up.
 */
describe('JwtAuthGuard — the delegated branch is unreachable from the network', () => {
  const originalMode = process.env.AUTH_MODE;
  let app: INestApplication<App>;
  let userFindFirst: jest.Mock;

  const smuggled = { kind: 'human', userId: USER_B, sessionEpoch: 1 };
  const smuggledJson = JSON.stringify(smuggled);

  beforeAll(async () => {
    process.env.AUTH_MODE = 'local';
    userFindFirst = jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        where.id === USER_A
          ? userRow()
          : userRow({ id: where.id, sessionEpoch: 1 }),
      ),
    );
    const prisma = {
      user: { findFirst: userFindFirst },
      serviceAccount: { findFirst: jest.fn(), update: jest.fn() },
      serviceAccountPermission: { findMany: jest.fn() },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        {
          provide: LocalCredentialService,
          // A valid session only for the exact token `session-a` (user A, epoch 3).
          useValue: {
            verifySession: (token: string) =>
              token === 'session-a'
                ? Promise.resolve({ sub: USER_A, epoch: 3, rememberMe: false })
                : Promise.reject(new Error('bad token')),
          },
        },
        PrincipalLoaderService,
        ServiceAccountAuthenticator,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env.AUTH_MODE = originalMode;
  });

  beforeEach(() => userFindFirst.mockClear());

  const smuggleBody = {
    'Symbol(lazyit.delegatedIdentity)': smuggled,
    delegatedIdentity: smuggled,
    constructor: { prototype: { delegatedIdentity: smuggled } },
  };

  it.each([
    ['a look-alike header', { 'x-delegated-identity': smuggledJson }],
    [
      'a header named after the symbol',
      { 'lazyit.delegatedIdentity': smuggledJson },
    ],
  ])('anonymous request with %s → 401', async (_label, headers) => {
    const res = await request(app.getHttpServer()).get('/probe').set(headers);
    expect(res.status).toBe(401);
  });

  it('anonymous request with a smuggling query string → 401', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe')
      .query({ 'Symbol(lazyit.delegatedIdentity)': smuggledJson })
      .query('delegatedIdentity[kind]=human&__proto__[kind]=human');
    expect(res.status).toBe(401);
  });

  it('anonymous request with a smuggling JSON body (incl. __proto__) → 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/probe')
      .set('content-type', 'application/json')
      .send(
        `{"Symbol(lazyit.delegatedIdentity)":${smuggledJson},"__proto__":{"delegatedIdentity":${smuggledJson}},"delegatedIdentity":${smuggledJson}}`,
      );
    expect(res.status).toBe(401);
  });

  it('an authenticated caller stays themselves whatever they smuggle; the target is never loaded', async () => {
    const res = await request(app.getHttpServer())
      .post('/probe')
      .query({ delegatedIdentity: smuggledJson })
      .set('authorization', 'Bearer session-a')
      .set('x-delegated-identity', smuggledJson)
      .send(smuggleBody);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      kind: 'human',
      id: USER_A,
      delegatedSymbols: 0,
    });
    const lookedUp = (
      userFindFirst.mock.calls as Array<[{ where: { id: string } }]>
    ).map(([args]) => args.where.id);
    expect(lookedUp).toEqual([USER_A]);
  });
});
