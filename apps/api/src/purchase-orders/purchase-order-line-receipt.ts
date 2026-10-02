import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { isCountableKind } from './purchase-order-derived';

type Client = PrismaService | Prisma.TransactionClient;

/** The stored line values the receipt checks read. */
interface LineCounts {
  id: string;
  quantity: number;
  cancelledQuantity: number;
}

/**
 * The 400 for a line that cannot take assets: only `ASSET` lines are received or linked (ADR-0099 §2) —
 * `OTHER` lines are never pending, and a kind a newer build added is not countable here.
 */
export function assertAssetLine(line: { kind: string }): void {
  if (line.kind !== 'ASSET' || !isCountableKind(line.kind)) {
    throw new BadRequestException(
      `Only ASSET lines take assets; this line is ${line.kind}`,
    );
  }
}

/**
 * A live `ASSET` line of a live purchase, for a receive that names it by id only (`POST
 * /assets/batch/receive` with `purchaseOrderLineId`). Anything else is a 400: the line is a body field
 * there, not the route's resource. Archived purchases and lines cannot receive new units (ADR-0099 §9).
 */
export async function loadReceivableLine(client: Client, lineId: string) {
  const line = await client.purchaseOrderLine.findFirst({
    where: { id: lineId, deletedAt: null, purchaseOrder: { deletedAt: null } },
  });
  if (!line) {
    throw new BadRequestException(`Purchase line ${lineId} not found`);
  }
  assertAssetLine(line);
  return line;
}

/** The live assets linked to a line — its received units (derived, never stored: ADR-0099 §4). */
export function countReceived(client: Client, lineId: string) {
  return client.asset.count({
    where: { purchaseOrderLineId: lineId, deletedAt: null },
  });
}

/** Whether a line now holds more live units than it still expects (quantity − cancelled). */
export async function isOverReceived(
  client: Client,
  line: LineCounts,
): Promise<boolean> {
  const received = await countReceived(client, line.id);
  return received > Math.max(line.quantity - line.cancelledQuantity, 0);
}
