import { Injectable } from '@nestjs/common';
import type { AssetHistoryEventType } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import type { ActorAttribution } from '../common/actor.service';
import { currentAiInvocationId } from '../ai/core/invocation-context';
import { PrismaService } from '../prisma/prisma.service';

/**
 * One asset event to append. `payload` is contextual jsonb. `actor` is the resolved attribution
 * (ADR-0048): a HUMAN write sets `{ userId }` → `performedById`; a SERVICE-ACCOUNT write sets
 * `{ serviceAccountId }` → `serviceAccountId`; system/unknown leaves both null. The DB at-most-one-actor
 * CHECK guarantees the two columns can never both be set — `ActorService.resolveActor` already returns
 * at most one of the pair, so spreading it here is CHECK-safe by construction.
 */
export interface RecordAssetEvent {
  assetId: string;
  eventType: AssetHistoryEventType;
  payload?: Prisma.InputJsonValue;
  actor?: ActorAttribution;
}

/**
 * A client able to write `asset_history` — the base `PrismaService` or a `$transaction` client.
 * Typed structurally so emitters can pass their transaction client (atomic with the change).
 */
export interface AssetHistoryWriter {
  assetHistory: {
    create: (args: {
      data: Prisma.AssetHistoryUncheckedCreateInput;
    }) => Promise<unknown>;
  };
}

/** A client able to append many `asset_history` rows in one statement (a `$transaction` client). */
export interface AssetHistoryBatchWriter {
  assetHistory: {
    createMany: (args: {
      data: Prisma.AssetHistoryCreateManyInput[];
    }) => Promise<unknown>;
  };
}

/**
 * AssetHistory writer/reader (ADR-0033). Events are appended by **explicit** service calls — the
 * Asset and AssetAssignment services pass their transaction client so the log row commits atomically
 * with the change it records. Reads power `GET /assets/:id/history`.
 */
@Injectable()
export class AssetHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Append one history row using the given client (pass a transaction client for atomicity). */
  record(
    client: AssetHistoryWriter,
    event: RecordAssetEvent,
  ): Promise<unknown> {
    return client.assetHistory.create({
      data: historyRow(event, currentAiInvocationId()),
    });
  }

  /** Append many rows in one insert, for a change that moves many assets at once (a location delete). */
  async recordMany(
    client: AssetHistoryBatchWriter,
    events: readonly RecordAssetEvent[],
  ): Promise<void> {
    if (events.length === 0) return;
    const aiInvocationId = currentAiInvocationId();
    await client.assetHistory.createMany({
      data: events.map((event) => historyRow(event, aiInvocationId)),
    });
  }

  /** A page of an asset's history, newest first; `before` is an exclusive cursor on the id. */
  list(assetId: string, opts: { limit: number; before?: number }) {
    return this.prisma.assetHistory.findMany({
      where: {
        assetId,
        ...(opts.before !== undefined ? { id: { lt: opts.before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: opts.limit,
    });
  }
}

// The actor spreads to at most one column (ADR-0048 CHECK); an AI tool call stamps its invocation id (ADR-0097).
function historyRow(
  event: RecordAssetEvent,
  aiInvocationId: string | undefined,
): Prisma.AssetHistoryUncheckedCreateInput {
  const actor = event.actor ?? {};
  return {
    assetId: event.assetId,
    eventType: event.eventType,
    ...(event.payload !== undefined ? { payload: event.payload } : {}),
    ...(actor.userId != null ? { performedById: actor.userId } : {}),
    ...(actor.serviceAccountId != null
      ? { serviceAccountId: actor.serviceAccountId }
      : {}),
    ...(aiInvocationId !== undefined ? { aiInvocationId } : {}),
  };
}
