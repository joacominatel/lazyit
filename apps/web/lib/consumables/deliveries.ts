import type {
  ConsumableDeliveryTarget,
  ConsumableDeliveryTargetKey,
  ConsumableMovement,
  ConsumableMovementType,
  CreateConsumableMovement,
} from "@lazyit/shared";

/**
 * Pure helpers for consumable DELIVERIES (ADR-0098, #1364) — the web half of "a targeted OUT movement".
 * No React, no fetching: the payload builders the dialogs submit, the target-label resolver the ledger
 * renders, and the per-delivery return tally. Kept pure so the rules (one target, only on an OUT; a
 * return is an IN with `returnOfId`; a redacted target never shows a raw id) are unit-tested here.
 */

/** The three kinds of place a delivery can go. `none` is the UI's "no destination" choice. */
export const DELIVERY_TARGET_KINDS = ["user", "asset", "location"] as const;
export type DeliveryTargetKind = (typeof DELIVERY_TARGET_KINDS)[number];

/** A chosen destination: its kind and the entity id (uuid for a user, cuid for an asset/location). */
export interface DeliveryTargetRef {
  kind: DeliveryTargetKind;
  id: string;
}

/** Target kind → the create-payload / deliveries-query key that carries its id. */
export const DELIVERY_TARGET_KEY: Record<
  DeliveryTargetKind,
  ConsumableDeliveryTargetKey
> = {
  user: "targetUserId",
  asset: "targetAssetId",
  location: "targetLocationId",
};

/** Trim an optional free-text field; blank → omitted. */
function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/**
 * The body of `POST /consumables/:id/movements` for a detailed movement. The target key is added ONLY
 * for an `OUT` with a chosen id — any other combination sends a plain movement, so a stale target left
 * in the form after switching direction can never produce a payload the API rejects. Blank reason /
 * notes are omitted (the shared schema would coerce them away anyway).
 */
export function buildMovementPayload(input: {
  type: ConsumableMovementType;
  quantity: number;
  reason?: string;
  notes?: string;
  target?: DeliveryTargetRef | null;
}): CreateConsumableMovement {
  const reason = trimmed(input.reason);
  const notes = trimmed(input.notes);
  const target =
    input.type === "OUT" && input.target && input.target.id
      ? input.target
      : null;
  return {
    type: input.type,
    quantity: input.quantity,
    ...(reason ? { reason } : {}),
    ...(notes ? { notes } : {}),
    ...(target ? { [DELIVERY_TARGET_KEY[target.kind]]: target.id } : {}),
  };
}

/** The body of a RETURN: an `IN` linked to the delivery it gives back (partial returns allowed). */
export function buildReturnPayload(input: {
  deliveryId: number;
  quantity: number;
  notes?: string;
}): CreateConsumableMovement {
  const notes = trimmed(input.notes);
  return {
    type: "IN",
    quantity: input.quantity,
    returnOfId: input.deliveryId,
    ...(notes ? { notes } : {}),
  };
}

/** The deliveries-read filter for one target (`GET /consumables/deliveries?targetXxxId=`). */
export function deliveryTargetQuery(
  target: DeliveryTargetRef,
): Partial<Record<ConsumableDeliveryTargetKey, string>> {
  return { [DELIVERY_TARGET_KEY[target.kind]]: target.id };
}

/**
 * A delivery target resolved for display.
 *  - `live`      — a named, current entity: show the label, link to it.
 *  - `gone`      — offboarded (user) or soft-deleted (asset / location): show the label, flag it, and
 *                  do not link (the detail page of a removed row is not a reliable destination).
 *  - `redacted`  — the caller cannot read the target's domain (the API nulled the name): show only a
 *                  neutral "restricted" placeholder — never the raw id as if it were a name.
 */
export type ResolvedDeliveryTarget =
  | { kind: DeliveryTargetKind; state: "redacted" }
  | {
      kind: DeliveryTargetKind;
      state: "live" | "gone";
      label: string;
      href: string | null;
    };

const TARGET_PATH: Record<DeliveryTargetKind, string> = {
  user: "/users",
  asset: "/assets",
  location: "/locations",
};

/**
 * Resolve a movement's `target` descriptor into what the UI renders. `null`/`undefined` (an untargeted
 * movement, or an older API that sends no target) → `null`. A null display name is REDACTION, whatever
 * the lifecycle flag says; a blank name is treated the same way (nothing honest to show). A null
 * lifecycle flag next to a real name reads as live — the tolerant read.
 */
export function resolveDeliveryTarget(
  target: ConsumableDeliveryTarget | null | undefined,
): ResolvedDeliveryTarget | null {
  if (!target) return null;
  let label: string | null;
  let gone: boolean | null;
  switch (target.type) {
    case "user":
      label = target.displayName;
      gone = target.isOffboarded;
      break;
    case "asset":
      label = target.label;
      gone = target.isDeleted;
      break;
    case "location":
      label = target.name;
      gone = target.isDeleted;
      break;
    default:
      // An unknown kind from a newer API — nothing safe to show.
      return null;
  }
  const kind: DeliveryTargetKind = target.type;
  const text = label?.trim();
  if (!text) return { kind, state: "redacted" };
  if (gone === true) return { kind, state: "gone", label: text, href: null };
  return {
    kind,
    state: "live",
    label: text,
    href: `${TARGET_PATH[kind]}/${target.id}`,
  };
}

/**
 * Units returned per delivery, summed from a consumable's FULL ledger (every IN carrying `returnOfId`).
 * The detail page reads the unfiltered ledger, so the sum is exact there; on a filtered ledger it would
 * under-count, so callers only use it on the unfiltered read.
 */
export function returnedByDelivery(
  movements: readonly Pick<ConsumableMovement, "type" | "quantity" | "returnOfId">[],
): Map<number, number> {
  const returned = new Map<number, number>();
  for (const movement of movements) {
    if (movement.type !== "IN" || movement.returnOfId == null) continue;
    returned.set(
      movement.returnOfId,
      (returned.get(movement.returnOfId) ?? 0) + movement.quantity,
    );
  }
  return returned;
}

/**
 * The return state of one delivery row in the ledger: `null` when it is not a returnable delivery,
 * otherwise how much came back and how much is still out (never negative).
 */
export function deliveryReturnState(
  movement: Pick<ConsumableMovement, "id" | "type" | "quantity" | "returnable">,
  returned: ReadonlyMap<number, number>,
): { returned: number; outstanding: number } | null {
  if (movement.type !== "OUT" || movement.returnable !== true) return null;
  const back = returned.get(movement.id) ?? 0;
  return { returned: back, outstanding: Math.max(0, movement.quantity - back) };
}

/** The light date-range presets of the deliveries panels ("any time" = no lower bound). */
export const DELIVERY_RANGE_PRESETS = ["all", "30d", "90d", "365d"] as const;
export type DeliveryRangePreset = (typeof DELIVERY_RANGE_PRESETS)[number];

const RANGE_DAYS: Record<Exclude<DeliveryRangePreset, "all">, number> = {
  "30d": 30,
  "90d": 90,
  "365d": 365,
};

/**
 * The inclusive `from` (ISO datetime) for a preset, counted back from `now`; `undefined` for "any time".
 * Computed once when the preset is chosen (not per render), so the query key stays stable.
 */
export function deliveryRangeFrom(
  preset: DeliveryRangePreset,
  now: Date,
): string | undefined {
  if (preset === "all") return undefined;
  return new Date(now.getTime() - RANGE_DAYS[preset] * 86_400_000).toISOString();
}
