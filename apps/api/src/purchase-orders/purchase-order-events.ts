import type { PurchaseOrderEventType } from '@lazyit/shared';
import type { Prisma } from '../../generated/prisma/client';
import type { ActorAttribution } from '../common/actor.service';
import { currentAiInvocationId } from '../ai/core/invocation-context';

/** A client able to append to `purchase_order_events` — a `$transaction` client, so the row commits with the change. */
export interface PurchaseOrderEventWriter {
  purchaseOrderEvent: {
    create: (args: {
      data: Prisma.PurchaseOrderEventUncheckedCreateInput;
    }) => Promise<unknown>;
  };
}

/**
 * Append one row to a purchase's activity log (ADR-0099, append-only) in the caller's transaction. The actor
 * is a human OR a service account, never both (the DB CHECK backs it); an AI tool call stamps its invocation
 * id, as on asset history. Shared by the purchases service, the receiving flows and the asset bulk receive
 * (a unit received against a line), so every writer records events the same way.
 */
export function recordPurchaseOrderEvent(
  tx: PurchaseOrderEventWriter,
  purchaseOrderId: string,
  eventType: PurchaseOrderEventType,
  actor: ActorAttribution,
  payload?: Record<string, Prisma.InputJsonValue | null>,
) {
  const aiInvocationId = currentAiInvocationId();
  return tx.purchaseOrderEvent.create({
    data: {
      purchaseOrderId,
      eventType,
      ...(payload !== undefined ? { payload: payload } : {}),
      ...(actor.userId != null ? { performedById: actor.userId } : {}),
      ...(actor.serviceAccountId != null
        ? { serviceAccountId: actor.serviceAccountId }
        : {}),
      ...(aiInvocationId !== undefined ? { aiInvocationId } : {}),
    },
  });
}

/** A client able to append many rows to `purchase_order_events` in one statement (a `$transaction` client). */
export interface PurchaseOrderEventBatchWriter {
  purchaseOrderEvent: {
    createMany: (args: {
      data: Prisma.PurchaseOrderEventCreateManyInput[];
    }) => Promise<unknown>;
  };
}

/**
 * Append the same event to many purchases in one insert, in the caller's transaction — for a change that
 * touches every purchase of a supplier at once (a supplier merge, #1496), where one insert per purchase would
 * scale the transaction with the purchase count. Same actor, AI provenance and payload rules as
 * {@link recordPurchaseOrderEvent}. No ids → no insert.
 */
export async function recordPurchaseOrderEvents(
  tx: PurchaseOrderEventBatchWriter,
  purchaseOrderIds: readonly string[],
  eventType: PurchaseOrderEventType,
  actor: ActorAttribution,
  payload?: Record<string, Prisma.InputJsonValue | null>,
): Promise<void> {
  if (purchaseOrderIds.length === 0) return;
  const aiInvocationId = currentAiInvocationId();
  await tx.purchaseOrderEvent.createMany({
    data: purchaseOrderIds.map((purchaseOrderId) => ({
      purchaseOrderId,
      eventType,
      ...(payload !== undefined ? { payload: payload } : {}),
      ...(actor.userId != null ? { performedById: actor.userId } : {}),
      ...(actor.serviceAccountId != null
        ? { serviceAccountId: actor.serviceAccountId }
        : {}),
      ...(aiInvocationId !== undefined ? { aiInvocationId } : {}),
    })),
  });
}
