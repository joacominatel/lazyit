// The controller transitively loads AssetCategoriesService → the generated Prisma client. Stub it
// (the service is replaced by a mock below; this only stops the real module from loading).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AssetCategoriesController } from './asset-categories.controller';
import { AssetCategoriesService } from './asset-categories.service';

const CATEGORY_ID = 'clh1abc0000xyz0000000cate';
const TARGET = 'clh1abc0000xyz0000000tgt0';

/** Stands in for the global guard chain: a signed-in admin. */
class SignedInGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Record<string, unknown>>();
    const user = { id: 'u-admin', role: 'ADMIN', sessionEpoch: 0 };
    req.user = user;
    req.principal = { kind: 'human', user };
    return true;
  }
}

describe('AssetCategoriesController — DELETE resolution query (SEC-041)', () => {
  let app: INestApplication<App>;
  const service = { remove: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AssetCategoriesController],
      providers: [
        { provide: AssetCategoriesService, useValue: service },
        { provide: APP_GUARD, useClass: SignedInGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    service.remove.mockReset();
    service.remove.mockResolvedValue({ id: CATEGORY_ID });
  });

  it('no query is no resolution (the service then refuses while models are left)', async () => {
    await request(app.getHttpServer())
      .delete(`/asset-categories/${CATEGORY_ID}`)
      .expect(200);
    expect(service.remove).toHaveBeenCalledWith(CATEGORY_ID, undefined);
  });

  it('forwards detach, and move with its target', async () => {
    await request(app.getHttpServer()).delete(
      `/asset-categories/${CATEGORY_ID}?strategy=detach`,
    );
    await request(app.getHttpServer()).delete(
      `/asset-categories/${CATEGORY_ID}?strategy=move&targetId=${TARGET}`,
    );
    expect(service.remove.mock.calls.map((c: unknown[]) => c[1])).toEqual([
      { strategy: 'detach' },
      { strategy: 'move', targetId: TARGET },
    ]);
  });

  it.each(['?strategy=move', '?strategy=move&targetId=not-a-cuid'])(
    '400s %s before the service',
    async (query) => {
      await request(app.getHttpServer())
        .delete(`/asset-categories/${CATEGORY_ID}${query}`)
        .expect(400);
      expect(service.remove).not.toHaveBeenCalled();
    },
  );
});
