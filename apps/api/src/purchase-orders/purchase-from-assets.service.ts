import { ConflictException, Injectable, Optional } from '@nestjs/common';
import {
  DEFAULT_PURCHASE_ORDER_STATUS,
  MONEY_MAX,
  currencyGroupKey,
  type CreatePurchaseFromAssets,
  type PurchaseLinkFailureReason,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import type { Principal } from '../auth/principal';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { PurchaseSearchSync } from '../search/purchase-search.sync';
import { PurchaseOrdersService } from './purchase-orders.service';
import { recordPurchaseOrderEvent } from './purchase-order-events';

/** What grouping and pricing read of each selected asset. */
const FROM_ASSET_SELECT = {
  id: true,
  name: true,
  modelId: true,
  purchaseOrderLineId: true,
  purchaseCost: true,
  purchaseCurrency: true,
  model: {
    select: { id: true, name: true, manufacturer: true, deletedAt: true },
  },
} as const satisfies Prisma.AssetSelect;

type FromAssetRow = Prisma.AssetGetPayload<{
  select: typeof FROM_ASSET_SELECT;
}>;

type Failure = {
  assetId: string;
  reason: PurchaseLinkFailureReason;
  error: string;
};

const FAILURE_MESSAGES: Partial<Record<PurchaseLinkFailureReason, string>> = {
  NOT_FOUND: 'Asset not found (missing or archived)',
  LINKED_ELSEWHERE:
    'Already linked to a purchase line; move it from that purchase instead',
};

function failure(assetId: string, reason: PurchaseLinkFailureReason): Failure {
  return { assetId, reason, error: FAILURE_MESSAGES[reason] ?? reason };
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** A group of selected assets that becomes one line: its model, or (without one) its asset name. */
interface AssetGroup {
  assets: FromAssetRow[];
  model: FromAssetRow['model'];
}

/** Assets group by model; assets without a model group by name (trimmed, case-insensitive). */
function groupKey(asset: FromAssetRow): string {
  return asset.modelId
    ? `model:${asset.modelId}`
    : `name:${asset.name.trim().toLowerCase()}`;
}

/**
 * The currency the purchase takes when the request names none: the one label every priced asset shares, as
 * first spelled. None when the priced assets disagree, or none is priced or labelled ("No currency").
 */
function sharedCurrency(assets: readonly FromAssetRow[]): string | null {
  const priced = assets.filter((asset) => asset.purchaseCost !== null);
  const keys = new Set(
    priced.map((asset) => currencyGroupKey(asset.purchaseCurrency)),
  );
  if (keys.size !== 1 || keys.has('')) return null;
  return priced[0].purchaseCurrency!.trim();
}

/**
 * The unit price a line shows, from its assets: their cost when EVERY asset of the group has one, they are
 * all equal and in the purchase's currency label; otherwise unknown (`null`) — never an average, never a
 * cost in another label. The asset's cost is copied to the line, never the other way round.
 */
function sharedUnitPrice(
  group: AssetGroup,
  currency: string | null,
): bigint | null {
  const [first] = group.assets;
  if (!first || first.purchaseCost === null) return null;
  const key = currencyGroupKey(currency);
  const same = group.assets.every(
    (asset) =>
      asset.purchaseCost !== null &&
      asset.purchaseCost === first.purchaseCost &&
      currencyGroupKey(asset.purchaseCurrency) === key,
  );
  if (!same) return null;
  // The line total must stay exact (ADR-0100): past it, the price is left unknown rather than refused.
  return first.purchaseCost * BigInt(group.assets.length) > BigInt(MONEY_MAX)
    ? null
    : first.purchaseCost;
}

/**
 * "Create purchase from selected assets" (ADR-0099 §13 Phase 2, #1477) — back-linking an existing estate:
 * one purchase, one `ASSET` line per group of the selected assets, every linkable asset linked to its
 * group's line. Only the link changes on an asset: no purchase value is copied onto it (values reach an asset
 * only through an explicit apply, §2), so each one records `PURCHASE_LINKED` with nothing applied.
 */
@Injectable()
export class PurchaseFromAssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
    private readonly history: AssetHistoryService,
    private readonly purchases: PurchaseOrdersService,
    // Global search (#1499): index the new purchase once it commits. Optional, as in PurchaseOrdersService.
    @Optional() private readonly searchSync?: PurchaseSearchSync,
  ) {}

  /**
   * One transaction, in the purchase-write lock order: the purchase row is inserted first (a row this
   * transaction created is its own until commit), then the asset rows are locked `FOR UPDATE` in id order —
   * as a link does — and re-read, so an asset another request links meanwhile is seen linked and left out.
   * Partial success: assets that are missing, archived or already on a purchase line come back in `failed`
   * and the rest go through. When none can be linked, nothing is created (409).
   */
  async create(data: CreatePurchaseFromAssets, principal?: Principal) {
    const actor = this.actor.resolveActor(principal);
    const { assetIds, ...header } = data;
    const result = await this.prisma.$transaction(async (tx) => {
      await this.purchases.assertReferences(tx, header);
      const purchase = await tx.purchaseOrder.create({
        data: {
          ...header,
          status: header.status ?? DEFAULT_PURCHASE_ORDER_STATUS,
        },
      });

      await tx.$queryRaw`SELECT "id" FROM "assets" WHERE "id" IN (${Prisma.join(assetIds)}) ORDER BY "id" FOR UPDATE`;
      const rows = await tx.asset.findMany({
        where: { id: { in: assetIds }, deletedAt: null },
        select: FROM_ASSET_SELECT,
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      const failed: Failure[] = [];
      const linkable: FromAssetRow[] = [];
      for (const assetId of assetIds) {
        const row = byId.get(assetId);
        if (!row) failed.push(failure(assetId, 'NOT_FOUND'));
        else if (row.purchaseOrderLineId !== null) {
          failed.push(failure(assetId, 'LINKED_ELSEWHERE'));
        } else linkable.push(row);
      }
      if (linkable.length === 0) {
        // Throwing rolls the purchase insert back: nothing is created.
        throw new ConflictException({
          message:
            'None of the selected assets can be linked to a new purchase',
          failed,
        });
      }

      const groups = new Map<string, AssetGroup>();
      for (const asset of linkable) {
        const key = groupKey(asset);
        const group = groups.get(key) ?? { assets: [], model: asset.model };
        group.assets.push(asset);
        groups.set(key, group);
      }
      const currency = header.currency ?? sharedCurrency(linkable);
      if (header.currency === undefined && currency !== null) {
        await tx.purchaseOrder.update({
          where: { id: purchase.id },
          data: { currency },
        });
      }

      await recordPurchaseOrderEvent(tx, purchase.id, 'CREATED', actor, {
        lineCount: groups.size,
      });
      await recordPurchaseOrderEvent(
        tx,
        purchase.id,
        'CREATED_FROM_ASSETS',
        actor,
        {
          lineCount: groups.size,
          linkedAssetIds: linkable.map((asset) => asset.id),
          failed: failed.length,
        },
      );

      let position = 0;
      for (const group of groups.values()) {
        const [first] = group.assets as [FromAssetRow];
        // An archived model is not mapped: a line may not name one (the line write rule).
        const model =
          group.model && group.model.deletedAt === null ? group.model : null;
        const description = group.model
          ? `${group.model.manufacturer} ${group.model.name}`.trim()
          : first.name.trim();
        const line = await tx.purchaseOrderLine.create({
          data: {
            purchaseOrderId: purchase.id,
            position: position++,
            kind: 'ASSET',
            description: clip(description || first.name, 500),
            manufacturerText: group.model
              ? clip(group.model.manufacturer, 200)
              : null,
            modelText: group.model ? clip(group.model.name, 200) : null,
            assetModelId: model?.id ?? null,
            quantity: group.assets.length,
            unitPrice: sharedUnitPrice(group, currency),
          },
        });
        const ids = group.assets.map((asset) => asset.id);
        // The link only: no other asset column is written.
        await tx.asset.updateMany({
          where: { id: { in: ids } },
          data: { purchaseOrderLineId: line.id },
        });
        for (const assetId of ids) {
          await this.history.record(tx, {
            assetId,
            eventType: 'PURCHASE_LINKED',
            actor,
            payload: {
              purchaseOrderId: purchase.id,
              purchaseOrderLineId: line.id,
              applied: [],
            },
          });
        }
        await recordPurchaseOrderEvent(tx, purchase.id, 'ASSET_LINKED', actor, {
          lineId: line.id,
          assetIds: ids,
          applied: {},
          moved: [],
          overReceived: false,
        });
      }

      return {
        purchaseOrder: await this.purchases.readDetail(tx, purchase.id),
        linkedAssetIds: linkable.map((asset) => asset.id),
        failed,
      };
    });
    this.searchSync?.purchase(result.purchaseOrder.id);
    return result;
  }
}
