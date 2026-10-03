import { describe, expect, test } from "bun:test";
import type { PendingPurchaseLine } from "@lazyit/shared";
import {
  assetReceivableLines,
  collectPages,
  groupPendingLines,
  isOverdue,
  lineReceiveAction,
  localToday,
  pendingLinesForModel,
  pendingTotals,
} from "./pending";

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

describe("assetReceivableLines (#1476)", () => {
  test("a consumable line is never offered to an asset receive", () => {
    const asset = line("1", "p1", 2);
    const consumable = { ...line("2", "p1", 5), kind: "CONSUMABLE" };
    expect(assetReceivableLines([asset, consumable])).toEqual([asset]);
  });
});

describe("collectPages — the From purchase picker sees every open line (#1476 review)", () => {
  /** A fake paged API over `n` rows, `limit` per page, recording the offsets asked for. */
  function pagedApi(n: number, limit: number) {
    const offsets: number[] = [];
    const rows = Array.from({ length: n }, (_, i) => i);
    return {
      offsets,
      fetchPage: async (offset: number) => {
        offsets.push(offset);
        return { items: rows.slice(offset, offset + limit), total: n };
      },
    };
  }

  test("asset lines past the first page are still read", async () => {
    const api = pagedApi(450, 200);
    const result = await collectPages(api.fetchPage);
    expect(result.items).toHaveLength(450);
    expect(api.offsets).toEqual([0, 200, 400]);
  });

  test("one page is enough when it holds everything", async () => {
    const api = pagedApi(3, 200);
    expect((await collectPages(api.fetchPage)).items).toEqual([0, 1, 2]);
    expect(api.offsets).toEqual([0]);
  });

  test("it stops at the page bound, and on an empty page even if total says more", async () => {
    const bounded = pagedApi(5_000, 200);
    expect((await collectPages(bounded.fetchPage, 2)).items).toHaveLength(400);
    const shrinking = async (offset: number) => ({ items: offset === 0 ? [1] : [], total: 10 });
    expect((await collectPages(shrinking)).items).toEqual([1]);
  });
});

describe("lineReceiveAction — what Receive means per line kind (#1477)", () => {
  test("an asset line receives assets, a consumable line receives stock", () => {
    expect(lineReceiveAction("ASSET")).toBe("receiveAssets");
    expect(lineReceiveAction("CONSUMABLE")).toBe("receiveStock");
  });

  test("a license line applies the license — never an asset or stock receive", () => {
    expect(lineReceiveAction("LICENSE")).toBe("applyLicense");
  });

  test("an Other line, or a kind a newer build writes, offers nothing to receive", () => {
    expect(lineReceiveAction("OTHER")).toBeNull();
    expect(lineReceiveAction("SUBSCRIPTION")).toBeNull();
  });
});
