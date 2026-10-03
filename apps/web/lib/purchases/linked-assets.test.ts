import { describe, expect, test } from "bun:test";
import { assetListSearchParams } from "@/lib/api/endpoints/assets";
import { lineAssetsFilters, linkPickerFilters, purchaseAssetFilter } from "./linked-assets";

const LINE = "ck0000000000000000000line1";
const PURCHASE_PARAMS = ["purchaseOrderLineId", "purchaseOrderId", "purchaseLinked"];

/** The purchase params a set of filters would put on the wire. */
function purchaseParams(filters: Parameters<typeof assetListSearchParams>[0]): string[] {
  const params = assetListSearchParams(filters);
  return PURCHASE_PARAMS.filter((name) => params.has(name)).map((name) => `${name}=${params.get(name)}`);
}

describe("purchase filters on the asset list are sent only with purchaseOrder:read (#1476, D-A)", () => {
  test("without the permission, no purchase filter is ever built", () => {
    expect(purchaseAssetFilter(false, { purchaseOrderLineId: LINE, purchaseLinked: false })).toBeUndefined();
    expect(lineAssetsFilters(LINE, false)).toBeNull();
    expect(purchaseParams(linkPickerFilters({ q: "", modelId: null, notLinked: true, canReadPurchases: false }))).toEqual([]);
  });

  test("a line's assets are read by its line id, oldest first", () => {
    const filters = lineAssetsFilters(LINE, true);
    expect(filters).toEqual({
      purchase: { purchaseOrderLineId: LINE },
      sort: "createdAt",
      dir: "asc",
      limit: 50,
    });
    expect(purchaseParams(filters!)).toEqual([`purchaseOrderLineId=${LINE}`]);
  });

  test("the link picker asks for assets not linked to any purchase, and false is sent as false", () => {
    const filters = linkPickerFilters({ q: "dell", modelId: "ck0000000000000000000model", notLinked: true, canReadPurchases: true });
    expect(purchaseParams(filters)).toEqual(["purchaseLinked=false"]);
    const params = assetListSearchParams(filters);
    expect(params.get("q")).toBe("dell");
    expect(params.get("modelId")).toBe("ck0000000000000000000model");
  });

  test("removing the chip removes the filter", () => {
    expect(purchaseParams(linkPickerFilters({ q: "", modelId: null, notLinked: false, canReadPurchases: true }))).toEqual([]);
  });

  test("an empty purchase filter sends nothing", () => {
    expect(purchaseParams({ purchase: purchaseAssetFilter(true, {}) })).toEqual([]);
  });
});
