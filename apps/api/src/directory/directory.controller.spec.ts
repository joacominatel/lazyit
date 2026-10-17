// The services load the generated Prisma client and, through UsersService, the ESM meilisearch package.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x },
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import type { Principal } from '../auth/principal';
import { DirectoryController } from './directory.controller';
import { DirectoryConnectionService } from './directory-connection.service';
import { DirectoryReconcileService } from './directory-reconcile.service';

describe('DirectoryController — writes are ADMIN-only (SEC-088)', () => {
  let app: INestApplication;

  // MEMBER (and the service account) hold settings:manage here: the delegation SEC-088 is about.
  const delegatedSet = new Set<string>(['settings:manage']);
  const resolverStub = {
    resolve: () => Promise.resolve(delegatedSet),
    hasAll: (role: string, required: string[]) =>
      Promise.resolve(
        role === 'ADMIN' || required.every((p) => delegatedSet.has(p)),
      ),
    invalidate: jest.fn(),
  };
  const connection = {
    getSettings: jest.fn().mockResolvedValue({ enabled: false }),
    updateSettings: jest.fn().mockResolvedValue({ enabled: true }),
  };
  const reconcile = {
    reconcile: jest.fn().mockResolvedValue({ ok: true }),
  };

  beforeAll(async () => {
    const fakeAuthGuard = {
      canActivate: (ctx: {
        switchToHttp: () => { getRequest: () => Record<string, unknown> };
      }) => {
        const req = ctx.switchToHttp().getRequest();
        const who = (req.headers as Record<string, string>)['x-test-who'];
        if (who === 'service') {
          const principal: Principal = {
            kind: 'service',
            serviceAccount: { id: 'sa-1' } as never,
            permissions: new Set(['settings:manage']),
          };
          req.principal = principal;
        } else if (who) {
          req.user = { id: 'u-' + who, role: who };
        }
        return true;
      },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [DirectoryController],
      providers: [
        { provide: DirectoryConnectionService, useValue: connection },
        { provide: DirectoryReconcileService, useValue: reconcile },
        { provide: PermissionResolverService, useValue: resolverStub },
        { provide: APP_GUARD, useValue: fakeAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    connection.updateSettings.mockClear();
    reconcile.reconcile.mockClear();
  });

  it('GET /directory/connection: a delegated MEMBER still reads it', async () => {
    const res = await request(app.getHttpServer())
      .get('/directory/connection')
      .set('X-Test-Who', 'MEMBER');
    expect(res.status).toBe(200);
  });

  it('PUT /directory/connection: a delegated MEMBER → 403 ADMIN_REQUIRED, nothing saved', async () => {
    const res = await request(app.getHttpServer())
      .put('/directory/connection')
      .set('X-Test-Who', 'MEMBER')
      .send({ enabled: true });
    expect(res.status).toBe(403);
    expect((res.body as { code?: string }).code).toBe('ADMIN_REQUIRED');
    expect(connection.updateSettings).not.toHaveBeenCalled();
  });

  it('POST /directory/sync: a delegated MEMBER → 403 ADMIN_REQUIRED, no sync runs', async () => {
    const res = await request(app.getHttpServer())
      .post('/directory/sync')
      .set('X-Test-Who', 'MEMBER');
    expect(res.status).toBe(403);
    expect((res.body as { code?: string }).code).toBe('ADMIN_REQUIRED');
    expect(reconcile.reconcile).not.toHaveBeenCalled();
  });

  it.each([
    ['put', '/directory/connection'],
    ['post', '/directory/sync'],
  ] as const)(
    '%s %s: a service account holding settings:manage → 403',
    async (method, path) => {
      const res = await request(app.getHttpServer())
        [method](path)
        .set('X-Test-Who', 'service')
        .send({ enabled: true });
      expect(res.status).toBe(403);
    },
  );

  it('PUT /directory/connection and POST /directory/sync: an ADMIN still succeeds', async () => {
    const put = await request(app.getHttpServer())
      .put('/directory/connection')
      .set('X-Test-Who', 'ADMIN')
      .send({ enabled: true });
    expect(put.status).toBe(200);
    const sync = await request(app.getHttpServer())
      .post('/directory/sync')
      .set('X-Test-Who', 'ADMIN');
    expect(sync.status).toBe(201);
    expect(connection.updateSettings).toHaveBeenCalledTimes(1);
    expect(reconcile.reconcile).toHaveBeenCalledTimes(1);
  });
});
