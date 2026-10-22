// Writes and then removes its own suppliers and purchases: DB_TEST_URL must be a throwaway, migrated Postgres
// (`bun run test:db`). Proves the yearly-totals aggregate (#1500) against the real SQL, which the unit spec mocks.
// SearchService (behind the optional PurchaseSearchSync) imports the ESM `meilisearch` package jest cannot load.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
import { MONEY_MAX } from '@lazyit/shared';
import { PrismaService } from '../src/prisma/prisma.service';
import { ActorService } from '../src/common/actor.service';
import { SuppliersService } from '../src/purchase-orders/suppliers.service';

const URL = process.env.DB_TEST_URL;

const S = 'csup1500kept000000000001';
const D = 'csup1500dupl000000000001';
const at = (iso: string) => new Date(iso);

describe('supplier yearly totals against Postgres (#1500)', () => {
  let prisma: PrismaService;
  let service: SuppliersService;
  let seq = 0;

  const purchase = async (
    supplierId: string,
    opts: {
      status?: string;
      currency?: string | null;
      orderDate?: string | null;
      createdAt: string;
      deleted?: boolean;
      lines?: {
        quantity: number;
        unitPrice: bigint | null;
        cancelledQuantity?: number;
        deleted?: boolean;
      }[];
    },
  ) => {
    const id = `cpo1500${String(++seq).padStart(17, '0')}`;
    await prisma.purchaseOrder.create({
      data: {
        id,
        supplierId,
        status: opts.status ?? 'ORDERED',
        currency: opts.currency ?? null,
        orderDate: opts.orderDate ? at(opts.orderDate) : null,
        createdAt: at(opts.createdAt),
        deletedAt: opts.deleted ? at('2026-10-01T00:00:00Z') : null,
        lines: {
          create: (opts.lines ?? []).map((line, position) => ({
            position,
            description: `line ${position}`,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            cancelledQuantity: line.cancelledQuantity ?? 0,
            deletedAt: line.deleted ? at('2026-10-01T00:00:00Z') : null,
          })),
        },
      },
    });
    return id;
  };

  const cleanup = async () => {
    await prisma.$executeRaw`DELETE FROM "purchase_order_events" WHERE "purchaseOrderId" LIKE 'cpo1500%'`;
    await prisma.$executeRaw`DELETE FROM "purchase_order_lines" WHERE "purchaseOrderId" LIKE 'cpo1500%'`;
    await prisma.$executeRaw`DELETE FROM "purchase_orders" WHERE "id" LIKE 'cpo1500%'`;
    await prisma.$executeRaw`DELETE FROM "suppliers" WHERE "id" IN (${S}, ${D})`;
  };

  beforeAll(async () => {
    if (!URL) {
      throw new Error(
        'DB_TEST_URL is not set: this suite needs a throwaway, migrated Postgres',
      );
    }
    process.env.DATABASE_URL = URL;
    prisma = new PrismaService();
    service = new SuppliersService(prisma, new ActorService());
    await cleanup();
    await prisma.supplier.createMany({
      data: [
        { id: S, name: 'Compumundo' },
        { id: D, name: 'Compumundo S.A.' },
      ],
    });

    // 2025, by order date, though recorded in 2026. (3 − 1) × 1000 = 2000; an unpriced line with units left
    // counts as unpriced; fully cancelled lines add nothing and are not "unpriced"; a deleted line is ignored.
    await purchase(S, {
      currency: 'USD',
      orderDate: '2025-12-31T00:00:00Z',
      createdAt: '2026-01-05T12:00:00Z',
      lines: [
        { quantity: 3, unitPrice: 1000n, cancelledQuantity: 1 },
        { quantity: 2, unitPrice: null },
        { quantity: 1, unitPrice: 500n, cancelledQuantity: 1 },
        { quantity: 2, unitPrice: null, cancelledQuantity: 2 },
        { quantity: 1, unitPrice: 99_999n, deleted: true },
      ],
    });
    // 2025 by the recorded date (no order date); "usd " is the same label as "USD", and it is dated first.
    await purchase(S, {
      currency: 'usd ',
      createdAt: '2025-06-01T09:00:00Z',
      lines: [{ quantity: 1, unitPrice: 300n }],
    });
    // Not counted: a draft, a cancelled purchase, an archived one.
    await purchase(S, {
      status: 'DRAFT',
      currency: 'USD',
      orderDate: '2025-03-01T00:00:00Z',
      createdAt: '2025-03-01T00:00:00Z',
      lines: [{ quantity: 1, unitPrice: 1_000_000n }],
    });
    await purchase(S, {
      status: 'CANCELLED',
      currency: 'USD',
      orderDate: '2025-03-02T00:00:00Z',
      createdAt: '2025-03-02T00:00:00Z',
      lines: [{ quantity: 1, unitPrice: 1_000_000n }],
    });
    await purchase(S, {
      currency: 'USD',
      orderDate: '2025-03-03T00:00:00Z',
      createdAt: '2025-03-03T00:00:00Z',
      deleted: true,
      lines: [{ quantity: 1, unitPrice: 1_000_000n }],
    });
    // 2026: ARS, then a purchase with no currency and no lines.
    await purchase(S, {
      currency: 'ARS',
      orderDate: '2026-03-01T00:00:00Z',
      createdAt: '2026-03-01T00:00:00Z',
      lines: [{ quantity: 10, unitPrice: 150_000n }],
    });
    await purchase(S, {
      orderDate: '2026-04-01T00:00:00Z',
      createdAt: '2026-04-01T00:00:00Z',
    });
    // 2024: a sum far beyond MONEY_MAX (and beyond bigint) — computed in numeric, reported as null.
    await purchase(S, {
      currency: 'EUR',
      orderDate: '2024-05-01T00:00:00Z',
      createdAt: '2024-05-01T00:00:00Z',
      lines: [{ quantity: 2_000_000_000, unitPrice: BigInt(MONEY_MAX) }],
    });
    // The duplicate's purchase, merged into S below.
    await purchase(D, {
      currency: 'USD',
      orderDate: '2025-02-01T00:00:00Z',
      createdAt: '2025-02-01T00:00:00Z',
      lines: [{ quantity: 1, unitPrice: 700n }],
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await cleanup();
    await prisma.$disconnect();
  });

  it('attributes years, excludes drafts, cancelled and archived purchases, and groups per label', async () => {
    const detail = await service.findDetail(S);
    expect(detail.name).toBe('Compumundo');
    expect(detail.yearlyTotals).toEqual([
      {
        year: 2026,
        currency: 'ARS',
        amount: 1_500_000,
        unpricedLines: 0,
        purchaseCount: 1,
      },
      {
        year: 2026,
        currency: null,
        amount: 0,
        unpricedLines: 0,
        purchaseCount: 1,
      },
      {
        year: 2025,
        currency: 'usd',
        amount: 2_300,
        unpricedLines: 1,
        purchaseCount: 2,
      },
      {
        year: 2024,
        currency: 'EUR',
        amount: null,
        unpricedLines: 0,
        purchaseCount: 1,
      },
    ]);
  });

  it("after a merge, the kept supplier's totals include the moved purchases", async () => {
    await service.merge(S, D);
    const totals = await service.yearlyTotals(S);
    expect(totals.find((t) => t.year === 2025)).toEqual({
      year: 2025,
      currency: 'USD',
      amount: 3_000,
      unpricedLines: 1,
      purchaseCount: 3,
    });
    // The merged purchase is now the earliest of 2025, so its spelling ("USD") leads the group.
    await expect(service.yearlyTotals(D)).resolves.toEqual([]);
  });
});
