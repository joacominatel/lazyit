jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));

import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import type { Principal } from '../auth/principal';
import { SmtpController } from './smtp.controller';
import { SmtpService } from './smtp.service';

describe('SmtpController — the save is ADMIN-only (SEC-088)', () => {
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
  const smtp = {
    getSettings: jest.fn().mockResolvedValue({ enabled: false }),
    updateSettings: jest.fn().mockResolvedValue({ enabled: true }),
    sendTest: jest.fn().mockResolvedValue({ ok: true, error: null }),
  };
  const relay = {
    enabled: true,
    host: 'relay.attacker.example',
    port: 587,
    security: 'STARTTLS',
    rejectUnauthorized: true,
    fromAddress: 'it@corp.example',
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
      controllers: [SmtpController],
      providers: [
        { provide: SmtpService, useValue: smtp },
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
    smtp.updateSettings.mockClear();
    smtp.sendTest.mockClear();
  });

  it('PUT /config/smtp: a delegated MEMBER → 403 ADMIN_REQUIRED, nothing saved', async () => {
    const res = await request(app.getHttpServer())
      .put('/config/smtp')
      .set('X-Test-Who', 'MEMBER')
      .send(relay);
    expect(res.status).toBe(403);
    expect((res.body as { code?: string }).code).toBe('ADMIN_REQUIRED');
    expect(smtp.updateSettings).not.toHaveBeenCalled();
  });

  it('PUT /config/smtp: a service account holding settings:manage → 403', async () => {
    const res = await request(app.getHttpServer())
      .put('/config/smtp')
      .set('X-Test-Who', 'service')
      .send(relay);
    expect(res.status).toBe(403);
    expect(smtp.updateSettings).not.toHaveBeenCalled();
  });

  it('PUT /config/smtp: an ADMIN still saves', async () => {
    const res = await request(app.getHttpServer())
      .put('/config/smtp')
      .set('X-Test-Who', 'ADMIN')
      .send(relay);
    expect(res.status).toBe(200);
    expect(smtp.updateSettings).toHaveBeenCalledTimes(1);
  });

  it('GET and the test send stay on settings:manage for a delegated MEMBER', async () => {
    const get = await request(app.getHttpServer())
      .get('/config/smtp')
      .set('X-Test-Who', 'MEMBER');
    expect(get.status).toBe(200);
    const test = await request(app.getHttpServer())
      .post('/config/smtp/test')
      .set('X-Test-Who', 'MEMBER')
      .send({ to: 'me@corp.example' });
    expect(test.status).toBe(201);
    expect(smtp.sendTest).toHaveBeenCalledWith('me@corp.example');
  });
});
