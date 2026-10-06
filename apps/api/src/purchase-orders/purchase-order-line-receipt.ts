import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';

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

/** The 400 for a line that cannot be applied to an application: only `LICENSE` lines are (#1477). */
export function assertLicenseLine(line: { kind: string }): void {
  if (line.kind !== 'LICENSE') {
    throw new BadRequestException(
      `Only LICENSE lines are applied to an application; this line is ${line.kind}`,
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
 * Units received per line — derived from the records, never a counter of its own (ADR-0099 §3–§4): for a
 * `CONSUMABLE` line the units of the `IN` movements posted from it (#1476), for a `LICENSE` line the seats a
 * person applied to its application (`appliedSeats`, raised only by the apply route, #1477), for any other
 * kind the live assets linked to it. The ledger is append-only, so a consumable line's count never goes
 * down: a mistaken receipt is corrected on the stock with an ordinary movement, and the line keeps counting
 * what was received (the ADR-0098 rule for returns); applied seats likewise only grow. At most one grouped
 * query per source (no N+1); a line with nothing received is absent from the map.
 */
export async function receivedByLine(
  client: Client,
  lines: readonly LineRef[],
): Promise<Map<string, number>> {
  const received = new Map<string, number>();
  const stockIds = lines
    .filter((line) => line.kind === 'CONSUMABLE')
    .map((line) => line.id);
  const licenseIds = lines
    .filter((line) => line.kind === 'LICENSE')
    .map((line) => line.id);
  const assetIds = lines
    .filter((line) => line.kind !== 'CONSUMABLE' && line.kind !== 'LICENSE')
    .map((line) => line.id);
  if (licenseIds.length > 0) {
    // Read from the row, not the caller's copy: the count must be the committed one (the apply raises it
    // under a line lock).
    const rows = await client.purchaseOrderLine.findMany({
      where: { id: { in: licenseIds }, appliedSeats: { gt: 0 } },
      select: { id: true, appliedSeats: true },
    });
    for (const row of rows) {
      received.set(row.id, row.appliedSeats);
    }
  }
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
  return (await receivedByLine(client, [line])).get(line.id) ?? 0;
}

/**
 * The same received count as SQL, for the raw queries that derive receipt in the database (the `receipt`
 * filter and the pending-units list). The line MUST be aliased `l`. Built per call (not at module load) so a
 * module importing this file never needs the client's SQL helpers until it runs a query.
 */
export function receivedUnitsSql(): Prisma.Sql {
  return Prisma.sql`(CASE WHEN l."kind" = 'CONSUMABLE'
         THEN (SELECT COALESCE(SUM(m."quantity"), 0) FROM "consumable_movements" m
                WHERE m."purchaseOrderLineId" = l."id" AND m."type" = 'IN'::"ConsumableMovementType")
         WHEN l."kind" = 'LICENSE' THEN l."appliedSeats"
         ELSE (SELECT COUNT(*) FROM "assets" a
                WHERE a."purchaseOrderLineId" = l."id" AND a."deletedAt" IS NULL)
    END)`;
}

/** Whether a line now holds more units than it still expects (quantity − cancelled). */
export async function isOverReceived(
  client: Client,
  line: LineCounts,
): Promise<boolean> {
  const received = await countReceived(client, line);
  return received > Math.max(line.quantity - line.cancelledQuantity, 0);
}
