/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/unbound-method -- harness rows are untyped; handler references are read for their metadata only */
// The generated client never loads under Jest (no DB); the services run over FakeOAuthPrisma instead.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Permission } from '@lazyit/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { PERMISSION_KEY } from '../auth/require-permission.decorator';
import { RolesGuard } from '../auth/roles.guard';
import {
  buildHarness,
  connect,
  enableMcp,
  seedUser,
  useHttpsInstance,
  type Harness,
} from '../../test/oauth/oauth-harness';
import { GrantsController } from './grants.controller';
import { GrantsService } from './grants.service';

const ENV_KEYS = ['WEB_ORIGIN', 'AUTH_MODE'] as const;
const savedEnv: Record<string, string | undefined> = {};

let h: Harness;
let caller: any;

class SignedInGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Record<string, unknown>>();
    req.user = caller;
    req.principal = { kind: 'human', user: caller };
    return true;
  }
}

describe('GrantsController — a user without ai:connect (AUD-083)', () => {
  let app: INestApplication<App>;
  let other: any;

  beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    useHttpsInstance();
    h = buildHarness();
    enableMcp(h);
    caller = seedUser(h);
    other = seedUser(h);
    await connect(h, caller);
    await connect(h, other);
    // Connected while MEMBER held ai:connect; an admin withdrew it afterwards.
    h.rolePermissions.set('MEMBER', new Set());

    const moduleRef = await Test.createTestingModule({
      controllers: [GrantsController],
      providers: [
        { provide: GrantsService, useValue: h.grants },
        {
          provide: PermissionResolverService,
          useValue: {
            hasAll: (role: string, required: readonly Permission[]) =>
              Promise.resolve(
                required.every((p) => h.rolePermissions.get(role)?.has(p)),
              ),
          },
        },
        { provide: APP_GUARD, useClass: SignedInGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  const grantOf = (user: any): any =>
    h.prisma.tables.oAuthGrant.find((g: any) => g.userId === user.id);

  it('lists only their own connections', async () => {
    const res = await request(app.getHttpServer())
      .get('/oauth/grants/mine')
      .expect(200);
    expect(res.body).toEqual([
      expect.objectContaining({ id: grantOf(caller).id, kind: 'oauth' }),
    ]);
  });

  it('cannot list or revoke anyone else’s, but revokes their own', async () => {
    await request(app.getHttpServer())
      .get(`/oauth/grants?userId=${other.id}`)
      .expect(403);
    await request(app.getHttpServer())
      .delete(`/oauth/grants/${grantOf(other).id}`)
      .expect(404);
    expect(grantOf(other).deletedAt).toBeNull();

    await request(app.getHttpServer())
      .delete(`/oauth/grants/${grantOf(caller).id}`)
      .expect(204);
    await request(app.getHttpServer())
      .get('/oauth/grants/mine')
      .expect(200, []);
  });

  it('gates only the admin list (route metadata)', () => {
    const reflector = new Reflector();
    const proto = GrantsController.prototype;
    expect(reflector.get(PERMISSION_KEY, proto.listMine)).toBeUndefined();
    expect(reflector.get(PERMISSION_KEY, proto.revoke)).toBeUndefined();
    expect(reflector.get(PERMISSION_KEY, proto.list)).toEqual([
      'settings:manage',
    ]);
  });
});
