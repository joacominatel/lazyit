import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';

type Client = PrismaService | Prisma.TransactionClient;

/** A line as the received count reads it: which line, and which kind of units it takes. */
interface LineRef {
  id: string;
  kind: string;
}

/** The stored line values the receipt checks read. */
interface LineCounts extends LineRef {
  quantity: number;
  cancelledQuantity: number;
}

/**
 * The 400 for a line that cannot take assets: only `ASSET` lines are received or linked (ADR-0099 §2) —
 * `OTHER` lines are never pending, a `CONSUMABLE` line is received into stock, and a kind a newer build added
 * is not countable here.
 */
export function assertAssetLine(line: { kind: string }): void {
  if (line.kind !== 'ASSET') {
    throw new BadRequestException(
      `Only ASSET lines take assets; this line is ${line.kind}`,
    );
  }
}

/** The 400 for a line that cannot be received into stock: only `CONSUMABLE` lines are (#1476). */
export function assertConsumableLine(line: { kind: string }): void {
  if (line.kind !== 'CONSUMABLE') {
    throw new BadRequestException(
      `Only CONSUMABLE lines are received into stock; this line is ${line.kind}`,
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

/**
 * Units received per line — derived, never stored (ADR-0099 §3–§4): for a `CONSUMABLE` line the units of the
 * `IN` movements posted from it (#1476), for any other kind the live assets linked to it. The ledger is
 * append-only, so a consumable line's count never goes down: a mistaken receipt is corrected on the stock
 * with an ordinary movement, and the line keeps counting what was received (the ADR-0098 rule for returns).
 * At most one grouped query per source (no N+1); a line with nothing received is absent from the map.
 */
export async function receivedByLine(
  client: Client,
  lines: readonly LineRef[],
): Promise<Map<string, number>> {
  const received = new Map<string, number>();
  const stockIds = lines
    .filter((line) => line.kind === 'CONSUMABLE')
    .map((line) => line.id);
  const assetIds = lines
    .filter((line) => line.kind !== 'CONSUMABLE')
    .map((line) => line.id);
  if (assetIds.length > 0) {
    const groups = await client.asset.groupBy({
      by: ['purchaseOrderLineId'],
      // Explicit `deletedAt: null`: a received unit is a LIVE asset, whatever filter the client carries.
      where: { purchaseOrderLineId: { in: assetIds }, deletedAt: null },
      _count: { _all: true },
    });
    for (const group of groups) {
      received.set(group.purchaseOrderLineId as string, group._count._all);
    }
  }
  if (stockIds.length > 0) {
    const groups = await client.consumableMovement.groupBy({
      by: ['purchaseOrderLineId'],
      where: { purchaseOrderLineId: { in: stockIds }, type: 'IN' },
      _sum: { quantity: true },
    });
    for (const group of groups) {
      received.set(
        group.purchaseOrderLineId as string,
        group._sum.quantity ?? 0,
      );
    }
  }
  return received;
}

/** The units received on one line (see {@link receivedByLine}). */
export async function countReceived(
  client: Client,
  line: LineRef,
): Promise<number> {
  if (line.kind === 'CONSUMABLE') {
    const sum = await client.consumableMovement.aggregate({
      where: { purchaseOrderLineId: line.id, type: 'IN' },
      _sum: { quantity: true },
    });
    return sum._sum.quantity ?? 0;
  }
  return client.asset.count({
    where: { purchaseOrderLineId: line.id, deletedAt: null },
  });
}

/** Whether a line now holds more units than it still expects (quantity − cancelled). */
export async function isOverReceived(
  client: Client,
  line: LineCounts,
): Promise<boolean> {
  const received = await countReceived(client, line);
  return received > Math.max(line.quantity - line.cancelledQuantity, 0);
}
