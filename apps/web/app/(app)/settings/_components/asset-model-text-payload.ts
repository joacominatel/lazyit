/**
 * The value an asset-model form sends for an optional free-text field — `sku` or `description`
 * (#1441) — from what the field holds and the value the model has now (`undefined` on create):
 *   - text (after trimming) → the trimmed text;
 *   - an empty field on CREATE → omitted (the model is created without it);
 *   - an empty field on EDIT of a model that has a value → `null`, which clears it (the PATCH contract);
 *   - an empty field on EDIT of a model that has none → omitted (nothing to change).
 * An empty string is never sent: the API refuses it on both create and update.
 */
export function clearableTextForPayload(
  entered: string,
  current: string | null | undefined,
): string | null | undefined {
  const trimmed = entered.trim();
  if (trimmed.length > 0) return trimmed;
  return current ? null : undefined;
}
