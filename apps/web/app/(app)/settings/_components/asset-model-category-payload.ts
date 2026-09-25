/**
 * The `categoryId` an asset-model form sends (#1315), from the picked value (`""` = no category) and
 * the category the model has now (`undefined` on create):
 *   - a picked category → its id;
 *   - no category on CREATE → omitted (the model is created uncategorized);
 *   - no category on EDIT of a model that has one → `null`, which clears it (the PATCH contract);
 *   - no category on EDIT of a model that has none → omitted (nothing to change).
 */
export function categoryIdForPayload(
  picked: string,
  current: string | null | undefined,
): string | null | undefined {
  if (picked.length > 0) return picked;
  return current ? null : undefined;
}
