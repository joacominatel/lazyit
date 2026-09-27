/**
 * The explicit "no category" row of {@link CategoryCombobox} (#1315). The Combobox needs a non-empty
 * key for a row, so the row carries a sentinel that can never be a category id (ids are cuids); the
 * caller only ever sees `""` for "no category", exactly as without the row.
 */
export const NO_CATEGORY_VALUE = "__no-category__";

/** The caller's value → the Combobox's: no category selects the explicit row. */
export function toNoneAwareValue(value: string | undefined): string {
  return value ? value : NO_CATEGORY_VALUE;
}

/**
 * The Combobox's value → the caller's: the explicit row, or the toggle-clear `""` (picking the row
 * that is already selected), both mean no category.
 */
export function fromNoneAwareValue(value: string): string {
  return value === NO_CATEGORY_VALUE ? "" : value;
}
