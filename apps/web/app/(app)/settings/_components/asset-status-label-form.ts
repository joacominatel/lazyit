import {
  ASSET_STATUS_LABEL_ORDER_MAX,
  type AssetStatus,
  type AssetStatusLabel,
  AssetStatusLabelColorSchema,
  type CreateAssetStatusLabel,
  type UpdateAssetStatusLabel,
} from "@lazyit/shared";

/**
 * Pure form-to-wire glue for the custom status dialog (Settings → Taxonomies → Statuses, ADR-0101), kept
 * out of React for its tests. The shared schemas stay the validators on the API; this only shapes the
 * body and catches the two mistakes worth a friendly inline message (an empty name, a bad colour/order).
 */

/**
 * The curated colour palette offered first (any `#RRGGBB` can still be typed). The colour only ever
 * paints the small dot next to the name — never text — so it carries no contrast burden (ADR-0049).
 */
export const STATUS_COLOR_PALETTE = [
  "#16A34A",
  "#0D9488",
  "#0284C7",
  "#2563EB",
  "#7C3AED",
  "#DB2777",
  "#DC2626",
  "#EA580C",
  "#CA8A04",
  "#64748B",
] as const;

/** The dialog's raw state — strings straight from the inputs. `color` "" = the built-in status's own. */
export interface StatusLabelFormValues {
  name: string;
  kind: AssetStatus;
  color: string;
  description: string;
  order: string;
}

export type StatusLabelFormError = "nameRequired" | "colorInvalid" | "orderInvalid";

export function toStatusLabelFormValues(
  label?: AssetStatusLabel,
  kind: AssetStatus = "OPERATIONAL",
): StatusLabelFormValues {
  return {
    name: label?.name ?? "",
    kind: label?.kind ?? kind,
    color: label?.color ?? "",
    description: label?.description ?? "",
    order: label?.order != null ? String(label.order) : "",
  };
}

type Normalized = {
  name: string;
  kind: AssetStatus;
  color: string | null;
  description: string | null;
  order: number | null;
};

function normalize(
  values: StatusLabelFormValues,
): { ok: true; value: Normalized } | { ok: false; error: StatusLabelFormError } {
  const name = values.name.trim();
  if (name.length === 0) return { ok: false, error: "nameRequired" };
  const rawColor = values.color.trim();
  if (rawColor && !AssetStatusLabelColorSchema.safeParse(rawColor).success) {
    return { ok: false, error: "colorInvalid" };
  }
  const rawOrder = values.order.trim();
  let order: number | null = null;
  if (rawOrder) {
    const parsed = Number(rawOrder);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > ASSET_STATUS_LABEL_ORDER_MAX) {
      return { ok: false, error: "orderInvalid" };
    }
    order = parsed;
  }
  const description = values.description.trim();
  return {
    ok: true,
    value: {
      name,
      kind: values.kind,
      // Stored upper-case so the same colour never reads as two values.
      color: rawColor ? rawColor.toUpperCase() : null,
      description: description || null,
      order,
    },
  };
}

/** The create body: blank optional fields are omitted. */
export function buildCreateStatusLabel(
  values: StatusLabelFormValues,
): { ok: true; body: CreateAssetStatusLabel } | { ok: false; error: StatusLabelFormError } {
  const result = normalize(values);
  if (!result.ok) return result;
  const { name, kind, color, description, order } = result.value;
  return {
    ok: true,
    body: {
      name,
      kind,
      ...(color ? { color } : {}),
      ...(description ? { description } : {}),
      ...(order !== null ? { order } : {}),
    },
  };
}

/**
 * The update body: ONLY the fields that changed (a cleared optional field is `null`), so an untouched
 * `kind` is never sent — the API refuses any kind write while the custom status is in use. `body` is
 * `null` when nothing changed (the API rejects an empty PATCH).
 */
export function buildUpdateStatusLabel(
  label: AssetStatusLabel,
  values: StatusLabelFormValues,
): { ok: true; body: UpdateAssetStatusLabel | null } | { ok: false; error: StatusLabelFormError } {
  const result = normalize(values);
  if (!result.ok) return result;
  const next = result.value;
  const body: UpdateAssetStatusLabel = {};
  if (next.name !== label.name) body.name = next.name;
  if (next.kind !== label.kind) body.kind = next.kind;
  if (next.color !== (label.color ? label.color.toUpperCase() : null)) body.color = next.color;
  if (next.description !== (label.description ?? null)) body.description = next.description;
  if (next.order !== (label.order ?? null)) body.order = next.order;
  return { ok: true, body: Object.keys(body).length > 0 ? body : null };
}
