// The controller transitively loads AssetModelsService → the generated Prisma client. Stub it
// (the service is replaced by a mock below; this only stops the real module from loading).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AssetModelsController } from './asset-models.controller';
import { AssetModelsService } from './asset-models.service';

/**
 * `PATCH /asset-models/:id` over real HTTP (Express, Nest routing, the global zod pipe): a model's
 * category can be cleared with `categoryId: null` (#1315), its SKU and description with `null`
 * (#1441), and a non-cuid or an empty SKU is still refused.
 */

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  role: 'MEMBER',
  sessionEpoch: 0,
};
const MODEL_ID = 'clh1abc0000xyz0000000abcd';
const CATEGORY_ID = 'clh1abc0000xyz0000000cate';

/** Stands in for the global guard chain: a signed-in member. */
class SignedInGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Record<string, unknown>>();
    req.user = USER;
    req.principal = { kind: 'human', user: USER };
    return true;
  }
}

describe('AssetModelsController — PATCH clearing categoryId, sku, description', () => {
  let app: INestApplication<App>;
  const service = { update: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AssetModelsController],
      providers: [
        { provide: AssetModelsService, useValue: service },
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
    service.update.mockResolvedValue({ id: MODEL_ID, categoryId: null });
  });

  it('clears the category: null reaches the service', async () => {
    await request(app.getHttpServer())
      .patch(`/asset-models/${MODEL_ID}`)
      .send({ categoryId: null })
      .expect(200);
    expect(service.update).toHaveBeenCalledWith(MODEL_ID, { categoryId: null });
  });

  it('still changes it to another category by cuid', async () => {
    await request(app.getHttpServer())
      .patch(`/asset-models/${MODEL_ID}`)
      .send({ categoryId: CATEGORY_ID })
      .expect(200);
    expect(service.update).toHaveBeenCalledWith(MODEL_ID, {
      categoryId: CATEGORY_ID,
    });
  });

  it('clears the SKU and the description: null reaches the service (#1441)', async () => {
    await request(app.getHttpServer())
      .patch(`/asset-models/${MODEL_ID}`)
      .send({ sku: null, description: null })
      .expect(200);
    expect(service.update).toHaveBeenCalledWith(MODEL_ID, {
      sku: null,
      description: null,
    });
  });

  it('refuses an empty SKU (null, not "", is how to clear it)', async () => {
    await request(app.getHttpServer())
      .patch(`/asset-models/${MODEL_ID}`)
      .send({ sku: '' })
      .expect(400);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('refuses a categoryId that is not a cuid', async () => {
    await request(app.getHttpServer())
      .patch(`/asset-models/${MODEL_ID}`)
      .send({ categoryId: 'not-a-cuid' })
      .expect(400);
    expect(service.update).not.toHaveBeenCalled();
  });
});

describe('AssetModelsController — DELETE resolution query (SEC-041)', () => {
  let app: INestApplication<App>;
  const service = { remove: jest.fn() };
  const TARGET = 'clh1abc0000xyz0000000tgt0';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AssetModelsController],
      providers: [
        { provide: AssetModelsService, useValue: service },
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
    service.remove.mockReset();
    service.remove.mockResolvedValue({ id: MODEL_ID });
  });

  it('no query is no resolution (the service then refuses while anything is left)', async () => {
    await request(app.getHttpServer())
      .delete(`/asset-models/${MODEL_ID}`)
      .expect(200);
    expect(service.remove).toHaveBeenCalledWith(
      MODEL_ID,
      undefined,
      expect.objectContaining({ kind: 'human' }),
    );
  });

  it('forwards detach, and move with its target', async () => {
    await request(app.getHttpServer()).delete(
      `/asset-models/${MODEL_ID}?strategy=detach`,
    );
    await request(app.getHttpServer()).delete(
      `/asset-models/${MODEL_ID}?strategy=move&targetId=${TARGET}`,
    );
    expect(service.remove.mock.calls.map((c: unknown[]) => c[1])).toEqual([
      { strategy: 'detach' },
      { strategy: 'move', targetId: TARGET },
    ]);
  });

  it.each([
    '?strategy=move',
    `?strategy=detach&targetId=${TARGET}`,
    `?targetId=${TARGET}`,
    '?strategy=move&targetId=not-a-cuid',
  ])('400s %s before the service', async (query) => {
    await request(app.getHttpServer())
      .delete(`/asset-models/${MODEL_ID}${query}`)
      .expect(400);
    expect(service.remove).not.toHaveBeenCalled();
  });
});
