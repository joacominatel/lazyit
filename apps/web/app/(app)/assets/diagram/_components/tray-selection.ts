import { INFRA_BULK_REVIEW_MAX } from "@lazyit/shared";

/**
 * The selection rules of the PENDING review tray (ADR-0074 §1 amendment, #1145).
 *
 * Pure and separate from the component for one reason: both of them are promises made in prose — in
 * the tray's own comment, in the "select everything shown" label, in the Manual in both languages and
 * in the bulk contract's JSDoc — and prose is not something a test can hold to account. These are.
 */

/**
 * The selected rows a bulk action may touch: the intersection of what is TICKED and what is VISIBLE.
 *
 * The raw selection is a set of ids that outlives a filter change, and that is fine as long as no
 * ACTION and no COUNT is derived from it. Both go through this instead — the number beside the
 * buttons, the two dialogs, and the ids in the request — so a row a filter hides is out of the action
 * AND out of the count, in the same instant it leaves the screen. Selecting all, narrowing the filter
 * and pressing Confirm therefore confirms exactly the rows still on screen. (The tray's checkboxes do
 * read the raw set, but only ever to draw a row that is already on screen.)
 *
 * Re-widening the filter brings a hidden row back, ticked and counted again. That is the deliberate
 * half: it is visible (the count goes up, the checkbox is drawn ticked, the row is on screen), which
 * is the opposite of the failure this guards — acting on rows nobody can see.
 */
export function visibleSelection<T extends { id: string }>(
  visibleRows: readonly T[],
  selected: ReadonlySet<string>,
): T[] {
  return visibleRows.filter((row) => selected.has(row.id));
}

/**
 * Is this selection bigger than one bulk request may carry?
 *
 * The cap is `INFRA_BULK_REVIEW_MAX` — the contract's own number, imported rather than restated, so
 * the tray and the schema can never disagree about it. The tray refuses BEFORE the request: a batch
 * over the cap fails the whole call, and telling the operator that in a toast after they have done all
 * of the selecting is the one moment the information is useless.
 */
export function exceedsBulkReviewCap(selectedCount: number): boolean {
  return selectedCount > INFRA_BULK_REVIEW_MAX;
}
