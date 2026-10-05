import type { AssetStatus } from '@lazyit/shared';
import type { Prisma } from '../../generated/prisma/client';

/** The compact custom status an asset read inlines (`AssetStatusLabelRefSchema`). */
export const ASSET_STATUS_LABEL_REF_SELECT = {
  id: true,
  name: true,
  kind: true,
  color: true,
} as const satisfies Prisma.AssetStatusLabelSelect;

export interface LiveStatusLabel {
  id: string;
  name: string;
  kind: AssetStatus;
  color: string | null;
}

/**
 * Lock a custom status row and read it back if it is LIVE (ADR-0101), inside the caller's transaction.
 *
 * The invariant `asset.statusLabelId != null ⇒ asset.status == label.kind` spans two tables, so every
 * write that touches it serializes on the label row:
 *   - an ASSET write that sets a custom status takes `FOR SHARE` (`mode: 'share'`) — concurrent asset writes
 *     never wait on each other;
 *   - a label `kind` change and a label delete take `FOR UPDATE` (`mode: 'update'`), so they wait for any
 *     in-flight asset write to commit and then see its asset, and an asset write that starts after them
 *     waits and then reads the new kind (or finds the label archived → 400).
 *
 * `null` when the row does not exist or is soft-deleted. Writes only: reads never lock.
 */
export async function lockLiveStatusLabel(
  tx: Prisma.TransactionClient,
  id: string,
  mode: 'share' | 'update',
): Promise<LiveStatusLabel | null> {
  if (mode === 'update') {
    await tx.$queryRaw`SELECT "id" FROM "asset_status_labels" WHERE "id" = ${id} FOR UPDATE`;
  } else {
    await tx.$queryRaw`SELECT "id" FROM "asset_status_labels" WHERE "id" = ${id} FOR SHARE`;
  }
  return tx.assetStatusLabel.findFirst({
    where: { id, deletedAt: null },
    select: ASSET_STATUS_LABEL_REF_SELECT,
  });
}

/** The `{ id, name }` a STATUS_CHANGED payload names a custom status by (or `null` for none). */
export function labelPayload(
  label: { id: string; name: string } | null | undefined,
): { id: string; name: string } | null {
  return label ? { id: label.id, name: label.name } : null;
}

/**
 * The `STATUS_CHANGED` payload (ADR-0033 + ADR-0101 amendment): `{ from, to }` are the BUILT-IN statuses, as
 * always. When either side carries a custom status, `fromLabel` / `toLabel` (`{ id, name }` or `null`) are
 * added — so an event that predates custom statuses, and one between two bare built-in statuses, keep the
 * exact `{ from, to }` shape every reader already handles.
 */
export function statusChangedPayload(
  from: AssetStatus,
  to: AssetStatus,
  fromLabel: { id: string; name: string } | null | undefined,
  toLabel: { id: string; name: string } | null | undefined,
): Prisma.InputJsonValue {
  const before = labelPayload(fromLabel);
  const after = labelPayload(toLabel);
  return before || after
    ? { from, to, fromLabel: before, toLabel: after }
    : { from, to };
}
