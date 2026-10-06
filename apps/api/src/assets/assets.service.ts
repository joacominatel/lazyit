import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AssetInventoryCsvItem,
  AssetStatus,
  BatchAssetStatus,
  AssetWarrantyFilter,
  BatchResult,
  CreateAsset,
  DeletedFilter,
  PageQuery,
  ReceiveAssets,
  UpdateAsset,
} from '@lazyit/shared';
import {
  ASSET_STATUS_REQUIRED_MESSAGE,
  applyAssetModelSpecsDefaults,
  assetInventoryCsvHeader,
  assetInventoryCsvRow,
  computeAssetBookValue,
  offsetOf,
  pageOf,
  WARRANTY_EXPIRING_WITHIN_DAYS,
} from '@lazyit/shared';
import { provenanceStampLine } from '../common/export-provenance';
import { resolveSortOrBadRequest } from '../common/resolve-sort';
import { deletedWhere, includeSoftDeletedFor } from '../common/deleted-filter';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PUBLIC_USER_SELECT } from '../users/public-user';
import { ActorService, type ActorAttribution } from '../common/actor.service';
import type { Principal } from '../auth/principal';
import { jsonDeepEqual } from '../common/deep-equal';
import { assetMoneyToDb, assetMoneyToWire } from '../common/money';
import {
  AssetHistoryService,
  type RecordAssetEvent,
} from '../asset-history/asset-history.service';
import { SearchService } from '../search/search.service';
import { projectAsset } from '../search/search.documents';
import {
  AssetTagSchemeService,
  isUniqueTagCollision,
} from '../asset-tag-scheme/asset-tag-scheme.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { recordPurchaseOrderEvent } from '../purchase-orders/purchase-order-events';
import {
  isOverReceived,
  loadReceivableLine,
} from '../purchase-orders/purchase-order-line-receipt';
import {
  ASSET_STATUS_LABEL_REF_SELECT,
  lockLiveStatusLabel,
  statusChangedPayload,
  type LiveStatusLabel,
} from '../asset-status-labels/asset-status-label-lock';

/**
 * Merge migrator re-import provenance into a change-event payload (#1061). Both are plain jsonb objects;
 * the provenance keys (`source`/`sessionId`/`rowIndex`) are added alongside the event's own `{ from, to }`
 * (a `SPECS_CHANGED` event carries no payload, so it becomes the provenance alone). Non-object payloads
 * (never produced today) are treated as empty so this can't throw on a hostile value.
 */
function mergeProvenance(
  payload: Prisma.InputJsonValue | undefined,
  provenance: Prisma.InputJsonValue,
): Prisma.InputJsonValue {
  const base =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as object)
      : {};
  const extra =
    typeof provenance === 'object' &&
    provenance !== null &&
    !Array.isArray(provenance)
      ? (provenance as object)
      : {};
  return { ...base, ...extra };
}

/**
 * The asset's PLAIN fields (#1382): every `UpdateAsset` key that has no discrete history event of its own.
 * A PATCH that changes any of them writes ONE `UPDATED { fields }` row naming them — field names only, never
 * the old or new values (ADR-0033 amendment 2026-09-25). `satisfies Record<…, true>` makes it exhaustive: a
 * field added to `UpdateAsset` without a discrete event fails the type check until it is listed here. Also
 * the Prisma `select` of the before snapshot.
 */
const ASSET_PLAIN_FIELDS_SELECT = {
  name: true,
  serial: true,
  assetTag: true,
  notes: true,
  company: true,
  purchaseDate: true,
  warrantyEnd: true,
  purchaseCost: true,
  usefulLifeMonths: true,
  salvageValue: true,
  purchaseCurrency: true,
} as const satisfies Record<
  Exclude<
    keyof UpdateAsset,
    'status' | 'statusLabelId' | 'locationId' | 'modelId' | 'specs'
  >,
  true
>;

type AssetPlainField = keyof typeof ASSET_PLAIN_FIELDS_SELECT;

const ASSET_PLAIN_FIELDS = Object.keys(
  ASSET_PLAIN_FIELDS_SELECT,
) as AssetPlainField[];

/** A plain field's value for comparison: a Date by its instant, a missing value as null. */
function plainValue(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : (value ?? null);
}

/** The plain fields whose stored value differs between the before snapshot and the updated row. */
function changedPlainFields(
  before: Partial<Record<AssetPlainField, unknown>>,
  after: Partial<Record<AssetPlainField, unknown>>,
): AssetPlainField[] {
  return ASSET_PLAIN_FIELDS.filter(
    (field) => plainValue(before[field]) !== plainValue(after[field]),
  );
}

/** Optional filters for listing assets. `categoryId` filters by the asset's model's category. */
export interface AssetFilters {
  categoryId?: string;
  /** Filter to assets carrying this exact AssetModel (#943) — deep-linked from the asset detail page. */
  modelId?: string;
  locationId?: string;
  /** The BUILT-IN status: matches every asset in it, whatever its custom status (ADR-0101). */
  status?: AssetStatus;
  /** One custom status (ADR-0101): the assets carrying exactly this label. */
  statusLabelId?: string;
  /** Exact-match grouping filter over the free-text `company` column (ADR-0076). */
  company?: string;
  /** Case-insensitive substring over name / serial / assetTag (OR). */
  q?: string;
  /** Restrict to assets with a LIVE assignment (releasedAt null) to this user (User.id is a uuid). */
  assignedToUserId?: string;
  /**
   * Ownership slice over LIVE assignments (releasedAt null). `HAS` = assets with at least one active
   * owner; `NONE` = unassigned assets. Independent of `assignedToUserId` (which already implies HAS).
   */
  ownership?: 'HAS' | 'NONE';
  /**
   * Warranty-window filter (#955). `expiring90d` = warranty ends within the next
   * WARRANTY_EXPIRING_WITHIN_DAYS days and hasn't lapsed (deep-linked from the dashboard tile);
   * `expired` = warranty end already passed. Assets with no `warrantyEnd` match neither.
   */
  warranty?: AssetWarrantyFilter;
  /** Exact, case-sensitive asset tags (#1387): the assets holding any of them. */
  assetTags?: string[];
  /** Exact, case-sensitive serials (#1387): the assets holding any of them. */
  serials?: string[];
  /**
   * Purchase provenance filters (#1476). Only an object minted by
   * {@link AssetsService.authorizePurchaseFilters} is accepted: `buildWhere` refuses any other (403).
   */
  purchase?: PurchaseFilters;
}

/**
 * The asset list's purchase provenance filters (ADR-0099, #1476): the assets linked to one line, to any line
 * of one purchase, and linked to some purchase (`true`) or to none (`false`), AND-combined. They reveal which
 * assets came from which purchase (D-A), so they need `purchaseOrder:read` on top of `asset:read`.
 */
export interface PurchaseFilters {
  purchaseOrderLineId?: string;
  purchaseOrderId?: string;
  purchaseLinked?: boolean;
}

/**
 * The purchase filters that passed the permission check — the only ones `buildWhere` applies. A runtime
 * brand rather than a type: any caller that reaches the list query (the list, the export, a future reader)
 * cannot apply purchase filters it did not have authorized, whatever it passes.
 */
const AUTHORIZED_PURCHASE_FILTERS = new WeakSet<PurchaseFilters>();

/**
 * Server-side sort allowlist for `GET /assets` (ADR-0030 amendment). Maps each PUBLIC `?sort=` key to
 * the Prisma column to order by — bounding the sortable surface to a curated set. An unknown key is a
 * 400 (resolveSortOrBadRequest). With no `sort`, the list keeps its default `createdAt desc` order.
 */
export const ASSET_SORT_ALLOWLIST = {
  name: 'name',
  assetTag: 'assetTag',
  serial: 'serial',
  status: 'status',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  // Plain asset columns behind the list's optional purchase & warranty columns (#1511).
  purchaseDate: 'purchaseDate',
  warrantyEnd: 'warrantyEnd',
  purchaseCost: 'purchaseCost',
} as const;

/**
 * The sort keys whose column is nullable and new with #1511: an asset with no purchase date, warranty end
 * or cost sorts after every dated or priced one, in both directions, so "no value" never tops the list.
 */
const ASSET_NULLS_LAST_SORT_KEYS: ReadonlySet<string> = new Set([
  'purchaseDate',
  'warrantyEnd',
  'purchaseCost',
]);

/**
 * The unique key appended to EVERY list sort, allowlisted or default (ADR-0030 §9 — a contract rule, as
 * `INFRA_NODE_TIEBREAKER` does for nodes). No sortable column is unique — received stock and imports share
 * a `createdAt`, many assets share a status or have no warranty end — and under LIMIT/OFFSET a tie Postgres
 * reorders between reads drops one row from the window and repeats another.
 */
const ASSET_TIEBREAKER = { id: 'desc' } as const;

// Inline relations for the expanded reads (GET /assets, GET /assets/:id): the model (+ its
// category, which lives on the model), the location, and the *active* owners (releasedAt = null)
// each with their user. One nested include → a constant number of queries, never N+1.
const ASSET_RELATIONS = {
  model: { include: { category: true } },
  location: true,
  // The custom status (ADR-0101) as its compact ref. Never an archived label: a delete moves its assets.
  statusLabel: { select: ASSET_STATUS_LABEL_REF_SELECT },
  assignments: {
    where: { releasedAt: null },
    orderBy: { assignedAt: 'desc' },
    // The owner through the PUBLIC column allowlist (SEC-085) — a whole-row `user: true` put the
    // owner's passwordHash and session epochs on GET /assets/:id for every `asset:read` holder.
    include: { user: { select: PUBLIC_USER_SELECT } },
  },
} satisfies Prisma.AssetInclude;

type AssetWithIncludes = Prisma.AssetGetPayload<{
  include: typeof ASSET_RELATIONS;
}>;

/**
 * The linked purchase's provenance an inventory export carries — ONLY for a caller holding
 * `purchaseOrder:read` (ADR-0099 §8). An archived purchase or supplier still names the asset's provenance:
 * soft delete keeps every link (§9).
 */
const EXPORT_PURCHASE_SELECT = {
  purchaseOrder: {
    select: {
      reference: true,
      invoiceNumbers: true,
      supplier: { select: { name: true } },
    },
  },
} as const satisfies Prisma.PurchaseOrderLineSelect;

// Lean projection for the LIST (GET /assets, paginated). Unlike the detail graph it (1) omits the
// `specs` jsonb blob the table never renders and (2) trims each join (model+category, location,
// active owners) to only the fields the list shows — not the full related rows. Keeps the full graph
// on findOne. See packages/shared/src/schemas/asset-list.ts and ADR-0030 / the perf analysis (#2).
const ASSET_LIST_SELECT = {
  id: true,
  name: true,
  serial: true,
  assetTag: true,
  status: true,
  // The custom status (ADR-0101): the id and its compact ref for the Status column's badge.
  statusLabelId: true,
  statusLabel: { select: ASSET_STATUS_LABEL_REF_SELECT },
  notes: true,
  company: true,
  purchaseDate: true,
  warrantyEnd: true,
  // The cost and its free-text currency label behind the list's optional Cost column (#1511) — the same
  // `asset:read` values the detail read shows. A `bigint` column: toLeanListItem converts it for the wire.
  purchaseCost: true,
  purchaseCurrency: true,
  modelId: true,
  locationId: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  model: {
    select: {
      id: true,
      name: true,
      manufacturer: true,
      category: { select: { id: true, name: true } },
    },
  },
  location: { select: { id: true, name: true, type: true } },
  assignments: {
    where: { releasedAt: null },
    orderBy: { assignedAt: 'desc' },
    select: {
      id: true,
      userId: true,
      user: {
        // `deletedAt` is carried so the LIST can dim a departed (soft-deleted) owner's avatar,
        // matching the detail read (ADR-0030 amendment, 2026-06-01 — re-added after Round 1 dropped it).
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          deletedAt: true,
        },
      },
    },
  },
} satisfies Prisma.AssetSelect;

/** The export's projection for a caller holding `purchaseOrder:read`: the list's plus the linked purchase. */
const EXPORT_SELECT_WITH_PURCHASE = {
  ...ASSET_LIST_SELECT,
  purchaseOrderLine: { select: EXPORT_PURCHASE_SELECT },
} as const satisfies Prisma.AssetSelect;

/** One exported row; `purchaseOrderLine` is only read for a caller holding `purchaseOrder:read`. */
type ExportRow = Prisma.AssetGetPayload<{
  select: typeof ASSET_LIST_SELECT;
}> &
  Partial<
    Pick<
      Prisma.AssetGetPayload<{ select: typeof EXPORT_SELECT_WITH_PURCHASE }>,
      'purchaseOrderLine'
    >
  >;

type AssetWithLeanSelect = Prisma.AssetGetPayload<{
  select: typeof ASSET_LIST_SELECT;
}>;

/** A lean list row; the `/assets/mine` self-read selects no cost columns (#1511). */
type LeanListRow = Omit<
  AssetWithLeanSelect,
  'purchaseCost' | 'purchaseCurrency'
> &
  Partial<Pick<AssetWithLeanSelect, 'purchaseCost' | 'purchaseCurrency'>>;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The `warrantyEnd` predicate for the warranty-window list filter (#955). `expiring90d` = the same
 * (now, now + N days] look-ahead the dashboard tile counts (warranty not yet lapsed but ending soon);
 * `expired` = warranty end already in the past. `now` is captured at call time so the window tracks
 * the request. Assets with a null `warrantyEnd` satisfy neither comparison, so they're excluded.
 */
function warrantyWhere(warranty: AssetWarrantyFilter): Prisma.AssetWhereInput {
  const now = new Date();
  if (warranty === 'expired') {
    return { warrantyEnd: { lt: now } };
  }
  const cutoff = new Date(
    now.getTime() + WARRANTY_EXPIRING_WITHIN_DAYS * MS_PER_DAY,
  );
  return { warrantyEnd: { gt: now, lte: cutoff } };
}

/**
 * The SELF-SCOPE variant of {@link ASSET_LIST_SELECT} for `GET /assets/mine` (#947 security review):
 * the SAME lean projection, but the `assignments` join is narrowed to the CALLER's own live
 * assignment. The regular list select inlines EVERY live assignee's identity (name + email) —
 * `user:read`-class PII the admin list legitimately shows, but that a self-read must not leak: on a
 * co-owned asset the caller would otherwise receive every co-assignee's email through a route that
 * (deliberately) carries no `asset:read`/`user:read` gate. Narrowing the join keeps the wire shape
 * (`Page<AssetListItem>`) intact — the only inlined identity is the caller's own. The admin list keeps
 * the full projection unchanged.
 */
const assetMineListSelect = (userId: string) =>
  ({
    ...ASSET_LIST_SELECT,
    // The self-read carries no `asset:read` gate, so it leaves out the cost the directory list shows
    // (#1511): a holder sees what they hold, not what it cost.
    purchaseCost: false,
    purchaseCurrency: false,
    assignments: {
      ...ASSET_LIST_SELECT.assignments,
      where: { releasedAt: null, userId },
    },
  }) satisfies Prisma.AssetSelect;

@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
    private readonly history: AssetHistoryService,
    private readonly search: SearchService,
    private readonly tagScheme: AssetTagSchemeService,
    private readonly permissions: PermissionResolverService,
  ) {}

  /**
   * Authorize the purchase filters for `principal` (#1476): 403 unless it holds `purchaseOrder:read` — the
   * filters reveal provenance, which follows it (ADR-0099 §8, D-A), while a list read alone is `asset:read`.
   * Returns the filters as the one object the list query will apply.
   */
  async authorizePurchaseFilters(
    filters: PurchaseFilters,
    principal?: Principal,
  ): Promise<PurchaseFilters> {
    if (!(await this.holds(principal, 'purchaseOrder:read'))) {
      throw new ForbiddenException(
        'Filtering assets by purchase needs purchaseOrder:read',
      );
    }
    const authorized = { ...filters };
    AUTHORIZED_PURCHASE_FILTERS.add(authorized);
    return authorized;
  }

  /**
   * 400 unless the location a write names is LIVE. A soft-deleted location still passes the foreign key, so
   * without this an asset could be created into, received into or moved to an archived location. Write-only:
   * reads stay tolerant, and an update that leaves the location unchanged is not checked (a legacy row
   * stays editable).
   */
  private async assertLocationLive(
    client: Prisma.TransactionClient | PrismaService,
    locationId: string | null | undefined,
  ): Promise<void> {
    if (!locationId) return;
    const location = await client.location.findFirst({
      where: { id: locationId, deletedAt: null },
      select: { id: true },
    });
    if (!location) {
      throw new BadRequestException(
        `Location ${locationId} not found (missing or archived)`,
      );
    }
  }

  /** 400 unless the model a write names is LIVE — the same rule as {@link assertLocationLive}. */
  private async assertModelLive(
    client: Prisma.TransactionClient | PrismaService,
    modelId: string | null | undefined,
  ): Promise<void> {
    if (!modelId) return;
    const model = await client.assetModel.findFirst({
      where: { id: modelId, deletedAt: null },
      select: { id: true },
    });
    if (!model) {
      throw new BadRequestException(
        `AssetModel ${modelId} not found (missing or archived)`,
      );
    }
  }

  /**
   * The LIVE custom status a write names, locked `FOR SHARE` for the rest of the transaction (ADR-0101) — a
   * concurrent kind change or delete of the label waits for this write, or this write waits for it and then
   * reads the new kind / finds it archived. 400 when the label is missing or archived. Write-only.
   */
  private async liveStatusLabel(
    tx: Prisma.TransactionClient,
    statusLabelId: string,
  ): Promise<LiveStatusLabel> {
    const label = await lockLiveStatusLabel(tx, statusLabelId, 'share');
    if (!label) {
      throw new BadRequestException(
        `Custom status ${statusLabelId} not found (missing or archived)`,
      );
    }
    return label;
  }

  /** 400 when a body names both a built-in `status` and a custom status of another kind (ADR-0101). */
  private assertStatusAgrees(
    status: AssetStatus | undefined,
    label: LiveStatusLabel,
  ): void {
    if (status !== undefined && status !== label.kind) {
      throw new BadRequestException(
        `status ${status} does not match the custom status "${label.name}", which maps to ${label.kind}. Send the custom status alone, or with its own status.`,
      );
    }
  }

  /**
   * The `status` / `statusLabelId` a CREATE writes (ADR-0101): a custom status sets both (its `kind` is the
   * status); a built-in status alone writes no label. Keeps the invariant `statusLabelId ⇒ status == kind`.
   */
  private async createStatus(
    tx: Prisma.TransactionClient,
    status: AssetStatus | undefined,
    statusLabelId: string | undefined,
  ): Promise<{ status: AssetStatus; statusLabelId?: string }> {
    if (statusLabelId === undefined) {
      // The create schema refuses a body with neither; an internal caller is held to the same rule.
      if (status === undefined) {
        throw new BadRequestException(ASSET_STATUS_REQUIRED_MESSAGE);
      }
      return { status };
    }
    const label = await this.liveStatusLabel(tx, statusLabelId);
    this.assertStatusAgrees(status, label);
    return { status: label.kind, statusLabelId: label.id };
  }

  /**
   * The `status` / `statusLabelId` an UPDATE writes, and the custom status the asset ends with (ADR-0101):
   *   - `statusLabelId: "<id>"` → the label and its kind (a disagreeing `status` is a 400);
   *   - `statusLabelId: null` → no label; the built-in status is kept (or set, if `status` is also given);
   *   - `status` alone → kept label when the status does not change (the label maps to it, by the
   *     invariant), cleared when it does;
   *   - neither → nothing.
   */
  private async updateStatus(
    tx: Prisma.TransactionClient,
    before: {
      status: AssetStatus;
      statusLabelId?: string | null;
      statusLabel?: { id: string; name: string } | null;
    },
    status: AssetStatus | undefined,
    statusLabelId: string | null | undefined,
  ): Promise<{
    write: { status?: AssetStatus; statusLabelId?: string | null };
    toLabel: { id: string; name: string } | null;
  }> {
    const current = before.statusLabel ?? null;
    if (statusLabelId === null) {
      return {
        write: { statusLabelId: null, ...(status ? { status } : {}) },
        toLabel: null,
      };
    }
    if (statusLabelId !== undefined) {
      const label = await this.liveStatusLabel(tx, statusLabelId);
      this.assertStatusAgrees(status, label);
      return {
        write: { status: label.kind, statusLabelId: label.id },
        toLabel: label,
      };
    }
    if (status === undefined) return { write: {}, toLabel: current };
    if (status === before.status)
      return { write: { status }, toLabel: current };
    return {
      write: {
        status,
        ...(before.statusLabelId ? { statusLabelId: null } : {}),
      },
      toLabel: null,
    };
  }

  /** Whether the principal holds `permission` (fail-closed for no principal). */
  private holds(
    principal: Principal | undefined,
    permission: Parameters<PermissionResolverService['principalHas']>[1],
  ): Promise<boolean> {
    return this.permissions.principalHas(principal, permission);
  }

  /**
   * Rows per round-trip when STREAMING the full filtered inventory export (issue #872). Mirrors the
   * audit/activity export batch: a bounded skip/take loop over the SAME lean list query so the whole
   * estate never sits in memory at once.
   *
   * ponytail: OFFSET/LIMIT batching (like the other exports). CEILING: deep OFFSET is O(offset) per
   * page — fine for an admin/audit dump; a keyset cursor is a clean future upgrade if ever needed.
   */
  static readonly EXPORT_BATCH_SIZE = 1000;

  /**
   * A single page of assets (the inventory pillar's main, heaviest list), newest first. Uses the
   * LEAN projection ({@link ASSET_LIST_SELECT}): no `specs` blob and trimmed joins — the full
   * relation graph stays on {@link findOne}. Runs the page `findMany(take/skip)` and the `count`
   * over the **same** `where` inside one `$transaction`, so the `total` can't drift from the page.
   * Optional filters: category and model (via the model), location, status, and `q` (substring over
   * name/serial/assetTag PLUS the related model's name/manufacturer, #943). The `deleted` slice
   * (`active` default | `only`) scopes the page to live or soft-deleted assets; `only` carries the
   * ADR-0032 `includeSoftDeleted` escape hatch so the read filter doesn't re-hide them (ADMIN-gated at
   * the controller).
   *
   * `selfUserId` is the `GET /assets/mine` PROJECTION override (#947 security review): when set, the
   * lean select's `assignments` join is narrowed to that user's own live assignment
   * ({@link assetMineListSelect}), so a co-owned asset never inlines other holders' identity
   * (name + email) through the ungated self-read. Omitted (every admin/list call site), the full
   * projection is used unchanged.
   */
  async findPage(
    filters: AssetFilters = {},
    page: PageQuery,
    selfUserId?: string,
  ) {
    const where = {
      ...this.buildWhere(filters),
      ...deletedWhere(page.deleted),
    };
    const includeSoftDeleted = includeSoftDeletedFor(page.deleted);
    const { take, skip } = offsetOf(page);
    // Server-side sort over the FULL result set (not page-local) via the per-resource allowlist
    // (ADR-0030 amendment). No `sort` ⇒ the default `createdAt desc`; either way the unique `id` follows.
    const sorted =
      resolveSortOrBadRequest<Prisma.AssetOrderByWithRelationInput>(
        page,
        ASSET_SORT_ALLOWLIST,
      );
    const primary: Prisma.AssetOrderByWithRelationInput =
      sorted && page.sort && ASSET_NULLS_LAST_SORT_KEYS.has(page.sort)
        ? {
            [ASSET_SORT_ALLOWLIST[
              page.sort as keyof typeof ASSET_SORT_ALLOWLIST
            ]]: { sort: page.dir ?? 'asc', nulls: 'last' },
          }
        : (sorted ?? { createdAt: 'desc' });
    const orderBy = [
      primary,
      ASSET_TIEBREAKER,
    ] satisfies Prisma.AssetOrderByWithRelationInput[];
    // `includeSoftDeleted` is the ADR-0032 custom arg (stripped by the extension before Prisma sees
    // it); Prisma's generated args type carries it only as `undefined`, so spread it in via an opaque
    // object — keeping the `select` inference intact so the lean row type is preserved.
    const escapeHatch: Record<string, unknown> = includeSoftDeleted
      ? { includeSoftDeleted }
      : {};
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.asset.findMany({
        where,
        orderBy,
        take,
        skip,
        // Self-scope (#947): the mine-path narrows the assignments join to the caller's own row;
        // every other call site keeps the full lean projection.
        select: selfUserId
          ? assetMineListSelect(selfUserId)
          : ASSET_LIST_SELECT,
        ...escapeHatch,
      }),
      this.prisma.asset.count({ where, ...escapeHatch }),
    ]);
    // The lean rows carry `Date`s; the API serializes them to ISO strings at the HTTP boundary (same
    // as findOne) — the AssetListPage DTO documents the resulting wire shape (specs omitted, joins
    // trimmed). The `assignments` relation is renamed to `activeAssignments` for the response.
    const items = rows.map((row) => this.toLeanListItem(row));
    return pageOf(items, total, page);
  }

  /** The shared `where` for the asset list — used identically by findPage and its count. */
  private buildWhere({
    categoryId,
    modelId,
    locationId,
    status,
    statusLabelId,
    company,
    q,
    assignedToUserId,
    ownership,
    warranty,
    assetTags,
    serials,
    purchase: purchaseFilters,
  }: AssetFilters): Prisma.AssetWhereInput {
    // Purchase provenance (#1476): applied only once authorized, whoever calls — defense in depth behind the
    // list route's own check. AND-combined, so a contradictory pair simply matches nothing.
    if (
      purchaseFilters !== undefined &&
      !AUTHORIZED_PURCHASE_FILTERS.has(purchaseFilters)
    ) {
      throw new ForbiddenException(
        'Filtering assets by purchase needs purchaseOrder:read',
      );
    }
    const { purchaseOrderLineId, purchaseOrderId, purchaseLinked } =
      purchaseFilters ?? {};
    const purchase: Prisma.AssetWhereInput[] = [
      ...(purchaseOrderLineId ? [{ purchaseOrderLineId }] : []),
      ...(purchaseOrderId ? [{ purchaseOrderLine: { purchaseOrderId } }] : []),
      ...(purchaseLinked === undefined
        ? []
        : [
            {
              purchaseOrderLineId: purchaseLinked ? { not: null } : null,
            },
          ]),
    ];
    return {
      ...(purchase.length > 0 ? { AND: purchase } : {}),
      ...(locationId ? { locationId } : {}),
      // Exact-value lists (#1387, the AI batch create's duplicate check): which of these tags / serials
      // live assets already hold — one indexed `IN` per field instead of one substring search per value.
      ...(assetTags && assetTags.length > 0
        ? { assetTag: { in: assetTags } }
        : {}),
      ...(serials && serials.length > 0 ? { serial: { in: serials } } : {}),
      ...(status ? { status } : {}),
      // One custom status (ADR-0101). `status` filters by the built-in status, so it already includes
      // every custom status of that kind; both together AND-combine.
      ...(statusLabelId ? { statusLabelId } : {}),
      // Warranty window (#955): `expiring90d` mirrors the dashboard tile's (now, now + N days]
      // look-ahead (assets whose warranty hasn't lapsed but ends soon); `expired` = warranty end
      // already past. `now` is read per-call so the window tracks the request time.
      ...(warranty ? warrantyWhere(warranty) : {}),
      // Grouping filter (ADR-0076): exact match on the chosen company value (one of the distinct
      // values offered by listCompanies). Not a scoping boundary — just narrows the list.
      ...(company ? { company } : {}),
      // Category lives on the model, not the asset: match assets whose model is in it.
      ...(categoryId ? { model: { categoryId } } : {}),
      // Exact model filter (#943) — deep-linked from the asset detail page's Model link, distinct
      // from the (broader) categoryId filter next to it.
      ...(modelId ? { modelId } : {}),
      // Owner: assets with a LIVE (releasedAt null) assignment to this user — ownership is a
      // timestamped join (asset-centric), never a column, so this filters the relation.
      ...(assignedToUserId
        ? {
            assignments: {
              some: { userId: assignedToUserId, releasedAt: null },
            },
          }
        : // Ownership slice over LIVE assignments. Both filters write the `assignments` key, so apply
          // ownership only when `assignedToUserId` is absent — a specific user already implies HAS.
          ownership === 'HAS'
          ? { assignments: { some: { releasedAt: null } } }
          : ownership === 'NONE'
            ? { assignments: { none: { releasedAt: null } } }
            : {}),
      ...(q
        ? {
            // #943: also match the related model's name/manufacturer (e.g. searching "Pro 14", visible
            // only in the Model column, previously returned nothing) — an OR across the asset's own
            // columns AND the model relation.
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { serial: { contains: q, mode: 'insensitive' } },
              { assetTag: { contains: q, mode: 'insensitive' } },
              { model: { name: { contains: q, mode: 'insensitive' } } },
              { model: { manufacturer: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
  }

  /**
   * Distinct, non-empty `company` values across LIVE assets, sorted (ADR-0076). Powers the asset
   * form's autocomplete datalist and the list's company filter — so an operator reuses an existing
   * grouping value instead of inventing a near-duplicate. Free-text, so this is the only "catalog":
   * there is no Company entity. Read-only; gated like the other asset reads (asset:read).
   */
  async listCompanies(): Promise<string[]> {
    const rows = await this.prisma.asset.findMany({
      where: { company: { not: null } },
      distinct: ['company'],
      select: { company: true },
      orderBy: { company: 'asc' },
    });
    // `company` is non-null here (filtered above), but Prisma's type keeps it `string | null`.
    return rows.map((r) => r.company).filter((c): c is string => c !== null);
  }

  /**
   * Bulk CSV export of the WHOLE filtered inventory (issue #872) — not just the visible page. Reuses
   * the SAME {@link buildWhere} + the SAME lean {@link ASSET_LIST_SELECT} projection as the list read,
   * and {@link assetInventoryCsvRow} from `@lazyit/shared` (the one place the RFC-4180 escaping +
   * formula-injection guard live), so the file can NEVER drift from the on-screen list. Streamed as an
   * async generator (bounded skip/take batches) so a large estate never buffers in memory.
   *
   * `deleted` scopes the export to the live (`active`, default) or archived (`only`) slice — exactly as
   * {@link findPage} does; the controller keeps `only` ADMIN-gated (assertCanListDeleted). `specs` is
   * omitted (the lean projection has none) — a per-spec-key export is a deferred follow-up.
   */
  async *streamInventoryCsvRows(
    filters: AssetFilters = {},
    deleted: DeletedFilter = 'active',
    principal?: Principal,
  ): AsyncGenerator<string> {
    // Purchase provenance columns (supplier, reference, invoice numbers) only for a caller holding
    // `purchaseOrder:read` (ADR-0099 §8, CEO decision D-A); cost and currency are the asset's own fields.
    const includePurchase = await this.holds(principal, 'purchaseOrder:read');
    // Leading provenance stamp (#909): names the build that wrote the file. The migrator strips it on
    // re-import and gates on major compatibility; other tools treat it as a leading `#` comment row.
    yield `${provenanceStampLine()}\n`;
    yield `${assetInventoryCsvHeader({ includePurchase })}\n`;

    const where = {
      ...this.buildWhere(filters),
      ...deletedWhere(deleted),
    };
    // The `only` slice needs the ADR-0032 escape hatch so the read filter doesn't re-hide soft-deleted
    // rows (mirrors findPage). `active` doesn't (the filter and `deletedAt: null` agree).
    const escapeHatch: Record<string, unknown> = includeSoftDeletedFor(deleted)
      ? { includeSoftDeleted: true }
      : {};

    let skip = 0;
    for (;;) {
      const batch = {
        where,
        // A stable TOTAL order for OFFSET batching: createdAt desc with `id` as a unique tiebreaker so
        // a createdAt tie at a batch boundary can never skip or duplicate a row across pages.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: AssetsService.EXPORT_BATCH_SIZE,
        skip,
        ...escapeHatch,
      } satisfies Prisma.AssetFindManyArgs;
      // The list projection (with the asset's cost columns) and — ONLY for a caller holding
      // `purchaseOrder:read` — the linked purchase's provenance; without it the provenance is never read.
      // NEVER added to ASSET_LIST_SELECT itself: the list is `asset:read` alone.
      const rows: ExportRow[] = includePurchase
        ? await this.prisma.asset.findMany({
            ...batch,
            select: EXPORT_SELECT_WITH_PURCHASE,
          })
        : await this.prisma.asset.findMany({
            ...batch,
            select: ASSET_LIST_SELECT,
          });
      if (rows.length === 0) break;
      yield `${rows
        .map((row) =>
          assetInventoryCsvRow(
            {
              ...this.toInventoryCsvItem(row),
              purchaseCost:
                row.purchaseCost == null ? null : Number(row.purchaseCost),
              purchaseCurrency: row.purchaseCurrency ?? null,
              purchase: row.purchaseOrderLine
                ? {
                    supplierName:
                      row.purchaseOrderLine.purchaseOrder.supplier?.name ??
                      null,
                    reference: row.purchaseOrderLine.purchaseOrder.reference,
                    invoiceNumbers:
                      row.purchaseOrderLine.purchaseOrder.invoiceNumbers,
                  }
                : null,
            },
            { includePurchase },
          ),
        )
        .join('\n')}\n`;
      skip += rows.length;
      // A short batch means the estate is exhausted — stop without an extra empty round-trip.
      if (rows.length < AssetsService.EXPORT_BATCH_SIZE) break;
    }
  }

  /**
   * Shape one lean Prisma row into the wire {@link AssetInventoryCsvItem} the shared CSV row fn reads —
   * the SAME lean shaping the list uses, plus the Date → ISO-string conversion the HTTP boundary does
   * automatically for the JSON list (the CSV builds strings directly, so it must convert explicitly).
   */
  private toInventoryCsvItem(row: AssetWithLeanSelect): AssetInventoryCsvItem {
    return {
      name: row.name,
      assetTag: row.assetTag,
      serial: row.serial,
      status: row.status,
      company: row.company,
      purchaseDate: row.purchaseDate?.toISOString() ?? null,
      warrantyEnd: row.warrantyEnd?.toISOString() ?? null,
      notes: row.notes,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      model: row.model,
      location: row.location,
      activeAssignments: row.assignments.map((assignment) => ({
        id: assignment.id,
        userId: assignment.userId,
        user: {
          id: assignment.user.id,
          firstName: assignment.user.firstName,
          lastName: assignment.user.lastName,
          email: assignment.user.email,
          deletedAt: assignment.user.deletedAt?.toISOString() ?? null,
        },
      })),
    };
  }

  /** A single non-deleted asset by id, expanded with its relations; 404 if missing or deleted. */
  async findOne(id: string) {
    const asset = await this.prisma.asset.findFirst({
      where: { id },
      include: ASSET_RELATIONS,
    });
    if (!asset) {
      throw new NotFoundException(`Asset ${id} not found`);
    }
    return this.toExpanded(asset);
  }

  /**
   * Create. Emits a `CREATED` history event transactionally with the insert (ADR-0033); the actor
   * comes from the authenticated User (ADR-0038). Invalid modelId/locationId hit the FK → 400.
   *
   * Asset-tag scheme (ADR-0063 §3/§4): when a scheme is ENABLED and the caller did NOT pass an
   * explicit `assetTag`, an auto-tag is allocated. The allocation atomically consumes the next
   * counter value (concurrency-safe) and renders the tag; if it collides with an existing LIVE tag
   * (P2002 on `assets_assetTag_active_key`, e.g. a manual tag took that value) the create RETRIES with
   * the next counter value, bounded. Each consumed number is durable, so a clash ADVANCES the sequence
   * — gaps are accepted, never back-filled. OFF by default: with no scheme / a disabled scheme / an
   * explicit tag, `allocateTag` returns undefined and this path is byte-for-byte today's behaviour.
   */
  async create(
    data: CreateAsset,
    principal?: Principal,
    options?: {
      createdPayload?: Prisma.InputJsonValue;
      suppressSearch?: boolean;
      /**
       * Receive the unit against this purchase line (ADR-0099, #1473). Not a body field — `CreateAsset`
       * never accepts it; only {@link receiveBatch} sets it, after validating the line.
       */
      purchaseOrderLineId?: string;
    },
  ) {
    const actor = this.actor.resolveActor(principal);
    const { specs, assetTag, ...rest } = data;

    // Bounded retry only matters when an auto-tag is in play; an explicit/absent tag runs ONCE (the
    // first attempt's allocateTag returns undefined and no collision-advance is possible).
    let lastError: unknown;
    for (
      let attempt = 0;
      attempt < AssetTagSchemeService.MAX_ALLOCATION_ATTEMPTS;
      attempt++
    ) {
      // Allocate (or pass through) the tag. On a retry this advances the counter to the next value.
      const allocatedTag = await this.tagScheme.allocateTag(assetTag);
      const effectiveTag = assetTag ?? allocatedTag; // explicit wins; else the auto-tag (or undefined).
      try {
        const asset = await this.prisma.$transaction(async (tx) => {
          let resolvedSpecs = specs;
          // A custom status sets its kind as the status; a missing or archived one is a 400 (ADR-0101).
          const { status, statusLabelId, ...fields } = rest;
          const statusWrite = await this.createStatus(
            tx,
            status,
            statusLabelId,
          );
          // A soft-deleted location or model passes the FK: refuse it explicitly (write-only, 400).
          await this.assertLocationLive(tx, rest.locationId);
          if (rest.modelId) {
            const model = await tx.assetModel.findFirst({
              where: { id: rest.modelId, deletedAt: null },
              select: { specs: true },
            });
            if (!model) {
              throw new BadRequestException(
                `AssetModel ${rest.modelId} not found`,
              );
            }
            resolvedSpecs = applyAssetModelSpecsDefaults(
              model.specs as Record<string, unknown> | null,
              specs,
            );
          }
          // specs is free-form jsonb; zod's Record<string, unknown> needs a cast to Prisma's Json input.
          const created = await tx.asset.create({
            data: {
              ...assetMoneyToDb(fields),
              ...statusWrite,
              ...(options?.purchaseOrderLineId !== undefined
                ? { purchaseOrderLineId: options.purchaseOrderLineId }
                : {}),
              ...(effectiveTag !== undefined ? { assetTag: effectiveTag } : {}),
              ...(resolvedSpecs !== undefined
                ? { specs: resolvedSpecs as Prisma.InputJsonValue }
                : {}),
            },
          });
          await this.history.record(tx, {
            assetId: created.id,
            eventType: 'CREATED',
            actor,
            // Optional provenance for the CREATED event's jsonb payload (ADR-0069 §8): the migrator
            // commit stamps `{ source: 'import', importRunId }` so an imported asset is auditable to
            // its run without a new history enum value (mirrors the SPECS_CHANGED-reuse precedent).
            ...(options?.createdPayload !== undefined
              ? { payload: options.createdPayload }
              : {}),
          });
          return created;
        });
        // Fire-and-forget search sync after the commit (ADR-0035): un-awaited, never throws, no-op
        // when Meili is disabled. Outside the transaction so a search outage can't roll back the write.
        // `suppressSearch` (ADR-0069 §10): the bulk migrator commit skips THIS asset's per-row upsert
        // and runs ONE post-bulk reconcile instead — scoped to the import's own writes, so a concurrent
        // non-import write (an article, a user…) is NEVER dropped (no process-wide suppression).
        if (!options?.suppressSearch) {
          this.search.upsert('assets', projectAsset(asset));
        }
        return assetMoneyToWire(asset);
      } catch (err) {
        // Only an AUTO-allocated tag may advance-and-retry on a unique collision. An EXPLICIT tag
        // colliding is the caller's own duplicate → propagate the P2002 (the global filter → 409).
        if (
          allocatedTag !== undefined &&
          assetTag === undefined &&
          isUniqueTagCollision(err)
        ) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    // Exhausted the retry budget: the rendered tags densely collide with the live manual estate.
    throw new ConflictException(
      'Could not allocate a unique asset tag — the configured scheme keeps colliding with existing tags; retry or adjust the scheme.',
      { cause: lastError instanceof Error ? lastError : undefined },
    );
  }

  /**
   * Bulk receive: mint `quantity` assets from ONE AssetModel in a single action (ADR-0089 Part A, #1029)
   * — "we just received 20 identical ThinkPads".
   *
   * The asset-tag counter constraint (ADR-0063) FORCES the shape: this LOOPS the existing single-asset
   * {@link create}, so each unit is its OWN transaction with its OWN INDEPENDENT tag-counter commit —
   * exactly as the import commit does per row. It must NEVER wrap the N inserts in one `$transaction`:
   * the counter increments in its own commit OUTSIDE the create tx, so a rolled-back insert would
   * un-consume the number and the retry would re-render the same colliding tag forever. Consequence,
   * accepted: PARTIAL SUCCESS is the correct outcome — a unit that fails (e.g. a duplicate serial → a
   * P2002 the create path re-throws) is captured in `failed[{ index, error }]` while its siblings land,
   * and the consumed tag numbers advance past the gaps. Reusing {@link create} verbatim (no
   * `suppressSearch`) gives every minted unit the full write path: model spec-defaults, the CREATED
   * history event with actor attribution, the search upsert, and the #954 money pass-through
   * (`purchaseCost` is already minor units — NEVER re-coerced here).
   *
   * The controller returns this envelope with HTTP 201 (NestJS `@Post` default), including an all-failed
   * batch (`created: []`) — `failed` is the honest partial signal (mirrors the import row-level FAILED).
   *
   * Against a purchase line (`purchaseOrderLineId`, ADR-0099 §4, #1473): the caller must also hold
   * `purchaseOrder:write` (403) and the line must be a live `ASSET` line of a live purchase (400). Each unit
   * is created already linked to the line, its CREATED history event carrying `{ source: 'purchase',
   * purchaseOrderId, purchaseOrderLineId }`; the loop and the tag-counter semantics are untouched. After the
   * loop ONE `UNITS_RECEIVED` row is appended to the purchase's log (not one per unit: the units are separate
   * transactions, and each unit's own history already records its line). Over-receipt is allowed and
   * reported as `overReceived` — derived from the live count after the loop, so a concurrent receive shows.
   */
  async receiveBatch(data: ReceiveAssets, principal?: Principal) {
    const line = data.purchaseOrderLineId
      ? await this.receivableLine(data.purchaseOrderLineId, principal)
      : null;
    // ONE upfront model and location check: a single friendly 400 instead of N identical per-unit failures,
    // and the model name feeds each unit's default `name`. Both must be LIVE, as in create().
    const model = await this.prisma.assetModel.findFirst({
      where: { id: data.modelId, deletedAt: null },
      select: { name: true },
    });
    if (!model) {
      throw new BadRequestException(`AssetModel ${data.modelId} not found`);
    }
    await this.assertLocationLive(this.prisma, data.locationId);
    // ONE upfront custom-status check too (ADR-0101): a missing or archived label, or a status of another
    // kind, is a single 400. Each unit's create() re-checks it under its own lock.
    if (data.statusLabelId !== undefined) {
      const label = await this.prisma.assetStatusLabel.findFirst({
        where: { id: data.statusLabelId, deletedAt: null },
        select: ASSET_STATUS_LABEL_REF_SELECT,
      });
      if (!label) {
        throw new BadRequestException(
          `Custom status ${data.statusLabelId} not found (missing or archived)`,
        );
      }
      this.assertStatusAgrees(data.status, label);
    }

    // create() returns a raw Prisma Asset row (Date fields). Let `created` INFER that type — do NOT type
    // it as the shared `Asset[]` (ISO strings) nor annotate this method's return as ReceiveAssetsResult,
    // or tsc flags Date-vs-string. Date→ISO happens at the Express JSON boundary (no ZodSerializer), the
    // same reason single-create returns the raw row typed as AssetDto and serializes correctly.
    const created: Awaited<ReturnType<AssetsService['create']>>[] = [];
    const failed: { index: number; error: string }[] = [];

    for (let i = 0; i < data.quantity; i++) {
      // Derive the per-unit payload from the shared batch fields + a friendly 1-based default name (a
      // label, NOT the asset tag — the tag still comes from the scheme via create()→allocateTag) +
      // serials[i] when present. Only present fields are spread so absent optionals stay absent; the
      // already-minor-units purchaseCost is forwarded untouched (#954).
      const unit: CreateAsset = {
        name: `${model.name} #${i + 1}`,
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.statusLabelId !== undefined
          ? { statusLabelId: data.statusLabelId }
          : {}),
        modelId: data.modelId,
        ...(data.locationId !== undefined
          ? { locationId: data.locationId }
          : {}),
        ...(data.company !== undefined ? { company: data.company } : {}),
        ...(data.purchaseDate !== undefined
          ? { purchaseDate: data.purchaseDate }
          : {}),
        ...(data.purchaseCost != null
          ? { purchaseCost: data.purchaseCost }
          : {}),
        ...(data.purchaseCurrency !== undefined
          ? { purchaseCurrency: data.purchaseCurrency }
          : {}),
        ...(data.warrantyEnd !== undefined
          ? { warrantyEnd: data.warrantyEnd }
          : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
        ...(data.serials?.[i] ? { serial: data.serials[i] } : {}),
      };
      try {
        // Each unit = its own tx + its own independent counter commit + its own CREATED history + search
        // upsert. A per-unit failure NEVER aborts the batch (partial success by design); the consumed tag
        // number has already advanced past this gap.
        created.push(
          await this.create(
            unit,
            principal,
            line
              ? {
                  purchaseOrderLineId: line.id,
                  createdPayload: {
                    source: 'purchase',
                    purchaseOrderId: line.purchaseOrderId,
                    purchaseOrderLineId: line.id,
                  },
                }
              : undefined,
          ),
        );
      } catch (err) {
        failed.push({
          index: i,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!line) return { created, failed };
    const overReceived = await isOverReceived(this.prisma, line);
    if (created.length > 0) {
      await recordPurchaseOrderEvent(
        this.prisma,
        line.purchaseOrderId,
        'UNITS_RECEIVED',
        this.actor.resolveActor(principal),
        {
          lineId: line.id,
          quantity: created.length,
          assetIds: created.map((asset) => asset.id),
          failed: failed.length,
          overReceived,
        },
      );
    }
    return { created, failed, overReceived };
  }

  /**
   * The purchase line a receive names, after the checks the asset route cannot express in its decorator:
   * `purchaseOrder:write` on top of `asset:write` (linking a unit to a purchase is a purchase write), and a
   * live `ASSET` line of a live purchase.
   */
  private async receivableLine(lineId: string, principal?: Principal) {
    if (!(await this.holds(principal, 'purchaseOrder:write'))) {
      throw new ForbiddenException(
        'Receiving against a purchase line also needs purchaseOrder:write',
      );
    }
    return loadReceivableLine(this.prisma, lineId);
  }

  /**
   * Partial update. Emits a discrete history event per changed dimension (status / location / model
   * / specs), plus ONE `UPDATED { fields }` row naming the plain fields that changed (#1382), all
   * transactionally with the update (ADR-0033). 404 if missing or already soft-deleted.
   *
   * `options` mirrors {@link create}'s bag for the migrator re-import path (#1061): `updatedPayload` stamps
   * `{ source:'import', sessionId, rowIndex }` onto every emitted change event AND — because a re-import
   * that changes nothing produces zero change events — guarantees exactly ONE `UPDATED` row so "updated via
   * re-import" is always in the AssetHistory timeline. `suppressSearch` skips the per-row Meili upsert (the
   * bulk commit runs ONE reconcile afterwards). Callers that pass no options are unaffected by either.
   */
  async update(
    id: string,
    data: UpdateAsset,
    principal?: Principal,
    options?: {
      updatedPayload?: Prisma.InputJsonValue;
      suppressSearch?: boolean;
    },
  ) {
    const actor = this.actor.resolveActor(principal);
    const before = await this.prisma.asset.findFirst({
      where: { id },
      select: {
        id: true,
        status: true,
        statusLabelId: true,
        statusLabel: { select: { id: true, name: true } },
        locationId: true,
        modelId: true,
        specs: true,
        ...ASSET_PLAIN_FIELDS_SELECT,
      },
    });
    if (!before) {
      throw new NotFoundException(`Asset ${id} not found`);
    }
    const { specs, status, statusLabelId, ...rest } = data;
    const updated = await this.prisma.$transaction(async (tx) => {
      // The custom status and the built-in status move together (ADR-0101, invariant in updateStatus).
      const statusChange = await this.updateStatus(
        tx,
        before,
        status,
        statusLabelId,
      );
      // Moving the asset to an archived location or model is refused (400); keeping a legacy one is not.
      if (rest.locationId !== before.locationId) {
        await this.assertLocationLive(tx, rest.locationId);
      }
      if (rest.modelId !== before.modelId) {
        await this.assertModelLive(tx, rest.modelId);
      }
      const row = await tx.asset.update({
        where: { id },
        data: {
          ...assetMoneyToDb(rest),
          ...statusChange.write,
          ...(specs !== undefined
            ? { specs: specs as Prisma.InputJsonValue }
            : {}),
        },
      });
      const events = this.changeEvents(before, row, actor, {
        from: before.statusLabel ?? null,
        to: statusChange.toLabel,
      });
      // Plain-field edits (#1382, ADR-0033 amendment): ONE `UPDATED` row per PATCH naming the plain fields
      // that actually changed — names only, never values. A PATCH that also moves a discrete dimension
      // writes both: its discrete row(s) above, and this row listing ONLY the plain fields. Every path (UI,
      // API, the AI `asset_update` / `asset_update_batch` tools, which dispatch to this route) lands here,
      // so an AI edit is stamped with its `aiInvocationId` by AssetHistoryService.
      const fields = changedPlainFields(before, row);
      if (fields.length > 0) {
        events.push({
          assetId: row.id,
          eventType: 'UPDATED',
          payload: { fields },
          actor,
        });
      }
      // Re-import provenance (#1061): stamp it onto every per-dimension change event, and when NONE fired
      // (a no-field-delta re-import) write exactly one UPDATED marker carrying the provenance — so the
      // re-import always leaves an audit trail. A plain-field UPDATED row above is itself a change event: it
      // takes the provenance and no extra marker is added. Gated on `updatedPayload` (re-import only).
      if (options?.updatedPayload !== undefined) {
        const provenance = options.updatedPayload;
        for (const ev of events) {
          ev.payload = mergeProvenance(ev.payload, provenance);
        }
        if (events.length === 0) {
          events.push({
            assetId: row.id,
            eventType: 'UPDATED',
            payload: provenance,
            actor,
          });
        }
      }
      for (const event of events) {
        await this.history.record(tx, event);
      }
      return row;
    });
    // Fire-and-forget search sync after the commit (ADR-0035): re-index the updated row. Suppressed during
    // the bulk migrator commit (#1061), which runs ONE reconcile after the batch instead.
    if (!options?.suppressSearch) {
      this.search.upsert('assets', projectAsset(updated));
    }
    return assetMoneyToWire(updated);
  }

  /** Soft delete: set deletedAt (never hard-delete). Emits `DELETED` transactionally (ADR-0033). */
  async remove(id: string, principal?: Principal) {
    const actor = this.actor.resolveActor(principal);
    await this.assertExists(id);
    const deleted = await this.prisma.$transaction(async (tx) => {
      const row = await tx.asset.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      await this.history.record(tx, {
        assetId: id,
        eventType: 'DELETED',
        actor,
      });
      return row;
    });
    // Drop from the index so soft-deleted assets never surface in search (ADR-0035).
    this.search.remove('assets', id);
    return assetMoneyToWire(deleted);
  }

  /**
   * Restore a soft-deleted asset: clear `deletedAt` and emit a `RESTORED` history event
   * transactionally (ADR-0033 / ADR-0041) — the counterpart of `remove()`/`DELETED`. The row is found
   * via the `includeSoftDeleted` escape hatch (the read filter hides soft-deleted assets). 404 if it
   * never existed; idempotent (no event) if already live. The partial unique indexes free
   * serial/assetTag on delete, so a restore can 409 if another live asset took one of them in the
   * meantime (mapped by the global PrismaExceptionFilter). Re-indexes for search on success.
   */
  async restore(id: string, principal?: Principal) {
    const actor = this.actor.resolveActor(principal);
    const existing = await this.prisma.asset.findFirst({
      where: { id },
      select: { id: true, deletedAt: true },
      includeSoftDeleted: true,
    } as Prisma.AssetFindFirstArgs);
    if (!existing) {
      throw new NotFoundException(`Asset ${id} not found`);
    }
    if (existing.deletedAt === null) {
      // Already live — return the expanded view; no RESTORED event for a no-op.
      return this.findOne(id);
    }
    const restored = await this.prisma.$transaction(async (tx) => {
      const row = await tx.asset.update({
        where: { id },
        data: { deletedAt: null },
      });
      await this.history.record(tx, {
        assetId: id,
        eventType: 'RESTORED',
        actor,
      });
      return row;
    });
    // Re-index the restored asset (ADR-0035).
    this.search.upsert('assets', projectAsset(restored));
    // Return the expanded relation graph (same shape as findOne), consistent with the no-op branch.
    return this.findOne(id);
  }

  // --- batch (bulk) actions (ADR-0030 amendment) ---------------------------
  // Each batch runs in ONE transaction but keeps PER-ENTITY auditability: one AssetHistory event per
  // item, exactly as the single-item action records it — never one event for the whole batch. A
  // batch is a convenience over N single actions, not a different audit event. Ids that are a no-op
  // (already deleted/restored, already in the target status, or not found) are SKIPPED (reported in
  // the result), never an error, so a partial multi-select still commits. Search sync is fired once
  // per mutated row after the commit (same fire-and-forget contract as the single-item paths).

  /**
   * Bulk soft-delete (ADMIN). For each live id: stamp `deletedAt` + emit a `DELETED` history event,
   * all inside one `$transaction`. An id that is missing or already soft-deleted is skipped (not an
   * error). Returns the per-id outcome. Drops each mutated id from the search index after the commit.
   */
  async batchRemove(
    ids: string[],
    principal?: Principal,
  ): Promise<BatchResult> {
    const actor = this.actor.resolveActor(principal);
    const live = await this.prisma.asset.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    const liveIds = new Set(live.map((a) => a.id));
    const succeeded = [...liveIds];
    const skipped = ids
      .filter((id) => !liveIds.has(id))
      .map((id) => ({ id, reason: 'not_found' }));

    if (succeeded.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        for (const id of succeeded) {
          await tx.asset.update({
            where: { id },
            data: { deletedAt: new Date() },
          });
          await this.history.record(tx, {
            assetId: id,
            eventType: 'DELETED',
            actor,
          });
        }
      });
      for (const id of succeeded) this.search.remove('assets', id);
    }
    return { requested: ids.length, succeeded, skipped };
  }

  /**
   * Bulk restore (ADMIN). For each soft-deleted id: clear `deletedAt` + emit a `RESTORED` history
   * event, all inside one `$transaction`. An id that is missing or already live is skipped. Returns
   * the per-id outcome and re-indexes each restored row after the commit. A unique-constraint clash
   * on a freed serial/assetTag surfaces as the usual 409 (the whole batch rolls back).
   */
  async batchRestore(
    ids: string[],
    principal?: Principal,
  ): Promise<BatchResult> {
    const actor = this.actor.resolveActor(principal);
    const rows = await this.prisma.asset.findMany({
      where: { id: { in: ids } },
      select: { id: true, deletedAt: true },
      includeSoftDeleted: true,
    } as Prisma.AssetFindManyArgs);
    const found = new Map(rows.map((r) => [r.id, r.deletedAt]));
    const succeeded: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of ids) {
      if (!found.has(id)) skipped.push({ id, reason: 'not_found' });
      else if (found.get(id) === null)
        skipped.push({ id, reason: 'already_in_state' });
      else succeeded.push(id);
    }

    if (succeeded.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        for (const id of succeeded) {
          await tx.asset.update({
            where: { id },
            data: { deletedAt: null },
          });
          await this.history.record(tx, {
            assetId: id,
            eventType: 'RESTORED',
            actor,
          });
        }
      });
      // One read for the whole batch (not one per id — #596): gather every restored row, then
      // fire-and-forget a search upsert per row (same contract as the single-item paths).
      const rows = await this.prisma.asset.findMany({
        where: { id: { in: succeeded } },
      });
      for (const row of rows) this.search.upsert('assets', projectAsset(row));
    }
    return { requested: ids.length, succeeded, skipped };
  }

  /**
   * Bulk status-change (ADMIN). The target is a built-in `status`, a custom status (`statusLabelId`,
   * ADR-0101 — sets the label and its kind), or both (they must agree, 400 otherwise); a missing or archived
   * custom status is a 400. For each live id whose (status, custom status) DIFFERS from the target: write it
   * + emit a `STATUS_CHANGED` history event — identical to the single-item update path, so a built-in
   * status alone keeps nothing of a custom status of another kind — inside one `$transaction`. An id already
   * there is skipped (a built-in status alone counts as "there" when the asset already has that status,
   * whatever its custom status, matching `update`). Missing/soft-deleted ids are skipped as not found.
   * Re-indexes each changed row after the commit.
   */
  async batchSetStatus(
    ids: string[],
    target: Pick<BatchAssetStatus, 'status' | 'statusLabelId'>,
    principal?: Principal,
  ): Promise<BatchResult> {
    const actor = this.actor.resolveActor(principal);
    let label: LiveStatusLabel | null = null;
    // `statusLabelId: null` = the bare built-in status: an asset in that status but carrying a custom one
    // is changed (its custom status cleared), not skipped as already in state.
    const bare = target.statusLabelId === null;
    if (typeof target.statusLabelId === 'string') {
      label = await this.prisma.assetStatusLabel.findFirst({
        where: { id: target.statusLabelId, deletedAt: null },
        select: ASSET_STATUS_LABEL_REF_SELECT,
      });
      if (!label) {
        throw new BadRequestException(
          `Custom status ${target.statusLabelId} not found (missing or archived)`,
        );
      }
      this.assertStatusAgrees(target.status, label);
    }
    const status = label?.kind ?? target.status;
    if (status === undefined) {
      throw new BadRequestException(ASSET_STATUS_REQUIRED_MESSAGE);
    }
    const live = await this.prisma.asset.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        status: true,
        statusLabelId: true,
        statusLabel: { select: { id: true, name: true } },
      },
    });
    const current = new Map(live.map((a) => [a.id, a]));
    const succeeded: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of ids) {
      const asset = current.get(id);
      if (!asset) skipped.push({ id, reason: 'not_found' });
      else if (
        asset.status === status &&
        (label === null
          ? !bare || asset.statusLabelId === null
          : asset.statusLabelId === label.id)
      )
        skipped.push({ id, reason: 'already_in_state' });
      else succeeded.push(id);
    }

    if (succeeded.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        // Re-check the custom status under its lock: archived or re-kinded since the read above → 400.
        if (label) {
          const locked = await this.liveStatusLabel(tx, label.id);
          if (locked.kind !== label.kind) {
            throw new ConflictException(
              `The custom status "${locked.name}" changed while the batch ran; retry`,
            );
          }
        }
        for (const id of succeeded) {
          const asset = current.get(id)!;
          await tx.asset.update({
            where: { id },
            data: {
              status,
              ...(label
                ? { statusLabelId: label.id }
                : asset.statusLabelId
                  ? { statusLabelId: null }
                  : {}),
            },
          });
          await this.history.record(tx, {
            assetId: id,
            eventType: 'STATUS_CHANGED',
            payload: statusChangedPayload(
              asset.status,
              status,
              asset.statusLabel,
              label,
            ),
            actor,
          });
        }
      });
      // One read for the whole batch (not one per id — #596): gather every changed row, then
      // fire-and-forget a search upsert per row (same contract as the single-item paths).
      const rows = await this.prisma.asset.findMany({
        where: { id: { in: succeeded } },
      });
      for (const row of rows) this.search.upsert('assets', projectAsset(row));
    }
    return { requested: ids.length, succeeded, skipped };
  }

  /** Lightweight 404 guard for writes and the nested assignments endpoint (no relation loading). */
  async assertExists(id: string): Promise<void> {
    const asset = await this.prisma.asset.findFirst({
      where: { id },
      select: { id: true },
    });
    if (!asset) {
      throw new NotFoundException(`Asset ${id} not found`);
    }
  }

  /**
   * Rename the Prisma `assignments` relation (filtered to active) to the response's
   * `activeAssignments`, and attach the COMPUTED straight-line `currentBookValue` (#954): the
   * depreciated value in minor units as-of now, or `null` when `purchaseCost` is unknown. Detail-only
   * (the lean list omits it) — derived from the stored `purchaseCost` / `usefulLifeMonths` /
   * `salvageValue` / `purchaseDate` via the shared pure util, never persisted.
   */
  private toExpanded(asset: AssetWithIncludes) {
    const { assignments, ...rest } = assetMoneyToWire(asset);
    return {
      ...rest,
      activeAssignments: assignments,
      currentBookValue: computeAssetBookValue(
        {
          purchaseCost: rest.purchaseCost,
          usefulLifeMonths: rest.usefulLifeMonths,
          salvageValue: rest.salvageValue,
          purchaseDate: rest.purchaseDate,
        },
        new Date(),
      ),
    };
  }

  /**
   * Same `assignments` -> `activeAssignments` rename for the lean LIST row (AssetListItem), with the
   * `bigint` cost as a wire number (ADR-0100) — absent on the self-read, which selects no cost.
   */
  private toLeanListItem(asset: LeanListRow) {
    const { assignments, purchaseCost, ...rest } = asset;
    return {
      ...rest,
      ...(purchaseCost === undefined
        ? {}
        : {
            purchaseCost: purchaseCost === null ? null : Number(purchaseCost),
          }),
      activeAssignments: assignments,
    };
  }

  /**
   * One discrete history event per field that actually changed in an update (ADR-0033). `STATUS_CHANGED`
   * also fires when only the custom status changes (same built-in status, ADR-0101); its payload names the
   * custom statuses (`fromLabel` / `toLabel`) whenever either side has one.
   */
  private changeEvents(
    before: Pick<
      Prisma.AssetGetPayload<{
        select: {
          status: true;
          locationId: true;
          modelId: true;
          specs: true;
        };
      }>,
      'status' | 'locationId' | 'modelId' | 'specs'
    > & { statusLabelId?: string | null },
    updated: { id: string } & typeof before,
    actor?: ActorAttribution,
    labels?: {
      from: { id: string; name: string } | null;
      to: { id: string; name: string } | null;
    },
  ): RecordAssetEvent[] {
    const events: RecordAssetEvent[] = [];
    const change = (
      eventType: RecordAssetEvent['eventType'],
      from: unknown,
      to: unknown,
    ) =>
      events.push({
        assetId: updated.id,
        eventType,
        payload: { from, to } as Prisma.InputJsonValue,
        actor,
      });
    if (
      before.status !== updated.status ||
      (before.statusLabelId ?? null) !== (updated.statusLabelId ?? null)
    ) {
      events.push({
        assetId: updated.id,
        eventType: 'STATUS_CHANGED',
        payload: statusChangedPayload(
          before.status,
          updated.status,
          labels?.from,
          labels?.to,
        ),
        actor,
      });
    }
    if (before.locationId !== updated.locationId) {
      change('LOCATION_CHANGED', before.locationId, updated.locationId);
    }
    if (before.modelId !== updated.modelId) {
      change('MODEL_CHANGED', before.modelId, updated.modelId);
    }
    if (!jsonDeepEqual(before.specs, updated.specs)) {
      // Order-insensitive deep compare (not JSON.stringify): jsonb does not preserve object key
      // order, so reordered specs keys must not emit a spurious SPECS_CHANGED (see deep-equal.ts).
      // specs can be large; record the change without echoing both blobs into the payload.
      events.push({
        assetId: updated.id,
        eventType: 'SPECS_CHANGED',
        actor,
      });
    }
    return events;
  }
}
