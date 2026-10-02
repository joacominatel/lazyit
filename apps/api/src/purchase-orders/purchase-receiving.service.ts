import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  applyActionOf,
  costApplyActionOf,
  offsetOf,
  pageOf,
  purchaseLineValues,
  RECEIVE_ASSETS_MAX_QUANTITY,
  warrantyEndFrom,
  type LinkAssetsToLine,
  type PageQuery,
  type PurchaseApplyAction,
  type PurchaseApplyField,
  type PurchaseLineValues,
  type PurchaseLinkFailureReason,
  type PurchaseLinkState,
  type ReceiveAssets,
  type ReceiveFromLine,
  type ReceiveStockFromLine,
} from '@lazyit/shared';
import { Prisma, type Asset } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import type { Principal } from '../auth/principal';
import { assetMoneyToDb, assetMoneyToWire } from '../common/money';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { AssetsService } from '../assets/assets.service';
import { ConsumablesService } from '../consumables/consumables.service';
import { PurchaseOrdersService } from './purchase-orders.service';
import { recordPurchaseOrderEvent } from './purchase-order-events';
import { COUNTABLE_LINE_KINDS, deriveLine } from './purchase-order-derived';
import {
  assertAssetLine,
  assertConsumableLine,
  countReceived,
  isOverReceived,
  receivedByLine,
} from './purchase-order-line-receipt';

type Tx = Prisma.TransactionClient;
/** An asset row as the wire carries it (money as numbers). */
type AssetWire = ReturnType<typeof assetMoneyToWire<Asset>>;

/** What linking reads of each asset: its link, and the fields `apply` may write. */
const LINK_ASSET_SELECT = {
  id: true,
  name: true,
  assetTag: true,
  purchaseOrderLineId: true,
  purchaseDate: true,
  purchaseCost: true,
  purchaseCurrency: true,
  warrantyEnd: true,
  company: true,
  modelId: true,
  purchaseOrderLine: { select: { purchaseOrderId: true } },
} as const satisfies Prisma.AssetSelect;

type LinkAssetRow = Prisma.AssetGetPayload<{
  select: typeof LINK_ASSET_SELECT;
}>;

/** The purchase header the value mapping reads. */
type PurchaseHeader = {
  orderDate: Date | null;
  invoiceDate: Date | null;
  currency: string | null;
  company: string | null;
};

/** The line values the value mapping reads. */
type LineValuesRow = {
  unitPrice: bigint | null;
  warrantyMonths: number | null;
  assetModelId: string | null;
};

/** The supplier projection of an asset's provenance: name and the support / RMA contact. */
const PROVENANCE_SUPPLIER_SELECT = {
  id: true,
  name: true,
  website: true,
  supportContactName: true,
  supportContactEmail: true,
  supportContactPhone: true,
  deletedAt: true,
} as const satisfies Prisma.SupplierSelect;

/** One asset's diff against the line, field by field. */
type AssetDiff = {
  [F in PurchaseApplyField]: { action: PurchaseApplyAction };
} & {
  purchaseDate: { current: string | null; purchase: string | null };
  purchaseCost: {
    current: { amount: number | null; currency: string | null };
    purchase: PurchaseLineValues['purchaseCost'];
  };
  warrantyEnd: { current: string | null; purchase: string | null };
  company: { current: string | null; purchase: string | null };
  modelId: { current: string | null; purchase: string | null };
};

const iso = (date: Date | null) => (date === null ? null : date.toISOString());

/** The values a line offers to its assets — the shared mapping over the stored rows. */
function lineValues(
  purchase: PurchaseHeader,
  line: LineValuesRow,
): PurchaseLineValues {
  return purchaseLineValues(
    {
      orderDate: iso(purchase.orderDate),
      invoiceDate: iso(purchase.invoiceDate),
      currency: purchase.currency,
      company: purchase.company,
    },
    {
      unitPrice: line.unitPrice === null ? null : Number(line.unitPrice),
      warrantyMonths: line.warrantyMonths,
      assetModelId: line.assetModelId,
    },
  );
}

/** One asset's per-field diff against the values a line offers. */
function diffAsset(asset: LinkAssetRow, values: PurchaseLineValues): AssetDiff {
  const currentDate = iso(asset.purchaseDate);
  const currentWarranty = iso(asset.warrantyEnd);
  const currentCost = {
    amount: asset.purchaseCost === null ? null : Number(asset.purchaseCost),
    currency: asset.purchaseCurrency,
  };
  return {
    purchaseDate: {
      current: currentDate,
      purchase: values.purchaseDate,
      action: applyActionOf(currentDate, values.purchaseDate, 'date'),
    },
    purchaseCost: {
      current: currentCost,
      purchase: values.purchaseCost,
      action: costApplyActionOf(currentCost, values.purchaseCost),
    },
    warrantyEnd: {
      current: currentWarranty,
      purchase: values.warrantyEnd,
      action: applyActionOf(currentWarranty, values.warrantyEnd, 'date'),
    },
    company: {
      current: asset.company,
      purchase: values.company,
      action: applyActionOf(asset.company, values.company),
    },
    modelId: {
      current: asset.modelId,
      purchase: values.modelId,
      action: applyActionOf(asset.modelId, values.modelId),
    },
  };
}

/**
 * The asset columns applying `fields` writes — only where the diff is a FILL or a REPLACE (a field the
 * purchase has no value for, or one already equal, is left alone: applying never clears). `purchaseCost`
 * writes its currency label with it.
 */
function appliedData(
  fields: readonly PurchaseApplyField[],
  diff: AssetDiff,
  values: PurchaseLineValues,
): { data: Prisma.AssetUncheckedUpdateInput; applied: PurchaseApplyField[] } {
  const data: Record<string, unknown> = {};
  const applied: PurchaseApplyField[] = [];
  for (const field of new Set(fields)) {
    const action = diff[field].action;
    if (action !== 'FILL' && action !== 'REPLACE') continue;
    applied.push(field);
    switch (field) {
      case 'purchaseCost':
        data.purchaseCost = values.purchaseCost?.amount;
        data.purchaseCurrency = values.purchaseCost?.currency ?? null;
        break;
      case 'purchaseDate':
        data.purchaseDate = values.purchaseDate;
        break;
      case 'warrantyEnd':
        data.warrantyEnd = values.warrantyEnd;
        break;
      case 'company':
        data.company = values.company;
        break;
      case 'modelId':
        data.modelId = values.modelId;
        break;
    }
  }
  return {
    data: assetMoneyToDb(
      data as { purchaseCost?: number | null },
    ) as Prisma.AssetUncheckedUpdateInput,
    applied,
  };
}

/**
 * The `reason` of a movement received from a purchase. Deliberately names no supplier or reference: the
 * consumable ledger is read under `consumable:read` (a VIEWER holds it), and a purchase's provenance follows
 * `purchaseOrder:read` (ADR-0099 §8, D-A). The link itself is the movement's `purchaseOrderLineId`.
 */
export const STOCK_RECEIPT_REASON = 'Received from a purchase';

/** The first day of the current UTC day — "today" as a purchase date. */
function todayUtc(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/**
 * The Purchases flows that move units (ADR-0099 §2–§4, #1473): receiving assets from a line, linking and
 * unlinking existing assets with the per-field "apply values" choice, the pending-units list and an asset's
 * purchase provenance. Asset purchase fields stay authoritative — a purchase value reaches an asset only for
 * a field the caller lists. Over-receipt is allowed and reported, never refused.
 */
@Injectable()
export class PurchaseReceivingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
    private readonly history: AssetHistoryService,
    private readonly assets: AssetsService,
    private readonly purchases: PurchaseOrdersService,
    private readonly consumables: ConsumablesService,
  ) {}

  // ── Link preview ────────────────────────────────────────────────────────────────────────────────────

  /**
   * The confirmation diff of a link (ux-proposal §3.e): the values the line offers, and per asset its current
   * value, the purchase value and whether applying it fills, replaces or changes nothing. Ids that are not
   * live assets come back in `missing`.
   */
  async linkPreview(
    purchaseOrderId: string,
    lineId: string,
    assetIds: string[],
  ) {
    const { purchase, line } = await this.purchases.assertLineLive(
      this.prisma,
      purchaseOrderId,
      lineId,
    );
    assertAssetLine(line);
    const values = lineValues(purchase, line);
    const rows = await this.prisma.asset.findMany({
      where: { id: { in: assetIds }, deletedAt: null },
      select: LINK_ASSET_SELECT,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const assets = assetIds
      .filter((id) => byId.has(id))
      .map((id) => {
        const row = byId.get(id) as LinkAssetRow;
        const linkState: PurchaseLinkState =
          row.purchaseOrderLineId === null
            ? 'NONE'
            : row.purchaseOrderLineId === lineId
              ? 'THIS_LINE'
              : 'OTHER_LINE';
        return {
          assetId: row.id,
          name: row.name,
          assetTag: row.assetTag,
          linkState,
          linkedLineId: row.purchaseOrderLineId,
          linkedPurchaseOrderId: row.purchaseOrderLine?.purchaseOrderId ?? null,
          fields: diffAsset(row, values),
        };
      });
    const received = await countReceived(this.prisma, line);
    const receivedAfter =
      received +
      assets.filter((asset) => asset.linkState !== 'THIS_LINE').length;
    return {
      line: await this.purchases.readLine(this.prisma, lineId),
      values,
      assets,
      missing: assetIds.filter((id) => !byId.has(id)),
      receivedAfter,
      overReceivedAfter:
        receivedAfter > Math.max(line.quantity - line.cancelledQuantity, 0),
    };
  }

  // ── Link / unlink ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Link existing assets to an `ASSET` line — partial success, like bulk receive. One transaction: the
   * asset rows are locked (`SELECT … FOR UPDATE`) so a concurrent link of the same asset waits and then sees
   * it linked; each linked asset gets its link, the purchase values the caller listed (only where the diff
   * is a fill or a replace), a `PURCHASE_LINKED` history event (and `MODEL_CHANGED` when the model is
   * applied); the purchase gets ONE `ASSET_LINKED` event. An asset on another line moves only with
   * `move: true`, and its old purchase records `ASSET_UNLINKED` in the same transaction. Over-receipt is
   * allowed and reported (`overReceived`).
   */
  async linkAssets(
    purchaseOrderId: string,
    lineId: string,
    data: LinkAssetsToLine,
    principal?: Principal,
  ) {
    const actor = this.actor.resolveActor(principal);
    return this.prisma.$transaction(async (tx) => {
      // Lock order: purchase, then assets. KEY SHARE conflicts with the FOR UPDATE that removing a line (or
      // changing its kind) takes on the purchase, so a link and a line removal serialize and the removal sees
      // the linked asset — yet two links on the same purchase, or cross moves between two purchases, do not
      // block each other (KEY SHARE does not conflict with itself), so no deadlock.
      await tx.$queryRaw`SELECT "id" FROM "purchase_orders" WHERE "id" = ${purchaseOrderId} FOR KEY SHARE`;
      const { purchase, line } = await this.purchases.assertLineLive(
        tx,
        purchaseOrderId,
        lineId,
      );
      assertAssetLine(line);
      const values = lineValues(purchase, line);
      const rows = await this.lockAssets(tx, data.assetIds);

      const linked: AssetWire[] = [];
      const failed: Failure[] = [];
      const applied: Record<string, PurchaseApplyField[]> = {};
      const moved: Prisma.InputJsonObject[] = [];
      const movedFrom = new Map<
        string,
        { purchaseOrderId: string; assetIds: string[] }
      >();

      for (const assetId of data.assetIds) {
        const row = rows.get(assetId);
        if (!row) {
          failed.push(failure(assetId, 'NOT_FOUND'));
          continue;
        }
        if (row.purchaseOrderLineId === lineId) {
          failed.push(failure(assetId, 'ALREADY_LINKED'));
          continue;
        }
        if (row.purchaseOrderLineId !== null && !data.move) {
          failed.push(failure(assetId, 'LINKED_ELSEWHERE'));
          continue;
        }
        const fields = data.applyByAsset?.[assetId] ?? data.apply ?? [];
        const write = appliedData(fields, diffAsset(row, values), values);
        const updated = await tx.asset.update({
          where: { id: assetId },
          data: { ...write.data, purchaseOrderLineId: lineId },
        });
        const previous =
          row.purchaseOrderLineId !== null && row.purchaseOrderLine
            ? {
                purchaseOrderId: row.purchaseOrderLine.purchaseOrderId,
                lineId: row.purchaseOrderLineId,
              }
            : null;
        await this.history.record(tx, {
          assetId,
          eventType: 'PURCHASE_LINKED',
          actor,
          payload: {
            purchaseOrderId,
            purchaseOrderLineId: lineId,
            applied: write.applied,
            ...(previous
              ? {
                  fromPurchaseOrderId: previous.purchaseOrderId,
                  fromPurchaseOrderLineId: previous.lineId,
                }
              : {}),
          },
        });
        if (write.applied.includes('modelId')) {
          await this.history.record(tx, {
            assetId,
            eventType: 'MODEL_CHANGED',
            actor,
            payload: { from: row.modelId, to: updated.modelId },
          });
        }
        if (previous) {
          moved.push({ assetId, ...previous });
          const group = movedFrom.get(previous.lineId) ?? {
            purchaseOrderId: previous.purchaseOrderId,
            assetIds: [],
          };
          group.assetIds.push(assetId);
          movedFrom.set(previous.lineId, group);
        }
        applied[assetId] = write.applied;
        linked.push(assetMoneyToWire(updated));
      }

      for (const [fromLineId, group] of movedFrom) {
        await recordPurchaseOrderEvent(
          tx,
          group.purchaseOrderId,
          'ASSET_UNLINKED',
          actor,
          {
            lineId: fromLineId,
            assetIds: group.assetIds,
            movedToPurchaseOrderId: purchaseOrderId,
            movedToLineId: lineId,
          },
        );
      }
      const overReceived = await isOverReceived(tx, line);
      if (linked.length > 0) {
        await recordPurchaseOrderEvent(
          tx,
          purchaseOrderId,
          'ASSET_LINKED',
          actor,
          {
            lineId,
            assetIds: linked.map((asset) => asset.id),
            applied,
            moved,
            overReceived,
          },
        );
      }
      return {
        linked,
        failed,
        overReceived,
        line: await this.purchases.readLine(tx, lineId),
      };
    });
  }

  /**
   * Unlink assets from a line — one or many, partial success. The asset's purchase values are NEVER cleared
   * (ADR-0099 §2). Each unlinked asset gets `PURCHASE_UNLINKED`; the purchase gets one `ASSET_UNLINKED`; all
   * in one transaction, over locked asset rows. An asset that is not live, or not on this line, fails.
   */
  async unlinkAssets(
    purchaseOrderId: string,
    lineId: string,
    assetIds: string[],
    principal?: Principal,
  ) {
    const actor = this.actor.resolveActor(principal);
    return this.prisma.$transaction(async (tx) => {
      await this.purchases.assertLineLive(tx, purchaseOrderId, lineId);
      const rows = await this.lockAssets(tx, assetIds);
      const unlinked: AssetWire[] = [];
      const failed: Failure[] = [];
      for (const assetId of assetIds) {
        const row = rows.get(assetId);
        if (!row) {
          failed.push(failure(assetId, 'NOT_FOUND'));
          continue;
        }
        if (row.purchaseOrderLineId !== lineId) {
          failed.push(failure(assetId, 'NOT_LINKED'));
          continue;
        }
        const updated = await tx.asset.update({
          where: { id: assetId },
          data: { purchaseOrderLineId: null },
        });
        await this.history.record(tx, {
          assetId,
          eventType: 'PURCHASE_UNLINKED',
          actor,
          payload: { purchaseOrderId, purchaseOrderLineId: lineId },
        });
        unlinked.push(assetMoneyToWire(updated));
      }
      if (unlinked.length > 0) {
        await recordPurchaseOrderEvent(
          tx,
          purchaseOrderId,
          'ASSET_UNLINKED',
          actor,
          { lineId, assetIds: unlinked.map((asset) => asset.id) },
        );
      }
      return {
        unlinked,
        failed,
        line: await this.purchases.readLine(tx, lineId),
      };
    });
  }

  /** Lock the named asset rows for the transaction, then read the live ones. */
  private async lockAssets(
    tx: Tx,
    assetIds: string[],
  ): Promise<Map<string, LinkAssetRow>> {
    // A stable lock order (by id), so two requests over overlapping assets cannot deadlock.
    await tx.$queryRaw`SELECT "id" FROM "assets" WHERE "id" IN (${Prisma.join(assetIds)}) ORDER BY "id" FOR UPDATE`;
    const rows = await tx.asset.findMany({
      where: { id: { in: assetIds }, deletedAt: null },
      select: LINK_ASSET_SELECT,
    });
    return new Map(rows.map((row) => [row.id, row]));
  }

  // ── Receive from a line ─────────────────────────────────────────────────────────────────────────────

  /**
   * Generate assets from an `ASSET` line through the bulk-receive loop (ADR-0089: each unit its own
   * transaction and tag-counter commit, untouched). Everything is prefilled from the purchase (the mapping is
   * in `ReceiveFromLineSchema`); the body only overrides. The model is required — the line's, or `modelId`
   * for this receive — else a 400 that says how to fix it. The quantity defaults to the serials, else to the
   * pending units; receiving past them is allowed and flagged.
   */
  async receiveFromLine(
    purchaseOrderId: string,
    lineId: string,
    data: ReceiveFromLine,
    principal?: Principal,
  ) {
    const { purchase, line } = await this.purchases.assertLineLive(
      this.prisma,
      purchaseOrderId,
      lineId,
    );
    assertAssetLine(line);
    const modelId = data.modelId ?? line.assetModelId;
    if (!modelId) {
      throw new BadRequestException(
        'This line has no asset model. Map the line to a model (PATCH the line with assetModelId), or pass modelId to receive it as a model',
      );
    }
    const received = await countReceived(this.prisma, line);
    const { pendingQuantity } = deriveLine(line, received);
    const quantity =
      data.quantity ??
      (data.serials && data.serials.length > 0
        ? data.serials.length
        : pendingQuantity);
    if (quantity < 1) {
      throw new BadRequestException(
        'Nothing is pending on this line. Pass quantity to receive more units than were ordered',
      );
    }
    if (quantity > RECEIVE_ASSETS_MAX_QUANTITY) {
      throw new BadRequestException(
        `Receive at most ${RECEIVE_ASSETS_MAX_QUANTITY} units per request; pass quantity`,
      );
    }

    const purchaseDate =
      data.purchaseDate !== undefined
        ? data.purchaseDate
        : (iso(purchase.invoiceDate) ?? todayUtc());
    const warrantyEnd =
      data.warrantyEnd !== undefined
        ? data.warrantyEnd
        : warrantyEndFrom(purchaseDate, line.warrantyMonths);
    const purchaseCost =
      data.purchaseCost !== undefined
        ? data.purchaseCost
        : line.unitPrice === null
          ? null
          : Number(line.unitPrice);
    const purchaseCurrency =
      data.purchaseCurrency !== undefined
        ? data.purchaseCurrency
        : purchaseCost === null
          ? null
          : purchase.currency;
    const company =
      data.company !== undefined ? data.company : purchase.company;
    const locationId =
      data.locationId !== undefined
        ? data.locationId
        : await this.liveLocation(purchase.deliveryLocationId);

    const body: ReceiveAssets = {
      modelId,
      quantity,
      status: data.status ?? 'IN_STORAGE',
      purchaseOrderLineId: lineId,
      ...(locationId ? { locationId } : {}),
      ...(company ? { company } : {}),
      ...(purchaseDate ? { purchaseDate } : {}),
      ...(warrantyEnd ? { warrantyEnd } : {}),
      ...(purchaseCost !== null ? { purchaseCost } : {}),
      ...(purchaseCurrency ? { purchaseCurrency } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
      ...(data.serials && data.serials.length > 0
        ? { serials: data.serials }
        : {}),
    };
    const result = await this.assets.receiveBatch(body, principal);
    return {
      created: result.created,
      failed: result.failed,
      overReceived: result.overReceived ?? false,
      line: await this.purchases.readLine(this.prisma, lineId),
    };
  }

  // ── Receive into stock (a CONSUMABLE line, #1476) ──────────────────────────────────────────────────────

  /**
   * Receive units of a `CONSUMABLE` line into its consumable's stock: ONE ordinary `IN` movement posted
   * through the consumables path (ADR-0034 — the guarded cache update, the int4 ceiling, the actor, the search
   * re-index), carrying the line id. Inside that movement's transaction the purchase is locked `FOR KEY SHARE`
   * first — the lock a link takes — so a kind change or a line removal (which lock it `FOR UPDATE`) serializes
   * with the receipt and sees it; and the purchase's `STOCK_RECEIVED` event commits with the movement.
   * Over-receipt is allowed and flagged (ADR-0099 §4). 400 for a line that is not `CONSUMABLE`, has no
   * consumable, or names an archived one; 404 for an archived purchase or line.
   */
  async receiveStock(
    purchaseOrderId: string,
    lineId: string,
    data: ReceiveStockFromLine,
    principal?: Principal,
  ) {
    const actor = this.actor.resolveActor(principal);
    const { line } = await this.purchases.assertLineLive(
      this.prisma,
      purchaseOrderId,
      lineId,
    );
    const consumableId = receivableConsumable(line);
    const consumable = await this.prisma.consumable.findFirst({
      where: { id: consumableId, deletedAt: null },
      select: { id: true },
    });
    if (!consumable) {
      throw new BadRequestException(
        `This line's consumable ${consumableId} is archived. Restore it, or map the line to another consumable (PATCH the line with consumableId)`,
      );
    }
    let overReceived = false;
    const movement = await this.consumables.createMovement(
      consumableId,
      {
        type: 'IN',
        quantity: data.quantity,
        reason: STOCK_RECEIPT_REASON,
        ...(data.note !== undefined ? { notes: data.note } : {}),
      },
      principal,
      {
        purchaseOrderLineId: lineId,
        beforeWrite: async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "purchase_orders" WHERE "id" = ${purchaseOrderId} FOR KEY SHARE`;
          // Re-read under the lock: the line may have been removed, or its kind or consumable changed.
          const { line: locked } = await this.purchases.assertLineLive(
            tx,
            purchaseOrderId,
            lineId,
          );
          if (
            locked.kind !== 'CONSUMABLE' ||
            locked.consumableId !== consumableId
          ) {
            throw new ConflictException(
              'The line changed while receiving; reload it and try again',
            );
          }
        },
        afterWrite: async (tx, created) => {
          const current = await tx.purchaseOrderLine.findFirstOrThrow({
            where: { id: lineId },
          });
          overReceived = await isOverReceived(tx, current);
          await recordPurchaseOrderEvent(
            tx,
            purchaseOrderId,
            'STOCK_RECEIVED',
            actor,
            {
              lineId,
              consumableId,
              movementId: created.id,
              quantity: data.quantity,
              overReceived,
            },
          );
        },
      },
    );
    return {
      movement,
      overReceived,
      line: await this.purchases.readLine(this.prisma, lineId),
    };
  }

  /** The purchase's delivery location as a receiving default — only while it is live. */
  private async liveLocation(id: string | null): Promise<string | null> {
    if (!id) return null;
    const location = await this.prisma.location.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    return location?.id ?? null;
  }

  // ── Pending units ───────────────────────────────────────────────────────────────────────────────────

  /**
   * The lines still waiting for units (ux-proposal §3.f): countable lines with pending > 0, on live purchases
   * that are neither `DRAFT` (not ordered yet) nor `CANCELLED`, oldest purchase first. Pending is derived
   * (quantity − cancelled − received: live linked assets, or the units of a `CONSUMABLE` line's `IN`
   * movements) in SQL, and the page and its total share one filter fragment, so pending is filtered and paged
   * in the database rather than over every line in memory.
   */
  async findPendingLines(filters: { supplierId?: string }, page: PageQuery) {
    const { take, skip } = offsetOf(page);
    const supplier = filters.supplierId
      ? Prisma.sql`AND po."supplierId" = ${filters.supplierId}`
      : Prisma.empty;
    const pending = Prisma.sql`
        FROM "purchase_order_lines" l
        JOIN "purchase_orders" po ON po."id" = l."purchaseOrderId"
       WHERE l."deletedAt" IS NULL
         AND po."deletedAt" IS NULL
         AND po."status" NOT IN ('DRAFT', 'CANCELLED')
         AND l."kind" IN (${Prisma.join([...COUNTABLE_LINE_KINDS])})
         ${supplier}
         AND l."quantity" - l."cancelledQuantity" - (
               CASE WHEN l."kind" = 'CONSUMABLE'
                    THEN (SELECT COALESCE(SUM(m."quantity"), 0) FROM "consumable_movements" m
                           WHERE m."purchaseOrderLineId" = l."id" AND m."type" = 'IN'::"ConsumableMovementType")
                    ELSE (SELECT COUNT(*) FROM "assets" a
                           WHERE a."purchaseOrderLineId" = l."id" AND a."deletedAt" IS NULL)
               END
             ) > 0`;
    const [ids, [{ total }]] = await Promise.all([
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT l."id" ${pending}
         ORDER BY po."orderDate" ASC NULLS LAST, po."createdAt" ASC, po."id" ASC,
                  l."position" ASC, l."createdAt" ASC
         LIMIT ${take} OFFSET ${skip}`,
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT COUNT(*)::int AS "total" ${pending}`,
    ]);
    const order = ids.map((row) => row.id);
    const lines = await this.prisma.purchaseOrderLine.findMany({
      where: { id: { in: order } },
      include: {
        purchaseOrder: {
          select: {
            id: true,
            reference: true,
            status: true,
            currency: true,
            orderDate: true,
            expectedDate: true,
            createdAt: true,
            supplier: { select: { id: true, name: true, deletedAt: true } },
          },
        },
      },
    });
    const received = await receivedByLine(this.prisma, lines);
    const byId = new Map(lines.map((line) => [line.id, line]));
    const items = order
      .filter((id) => byId.has(id))
      .map((id) => {
        const { purchaseOrder, ...line } = byId.get(id) as (typeof lines)[0];
        return {
          ...this.purchases.lineToWire(
            line,
            deriveLine(line, received.get(id) ?? 0),
          ),
          purchaseOrder,
        };
      });
    return pageOf(items, total, page);
  }

  // ── An asset's provenance ───────────────────────────────────────────────────────────────────────────

  /**
   * The asset's *Purchase* panel (ADR-0099 §8, D-A — the route requires `purchaseOrder:read`): its line,
   * the purchase header with the supplier's support contact, and the purchase's documents. 404 when the asset
   * is missing or not linked. An archived purchase is still its provenance (soft delete keeps the link); its
   * documents are listed only while it is live, as everywhere else (ADR-0082: the parent's 404 hides them).
   */
  async findAssetProvenance(assetId: string) {
    const asset = await this.prisma.asset.findFirst({
      where: { id: assetId },
      select: { purchaseOrderLineId: true },
    });
    if (!asset) {
      throw new NotFoundException(`Asset ${assetId} not found`);
    }
    if (!asset.purchaseOrderLineId) {
      throw new NotFoundException(
        `Asset ${assetId} is not linked to a purchase`,
      );
    }
    // The escape hatch: the link outlives an archived line or purchase, and so does the provenance.
    const line = await this.prisma.purchaseOrderLine.findFirst({
      where: { id: asset.purchaseOrderLineId },
      include: {
        purchaseOrder: {
          include: { supplier: { select: PROVENANCE_SUPPLIER_SELECT } },
        },
      },
      includeSoftDeleted: true,
    } as Prisma.PurchaseOrderLineFindFirstArgs);
    if (!line) {
      throw new NotFoundException(
        `Asset ${assetId} is not linked to a purchase`,
      );
    }
    const { purchaseOrder: po, ...lineRow } = line as typeof line & {
      purchaseOrder: Prisma.PurchaseOrderGetPayload<{
        include: { supplier: { select: typeof PROVENANCE_SUPPLIER_SELECT } };
      }>;
    };
    const documents =
      po.deletedAt === null
        ? await this.prisma.attachment.findMany({
            where: { entityType: 'PURCHASE_ORDER', entityId: po.id },
            orderBy: { createdAt: 'desc' },
          })
        : [];
    const received = await countReceived(this.prisma, lineRow);
    return {
      line: this.purchases.lineToWire(lineRow, deriveLine(lineRow, received)),
      purchaseOrder: {
        id: po.id,
        reference: po.reference,
        status: po.status,
        currency: po.currency,
        orderDate: po.orderDate,
        expectedDate: po.expectedDate,
        company: po.company,
        invoiceNumbers: po.invoiceNumbers,
        invoiceDate: po.invoiceDate,
        deletedAt: po.deletedAt,
        supplier: po.supplier,
      },
      documents,
    };
  }
}

/**
 * The consumable a `CONSUMABLE` line receives into, or the 400 that says how to fix the line: only a
 * `CONSUMABLE` line is received into stock, and it must name its consumable by then.
 */
function receivableConsumable(line: {
  kind: string;
  consumableId: string | null;
}): string {
  assertConsumableLine(line);
  if (!line.consumableId) {
    throw new BadRequestException(
      'This line has no consumable. Map the line to a consumable (PATCH the line with consumableId) before receiving stock',
    );
  }
  return line.consumableId;
}

type Failure = {
  assetId: string;
  reason: PurchaseLinkFailureReason;
  error: string;
};

const FAILURE_MESSAGES: Record<PurchaseLinkFailureReason, string> = {
  NOT_FOUND: 'Asset not found (missing or archived)',
  ALREADY_LINKED: 'Already linked to this line',
  LINKED_ELSEWHERE:
    'Linked to another purchase line; pass move: true to move it here',
  NOT_LINKED: 'Not linked to this line',
};

function failure(assetId: string, reason: PurchaseLinkFailureReason): Failure {
  return { assetId, reason, error: FAILURE_MESSAGES[reason] };
}
