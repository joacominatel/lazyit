import { describe, expect, test } from "bun:test";
import type { PurchaseApplyAction, PurchaseLinkedPreviewAsset } from "@lazyit/shared";
import {
  applyInChunks,
  chunkIds,
  initialLinkedSelection,
  linkedCostRows,
  linkedPriceFollowUp,
} from "./linked-update";

const line = (kind: string, unitPrice: number | null, receivedQuantity: number) => ({ kind, unitPrice, receivedQuantity });

describe("linkedPriceFollowUp — when a line edit offers to update its linked assets (#1502)", () => {
  test("an asset line with linked assets whose price changed: offered, with the price it replaced", () => {
    expect(linkedPriceFollowUp(line("ASSET", 138000000, 3), line("ASSET", 141250000, 3))).toEqual({
      previousUnitPrice: 138000000,
    });
    // A line that had no price: the previous price is null, which the API reads as "no cost held".
    expect(linkedPriceFollowUp(line("ASSET", null, 2), line("ASSET", 5000, 2))).toEqual({ previousUnitPrice: null });
  });

  test("not offered when nothing is linked, the price did not change, was cleared, or the line is not an asset line", () => {
    expect(linkedPriceFollowUp(line("ASSET", 100, 0), line("ASSET", 200, 0))).toBeNull();
    expect(linkedPriceFollowUp(line("ASSET", 100, 3), line("ASSET", 100, 3))).toBeNull();
    expect(linkedPriceFollowUp(line("ASSET", 100, 3), line("ASSET", null, 3))).toBeNull();
    expect(linkedPriceFollowUp(line("CONSUMABLE", 100, 3), line("CONSUMABLE", 200, 3))).toBeNull();
    expect(linkedPriceFollowUp(line("LICENSE", 100, 3), line("LICENSE", 200, 3))).toBeNull();
  });
});

function asset(
  id: string,
  action: PurchaseApplyAction,
  holdsPreviousCost: boolean | null,
  preChecked: PurchaseLinkedPreviewAsset["preChecked"],
  current: number | null = 100,
): PurchaseLinkedPreviewAsset {
  const same = { current: null, purchase: null, action: "SAME" as const };
  return {
    assetId: id,
    name: `Asset ${id}`,
    assetTag: `LZ-${id}`,
    holdsPreviousCost,
    preChecked,
    fields: {
      purchaseDate: same,
      purchaseCost: { current: { amount: current, currency: "ARS" }, purchase: { amount: 200, currency: "ARS" }, action },
      warrantyEnd: same,
      company: same,
      modelId: same,
    },
  };
}

describe("the follow-up's rows and its pre-check — follow unless overridden", () => {
  const assets = [
    asset("1", "REPLACE", true, ["purchaseCost"]), // still the old purchase value → follows
    asset("2", "REPLACE", false, []), // changed by hand → overridden, never pre-checked
    asset("3", "FILL", true, ["purchaseCost"], null), // empty → filled
    asset("4", "SAME", false, []), // already the new value
  ];

  test("an overridden asset is marked; one already at the new value cannot be ticked", () => {
    const rows = linkedCostRows(assets);
    expect(rows.map((r) => [r.assetId, r.overridden, r.selectable])).toEqual([
      ["1", false, true],
      ["2", true, true],
      ["3", false, true],
      ["4", false, false],
    ]);
    expect(rows[0]!.next).toEqual({ amount: 200, currency: "ARS" });
  });

  test("pre-checked exactly as the API says, never an asset that would not change", () => {
    expect([...initialLinkedSelection(assets)].sort()).toEqual(["1", "3"]);
    // A pre-check on a SAME row (an API mismatch) is still not ticked: it would change nothing.
    expect([...initialLinkedSelection([asset("5", "SAME", true, ["purchaseCost"])])]).toEqual([]);
  });

  test("a REPLACE with no previous price given (holdsPreviousCost null) is not marked overridden", () => {
    expect(linkedCostRows([asset("6", "REPLACE", null, [])])[0]!.overridden).toBe(false);
  });
});

describe("applying in chunks of at most 200 ids", () => {
  const ids = Array.from({ length: 450 }, (_, i) => `id${i}`);

  test("450 ids are three calls: 200, 200, 50", () => {
    expect(chunkIds(ids).map((c) => c.length)).toEqual([200, 200, 50]);
    expect(chunkIds([])).toEqual([]);
  });

  test("the results add up across calls", async () => {
    const sent: number[] = [];
    const outcome = await applyInChunks(ids, async (chunk) => {
      sent.push(chunk.length);
      return {
        updated: chunk.slice(1).map(() => ({}) as never),
        unchanged: [chunk[0]!],
        failed: [],
      };
    });
    expect(sent).toEqual([200, 200, 50]);
    expect(outcome).toMatchObject({ updated: 447, unchanged: 3, notSent: 0, error: null });
  });

  test("a call that fails stops the rest and says how many were never sent", async () => {
    let calls = 0;
    const outcome = await applyInChunks(ids, async (chunk) => {
      calls++;
      if (calls === 2) throw new Error("boom");
      return {
        updated: chunk.map(() => ({}) as never),
        unchanged: [],
        failed: [{ assetId: chunk[0]!, reason: "NOT_LINKED", error: "not on this line" }],
      };
    });
    expect(calls).toBe(2);
    expect(outcome.updated).toBe(200);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.notSent).toBe(250);
    expect((outcome.error as Error).message).toBe("boom");
  });
});
