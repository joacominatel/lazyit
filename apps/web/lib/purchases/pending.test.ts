import { describe, expect, test } from "bun:test";
import type { PendingPurchaseLine } from "@lazyit/shared";
import { groupPendingLines, isOverdue, localToday, pendingLinesForModel, pendingTotals } from "./pending";

const MODEL = "ck00000000000000000model1";

function line(id: string, purchaseId: string, pending: number, assetModelId: string | null = null): PendingPurchaseLine {
  return {
    id: `ck0000000000000000line${id}`,
    purchaseOrderId: purchaseId,
    position: 0,
    kind: "ASSET",
    description: `Line ${id}`,
    manufacturerText: null,
    modelText: null,
    assetModelId,
    quantity: 4,
    unitPrice: null,
    cancelledQuantity: 0,
    warrantyMonths: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    deletedAt: null,
    receivedQuantity: 4 - pending,
    pendingQuantity: pending,
    receiptState: "PARTIAL",
    lineTotal: null,
    purchaseOrder: {
      id: purchaseId,
      reference: `OC ${purchaseId.slice(-1)}`,
      status: "ORDERED",
      currency: null,
      orderDate: "2026-03-03T00:00:00.000Z",
      expectedDate: null,
      createdAt: "2026-03-03T00:00:00.000Z",
      supplier: null,
    },
  };
}

const P1 = "ck00000000000000purchase1";
const P2 = "ck00000000000000purchase2";

describe("pending units, grouped by purchase", () => {
  test("keeps the API's oldest-first order and sums the pending units per purchase", () => {
    const groups = groupPendingLines([line("a", P1, 1), line("b", P2, 4), line("c", P1, 2)]);
    expect(groups.map((g) => [g.purchase.id, g.lines.map((l) => l.description), g.pending])).toEqual([
      [P1, ["Line a", "Line c"], 3],
      [P2, ["Line b"], 4],
    ]);
    expect(pendingTotals(groups)).toEqual({ purchases: 2, units: 7 });
  });

  test("an empty page is no purchases and no units", () => {
    expect(pendingTotals(groupPendingLines([]))).toEqual({ purchases: 0, units: 0 });
  });
});

describe("overdue", () => {
  test("only with an expected date before today", () => {
    expect(isOverdue(null, "2026-04-02")).toBe(false);
    expect(isOverdue("2026-04-02T00:00:00.000Z", "2026-04-02")).toBe(false);
    expect(isOverdue("2026-04-01T00:00:00.000Z", "2026-04-02")).toBe(true);
  });

  test("today is the viewer's local day", () => {
    expect(localToday(new Date(2026, 3, 2, 23, 30))).toBe("2026-04-02");
  });
});

describe("open lines for a chosen model", () => {
  test("only lines mapped to that model, and none for no model", () => {
    const lines = [line("a", P1, 1, MODEL), line("b", P2, 2, null), line("c", P2, 3, MODEL)];
    expect(pendingLinesForModel(lines, MODEL).map((l) => l.description)).toEqual(["Line a", "Line c"]);
    expect(pendingLinesForModel(lines, "")).toEqual([]);
  });
});
