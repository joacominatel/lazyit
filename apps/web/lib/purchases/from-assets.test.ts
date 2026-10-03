import { describe, expect, test } from "bun:test";
import { CreatePurchaseFromAssetsSchema } from "@lazyit/shared";
import { ApiError } from "@/lib/api/client";
import { buildFromAssetsPayload, fromAssetsOutcome, isNothingLinkable } from "./from-assets";

const A = "ckasset00000000000000000a";
const B = "ckasset00000000000000000b";
const SUPPLIER = "cksupplier000000000000000";

describe("buildFromAssetsPayload", () => {
  test("the selection alone is a whole request: the API groups, prices and links", () => {
    const result = buildFromAssetsPayload([A, B], null, { reference: "", currency: "" });
    expect(result).toEqual({ ok: true, payload: { assetIds: [A, B] } });
    if (result.ok) expect(CreatePurchaseFromAssetsSchema.safeParse(result.payload).success).toBe(true);
  });

  test("the supplier, reference and currency are sent trimmed when filled", () => {
    expect(buildFromAssetsPayload([A], SUPPLIER, { reference: " OC 7 ", currency: " USD " })).toEqual({
      ok: true,
      payload: { assetIds: [A], supplierId: SUPPLIER, reference: "OC 7", currency: "USD" },
    });
  });

  test("a blank currency is left out, so the API takes the label the priced assets share", () => {
    const result = buildFromAssetsPayload([A], SUPPLIER, { reference: "OC 7", currency: "   " });
    expect(result.ok && "currency" in result.payload).toBe(false);
  });

  test("an empty selection is refused before the request", () => {
    expect(buildFromAssetsPayload([], null, { reference: "", currency: "" })).toEqual({ ok: false });
  });
});

describe("fromAssetsOutcome", () => {
  const names = new Map([[B, { name: "NB-02", assetTag: "IT-0002" }]]);

  test("everything linked goes straight to the purchase", () => {
    expect(fromAssetsOutcome({ linkedAssetIds: [A, B], failed: [] }, names)).toEqual({ kind: "done", linked: 2 });
  });

  test("assets left out are named with their reason", () => {
    expect(
      fromAssetsOutcome(
        { linkedAssetIds: [A], failed: [{ assetId: B, reason: "LINKED_ELSEWHERE", error: "Already on a line" }] },
        names,
      ),
    ).toEqual({
      kind: "partial",
      linked: 1,
      failures: [{ assetId: B, label: "IT-0002 · NB-02", reasonKey: "linkedElsewhere", error: "Already on a line" }],
    });
  });

  test("a 409 is the nothing-linkable refusal; other errors are not", () => {
    expect(isNothingLinkable(new ApiError(409, "None of the assets can be linked"))).toBe(true);
    expect(isNothingLinkable(new ApiError(400, "Bad"))).toBe(false);
    expect(isNothingLinkable(new Error("network"))).toBe(false);
  });
});
