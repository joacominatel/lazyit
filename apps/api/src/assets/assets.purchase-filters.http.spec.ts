// The asset list's purchase filters over real HTTP (#1476): the real controller, guard, permission resolver
// (seeded role matrix) and AssetsService; only the database is a fake.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD, APP_PIPE, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DEFAULT_ROLE_PERMISSIONS, type Role } from '@lazyit/shared';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { AssetTagSchemeService } from '../asset-tag-scheme/asset-tag-scheme.service';
import { ArticlesService } from '../articles/articles.service';
import { ActorService } from '../common/actor.service';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';

const PO = 'clpo00000000000000000001';
const LINE = 'clline000000000000000001';

/** `?role=` impersonates a human of that role. */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Record<string, unknown>>();
    const role = (req.query as Record<string, string>).role;
    const user = { id: '11111111-1111-4111-8111-111111111111', role };
    req.user = user;
    req.principal = { kind: 'human', user };
    return true;
  }
}

describe('GET /assets — purchase filters (#1476)', () => {
  let app: INestApplication<App>;
  const findMany = jest.fn().mockResolvedValue([]);
  const prisma = {
    asset: { findMany, count: jest.fn().mockResolvedValue(0) },
    rolePermission: {
      findMany: jest.fn(({ where }: { where: { role: Role } }) =>
        Promise.resolve(
          DEFAULT_ROLE_PERMISSIONS[where.role].map((permission) => ({
            permission,
          })),
        ),
      ),
    },
    $transaction: jest.fn((queries: Promise<unknown>[]) =>
      Promise.all(queries),
    ),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AssetsController],
      providers: [
        Reflector,
        AssetsService,
        ActorService,
        PermissionResolverService,
        { provide: PrismaService, useValue: prisma },
        { provide: AssetHistoryService, useValue: {} },
        { provide: SearchService, useValue: {} },
        { provide: AssetTagSchemeService, useValue: {} },
        { provide: AssetAssignmentsService, useValue: {} },
        { provide: ArticlesService, useValue: {} },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => findMany.mockClear());

  const list = (query: string) =>
    request(app.getHttpServer()).get(`/assets?${query}`);
  const where = () =>
    (findMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;

  it("a MEMBER lists a line's and a purchase's assets", async () => {
    await list(`role=MEMBER&purchaseOrderLineId=${LINE}`).expect(200);
    expect(where()).toMatchObject({ AND: [{ purchaseOrderLineId: LINE }] });
    findMany.mockClear();
    await list(`role=MEMBER&purchaseOrderId=${PO}`).expect(200);
    expect(where()).toMatchObject({
      AND: [{ purchaseOrderLine: { purchaseOrderId: PO } }],
    });
  });

  it('purchaseLinked=false lists the assets linked to no purchase', async () => {
    await list('role=MEMBER&purchaseLinked=false').expect(200);
    expect(where()).toMatchObject({ AND: [{ purchaseOrderLineId: null }] });
  });

  it('a VIEWER (asset:read, no purchaseOrder:read) is refused every purchase filter — and still lists', async () => {
    for (const filter of [
      `purchaseOrderLineId=${LINE}`,
      `purchaseOrderId=${PO}`,
      'purchaseLinked=false',
    ]) {
      await list(`role=VIEWER&${filter}`).expect(403);
    }
    expect(findMany).not.toHaveBeenCalled();
    // Without a purchase filter the list is asset:read alone, as before.
    await list('role=VIEWER').expect(200);
  });

  it('400 on an id that is not a cuid', async () => {
    await list('role=ADMIN&purchaseOrderLineId=not-an-id').expect(400);
    await list('role=ADMIN&purchaseOrderId=1').expect(400);
  });
});
