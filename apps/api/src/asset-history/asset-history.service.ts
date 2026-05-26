import { Injectable } from '@nestjs/common';
import type { AssetHistoryEventType } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** One asset event to append. `payload` is contextual jsonb; `performedById` is the shim actor. */
export interface RecordAssetEvent {
  assetId: string;
  eventType: AssetHistoryEventType;
  payload?: Prisma.InputJsonValue;
  performedById?: string;
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
      data: {
        assetId: event.assetId,
        eventType: event.eventType,
        ...(event.payload !== undefined ? { payload: event.payload } : {}),
        ...(event.performedById != null
          ? { performedById: event.performedById }
          : {}),
      },
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
