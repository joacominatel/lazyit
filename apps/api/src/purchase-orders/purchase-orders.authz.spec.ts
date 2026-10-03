// Only the guard, the resolver and the controllers are real; the services and the DB are stubs.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x, join: (x: unknown) => x },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { PurchaseReceivingService } from './purchase-receiving.service';
import { PurchaseLicenseService } from './purchase-license.service';
import { PurchaseFromAssetsService } from './purchase-from-assets.service';
import { PurchaseExtractionService } from './extraction/purchase-extraction.service';
import { AssetPurchaseController } from './asset-purchase.controller';
import { PurchaseOrderAttachmentsController } from '../attachments/purchase-order-attachments.controller';
import { AttachmentsService } from '../attachments/attachments.service';

const PO = 'clpo00000000000000000001';
const LINE = 'clline000000000000000001';
const ASSET = 'classet00000000000000001';
const ATT = 'clatt0000000000000000001';

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
  const receiving = {
    findPendingLines: ok,
    linkPreview: ok,
    linkAssets: ok,
    unlinkAssets: ok,
    receiveFromLine: ok,
    receiveStock: ok,
    findAssetProvenance: ok,
  };
  const attachments = { list: ok, upload: ok, remove: ok, updateLabel: ok };
  const licenses = { proposal: ok, apply: ok };
  const fromAssets = { create: ok };
  const extraction = { status: ok, extract: ok };
  (purchases as Record<string, jest.Mock>).cancelRemaining = ok;
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
      controllers: [
        PurchaseOrdersController,
        SuppliersController,
        AssetPurchaseController,
        PurchaseOrderAttachmentsController,
      ],
      providers: [
        Reflector,
        PermissionResolverService,
        { provide: PrismaService, useValue: prisma },
        { provide: PurchaseOrdersService, useValue: purchases },
        { provide: SuppliersService, useValue: suppliers },
        { provide: PurchaseReceivingService, useValue: receiving },
        { provide: AttachmentsService, useValue: attachments },
        { provide: PurchaseLicenseService, useValue: licenses },
        { provide: PurchaseFromAssetsService, useValue: fromAssets },
        { provide: PurchaseExtractionService, useValue: extraction },
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
  describe('flows (#1473)', () => {
    beforeEach(() => ok.mockClear());

    it("an asset's provenance: 403 for a VIEWER (asset:read alone), 200 for a MEMBER", async () => {
      await http()
        .get(`/assets/${ASSET}/purchase${as('role=VIEWER')}`)
        .expect(403);
      expect(receiving.findAssetProvenance).not.toHaveBeenCalled();
      await http()
        .get(`/assets/${ASSET}/purchase${as('role=MEMBER')}`)
        .expect(200);
      await http()
        .get(`/assets/${ASSET}/purchase${as('sa=asset:read')}`)
        .expect(403);
      await http()
        .get(
          `/assets/${ASSET}/purchase${as('sa=asset:read,purchaseOrder:read')}`,
        )
        .expect(200);
    });

    it('pending-lines is its own route (never read as an id), purchaseOrder:read', async () => {
      await http()
        .get(`/purchase-orders/pending-lines${as('role=MEMBER')}`)
        .expect(200);
      // Every stub shares one mock: the pending read got its parsed filters, and nothing was handed
      // "pending-lines" as a purchase id.
      expect(ok).toHaveBeenCalledWith(
        { supplierId: undefined },
        expect.objectContaining({ limit: 50 }),
      );
      expect(ok).not.toHaveBeenCalledWith('pending-lines');
      await http()
        .get(`/purchase-orders/pending-lines${as('role=VIEWER')}`)
        .expect(403);
    });

    it('linking, unlinking and receiving need purchaseOrder:write AND asset:write', async () => {
      const writes: [string, object][] = [
        [
          `/purchase-orders/${PO}/lines/${LINE}/link-assets`,
          { assetIds: [ASSET] },
        ],
        [
          `/purchase-orders/${PO}/lines/${LINE}/unlink-assets`,
          { assetIds: [ASSET] },
        ],
        [`/purchase-orders/${PO}/lines/${LINE}/receive`, {}],
      ];
      for (const [path, body] of writes) {
        await http()
          .post(`${path}${as('sa=purchaseOrder:write')}`)
          .send(body)
          .expect(403);
        await http()
          .post(`${path}${as('sa=asset:write')}`)
          .send(body)
          .expect(403);
        await http()
          .post(`${path}${as('sa=purchaseOrder:write,asset:write')}`)
          .send(body)
          .expect(201);
        await http()
          .post(`${path}${as('role=MEMBER')}`)
          .send(body)
          .expect(201);
        await http()
          .post(`${path}${as('role=VIEWER')}`)
          .send(body)
          .expect(403);
      }
    });

    it('the link preview is a read: purchaseOrder:read and asset:read', async () => {
      const path = `/purchase-orders/${PO}/lines/${LINE}/link-preview`;
      await http()
        .post(`${path}${as('sa=purchaseOrder:read,asset:read')}`)
        .send({ assetIds: [ASSET] })
        .expect(201);
      await http()
        .post(`${path}${as('sa=purchaseOrder:read')}`)
        .send({ assetIds: [ASSET] })
        .expect(403);
    });

    it('cancel remaining is a purchase write; the body is validated at the edge', async () => {
      const path = `/purchase-orders/${PO}/lines/${LINE}/cancel-remaining`;
      await http()
        .post(`${path}${as('role=VIEWER')}`)
        .send({})
        .expect(403);
      await http()
        .post(`${path}${as('role=MEMBER')}`)
        .send({ quantity: 1, reason: 'never came' })
        .expect(201);
      await http()
        .post(`${path}${as('role=MEMBER')}`)
        .send({ quantity: 0 })
        .expect(400);
    });

    it('400 at the edge: an unknown apply field, a duplicate id, serials that do not match quantity', async () => {
      await http()
        .post(
          `/purchase-orders/${PO}/lines/${LINE}/link-assets${as('role=ADMIN')}`,
        )
        .send({ assetIds: [ASSET], apply: ['serial'] })
        .expect(400);
      await http()
        .post(
          `/purchase-orders/${PO}/lines/${LINE}/link-assets${as('role=ADMIN')}`,
        )
        .send({ assetIds: [ASSET, ASSET] })
        .expect(400);
      await http()
        .post(`/purchase-orders/${PO}/lines/${LINE}/receive${as('role=ADMIN')}`)
        .send({ quantity: 3, serials: ['A'] })
        .expect(400);
    });

    it('purchase documents: purchaseOrder:read to list and download, purchaseOrder:write to remove', async () => {
      const base = `/purchase-orders/${PO}/attachments`;
      await http()
        .get(`${base}${as('role=VIEWER')}`)
        .expect(403);
      await http()
        .get(`${base}${as('sa=asset:read')}`)
        .expect(403);
      await http()
        .get(`${base}${as('role=MEMBER')}`)
        .expect(200);
      await http()
        .delete(`${base}/${ATT}${as('sa=purchaseOrder:read')}`)
        .expect(403);
      await http()
        .delete(`${base}/${ATT}${as('role=MEMBER')}`)
        .expect(200);
      await http()
        .get(`${base}/${ATT}/content${as('role=VIEWER')}`)
        .expect(403);
    });
  });

  describe('consumable lines (#1476)', () => {
    beforeEach(() => ok.mockClear());

    it('receiving into stock needs purchaseOrder:write AND consumable:write', async () => {
      const path = `/purchase-orders/${PO}/lines/${LINE}/receive-stock`;
      const body = { quantity: 5 };
      await http()
        .post(`${path}${as('role=VIEWER')}`)
        .send(body)
        .expect(403);
      await http()
        .post(`${path}${as('sa=purchaseOrder:write')}`)
        .send(body)
        .expect(403);
      await http()
        .post(`${path}${as('sa=consumable:write')}`)
        .send(body)
        .expect(403);
      expect(receiving.receiveStock).not.toHaveBeenCalled();
      await http()
        .post(`${path}${as('sa=purchaseOrder:write,consumable:write')}`)
        .send(body)
        .expect(201);
      await http()
        .post(`${path}${as('role=MEMBER')}`)
        .send(body)
        .expect(201);
      await http()
        .post(`${path}${as('role=ADMIN')}`)
        .send(body)
        .expect(201);
      expect(receiving.receiveStock).toHaveBeenCalledWith(
        PO,
        LINE,
        { quantity: 5 },
        expect.objectContaining({ kind: 'human' }),
      );
    });

    it('receive-stock validates its body at the edge: a quantity is required, nothing else is accepted', async () => {
      const path = `/purchase-orders/${PO}/lines/${LINE}/receive-stock`;
      await http()
        .post(`${path}${as('role=ADMIN')}`)
        .send({})
        .expect(400);
      await http()
        .post(`${path}${as('role=ADMIN')}`)
        .send({ quantity: 1, type: 'OUT' })
        .expect(400);
    });

    it('a line names a consumable only on a CONSUMABLE line (400 at the edge)', async () => {
      await http()
        .post(`/purchase-orders/${PO}/lines${as('role=MEMBER')}`)
        .send({
          description: 'Toner',
          consumableId: 'clconsumable000000000001',
        })
        .expect(400);
      await http()
        .post(`/purchase-orders/${PO}/lines${as('role=MEMBER')}`)
        .send({
          kind: 'CONSUMABLE',
          description: 'Toner',
          consumableId: 'clconsumable000000000001',
        })
        .expect(201);
    });
  });

  describe('document type labels (#1476)', () => {
    beforeEach(() => ok.mockClear());

    it("editing a purchase document's label is a purchase write; the body is the label only", async () => {
      const path = `/purchase-orders/${PO}/attachments/${ATT}`;
      await http()
        .patch(`${path}${as('role=VIEWER')}`)
        .send({ label: 'Invoice' })
        .expect(403);
      await http()
        .patch(`${path}${as('sa=purchaseOrder:read')}`)
        .send({ label: 'Invoice' })
        .expect(403);
      await http()
        .patch(`${path}${as('role=MEMBER')}`)
        .send({ label: 'Invoice' })
        .expect(200);
      expect(attachments.updateLabel).toHaveBeenCalledWith(
        'PURCHASE_ORDER',
        PO,
        ATT,
        'Invoice',
        expect.objectContaining({ kind: 'human' }),
      );
      await http()
        .patch(`${path}${as('role=MEMBER')}`)
        .send({ label: 'x'.repeat(101) })
        .expect(400);
      await http()
        .patch(`${path}${as('role=MEMBER')}`)
        .send({ originalName: 'evil.html' })
        .expect(400);
    });

    it('the upload hands the multipart label to the service', async () => {
      // The multer stage writes the file to <ATTACHMENTS_DIR>/tmp: keep it out of the tree.
      const dir = await mkdtemp(join(tmpdir(), 'lazyit-po-authz-'));
      process.env.ATTACHMENTS_DIR = dir;
      await http()
        .post(`/purchase-orders/${PO}/attachments${as('role=MEMBER')}`)
        .field('label', 'Remito')
        .attach('file', Buffer.from('%PDF-1.7 x'), 'remito.pdf')
        .expect(201);
      expect(attachments.upload).toHaveBeenCalledWith(
        'PURCHASE_ORDER',
        PO,
        expect.objectContaining({ originalname: 'remito.pdf' }),
        expect.objectContaining({ kind: 'human' }),
        'Remito',
      );
      delete process.env.ATTACHMENTS_DIR;
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe('Phase 2 (#1477)', () => {
    beforeEach(() => ok.mockClear());

    it('the extraction status is a purchase read, its own route (never read as an id)', async () => {
      await http()
        .get(`/purchase-orders/extraction/status${as('role=VIEWER')}`)
        .expect(403);
      await http()
        .get(`/purchase-orders/extraction/status${as('role=MEMBER')}`)
        .expect(200);
      expect(extraction.status).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'human' }),
      );
      expect(ok).not.toHaveBeenCalledWith('extraction');
      // A service account may read it: the service answers NOT_PERMITTED for it.
      await http()
        .get(`/purchase-orders/extraction/status${as('sa=purchaseOrder:read')}`)
        .expect(200);
    });

    it('extracting needs purchaseOrder:write AND ai:use; it answers 200 (a draft, nothing created)', async () => {
      const path = `/purchase-orders/${PO}/attachments/${ATT}/extract`;
      await http()
        .post(`${path}${as('role=VIEWER')}`)
        .expect(403);
      await http()
        .post(`${path}${as('sa=purchaseOrder:write')}`)
        .expect(403);
      await http()
        .post(`${path}${as('sa=ai:use')}`)
        .expect(403);
      expect(extraction.extract).not.toHaveBeenCalled();
      await http()
        .post(`${path}${as('role=MEMBER')}`)
        .expect(200);
      await http()
        .post(`${path}${as('role=ADMIN')}`)
        .expect(200);
      expect(extraction.extract).toHaveBeenCalledWith(
        PO,
        ATT,
        expect.objectContaining({ kind: 'human' }),
      );
    });

    it('the license proposal needs purchaseOrder:read AND application:read', async () => {
      const path = `/purchase-orders/${PO}/lines/${LINE}/license-proposal`;
      // A VIEWER reads applications but not purchases.
      await http()
        .get(`${path}${as('role=VIEWER')}`)
        .expect(403);
      await http()
        .get(`${path}${as('sa=purchaseOrder:read')}`)
        .expect(403);
      await http()
        .get(`${path}${as('sa=purchaseOrder:read,application:read')}`)
        .expect(200);
      await http()
        .get(`${path}${as('role=MEMBER')}`)
        .expect(200);
    });

    it('applying a license needs purchaseOrder:write AND application:write; the body is validated at the edge', async () => {
      const path = `/purchase-orders/${PO}/lines/${LINE}/apply-license`;
      const body = { seatsToAdd: 10 };
      await http()
        .post(`${path}${as('role=VIEWER')}`)
        .send(body)
        .expect(403);
      await http()
        .post(`${path}${as('sa=purchaseOrder:write')}`)
        .send(body)
        .expect(403);
      await http()
        .post(`${path}${as('sa=application:write')}`)
        .send(body)
        .expect(403);
      expect(licenses.apply).not.toHaveBeenCalled();
      await http()
        .post(`${path}${as('sa=purchaseOrder:write,application:write')}`)
        .send(body)
        .expect(201);
      await http()
        .post(`${path}${as('role=MEMBER')}`)
        .send(body)
        .expect(201);
      await http()
        .post(`${path}${as('role=MEMBER')}`)
        .send({})
        .expect(400);
      await http()
        .post(`${path}${as('role=MEMBER')}`)
        .send({ seatsToAdd: 0 })
        .expect(400);
    });

    it('creating a purchase from assets needs purchaseOrder:write AND asset:write', async () => {
      const path = '/purchase-orders/from-assets';
      const body = { assetIds: [ASSET] };
      await http()
        .post(`${path}${as('role=VIEWER')}`)
        .send(body)
        .expect(403);
      await http()
        .post(`${path}${as('sa=purchaseOrder:write')}`)
        .send(body)
        .expect(403);
      await http()
        .post(`${path}${as('sa=asset:write')}`)
        .send(body)
        .expect(403);
      expect(fromAssets.create).not.toHaveBeenCalled();
      await http()
        .post(`${path}${as('sa=purchaseOrder:write,asset:write')}`)
        .send(body)
        .expect(201);
      await http()
        .post(`${path}${as('role=ADMIN')}`)
        .send(body)
        .expect(201);
      expect(fromAssets.create).toHaveBeenCalledWith(
        body,
        expect.objectContaining({ kind: 'human' }),
      );
      await http()
        .post(`${path}${as('role=ADMIN')}`)
        .send({ assetIds: [] })
        .expect(400);
    });

    it('a LICENSE line names an application only on that kind (400 at the edge)', async () => {
      await http()
        .post(`/purchase-orders/${PO}/lines${as('role=MEMBER')}`)
        .send({
          description: 'M365 E3',
          applicationId: 'clapp0000000000000000001',
        })
        .expect(400);
      await http()
        .post(`/purchase-orders/${PO}/lines${as('role=MEMBER')}`)
        .send({
          kind: 'LICENSE',
          description: 'M365 E3',
          applicationId: 'clapp0000000000000000001',
        })
        .expect(201);
    });
  });
});
