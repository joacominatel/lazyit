import { type AssetStatus, AssetStatusSchema } from "@lazyit/shared";

/**
 * Pure payload → parts glue for the asset history `STATUS_CHANGED` event (ADR-0033, amended by ADR-0101).
 *
 * The API writes `{ from, to }` — the built-in statuses — and, when either side carries a custom status,
 * `fromLabel` / `toLabel` (`{ id, name }` or `null`). It also writes the event when ONLY the custom status
 * changed (`from === to`). Rows written before custom statuses have no label keys at all, and the payload
 * is unvalidated jsonb, so every read is tolerant: an absent or malformed label is "no custom status", and
 * a built-in value this build does not know is kept verbatim.
 */

/** One side of a status change: the built-in status (or its raw value) and the custom name, if any. */
export interface StatusChangeSide {
  /** The built-in status, or null when the payload holds a value this build does not know. */
  status: AssetStatus | null;
  /** The raw built-in value as written (shown verbatim when `status` is null). */
  raw: string;
  /** The custom status name on this side, or null. */
  label: string | null;
}

function labelName(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" && name.trim().length > 0 ? name : null;
}

function side(rawStatus: unknown, rawLabel: unknown): StatusChangeSide | null {
  if (typeof rawStatus !== "string" || rawStatus.length === 0) return null;
  const parsed = AssetStatusSchema.safeParse(rawStatus);
  return {
    status: parsed.success ? parsed.data : null,
    raw: rawStatus,
    label: labelName(rawLabel),
  };
}

/** The two sides of a `STATUS_CHANGED` payload, or null when it lacks a usable `from` / `to`. */
export function parseStatusChange(
  payload: Record<string, unknown> | null | undefined,
): { from: StatusChangeSide; to: StatusChangeSide } | null {
  if (!payload) return null;
  const from = side(payload.from, payload.fromLabel);
  const to = side(payload.to, payload.toLabel);
  return from && to ? { from, to } : null;
}
