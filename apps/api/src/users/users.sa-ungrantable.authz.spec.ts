import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import type { App } from 'supertest/types';

// Keep the real jose / generated Prisma client / meilisearch from loading (the DB is mocked).
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
}));
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x },
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { LocalCredentialService } from '../auth/local/local-credential.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { PrincipalLoaderService } from '../auth/principal-loader.service';
import { ServiceAccountAuthenticator } from '../auth/service-account-authenticator';
import { PrismaService } from '../prisma/prisma.service';
import { mintToken } from '../service-accounts/service-account-token';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { AccessGrantsService } from '../access-grants/access-grants.service';
import { ActorService } from '../common/actor.service';
import { VaultSetupNudgeService } from '../notifications/vault-setup-nudge.service';

const SA_ID = 'ckg9z1a2b0000qzrmn831k4d8';
const minted = mintToken(SA_ID);
const TARGET = '11111111-1111-4111-8111-111111111111';

/**
 * SEC-073 — a service account whose `service_account_permissions` still carries a row for an
 * SA-ungrantable verb (`user:manage`, persisted before the SEC-011 write-time refinement) must NOT hold
 * it: the verb is stripped when the principal is built, so every `user:manage` route refuses it with 403
 * even though `UsersController` carries no `ServicePrincipalForbiddenGuard` (INV-SA-3).
 *
 * Real JwtAuthGuard (SA-token branch, DB-first) + real RolesGuard over the real UsersController; only
 * Prisma and the controller's services are mocked.
 */
describe('UsersController — legacy SA-ungrantable grant is inert (SEC-073, INV-SA-3)', () => {
  const originalMode = process.env.AUTH_MODE;
  let app: INestApplication<App>;
  const create = jest.fn();
  const update = jest.fn();
  const findPage = jest.fn();
  const hasAll = jest.fn();

  beforeAll(async () => {
    process.env.AUTH_MODE = 'local';
    const prisma = {
      user: { findFirst: jest.fn() },
      serviceAccount: {
        findFirst: jest.fn().mockResolvedValue({
          id: SA_ID,
          name: 'ci-bot',
          tokenHash: minted.tokenHash,
          tokenPrefix: minted.tokenPrefix,
          isActive: true,
          expiresAt: null,
          deletedAt: null,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      // The legacy grant set: `user:manage` was granted before SEC-011 and never re-saved.
      serviceAccountPermission: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { permission: 'user:read' },
            { permission: 'user:manage' },
          ]),
      },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: LocalCredentialService, useValue: {} },
        { provide: PermissionResolverService, useValue: { hasAll } },
        PrincipalLoaderService,
        ServiceAccountAuthenticator,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        {
          provide: UsersService,
          useValue: {
            create,
            update,
            findPage,
            serializeUser: jest.fn((u: unknown) => Promise.resolve(u)),
          },
        },
        { provide: AssetAssignmentsService, useValue: {} },
        { provide: AccessGrantsService, useValue: {} },
        {
          provide: ActorService,
          useValue: { resolve: jest.fn().mockReturnValue(undefined) },
        },
        {
          provide: VaultSetupNudgeService,
          useValue: { notifyIfVaultSetupNeeded: jest.fn() },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env.AUTH_MODE = originalMode;
  });

  beforeEach(() => {
    create.mockReset().mockResolvedValue({ id: TARGET });
    update.mockReset().mockResolvedValue({ id: TARGET });
    findPage.mockReset().mockResolvedValue({ items: [], total: 0 });
    hasAll.mockReset();
  });

  const bearer = { Authorization: `Bearer ${minted.token}` };

  it('control: the token authenticates and a grantable verb (user:read) still authorizes', async () => {
    await request(app.getHttpServer()).get('/users').set(bearer).expect(200);
    expect(findPage).toHaveBeenCalled();
    // A service account never consults the role resolver.
    expect(hasAll).not.toHaveBeenCalled();
  });

  it('403s POST /users (create an ADMIN) — the legacy user:manage row confers nothing', async () => {
    await request(app.getHttpServer())
      .post('/users')
      .set(bearer)
      .send({
        email: 'eve@example.com',
        firstName: 'Eve',
        lastName: 'X',
        role: 'ADMIN',
      })
      .expect(403);
    expect(create).not.toHaveBeenCalled();
  });

  it('403s PATCH /users/:id with a role change — no promotion to ADMIN', async () => {
    await request(app.getHttpServer())
      .patch(`/users/${TARGET}`)
      .set(bearer)
      .send({ role: 'ADMIN' })
      .expect(403);
    expect(update).not.toHaveBeenCalled();
  });
});
