import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AssetStatusSchema,
  type AssetStatus,
  type CreateAssetStatusLabel,
  type DeleteAssetStatusLabelQuery,
  type DeletedFilter,
  type UpdateAssetStatusLabel,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { SearchService } from '../search/search.service';
import { projectAsset } from '../search/search.documents';
import type { Principal } from '../auth/principal';
import { deletedWhere, includeSoftDeletedFor } from '../common/deleted-filter';
import {
  lockLiveStatusLabel,
  statusChangedPayload,
} from './asset-status-label-lock';

/** Live assets only: `assetCount` counts what an operator sees in the inventory. */
const LIVE_ASSET_COUNT = {
  _count: { select: { assets: { where: { deletedAt: null } } } },
} as const satisfies Prisma.AssetStatusLabelInclude;

type LabelWithCount = Prisma.AssetStatusLabelGetPayload<{
  include: typeof LIVE_ASSET_COUNT;
}>;

/** The built-in status order (`AssetStatusSchema`), the first sort key of the list. */
const KIND_ORDER = new Map<string, number>(
  AssetStatusSchema.options.map((kind, index) => [kind, index]),
);

/** List order: by kind (built-in order), then `order` (unset last), then name. */
function compareLabels(
  a: { kind: string; order: number | null; name: string },
  b: { kind: string; order: number | null; name: string },
): number {
  const byKind =
    (KIND_ORDER.get(a.kind) ?? 99) - (KIND_ORDER.get(b.kind) ?? 99);
  if (byKind !== 0) return byKind;
  const ao = a.order ?? Number.MAX_SAFE_INTEGER;
  const bo = b.order ?? Number.MAX_SAFE_INTEGER;
  if (ao !== bo) return ao - bo;
  return a.name.localeCompare(b.name);
}

function withCount(row: LabelWithCount) {
  const { _count, ...label } = row;
  return { ...label, assetCount: _count.assets };
}

/**
 * Custom asset statuses (ADR-0101, #1524): an operator-defined name mapped to one built-in AssetStatus.
 * Taxonomy data under the category permissions. The invariant `asset.statusLabelId != null ⇒ asset.status ==
 * label.kind` is kept here (a `kind` change is refused while any asset carries the label; a delete moves
 * the assets off it first) and in AssetsService (every asset write path derives `status` from the label).
 */
@Injectable()
export class AssetStatusLabelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actor: ActorService,
    private readonly history: AssetHistoryService,
    private readonly search: SearchService,
  ) {}

  /**
   * The custom statuses of a slice (`active` = live, default; `only` = archived), each with the number of
   * LIVE assets carrying it, ordered by kind (built-in order), then `order`, then name. Unpaged: a
   * reference list an instance keeps short.
   */
  async findAll(deleted: DeletedFilter = 'active') {
    const escapeHatch: Record<string, unknown> = includeSoftDeletedFor(deleted)
      ? { includeSoftDeleted: true }
      : {};
    const rows = await this.prisma.assetStatusLabel.findMany({
      where: deletedWhere(deleted),
      include: LIVE_ASSET_COUNT,
      ...escapeHatch,
    });
    return rows.map(withCount).sort(compareLabels);
  }

  /** One live custom status with its live asset count; 404 if missing or archived. */
  async findOne(id: string) {
    const row = await this.prisma.assetStatusLabel.findFirst({
      where: { id },
      include: LIVE_ASSET_COUNT,
    });
    if (!row) {
      throw new NotFoundException(`Custom status ${id} not found`);
    }
    return withCount(row);
  }

  /** Create. A live custom status with the same name is a 409 (the partial unique index is the backstop). */
  async create(data: CreateAssetStatusLabel) {
    await this.assertNameFree(data.name);
    return this.prisma.assetStatusLabel.create({ data });
  }

  /**
   * Partial update. Changing `kind` is refused (409) while ANY asset — live or archived — carries the
   * custom status: its assets would silently change built-in status. The label row is locked `FOR UPDATE`
   * first, so an asset write setting this label concurrently either commits before (and is counted) or
   * waits and reads the new kind.
   */
  async update(id: string, data: UpdateAssetStatusLabel) {
    const current = await this.findOne(id);
    if (data.name !== undefined && data.name !== current.name) {
      await this.assertNameFree(data.name, id);
    }
    if (data.kind === undefined || data.kind === current.kind) {
      return this.prisma.assetStatusLabel.update({ where: { id }, data });
    }
    const kind = data.kind;
    return this.prisma.$transaction(async (tx) => {
      const locked = await lockLiveStatusLabel(tx, id, 'update');
      if (!locked) {
        throw new NotFoundException(`Custom status ${id} not found`);
      }
      const inUse = await this.countAssets(tx, id);
      if (inUse > 0) {
        throw new ConflictException(
          `The custom status "${locked.name}" maps to ${locked.kind} and ${inUse} asset(s) carry it, so its built-in status cannot change to ${kind}. Move those assets to another status first, or create a new custom status.`,
        );
      }
      return tx.assetStatusLabel.update({ where: { id }, data });
    });
  }

  /**
   * Soft delete. When assets (live or archived) carry the custom status, exactly one target is required —
   * another live custom status (`reassignLabelId`) or a bare built-in status (`reassignStatus`) — else 400.
   * In ONE transaction: every carrying asset moves to the target (its `statusLabelId` and its `status`, with
   * one `STATUS_CHANGED` history event per asset), then the label is soft-deleted. So no asset ever points
   * at an archived label. An unused custom status ignores any target.
   */
  async remove(
    id: string,
    target: DeleteAssetStatusLabelQuery,
    principal?: Principal,
  ) {
    await this.findOne(id); // 404 if missing or already archived
    if (
      target.reassignLabelId !== undefined &&
      target.reassignStatus !== undefined
    ) {
      throw new BadRequestException(
        'Give reassignLabelId or reassignStatus, not both',
      );
    }
    if (target.reassignLabelId === id) {
      throw new BadRequestException(
        'Choose another custom status to move the assets to, not the one being archived',
      );
    }
    const actor = this.actor.resolveActor(principal);
    const result = await this.prisma.$transaction(async (tx) => {
      const label = await lockLiveStatusLabel(tx, id, 'update');
      if (!label) {
        throw new NotFoundException(`Custom status ${id} not found`);
      }
      const carriers = await tx.asset.findMany({
        where: { statusLabelId: id },
        select: { id: true, status: true, deletedAt: true },
        orderBy: { id: 'asc' },
        includeSoftDeleted: true,
      } as Prisma.AssetFindManyArgs);
      const moved: string[] = [];
      if (carriers.length > 0) {
        const to = await this.reassignTarget(tx, target, carriers.length);
        await tx.asset.updateMany({
          where: { id: { in: carriers.map((a) => a.id) } },
          data: { status: to.status, statusLabelId: to.label?.id ?? null },
        });
        for (const asset of carriers) {
          await this.history.record(tx, {
            assetId: asset.id,
            eventType: 'STATUS_CHANGED',
            payload: statusChangedPayload(
              asset.status,
              to.status,
              label,
              to.label,
            ),
            actor,
          });
          if (asset.deletedAt === null) moved.push(asset.id);
        }
      }
      const archived = await tx.assetStatusLabel.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      return { archived, moved, total: carriers.length };
    });
    // The search document carries the built-in status: re-index the live assets that moved (after the
    // commit, fire-and-forget — ADR-0035). Archived assets are not in the index.
    if (result.moved.length > 0) {
      const rows = await this.prisma.asset.findMany({
        where: { id: { in: result.moved } },
      });
      for (const row of rows) this.search.upsert('assets', projectAsset(row));
    }
    return { ...result.archived, movedAssetCount: result.total };
  }

  /**
   * Restore an archived custom status (ADR-0041): 404 if it never existed, idempotent if live, 409 when a
   * live custom status took its name meanwhile. It comes back with no assets — the delete moved them off.
   */
  async restore(id: string) {
    const label = await this.prisma.assetStatusLabel.findFirst({
      where: { id },
      includeSoftDeleted: true,
    } as Prisma.AssetStatusLabelFindFirstArgs);
    if (!label) {
      throw new NotFoundException(`Custom status ${id} not found`);
    }
    if (label.deletedAt === null) {
      return label;
    }
    await this.assertNameFree(label.name, id);
    return this.prisma.assetStatusLabel.update({
      where: { id },
      data: { deletedAt: null },
    });
  }

  /** Every asset carrying the label, live or archived (the invariant holds for both). */
  private countAssets(
    tx: Prisma.TransactionClient,
    statusLabelId: string,
  ): Promise<number> {
    return tx.asset.count({
      where: { statusLabelId },
      includeSoftDeleted: true,
    } as Prisma.AssetCountArgs);
  }

  /** Where a delete moves the assets: a live custom status (locked against its own delete) or a status. */
  private async reassignTarget(
    tx: Prisma.TransactionClient,
    target: DeleteAssetStatusLabelQuery,
    count: number,
  ): Promise<{
    status: AssetStatus;
    label: { id: string; name: string } | null;
  }> {
    if (target.reassignLabelId !== undefined) {
      const to = await lockLiveStatusLabel(tx, target.reassignLabelId, 'share');
      if (!to) {
        throw new BadRequestException(
          `Custom status ${target.reassignLabelId} not found (missing or archived)`,
        );
      }
      return { status: to.kind, label: to };
    }
    if (target.reassignStatus !== undefined) {
      return { status: target.reassignStatus, label: null };
    }
    throw new BadRequestException(
      `${count} asset(s) carry this custom status: choose where they go with reassignLabelId (another custom status) or reassignStatus (a built-in status)`,
    );
  }

  /** 409 when a LIVE custom status other than `exceptId` already has this name (case-sensitive). */
  private async assertNameFree(name: string, exceptId?: string): Promise<void> {
    const clash = await this.prisma.assetStatusLabel.findFirst({
      where: {
        name,
        deletedAt: null,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException(
        `A custom status named "${name}" already exists (${clash.id})`,
      );
    }
  }
}
