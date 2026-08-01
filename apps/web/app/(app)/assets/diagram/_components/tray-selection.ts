import { INFRA_BULK_REVIEW_MAX } from "@lazyit/shared";

/**
 * The selection rules of the PENDING review tray (ADR-0074 §1 amendment, #1145).
 *
 * Pure and separate from the component for one reason: both of them are promises made in prose — in
 * the tray's own comment, in the "select everything shown" label, in the Manual in both languages and
 * in the bulk contract's JSDoc — and prose is not something a test can hold to account. These are.
 */

/**
 * Forget the ids a filter has hidden.
 *
 * A bulk action must reach EXACTLY what the operator can see. Deriving the acted-on nodes from the
 * visible rows is half of that; this is the other half, and it is the half the *count* depends on —
 * "12 selected" beside a Confirm button has to mean twelve rows on screen, not twelve rows of which
 * four are behind a filter the operator has since narrowed. Without it, *select all → filter → Confirm*
 * confirms rows nobody looked at, and widening the filter again resurrects a selection the operator
 * has no memory of making.
 *
 * Returns the SAME set when nothing was hidden: the tray calls this from an effect that writes the
 * result back into state, so a fresh `Set` on every pass would re-render for its own sake forever.
 */
export function pruneHiddenFromSelection(
  selected: ReadonlySet<string>,
  visibleIds: readonly string[],
): ReadonlySet<string> {
  if (selected.size === 0) return selected;
  const visible = new Set(visibleIds);
  const kept = [...selected].filter((id) => visible.has(id));
  return kept.length === selected.size ? selected : new Set(kept);
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
