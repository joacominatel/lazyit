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
      label: null,
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
      label: null,
    });
  });
});

describe("consumable receipts and document labels (#1476)", () => {
  test("a stock receipt reads its line, count and over-received flag — never as asset units", () => {
    expect(
      describePurchaseEvent({
        eventType: "STOCK_RECEIVED",
        payload: { lineId: "l2", consumableId: "c1", movementId: "m1", quantity: 12, overReceived: true },
      }),
    ).toEqual({ kind: "stockReceived", lineId: "l2", quantity: 12, over: true });
  });

  test("a thin stock receipt degrades instead of printing undefined", () => {
    expect(describePurchaseEvent({ eventType: "STOCK_RECEIVED", payload: null })).toEqual({
      kind: "stockReceived",
      lineId: null,
      quantity: null,
      over: false,
    });
  });

  test("a label change keeps before and after; a cleared label reads as null", () => {
    expect(
      describePurchaseEvent({
        eventType: "DOCUMENT_UPDATED",
        payload: { attachmentId: "a1", originalName: "fc-0001.pdf", label: { from: "Quote", to: "Invoice" } },
      }),
    ).toEqual({ kind: "documentUpdated", name: "fc-0001.pdf", from: "Quote", to: "Invoice" });
    expect(
      describePurchaseEvent({
        eventType: "DOCUMENT_UPDATED",
        payload: { originalName: "fc-0001.pdf", label: { from: "Invoice", to: null } },
      }),
    ).toEqual({ kind: "documentUpdated", name: "fc-0001.pdf", from: "Invoice", to: null });
    expect(describePurchaseEvent({ eventType: "DOCUMENT_UPDATED", payload: { label: "oops" } })).toEqual({
      kind: "documentUpdated",
      name: null,
      from: null,
      to: null,
    });
  });

  test("a document added or removed carries its label, and an older event without one reads as none", () => {
    expect(
      describePurchaseEvent({ eventType: "DOCUMENT_ADDED", payload: { originalName: "remito.jpg", label: "Delivery note" } }),
    ).toEqual({ kind: "documentAdded", name: "remito.jpg", label: "Delivery note" });
    expect(describePurchaseEvent({ eventType: "DOCUMENT_REMOVED", payload: { originalName: "x.pdf" } })).toEqual({
      kind: "documentRemoved",
      name: "x.pdf",
      label: null,
    });
  });
});

describe("Phase 2 events (#1477) read as sentences, tolerant of a thin payload", () => {
  test("a license applied carries the seats added, before and after, and the renewal", () => {
    expect(
      describePurchaseEvent({
        eventType: "LICENSE_APPLIED",
        payload: {
          lineId: "l1",
          applicationId: "a1",
          seatsAdded: 10,
          seatsPurchased: { from: 20, to: 30 },
          renewalDate: { from: null, to: "2027-03-01T00:00:00.000Z" },
          appliedSeats: { from: 0, to: 10 },
          overApplied: false,
        },
      }),
    ).toEqual({
      kind: "licenseApplied",
      lineId: "l1",
      seatsAdded: 10,
      seats: { from: 20, to: 30 },
      renewal: { from: null, to: "2027-03-01T00:00:00.000Z" },
      over: false,
    });
  });

  test("a renewal-only apply has no seat change, and an over-application is flagged", () => {
    expect(
      describePurchaseEvent({
        eventType: "LICENSE_APPLIED",
        payload: { lineId: "l1", seatsAdded: 0, seatsPurchased: null, overApplied: true },
      }),
    ).toMatchObject({ kind: "licenseApplied", seats: null, renewal: null, over: true });
  });

  test("an extraction run says whether it succeeded, with the provider and model — never document values", () => {
    expect(
      describePurchaseEvent({
        eventType: "EXTRACTION_RUN",
        payload: {
          extractionId: "ext_1",
          attachmentId: "att1",
          outcome: "SUCCEEDED",
          errorCode: null,
          provider: "anthropic",
          model: "claude-x",
          inputTokens: 1200,
          outputTokens: 300,
          lineCount: 4,
          warningCount: 2,
        },
      }),
    ).toEqual({
      kind: "extractionRun",
      succeeded: true,
      errorCode: null,
      provider: "anthropic",
      model: "claude-x",
      lineCount: 4,
      warningCount: 2,
    });
    expect(
      describePurchaseEvent({ eventType: "EXTRACTION_RUN", payload: { outcome: "FAILED", errorCode: "EXTRACTION_TIMEOUT" } }),
    ).toMatchObject({ kind: "extractionRun", succeeded: false, errorCode: "EXTRACTION_TIMEOUT", lineCount: null });
  });

  test("a purchase created from assets counts the assets linked and the ones left out", () => {
    expect(
      describePurchaseEvent({
        eventType: "CREATED_FROM_ASSETS",
        payload: { lineCount: 2, linkedAssetIds: ["a", "b", "c"], failed: 1 },
      }),
    ).toEqual({ kind: "createdFromAssets", linked: 3, lineCount: 2, failed: 1 });
    expect(describePurchaseEvent({ eventType: "CREATED_FROM_ASSETS", payload: null })).toEqual({
      kind: "createdFromAssets",
      linked: null,
      lineCount: null,
      failed: 0,
    });
  });
});
