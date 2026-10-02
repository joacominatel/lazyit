import { describe, expect, test } from "bun:test";
import { describePurchaseEvent, parseChanges } from "./events";

describe("describePurchaseEvent — the log reads tolerantly", () => {
  test("a price change on a line keeps before and after", () => {
    expect(
      describePurchaseEvent({
        eventType: "LINE_UPDATED",
        payload: { lineId: "l1", changes: { unitPrice: { from: 138000000, to: 141250000 } } },
      }),
    ).toEqual({
      kind: "lineUpdated",
      lineId: "l1",
      changes: [{ field: "unitPrice", from: 138000000, to: 141250000, nameOnly: false }],
    });
  });

  test("notes are logged by name only", () => {
    expect(parseChanges({ notes: { changed: true }, reference: { from: null, to: "OC 1" } })).toEqual([
      { field: "notes", from: null, to: null, nameOnly: true },
      { field: "reference", from: null, to: "OC 1", nameOnly: false },
    ]);
  });

  test("a missing or malformed payload degrades instead of printing undefined", () => {
    expect(describePurchaseEvent({ eventType: "LINE_ADDED", payload: null })).toEqual({
      kind: "lineAdded",
      description: null,
      quantity: null,
      unitPrice: null,
    });
    expect(describePurchaseEvent({ eventType: "UPDATED", payload: { changes: "oops" } })).toEqual({
      kind: "updated",
      changes: [],
    });
    expect(describePurchaseEvent({ eventType: "STATUS_CHANGED", payload: { from: 3 } })).toEqual({
      kind: "statusChanged",
      from: null,
      to: null,
    });
  });

  test("an event type a newer build appends reads generically", () => {
    expect(describePurchaseEvent({ eventType: "UNITS_RECEIVED", payload: { quantity: 3 } })).toEqual({
      kind: "other",
      eventType: "UNITS_RECEIVED",
    });
  });
});
