/**
 * The two rules a bulk action in the PENDING review tray has to keep (ADR-0074 §1 amendment, #1145),
 * pulled out of the component so they can be asserted rather than described.
 *
 * Both were promises the copy made and the code did not keep:
 *
 *  1. **A selection never reaches a row the operator cannot see.** The tray's comment, the Manual in
 *     both languages and the "select everything shown" label all said so, while the selection was a
 *     plain set of ids that survived every filter change — so *select all → narrow the filter →
 *     Confirm* confirmed rows that were no longer on screen.
 *  2. **A batch is bounded by `INFRA_BULK_REVIEW_MAX`.** The contract caps it at 200 and the schema's
 *     own comment claimed "the UI is what keeps a selection inside this bound", which nothing did: a
 *     selection of 201 was sent, rejected whole, and reported as a generic toast after the operator
 *     had done all of the selecting.
 */
import { INFRA_BULK_REVIEW_MAX } from "@lazyit/shared";
import { describe, expect, test } from "bun:test";
import { exceedsBulkReviewCap, pruneHiddenFromSelection } from "./tray-selection";

describe("pruneHiddenFromSelection (#1145)", () => {
  test("drops the ids a filter has hidden", () => {
    const selected = new Set(["a", "b", "c"]);
    expect([...pruneHiddenFromSelection(selected, ["a", "c"])]).toEqual(["a", "c"]);
  });

  test("a narrowed filter cannot leave a single hidden row selected", () => {
    const selected = new Set(["srv-1", "srv-2", "db-1"]);
    // The operator selected everything, then filtered down to the two `srv-` rows.
    const kept = pruneHiddenFromSelection(selected, ["srv-1", "srv-2"]);
    expect(kept.has("db-1")).toBe(false);
    expect(kept.size).toBe(2);
  });

  test("returns the SAME set when nothing was hidden, so the effect cannot loop", () => {
    // Referential identity is load-bearing: the tray calls this from an effect that writes the
    // result back into state, and a fresh Set every time would re-render for its own sake forever.
    const selected = new Set(["a", "b"]);
    expect(pruneHiddenFromSelection(selected, ["a", "b", "c"])).toBe(selected);
    expect(pruneHiddenFromSelection(selected, ["b", "a"])).toBe(selected);
  });

  test("an empty selection is returned untouched, whatever is visible", () => {
    const empty = new Set<string>();
    expect(pruneHiddenFromSelection(empty, [])).toBe(empty);
    expect(pruneHiddenFromSelection(empty, ["a"])).toBe(empty);
  });

  test("everything hidden clears the selection", () => {
    expect(pruneHiddenFromSelection(new Set(["a", "b"]), []).size).toBe(0);
  });
});

describe("exceedsBulkReviewCap (#1145)", () => {
  test("the cap is the contract's, not a second number", () => {
    expect(exceedsBulkReviewCap(INFRA_BULK_REVIEW_MAX)).toBe(false);
    expect(exceedsBulkReviewCap(INFRA_BULK_REVIEW_MAX + 1)).toBe(true);
  });

  test("an empty or small selection is never over the cap", () => {
    expect(exceedsBulkReviewCap(0)).toBe(false);
    expect(exceedsBulkReviewCap(1)).toBe(false);
  });
});
