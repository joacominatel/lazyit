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
      currency: null,
    });
  });

  test("an amount carries the label the event recorded, not the purchase's current one", () => {
    expect(
      describePurchaseEvent({
        eventType: "LINE_ADDED",
        payload: { description: "NB", quantity: 1, unitPrice: 100, currency: "USD" },
      }),
    ).toMatchObject({ kind: "lineAdded", currency: "USD" });
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
      currency: null,
    });
    expect(describePurchaseEvent({ eventType: "UPDATED", payload: { changes: "oops" } })).toEqual({
      kind: "updated",
      changes: [],
      currency: null,
    });
    expect(describePurchaseEvent({ eventType: "STATUS_CHANGED", payload: { from: 3 } })).toEqual({
      kind: "statusChanged",
      from: null,
      to: null,
    });
  });

  test("an event type a newer build appends reads generically", () => {
    // UNITS_RECEIVED was this example until #1475 taught the log the flows' events.
    expect(describePurchaseEvent({ eventType: "LICENSES_RENEWED", payload: { quantity: 3 } })).toEqual({
      kind: "other",
      eventType: "LICENSES_RENEWED",
    });
  });
});

describe("the flows' events (#1473) read as sentences, tolerant of a thin payload", () => {
  test("a receive carries its count, failures and the over-received flag", () => {
    expect(
      describePurchaseEvent({
        eventType: "UNITS_RECEIVED",
        payload: { lineId: "l1", quantity: 3, assetIds: ["a", "b", "c"], failed: 1, overReceived: true },
      }),
    ).toEqual({ kind: "unitsReceived", lineId: "l1", quantity: 3, failed: 1, over: true });
  });

  test("a link counts its assets and says when they were moved here", () => {
    expect(
      describePurchaseEvent({
        eventType: "ASSET_LINKED",
        payload: {
          lineId: "l1",
          assetIds: ["a", "b"],
          applied: {},
          moved: [{ assetId: "a", lineId: "l0", purchaseOrderId: "p0" }],
          overReceived: false,
        },
      }),
    ).toEqual({ kind: "assetsLinked", lineId: "l1", count: 2, moved: true, over: false });
    expect(
      describePurchaseEvent({
        eventType: "ASSET_LINKED",
        payload: { lineId: "l1", assetIds: ["a"], applied: {}, moved: [], overReceived: false },
      }),
    ).toMatchObject({ moved: false });
  });

  test("an unlink by a move names the purchase the assets went to", () => {
    expect(
      describePurchaseEvent({
        eventType: "ASSET_UNLINKED",
        payload: { lineId: "l1", assetIds: ["a"], movedToPurchaseOrderId: "p2", movedToLineId: "l9" },
      }),
    ).toEqual({ kind: "assetsUnlinked", lineId: "l1", count: 1, movedToPurchaseOrderId: "p2" });
  });

  test("cancelled units keep the optional reason; documents keep their file name", () => {
    expect(
      describePurchaseEvent({
        eventType: "UNITS_CANCELLED",
        payload: { lineId: "l1", quantity: 1, cancelledQuantity: { from: 0, to: 1 }, reason: "never came" },
      }),
    ).toEqual({ kind: "unitsCancelled", lineId: "l1", quantity: 1, reason: "never came" });
    expect(describePurchaseEvent({ eventType: "DOCUMENT_ADDED", payload: { originalName: "Factura A.pdf" } })).toEqual({
      kind: "documentAdded",
      name: "Factura A.pdf",
    });
  });

  test("a payload missing its fields degrades to nulls, never undefined", () => {
    expect(describePurchaseEvent({ eventType: "UNITS_RECEIVED", payload: null })).toEqual({
      kind: "unitsReceived",
      lineId: null,
      quantity: null,
      failed: 0,
      over: false,
    });
    expect(describePurchaseEvent({ eventType: "DOCUMENT_REMOVED", payload: {} })).toEqual({
      kind: "documentRemoved",
      name: null,
    });
  });
});
