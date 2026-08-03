/**
 * The two rules a bulk action in the PENDING review tray has to keep (ADR-0074 §1 amendment, #1145),
 * pulled out of the component so they can be asserted rather than described.
 *
 * Both were promises the copy made and the code did not keep:
 *
 *  1. **A bulk action never reaches a row the operator cannot see.** The tray's comment, the Manual in
 *     both languages and the "select everything shown" label all said so, while the acted-on nodes
 *     were filtered out of the *unfiltered* pending list — so *select all → narrow the filter →
 *     Confirm* confirmed rows that were no longer on screen, and the count beside the button counted
 *     them.
 *  2. **A batch is bounded by `INFRA_BULK_REVIEW_MAX`.** The contract caps it at 200 and the schema's
 *     own comment claimed "the UI is what keeps a selection inside this bound", which nothing did: a
 *     selection of 201 was sent, rejected whole, and reported as a generic toast after the operator
 *     had done all of the selecting.
 */
import { INFRA_BULK_REVIEW_MAX } from "@lazyit/shared";
import { describe, expect, test } from "bun:test";
import { exceedsBulkReviewCap, visibleSelection } from "./tray-selection";

const row = (id: string) => ({ id, label: id });

describe("visibleSelection (#1145)", () => {
  test("is the intersection of ticked and visible", () => {
    const selected = new Set(["a", "b", "c"]);
    expect(visibleSelection([row("a"), row("c")], selected).map((r) => r.id)).toEqual(["a", "c"]);
  });

  test("a narrowed filter takes its hidden rows out of the action AND the count", () => {
    // The operator ticked everything, then filtered down to the two `srv-` rows.
    const selected = new Set(["srv-1", "srv-2", "db-1"]);
    const acted = visibleSelection([row("srv-1"), row("srv-2")], selected);
    expect(acted.map((r) => r.id)).toEqual(["srv-1", "srv-2"]);
    // `db-1` is what a bulk confirm would have reached while the operator could not see it.
    expect(acted.some((r) => r.id === "db-1")).toBe(false);
  });

  test("a filter hiding everything leaves nothing to act on", () => {
    expect(visibleSelection([], new Set(["a", "b"]))).toEqual([]);
  });

  test("an empty selection acts on nothing, however much is visible", () => {
    expect(visibleSelection([row("a"), row("b")], new Set())).toEqual([]);
  });

  test("keeps the VISIBLE order, so the request mirrors the list the operator read", () => {
    const selected = new Set(["b", "a"]);
    expect(visibleSelection([row("a"), row("b")], selected).map((r) => r.id)).toEqual(["a", "b"]);
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
