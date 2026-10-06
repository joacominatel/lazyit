import { Test, type TestingModule } from '@nestjs/testing';
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  Injectable,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DEFAULT_ROLE_PERMISSIONS, type Role } from '@lazyit/shared';
import { SuggestionsController } from './suggestions.controller';
import { SuggestionsService } from './suggestions.service';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so nothing loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

/**
 * `GET /suggestions/:field` authorization end to end (ADR-0099 §7): the REAL RolesGuard, the REAL
 * PermissionResolverService over the SEEDED role matrix, the REAL controller and service; only the
 * database is a fake. The route carries no `@RequirePermission`, so the guard refuses a service account
 * outright (fail-closed, INV-SA-2) and the service authorizes each source for a human.
 */

// Stand-in for JwtAuthGuard: `X-Test-Role` → a human of that role; `X-Test-Service: true` → a service
// principal (holding purchaseOrder:read, which must NOT open an unannotated route); neither → anonymous.
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string>;
      user?: unknown;
      principal?: unknown;
    }>();
    if (req.headers['x-test-service'] === 'true') {
      req.principal = {
        kind: 'service',
        serviceAccount: { id: 'sa1' },
        permissions: new Set(['purchaseOrder:read', 'asset:read']),
      };
      return true;
    }
    const role = req.headers['x-test-role'];
    if (role) {
      const user = { id: 'u1', role };
      req.user = user;
      req.principal = { kind: 'human', user };
    }
    return true;
  }
}

describe('GET /suggestions/:field — authorization (ADR-0099 §7)', () => {
  let app: INestApplication<App>;
  const groupBy = () => jest.fn().mockResolvedValue([]);
  const sources = {
    supplier: { groupBy: groupBy() },
    purchaseOrder: { groupBy: groupBy() },
    purchaseOrderLine: { groupBy: groupBy() },
    asset: { groupBy: groupBy() },
    assetModel: { groupBy: groupBy() },
    application: { groupBy: groupBy() },
  };
  const allGroupBys = Object.values(sources).map((s) => s.groupBy);
  const prisma = {
    ...sources,
    rolePermission: {
      findMany: jest.fn(({ where }: { where: { role: Role } }) =>
        Promise.resolve(
          DEFAULT_ROLE_PERMISSIONS[where.role].map((permission) => ({
            permission,
          })),
        ),
      ),
    },
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SuggestionsController],
      providers: [
        Reflector,
        SuggestionsService,
        PermissionResolverService,
        { provide: PrismaService, useValue: prisma },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    allGroupBys.forEach((fn) => fn.mockClear());
  });

  const get = (field: string) =>
    request(app.getHttpServer()).get(`/suggestions/${field}`);

  it('refuses a service account at the guard, before the service reads anything', async () => {
    await get('company').set('X-Test-Service', 'true').expect(403);
    allGroupBys.forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });

  it.each([
    'supplierName',
    'lineModel',
    'reference',
    'invoiceNumbers',
    'lineDescription',
  ])(
    'refuses a VIEWER on %s — every source needs purchaseOrder:read',
    async (field) => {
      await get(field).set('X-Test-Role', 'VIEWER').expect(403);
      expect(sources.supplier.groupBy).not.toHaveBeenCalled();
      expect(sources.purchaseOrderLine.groupBy).not.toHaveBeenCalled();
    },
  );

  it.each(['vendor', 'company'])(
    'serves a VIEWER on %s from the sources it may read only',
    async (field) => {
      await get(field).set('X-Test-Role', 'VIEWER').expect(200);
      // The purchase source of `company` is skipped for a VIEWER; the asset source is read.
      expect(sources.purchaseOrder.groupBy).not.toHaveBeenCalled();
    },
  );

  it('serves a MEMBER every source of a merged field', async () => {
    await get('company').set('X-Test-Role', 'MEMBER').expect(200);
    expect(sources.asset.groupBy).toHaveBeenCalledTimes(1);
    expect(sources.purchaseOrder.groupBy).toHaveBeenCalledTimes(1);
  });

  it('400 on a field outside the whitelist, and on a limit above the maximum', async () => {
    await get('passwordHash').set('X-Test-Role', 'ADMIN').expect(400);
    await get('vendor?limit=51').set('X-Test-Role', 'ADMIN').expect(400);
  });
});
