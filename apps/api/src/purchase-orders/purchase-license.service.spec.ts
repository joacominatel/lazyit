// The services import the generated client for types only; stub it so no real client loads.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {
    join: (values: unknown[]) => values,
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import { BadRequestException } from '@nestjs/common';
import { ActorService } from '../common/actor.service';
import type { Principal } from '../auth/principal';
import type { PrismaService } from '../prisma/prisma.service';
import type { ApplicationsService } from '../applications/applications.service';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PurchaseLicenseService } from './purchase-license.service';

const PO = 'clpo00000000000000000001';
const LINE = 'clline000000000000000001';
const APP = 'clapp0000000000000000001';
const USER_ID = '11111111-1111-4111-8111-111111111111';

const human = {
  kind: 'human',
  user: { id: USER_ID, role: 'MEMBER' },
} as unknown as Principal;

type Row = Record<string, unknown>;

function lineRow(over: Row = {}): Row {
  return {
    id: LINE,
    purchaseOrderId: PO,
    position: 0,
    kind: 'LICENSE',
    description: 'Microsoft 365 E3',
    manufacturerText: null,
    modelText: null,
    assetModelId: null,
    consumableId: null,
    applicationId: APP,
    appliedSeats: 0,
    quantity: 25,
    unitPrice: null,
    cancelledQuantity: 0,
    warrantyMonths: null,
    createdAt: new Date('2026-10-02T00:00:00Z'),
    updatedAt: new Date('2026-10-02T00:00:00Z'),
    deletedAt: null,
    ...over,
  };
}

function appRow(over: Row = {}): Row {
  return {
    id: APP,
    name: 'Microsoft 365',
    seatsPurchased: 100,
    renewalDate: new Date('2026-12-01T00:00:00Z'),
    deletedAt: null,
    ...over,
  };
}

function setup(opts: { line?: Row; app?: Row | null } = {}) {
  let line = lineRow(opts.line);
  const locks: string[] = [];
  const prisma = {
    purchaseOrder: {
      findFirst: jest.fn().mockResolvedValue({ id: PO, deletedAt: null }),
      update: jest.fn(),
    },
    purchaseOrderLine: {
      findFirst: jest.fn(() => Promise.resolve(line)),
      findFirstOrThrow: jest.fn(() => Promise.resolve(line)),
      findMany: jest.fn(() =>
        Promise.resolve(
          (line.appliedSeats as number) > 0
            ? [{ id: LINE, appliedSeats: line.appliedSeats }]
            : [],
        ),
      ),
      update: jest.fn(({ data }: { data: Row }) => {
        line = { ...line, ...data };
        return Promise.resolve(line);
      }),
    },
    application: {
      findFirst: jest.fn(() =>
        Promise.resolve(opts.app === undefined ? appRow() : opts.app),
      ),
      update: jest.fn(),
    },
    purchaseOrderEvent: { create: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      locks.push(strings.join('?'));
      return Promise.resolve([]);
    }),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(prisma),
  );
  const applications = {
    update: jest.fn((id: string, data: Row) =>
      Promise.resolve({ ...appRow(), id, ...data }),
    ),
    findOne: jest.fn().mockResolvedValue({ ...appRow(), seatsUsed: 80 }),
  };
  const actor = new ActorService();
  const purchases = new PurchaseOrdersService(
    prisma as unknown as PrismaService,
    actor,
  );
  const service = new PurchaseLicenseService(
    prisma as unknown as PrismaService,
    actor,
    purchases,
    applications as unknown as ApplicationsService,
  );
  return { service, prisma, applications, locks };
}

describe('PurchaseLicenseService (ADR-0099 §2, ADR-0088, #1477)', () => {
  describe('the proposal — a read', () => {
    it("proposes the line's pending seats against the application's current count, and writes nothing", async () => {
      const { service, prisma, applications } = setup({
        line: { appliedSeats: 5 },
      });
      const proposal = await service.proposal(PO, LINE);
      expect(proposal).toMatchObject({
        application: {
          id: APP,
          seatsPurchased: 100,
          seatsUsed: 80,
          renewalDate: '2026-12-01T00:00:00.000Z',
        },
        seatsToAdd: 20,
        seatsPurchasedAfter: 120,
        overAppliedAfter: false,
        warnings: [],
      });
      expect(proposal.line.receivedQuantity).toBe(5);
      expect(applications.update).not.toHaveBeenCalled();
      expect(prisma.purchaseOrderLine.update).not.toHaveBeenCalled();
      expect(prisma.purchaseOrderEvent.create).not.toHaveBeenCalled();
    });

    it('says what blocks or qualifies an apply', async () => {
      expect(
        (
          await setup({ line: { applicationId: null } }).service.proposal(
            PO,
            LINE,
          )
        ).warnings,
      ).toEqual(['NO_APPLICATION']);
      const archived = await setup({
        app: appRow({ deletedAt: new Date('2026-09-01T00:00:00Z') }),
      }).service.proposal(PO, LINE);
      expect(archived.warnings).toEqual(['APPLICATION_ARCHIVED']);
      expect(archived.application?.seatsUsed).toBeNull();
      expect(archived.seatsPurchasedAfter).toBeNull();
      expect(
        (
          await setup({
            app: appRow({ seatsPurchased: null }),
          }).service.proposal(PO, LINE)
        ).seatsPurchasedAfter,
      ).toBe(25);
      expect(
        (await setup({ line: { appliedSeats: 25 } }).service.proposal(PO, LINE))
          .warnings,
      ).toEqual(['NOTHING_PENDING']);
    });

    it('is refused for a line that is not LICENSE', async () => {
      await expect(
        setup({ line: { kind: 'ASSET' } }).service.proposal(PO, LINE),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('the apply — explicit, through the applications path', () => {
    it('adds the seats through ApplicationsService.update in the same transaction, and counts them on the line', async () => {
      const { service, prisma, applications } = setup();
      const result = await service.apply(PO, LINE, { seatsToAdd: 20 }, human);

      expect(applications.update).toHaveBeenCalledWith(
        APP,
        { seatsPurchased: 120 },
        prisma,
      );
      expect(prisma.application.update).not.toHaveBeenCalled();
      expect(prisma.purchaseOrderLine.update).toHaveBeenCalledWith({
        where: { id: LINE },
        data: { appliedSeats: 20 },
      });
      expect(result.overApplied).toBe(false);
      expect(result.warnings).toEqual([]);
      expect(result.line.receivedQuantity).toBe(20);
      expect(result.line.pendingQuantity).toBe(5);
      expect(prisma.purchaseOrderEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: 'LICENSE_APPLIED',
          performedById: USER_ID,
          payload: {
            lineId: LINE,
            applicationId: APP,
            seatsAdded: 20,
            seatsPurchased: { from: 100, to: 120 },
            renewalDate: null,
            appliedSeats: { from: 0, to: 20 },
            overApplied: false,
          },
        }) as unknown,
      });
    });

    it('locks purchase, then line, then application', async () => {
      const { service, locks } = setup();
      await service.apply(PO, LINE, { seatsToAdd: 1 }, human);
      expect(locks).toEqual([
        expect.stringMatching(/purchase_orders.*FOR KEY SHARE/s),
        expect.stringMatching(/purchase_order_lines.*FOR UPDATE/s),
        expect.stringMatching(/applications.*FOR UPDATE/s),
      ]);
    });

    it('a renewal date alone changes no seat count', async () => {
      const { service, prisma, applications } = setup();
      await service.apply(
        PO,
        LINE,
        { renewalDate: '2027-12-01T00:00:00.000Z' },
        human,
      );
      expect(applications.update).toHaveBeenCalledWith(
        APP,
        { renewalDate: '2027-12-01T00:00:00.000Z' },
        prisma,
      );
      expect(prisma.purchaseOrderLine.update).not.toHaveBeenCalled();
    });

    it('over-application is allowed and flagged', async () => {
      const { service, prisma } = setup({ line: { appliedSeats: 20 } });
      const result = await service.apply(PO, LINE, { seatsToAdd: 10 }, human);
      expect(result.overApplied).toBe(true);
      expect(result.warnings).toEqual(['OVER_APPLIED']);
      expect(result.line.receiptState).toBe('OVER');
      expect(
        (prisma.purchaseOrderEvent.create.mock.calls as [{ data: Row }][])[0][0]
          .data.payload,
      ).toMatchObject({
        appliedSeats: { from: 20, to: 30 },
        overApplied: true,
      });
    });

    it('an untracked seat count starts from the seats added, with a warning', async () => {
      const { service, applications } = setup({
        app: appRow({ seatsPurchased: null }),
      });
      const result = await service.apply(PO, LINE, { seatsToAdd: 25 }, human);
      expect(applications.update).toHaveBeenCalledWith(
        APP,
        { seatsPurchased: 25 },
        expect.anything(),
      );
      expect(result.warnings).toEqual(['SEATS_UNTRACKED']);
    });

    it('refuses a line that is not LICENSE, has no application, or names an archived one — nothing written', async () => {
      for (const opts of [
        { line: { kind: 'CONSUMABLE' } },
        { line: { applicationId: null } },
        { app: null },
      ]) {
        const { service, applications, prisma } = setup(opts);
        await expect(
          service.apply(PO, LINE, { seatsToAdd: 1 }, human),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(applications.update).not.toHaveBeenCalled();
        expect(prisma.purchaseOrderEvent.create).not.toHaveBeenCalled();
      }
    });

    it('refuses a count past int4', async () => {
      const { service, applications } = setup({
        app: appRow({ seatsPurchased: 2_147_483_000 }),
      });
      await expect(
        service.apply(PO, LINE, { seatsToAdd: 1000 }, human),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(applications.update).not.toHaveBeenCalled();
    });
  });
});
