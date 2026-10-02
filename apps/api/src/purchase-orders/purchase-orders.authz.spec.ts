// Only the guard, the resolver and the controllers are real; the services and the DB are stubs.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x, join: (x: unknown) => x },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));

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
import { RolesGuard } from '../auth/roles.guard';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

const PO = 'clpo00000000000000000001';

/**
 * Purchases authorization end to end (ADR-0099 §8): the REAL RolesGuard and PermissionResolverService over
 * the SEEDED role matrix, the REAL controllers, stub services. `?role=` impersonates a human; `?sa=` a
 * service account holding the comma-separated grants.
 */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Record<string, unknown>>();
    const query = req.query as Record<string, string>;
    if (query.role) {
      const user = {
        id: '11111111-1111-4111-8111-111111111111',
        role: query.role,
      };
      req.user = user;
      req.principal = { kind: 'human', user };
    } else if (query.sa !== undefined) {
      req.principal = {
        kind: 'service',
        serviceAccount: { id: 'clsa0000000000000000001' },
        permissions: new Set(query.sa.split(',').filter(Boolean)),
      };
    }
    return true;
  }
}

describe('Purchases authorization (ADR-0099 §8)', () => {
  let app: INestApplication<App>;
  const ok = jest.fn().mockResolvedValue({ ok: true });
  const purchases = {
    findPage: ok,
    findOne: ok,
    findEvents: ok,
    create: ok,
    update: ok,
    remove: ok,
    restore: ok,
    addLine: ok,
    updateLine: ok,
    removeLine: ok,
  };
  const suppliers = {
    findPage: ok,
    findOne: ok,
    create: ok,
    update: ok,
    remove: ok,
    restore: ok,
  };

  beforeAll(async () => {
    const prisma = {
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
    const moduleRef = await Test.createTestingModule({
      controllers: [PurchaseOrdersController, SuppliersController],
      providers: [
        Reflector,
        PermissionResolverService,
        { provide: PrismaService, useValue: prisma },
        { provide: PurchaseOrdersService, useValue: purchases },
        { provide: SuppliersService, useValue: suppliers },
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

  const as = (who: string) => `?${who}`;
  const http = () => request(app.getHttpServer());

  describe('VIEWER — denied by default', () => {
    it.each([
      '/purchase-orders',
      `/purchase-orders/${PO}`,
      `/purchase-orders/${PO}/events`,
      '/suppliers',
    ])('403 on GET %s', async (path) => {
      await http()
        .get(`${path}${as('role=VIEWER')}`)
        .expect(403);
    });

    it('403 on create', async () => {
      await http()
        .post(`/purchase-orders${as('role=VIEWER')}`)
        .send({ reference: 'OC-1' })
        .expect(403);
    });
  });

  describe('MEMBER — read and write, never delete', () => {
    it('200 on the reads', async () => {
      await http()
        .get(`/purchase-orders${as('role=MEMBER')}`)
        .expect(200);
      await http()
        .get(`/suppliers${as('role=MEMBER')}`)
        .expect(200);
    });

    it('201 on create, 200 on line edits', async () => {
      await http()
        .post(`/purchase-orders${as('role=MEMBER')}`)
        .send({ lines: [{ description: 'Laptop' }] })
        .expect(201);
      await http()
        .post(`/suppliers${as('role=MEMBER')}`)
        .send({ name: 'Compumundo' })
        .expect(201);
      await http()
        .delete(
          `/purchase-orders/${PO}/lines/clline000000000000000001${as('role=MEMBER')}`,
        )
        .expect(200);
    });

    it('403 on delete and restore of purchases and suppliers', async () => {
      await http()
        .delete(`/purchase-orders/${PO}${as('role=MEMBER')}`)
        .expect(403);
      await http()
        .post(`/purchase-orders/${PO}/restore${as('role=MEMBER')}`)
        .expect(403);
      await http()
        .delete(`/suppliers/${PO}${as('role=MEMBER')}`)
        .expect(403);
      await http()
        .post(`/suppliers/${PO}/restore${as('role=MEMBER')}`)
        .expect(403);
    });

    it('403 on the archived slice (deleted=only is ADMIN-only)', async () => {
      await http()
        .get(`/purchase-orders${as('role=MEMBER')}&deleted=only`)
        .expect(403);
    });
  });

  describe('ADMIN', () => {
    it('200 on delete and restore', async () => {
      await http()
        .delete(`/purchase-orders/${PO}${as('role=ADMIN')}`)
        .expect(200);
      await http()
        .post(`/purchase-orders/${PO}/restore${as('role=ADMIN')}`)
        .expect(201);
      await http()
        .post(`/suppliers/${PO}/restore${as('role=ADMIN')}`)
        .expect(201);
      await http()
        .get(`/purchase-orders${as('role=ADMIN')}&deleted=only`)
        .expect(200);
    });
  });

  describe('service accounts — fail-closed, grantable', () => {
    it('reads with purchaseOrder:read, and nothing without it', async () => {
      await http()
        .get(`/purchase-orders${as('sa=purchaseOrder:read')}`)
        .expect(200);
      await http()
        .get(`/purchase-orders${as('sa=asset:read')}`)
        .expect(403);
      await http()
        .post(`/purchase-orders${as('sa=purchaseOrder:read')}`)
        .send({ reference: 'OC-1' })
        .expect(403);
    });
  });

  describe('validation at the edge', () => {
    it('400 on a purchase that identifies nothing, a bad receipt filter or a bad status', async () => {
      await http()
        .post(`/purchase-orders${as('role=ADMIN')}`)
        .send({})
        .expect(400);
      await http()
        .get(`/purchase-orders${as('role=ADMIN')}&receipt=LATE`)
        .expect(400);
      await http()
        .get(`/purchase-orders${as('role=ADMIN')}&status=RECEIVED`)
        .expect(400);
    });
  });
});
