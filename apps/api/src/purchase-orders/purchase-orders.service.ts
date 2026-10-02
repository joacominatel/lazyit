import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DEFAULT_PURCHASE_ORDER_LINE_KIND,
  DEFAULT_PURCHASE_ORDER_STATUS,
  MONEY_MAX,
  offsetOf,
  pageOf,
  type CreatePurchaseOrder,
  type CancelRemainingUnits,
  type CreatePurchaseOrderLine,
  type PageQuery,
  type PurchaseOrderReceiptFilter,
  type PurchaseOrderStatus,
  type UpdatePurchaseOrder,
  type UpdatePurchaseOrderLine,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import type { Principal } from '../auth/principal';
import { resolveSortOrBadRequest } from '../common/resolve-sort';
import { deletedWhere, includeSoftDeletedFor } from '../common/deleted-filter';
import {
  purchaseOrderLineMoneyToDb,
  purchaseOrderLineMoneyToWire,
} from '../common/money';
import {
  COUNTABLE_LINE_KINDS,
  deriveLine,
  derivePurchaseReceipt,
  lineTotalToWire,
  purchaseTotals,
  type LineInput,
} from './purchase-order-derived';
import { recordPurchaseOrderEvent } from './purchase-order-events';

/** Optional filters for listing purchases. */
export interface PurchaseOrderFilters {
  /** Case-insensitive substring over reference, invoice numbers, supplier name and line descriptions. */
  q?: string;
  status?: PurchaseOrderStatus[];
  supplierId?: string;
  /** A derived receipt state, or `PENDING` (units still pending on a purchase that is not cancelled). */
  receipt?: PurchaseOrderReceiptFilter;
}

/** Server-side sort allowlist for `GET /purchase-orders` (ADR-0030). Default `createdAt desc`. */
export const PURCHASE_ORDER_SORT_ALLOWLIST = {
  reference: 'reference',
  status: 'status',
  orderDate: 'orderDate',
  expectedDate: 'expectedDate',
  invoiceDate: 'invoiceDate',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
} as const;

/** A transaction client (or the base client) — what the in-transaction helpers write through. */
type Tx = Prisma.TransactionClient;

/** The supplier projection embedded on a purchase read (an archived supplier is still shown). */
const SUPPLIER_REF_SELECT = {
  id: true,
  name: true,
  deletedAt: true,
} as const satisfies Prisma.SupplierSelect;

/**
 * The live lines of a purchase, in display order. A relation `include` is NOT rewritten by the ADR-0032
 * read filter, so the `deletedAt: null` is explicit.
 */
const LIVE_LINES = {
  where: { deletedAt: null },
  orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
} as const satisfies Prisma.PurchaseOrder$linesArgs;

const PURCHASE_ORDER_INCLUDE = {
  supplier: { select: SUPPLIER_REF_SELECT },
  lines: LIVE_LINES,
} as const satisfies Prisma.PurchaseOrderInclude;

type PurchaseOrderRow = Prisma.PurchaseOrderGetPayload<{
  include: typeof PURCHASE_ORDER_INCLUDE;
}>;
type LineRow = PurchaseOrderRow['lines'][number];

/** The header fields an update may change, compared field by field for the activity log. */
const HEADER_FIELDS = [
  'supplierId',
  'reference',
  'currency',
  'orderDate',
  'expectedDate',
  'deliveryLocationId',
  'company',
  'invoiceNumbers',
  'invoiceDate',
  'notes',
] as const satisfies readonly Exclude<keyof UpdatePurchaseOrder, 'status'>[];

/** The line fields an update may change, compared field by field for the activity log. */
const LINE_FIELDS = [
  'kind',
  'description',
  'manufacturerText',
  'modelText',
  'assetModelId',
  'quantity',
  'unitPrice',
  'cancelledQuantity',
  'warrantyMonths',
  'position',
] as const satisfies readonly (keyof UpdatePurchaseOrderLine)[];

/** Free text that is too long to copy into the log: recorded as "changed", by name only. */
const NAME_ONLY_FIELDS = new Set<string>(['notes']);

/** A value as the activity log records it: a Date as ISO, a bigint as a number, a missing value as null. */
function logValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  return value;
}

/** Comparable form of a stored or incoming value (dates by instant, bigint by number). */
function comparable(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : ms;
  }
  if (typeof value === 'bigint') return Number(value);
  return value;
}

/**
 * The `{ field: { from, to } }` changes between a stored row and a PATCH body, over `fields`. A field
 * absent from the body did not change. Long free text is recorded as `{ changed: true }` only.
 */
function diff(
  before: Record<string, unknown>,
  body: Record<string, unknown>,
  fields: readonly string[],
): Record<string, Prisma.InputJsonValue> {
  const changes: Record<string, Prisma.InputJsonValue> = {};
  for (const field of fields) {
    if (!(field in body)) continue;
    if (comparable(before[field]) === comparable(body[field])) continue;
    changes[field] = NAME_ONLY_FIELDS.has(field)
      ? { changed: true }
      : { from: logValue(before[field]), to: logValue(body[field]) };
  }
  return changes;
}

/** 400 unless quantity × unit price fits a wire amount (ADR-0100): the derived total must stay exact. */
function assertLineTotalFits(quantity: number, unitPrice: number | null) {
  if (unitPrice === null) return;
  if (BigInt(quantity) * BigInt(unitPrice) > BigInt(MONEY_MAX)) {
    throw new BadRequestException(
      'quantity × unitPrice exceeds the largest amount lazyit can total',
    );
  }
}

/**
 * Purchases (ADR-0099): purchase orders, their lines and their append-only activity log. Totals and the
 * receipt state are DERIVED on every read (never stored), and every write appends its
 * {@link PurchaseOrderEvent} in the same transaction, attributed to a human or a service account
 * (INV-SA-4) and stamped with the AI invocation when an AI tool made the call.
 */
@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
  ) {}

  // ── Reads ────────────────────────────────────────────────────────────────────────────────────────────

  /** A page of purchases (default newest first) with their supplier, receipt and totals. */
  async findPage(filters: PurchaseOrderFilters, page: PageQuery) {
    const where: Prisma.PurchaseOrderWhereInput = {
      AND: [await this.buildWhere(filters), deletedWhere(page.deleted)],
    };
    const escapeHatch: Record<string, unknown> = includeSoftDeletedFor(
      page.deleted,
    )
      ? { includeSoftDeleted: true }
      : {};
    const { take, skip } = offsetOf(page);
    const orderBy =
      resolveSortOrBadRequest<Prisma.PurchaseOrderOrderByWithRelationInput>(
        page,
        PURCHASE_ORDER_SORT_ALLOWLIST,
      ) ??
      ({
        createdAt: 'desc',
      } satisfies Prisma.PurchaseOrderOrderByWithRelationInput);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.purchaseOrder.findMany({
        where,
        orderBy: [orderBy, { id: 'asc' }],
        take,
        skip,
        include: PURCHASE_ORDER_INCLUDE,
        ...escapeHatch,
      }),
      this.prisma.purchaseOrder.count({ where, ...escapeHatch }),
    ]);
    const received = await this.receivedByLine(
      this.prisma,
      rows.flatMap((row) => row.lines.map((line) => line.id)),
    );
    const items = rows.map((row) => {
      const { lines, ...item } = this.toDetail(row, received);
      return { ...item, lineCount: lines.length };
    });
    return pageOf(items, total, page);
  }

  /** The `where` of the list (and its count). The receipt filter resolves to a set of purchase ids. */
  private async buildWhere({
    q,
    status,
    supplierId,
    receipt,
  }: PurchaseOrderFilters): Promise<Prisma.PurchaseOrderWhereInput> {
    const and: Prisma.PurchaseOrderWhereInput[] = [];
    if (q) {
      const contains = { contains: q, mode: 'insensitive' as const };
      and.push({
        OR: [
          { reference: contains },
          { invoiceNumbers: contains },
          { supplier: { name: contains } },
          { lines: { some: { deletedAt: null, description: contains } } },
        ],
      });
    }
    if (status) and.push({ status: { in: status } });
    if (supplierId) and.push({ supplierId });
    if (receipt) {
      and.push({ id: { in: await this.purchaseIdsWithReceipt(receipt) } });
      if (receipt === 'PENDING') and.push({ status: { not: 'CANCELLED' } });
    }
    return { AND: and };
  }

  /**
   * The purchases whose DERIVED receipt matches `filter`. Receipt is never stored, so this reads every live
   * countable line with its live linked-asset count in ONE query and derives the state with the same
   * functions the detail read uses — the list filter and the shown state can never disagree.
   */
  private async purchaseIdsWithReceipt(
    filter: PurchaseOrderReceiptFilter,
  ): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<
      {
        purchaseOrderId: string;
        kind: string;
        quantity: number;
        cancelledQuantity: number;
        received: number;
      }[]
    >`
      SELECT l."purchaseOrderId", l."kind", l."quantity", l."cancelledQuantity",
             (SELECT COUNT(*)::int FROM "assets" a
               WHERE a."purchaseOrderLineId" = l."id" AND a."deletedAt" IS NULL) AS "received"
        FROM "purchase_order_lines" l
       WHERE l."deletedAt" IS NULL
         AND l."kind" IN (${Prisma.join([...COUNTABLE_LINE_KINDS])})`;
    const linesByPurchase = new Map<
      string,
      (LineInput & ReturnType<typeof deriveLine>)[]
    >();
    for (const row of rows) {
      const input: LineInput = { ...row, unitPrice: null };
      const derived = { ...input, ...deriveLine(input, row.received) };
      const lines = linesByPurchase.get(row.purchaseOrderId) ?? [];
      lines.push(derived);
      linesByPurchase.set(row.purchaseOrderId, lines);
    }
    const ids: string[] = [];
    for (const [id, lines] of linesByPurchase) {
      const state = derivePurchaseReceipt(lines)?.state;
      const matches =
        filter === 'PENDING'
          ? state === 'NONE' || state === 'PARTIAL'
          : state === filter;
      if (matches) ids.push(id);
    }
    return ids;
  }

  /** A live purchase with its live lines and every derived value; 404 if missing or soft-deleted. */
  async findOne(id: string) {
    return this.readDetail(this.prisma, id);
  }

  private async readDetail(client: Tx | PrismaService, id: string) {
    const row = await client.purchaseOrder.findFirst({
      where: { id, deletedAt: null },
      include: PURCHASE_ORDER_INCLUDE,
    });
    if (!row) {
      throw new NotFoundException(`Purchase ${id} not found`);
    }
    const received = await this.receivedByLine(
      client,
      row.lines.map((line) => line.id),
    );
    return this.toDetail(row, received);
  }

  /** Live linked assets per line, in one grouped query (no N+1). Absent line → 0. */
  private async receivedByLine(
    client: Tx | PrismaService,
    lineIds: string[],
  ): Promise<Map<string, number>> {
    if (lineIds.length === 0) return new Map();
    const groups = await client.asset.groupBy({
      by: ['purchaseOrderLineId'],
      // Explicit `deletedAt: null`: a received unit is a LIVE asset, whatever filter the client carries.
      where: { purchaseOrderLineId: { in: lineIds }, deletedAt: null },
      _count: { _all: true },
    });
    return new Map(
      groups.map((group) => [
        group.purchaseOrderLineId as string,
        group._count._all,
      ]),
    );
  }

  /** Build the wire detail: lines with their derived values, the receipt and the totals. */
  private toDetail(row: PurchaseOrderRow, received: Map<string, number>) {
    const { lines, ...purchase } = row;
    const derived = lines.map((line) => ({
      line,
      ...deriveLine(line, received.get(line.id) ?? 0),
    }));
    return {
      ...purchase,
      receipt: derivePurchaseReceipt(
        derived.map(({ line, ...values }) => ({ ...line, ...values })),
      ),
      totals: purchaseTotals(purchase.currency, derived),
      lines: derived.map(({ line, ...values }) =>
        this.lineToWire(line, values),
      ),
    };
  }

  /** A line row as the wire carries it: money as numbers, plus its derived receipt values. */
  lineToWire(line: LineRow, values: ReturnType<typeof deriveLine>) {
    return {
      ...purchaseOrderLineMoneyToWire(line),
      receivedQuantity: values.receivedQuantity,
      pendingQuantity: values.pendingQuantity,
      receiptState: values.receiptState,
      lineTotal: lineTotalToWire(values.lineTotal),
    };
  }

  /** The activity log of a live purchase, newest first. */
  async findEvents(id: string, page: PageQuery) {
    await this.assertLive(this.prisma, id);
    const { take, skip } = offsetOf(page);
    const where = { purchaseOrderId: id };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.purchaseOrderEvent.findMany({
        where,
        orderBy: { id: 'desc' },
        take,
        skip,
      }),
      this.prisma.purchaseOrderEvent.count({ where }),
    ]);
    return pageOf(items, total, page);
  }

  // ── Purchase writes ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Create a purchase, with any lines given inline, and its `CREATED` event — one transaction. The schema
   * already refused a purchase that identifies nothing; nothing is unique, so the same reference twice is
   * simply two purchases.
   */
  async create(data: CreatePurchaseOrder, principal?: Principal) {
    const actor = this.actor.resolveActor(principal);
    const { lines = [], ...header } = data;
    lines.forEach((line) =>
      assertLineTotalFits(line.quantity ?? 1, line.unitPrice ?? null),
    );
    return this.prisma.$transaction(async (tx) => {
      await this.assertReferences(tx, header);
      await this.assertModelsLive(
        tx,
        lines.map((line) => line.assetModelId),
      );
      const created = await tx.purchaseOrder.create({
        data: {
          ...header,
          status: header.status ?? DEFAULT_PURCHASE_ORDER_STATUS,
          lines: {
            create: lines.map((line, index) =>
              this.lineCreateData(line, line.position ?? index),
            ),
          },
        },
      });
      await recordPurchaseOrderEvent(tx, created.id, 'CREATED', actor, {
        lineCount: lines.length,
      });
      return this.readDetail(tx, created.id);
    });
  }

  /**
   * Update the header. A status change writes `STATUS_CHANGED { from, to }`; any other change writes one
   * `UPDATED { fields, changes }`. Refuses a change that would leave the purchase with nothing that
   * identifies it (no supplier, no reference, no line); the purchase row is locked first, so a concurrent
   * line removal cannot slip between the check and the write.
   */
  async update(id: string, data: UpdatePurchaseOrder, principal?: Principal) {
    const actor = this.actor.resolveActor(principal);
    return this.prisma.$transaction(async (tx) => {
      const before = await this.assertLive(tx, id, { lock: true });
      await this.assertReferences(tx, data);
      const supplierId =
        data.supplierId !== undefined ? data.supplierId : before.supplierId;
      const reference =
        data.reference !== undefined ? data.reference : before.reference;
      if (supplierId === null && reference === null) {
        await this.assertHasLines(tx, id);
      }
      await tx.purchaseOrder.update({ where: { id }, data });
      if (data.status !== undefined && data.status !== before.status) {
        await recordPurchaseOrderEvent(tx, id, 'STATUS_CHANGED', actor, {
          from: before.status,
          to: data.status,
        });
      }
      const changes = diff(before, data, HEADER_FIELDS);
      if (Object.keys(changes).length > 0) {
        await recordPurchaseOrderEvent(tx, id, 'UPDATED', actor, {
          fields: Object.keys(changes),
          changes,
        });
      }
      return this.readDetail(tx, id);
    });
  }

  /** Soft delete (ADMIN). Every asset link is kept; nothing else is touched. */
  async remove(id: string, principal?: Principal) {
    const actor = this.actor.resolveActor(principal);
    return this.prisma.$transaction(async (tx) => {
      await this.assertLive(tx, id);
      await tx.purchaseOrder.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await recordPurchaseOrderEvent(tx, id, 'DELETED', actor);
      return tx.purchaseOrder.findFirstOrThrow({
        where: { id },
        includeSoftDeleted: true,
      } as Prisma.PurchaseOrderFindFirstOrThrowArgs);
    });
  }

  /** Restore (ADMIN, ADR-0041). 404 if it never existed; idempotent (no event) when already live. */
  async restore(id: string, principal?: Principal) {
    const actor = this.actor.resolveActor(principal);
    return this.prisma.$transaction(async (tx) => {
      // The read filter applies inside the transaction too; restore must see the archived row (ADR-0032).
      const purchase = await tx.purchaseOrder.findFirst({
        where: { id },
        includeSoftDeleted: true,
      } as Prisma.PurchaseOrderFindFirstArgs);
      if (!purchase) {
        throw new NotFoundException(`Purchase ${id} not found`);
      }
      if (purchase.deletedAt !== null) {
        await tx.purchaseOrder.update({
          where: { id },
          data: { deletedAt: null },
        });
        await recordPurchaseOrderEvent(tx, id, 'RESTORED', actor);
      }
      return this.readDetail(tx, id);
    });
  }

  // ── Line writes ─────────────────────────────────────────────────────────────────────────────────────

  /** Add a line (appended after the last one unless `position` is given) and its `LINE_ADDED` event. */
  async addLine(
    purchaseOrderId: string,
    data: CreatePurchaseOrderLine,
    principal?: Principal,
  ) {
    const actor = this.actor.resolveActor(principal);
    assertLineTotalFits(data.quantity ?? 1, data.unitPrice ?? null);
    return this.prisma.$transaction(async (tx) => {
      await this.assertLive(tx, purchaseOrderId);
      await this.assertModelsLive(tx, [data.assetModelId]);
      let position = data.position;
      if (position === undefined) {
        const last = await tx.purchaseOrderLine.aggregate({
          where: { purchaseOrderId, deletedAt: null },
          _max: { position: true },
        });
        position = last._max.position === null ? 0 : last._max.position + 1;
      }
      const line = await tx.purchaseOrderLine.create({
        data: { purchaseOrderId, ...this.lineCreateData(data, position) },
      });
      await recordPurchaseOrderEvent(tx, purchaseOrderId, 'LINE_ADDED', actor, {
        lineId: line.id,
        description: line.description,
        quantity: line.quantity,
        unitPrice: logValue(line.unitPrice),
      });
      return this.readLine(tx, line.id);
    });
  }

  /**
   * Update a line. Values are recorded before and after in `LINE_UPDATED` — "unit price changed from X to
   * Y" is what the log is for. The cancelled count may not exceed the quantity; the kind of a line that
   * already has assets linked cannot change (its received units would silently stop counting).
   */
  async updateLine(
    purchaseOrderId: string,
    lineId: string,
    data: UpdatePurchaseOrderLine,
    principal?: Principal,
  ) {
    const actor = this.actor.resolveActor(principal);
    return this.prisma.$transaction(async (tx) => {
      // A kind change is checked against the linked assets: lock the purchase first so a concurrent link
      // (which takes KEY SHARE on it) cannot slip a unit in between the check and the write.
      const { line: before } = await this.assertLineLive(
        tx,
        purchaseOrderId,
        lineId,
        { lock: data.kind !== undefined },
      );
      await this.assertModelsLive(tx, [data.assetModelId ?? undefined]);
      const quantity = data.quantity ?? before.quantity;
      const cancelled = data.cancelledQuantity ?? before.cancelledQuantity;
      if (cancelled > quantity) {
        throw new BadRequestException(
          'cancelledQuantity cannot exceed quantity',
        );
      }
      assertLineTotalFits(
        quantity,
        data.unitPrice !== undefined
          ? data.unitPrice
          : before.unitPrice === null
            ? null
            : Number(before.unitPrice),
      );
      if (data.kind !== undefined && data.kind !== before.kind) {
        await this.assertNothingLinked(tx, lineId, 'change the kind of');
      }
      await tx.purchaseOrderLine.update({
        where: { id: lineId },
        data: purchaseOrderLineMoneyToDb(data),
      });
      const changes = diff(before, data, LINE_FIELDS);
      if (Object.keys(changes).length > 0) {
        await recordPurchaseOrderEvent(
          tx,
          purchaseOrderId,
          'LINE_UPDATED',
          actor,
          {
            lineId,
            changes,
          },
        );
      }
      return this.readLine(tx, lineId);
    });
  }

  /**
   * Remove a line (soft delete), only while no live asset is linked to it (ADR-0099 §9), and never the
   * last thing that identifies the purchase. The purchase row is locked first (`SELECT … FOR UPDATE`, the
   * ADR-0098 pattern), so two concurrent removals — or a removal racing a header update that clears the
   * supplier and reference — serialize and the second one sees the first.
   */
  async removeLine(
    purchaseOrderId: string,
    lineId: string,
    principal?: Principal,
  ) {
    const actor = this.actor.resolveActor(principal);
    return this.prisma.$transaction(async (tx) => {
      const { purchase, line } = await this.assertLineLive(
        tx,
        purchaseOrderId,
        lineId,
        { lock: true },
      );
      await this.assertNothingLinked(tx, lineId, 'remove');
      if (purchase.supplierId === null && purchase.reference === null) {
        const others = await tx.purchaseOrderLine.count({
          where: { purchaseOrderId, deletedAt: null, id: { not: lineId } },
        });
        if (others === 0) {
          throw new BadRequestException(
            'A purchase needs a supplier, a reference or at least one line: set one before removing its last line',
          );
        }
      }
      const now = new Date();
      await tx.purchaseOrderLine.update({
        where: { id: lineId },
        data: { deletedAt: now },
      });
      await recordPurchaseOrderEvent(
        tx,
        purchaseOrderId,
        'LINE_REMOVED',
        actor,
        {
          lineId,
          description: line.description,
        },
      );
      // Nothing is linked (checked above), so the line reads as received 0 — the full line shape.
      return { ...this.lineToWire(line, deriveLine(line, 0)), deletedAt: now };
    });
  }

  /**
   * Cancel units that will not arrive ("cancel remaining units", ADR-0099 §3): adds `quantity` (default every
   * pending unit) to the line's cancelled count and writes `UNITS_CANCELLED` with the optional reason. The
   * line row is locked first, so two concurrent cancels cannot both take the same pending units. Refuses a
   * line with nothing pending (409) and a quantity beyond the pending count (400).
   */
  async cancelRemaining(
    purchaseOrderId: string,
    lineId: string,
    data: CancelRemainingUnits,
    principal?: Principal,
  ) {
    const actor = this.actor.resolveActor(principal);
    return this.prisma.$transaction(async (tx) => {
      await this.assertLineLive(tx, purchaseOrderId, lineId);
      await tx.$queryRaw`SELECT "id" FROM "purchase_order_lines" WHERE "id" = ${lineId} FOR UPDATE`;
      // Re-read under the lock: the cancelled count may have moved since the check above.
      const line = await tx.purchaseOrderLine.findFirstOrThrow({
        where: { id: lineId },
      });
      const received = await this.receivedByLine(tx, [lineId]);
      const { pendingQuantity } = deriveLine(line, received.get(lineId) ?? 0);
      if (pendingQuantity === 0) {
        throw new ConflictException('This line has no pending units to cancel');
      }
      const quantity = data.quantity ?? pendingQuantity;
      if (quantity > pendingQuantity) {
        throw new BadRequestException(
          `Only ${pendingQuantity} unit(s) are pending on this line`,
        );
      }
      const to = line.cancelledQuantity + quantity;
      await tx.purchaseOrderLine.update({
        where: { id: lineId },
        data: { cancelledQuantity: to },
      });
      await recordPurchaseOrderEvent(
        tx,
        purchaseOrderId,
        'UNITS_CANCELLED',
        actor,
        {
          lineId,
          quantity,
          cancelledQuantity: { from: line.cancelledQuantity, to },
          reason: data.reason ?? null,
        },
      );
      return this.readLine(tx, lineId);
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────

  private lineCreateData(line: CreatePurchaseOrderLine, position: number) {
    return purchaseOrderLineMoneyToDb({
      ...line,
      kind: line.kind ?? DEFAULT_PURCHASE_ORDER_LINE_KIND,
      position,
    });
  }

  /** One line with its derived values (also read by the receiving flows after their writes). */
  async readLine(tx: Tx | PrismaService, lineId: string) {
    const line = await tx.purchaseOrderLine.findFirstOrThrow({
      where: { id: lineId },
    });
    const received = await this.receivedByLine(tx, [lineId]);
    return this.lineToWire(line, deriveLine(line, received.get(lineId) ?? 0));
  }

  /**
   * A live purchase row; 404 otherwise. With `lock`, the row is locked for the rest of the transaction
   * first (`SELECT … FOR UPDATE`), so a check made on it holds until the commit.
   */
  private async assertLive(
    client: Tx | PrismaService,
    id: string,
    options: { lock?: boolean } = {},
  ) {
    if (options.lock) {
      await client.$queryRaw`SELECT "id" FROM "purchase_orders" WHERE "id" = ${id} FOR UPDATE`;
    }
    const purchase = await client.purchaseOrder.findFirst({
      where: { id, deletedAt: null },
    });
    if (!purchase) {
      throw new NotFoundException(`Purchase ${id} not found`);
    }
    return purchase;
  }

  /**
   * A live line of a live purchase (404 otherwise — a line of another purchase is not found here). An
   * archived purchase therefore takes no new link, unit or cancellation (ADR-0099 §9).
   */
  async assertLineLive(
    tx: Tx | PrismaService,
    purchaseOrderId: string,
    lineId: string,
    options: { lock?: boolean } = {},
  ) {
    const purchase = await this.assertLive(tx, purchaseOrderId, options);
    const line = await tx.purchaseOrderLine.findFirst({
      where: { id: lineId, purchaseOrderId, deletedAt: null },
    });
    if (!line) {
      throw new NotFoundException(
        `Line ${lineId} not found on purchase ${purchaseOrderId}`,
      );
    }
    return { purchase, line };
  }

  private async assertHasLines(tx: Tx, purchaseOrderId: string) {
    const lines = await tx.purchaseOrderLine.count({
      where: { purchaseOrderId, deletedAt: null },
    });
    if (lines === 0) {
      throw new BadRequestException(
        'A purchase needs a supplier, a reference or at least one line',
      );
    }
  }

  /** 409 when a live asset is linked to the line. */
  private async assertNothingLinked(tx: Tx, lineId: string, verb: string) {
    const linked = await tx.asset.count({
      where: { purchaseOrderLineId: lineId, deletedAt: null },
    });
    if (linked > 0) {
      throw new ConflictException(
        `Cannot ${verb} a line with ${linked} linked asset(s); unlink them first`,
      );
    }
  }

  /** The supplier and delivery location a write names must be live (a soft-deleted one passes the FK). */
  private async assertReferences(
    tx: Tx,
    data: { supplierId?: string | null; deliveryLocationId?: string | null },
  ) {
    if (data.supplierId) {
      const supplier = await tx.supplier.findFirst({
        where: { id: data.supplierId, deletedAt: null },
        select: { id: true },
      });
      if (!supplier) {
        throw new BadRequestException(`Supplier ${data.supplierId} not found`);
      }
    }
    if (data.deliveryLocationId) {
      const location = await tx.location.findFirst({
        where: { id: data.deliveryLocationId, deletedAt: null },
        select: { id: true },
      });
      if (!location) {
        throw new BadRequestException(
          `Location ${data.deliveryLocationId} not found`,
        );
      }
    }
  }

  private async assertModelsLive(tx: Tx, ids: (string | undefined)[]) {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    if (wanted.length === 0) return;
    const found = await tx.assetModel.findMany({
      where: { id: { in: wanted }, deletedAt: null },
      select: { id: true },
    });
    const missing = wanted.filter((id) => !found.some((m) => m.id === id));
    if (missing.length > 0) {
      throw new BadRequestException(`AssetModel ${missing[0]} not found`);
    }
  }
}
