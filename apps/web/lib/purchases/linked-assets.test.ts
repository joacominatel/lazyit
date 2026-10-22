import { describe, expect, test } from "bun:test";
import { assetListSearchParams } from "@/lib/api/endpoints/assets";
import { lineAssetsFilters, linkPickerFilters, nearOrderWindow, purchaseAssetFilter } from "./linked-assets";

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

describe("the link picker's near the order date chip (#1503)", () => {
  const CREATED = "2026-03-20T14:31:07.000Z";

  test("±90 days around the order date, whole UTC days, both ends inclusive", () => {
    expect(nearOrderWindow({ orderDate: "2026-03-03T00:00:00.000Z", invoiceDate: "2026-03-10T00:00:00.000Z", createdAt: CREATED })).toEqual({
      anchor: "2026-03-03",
      from: "2025-12-03T00:00:00.000Z",
      to: "2026-06-01T23:59:59.999Z",
    });
  });

  test("without an order date, the invoice date; without either, the day the purchase was recorded", () => {
    expect(nearOrderWindow({ orderDate: null, invoiceDate: "2026-03-10T00:00:00.000Z", createdAt: CREATED })?.anchor).toBe(
      "2026-03-10",
    );
    const recorded = nearOrderWindow({ orderDate: null, createdAt: CREATED });
    expect(recorded).toEqual({
      anchor: "2026-03-20",
      from: "2025-12-20T00:00:00.000Z",
      to: "2026-06-18T23:59:59.999Z",
    });
  });

  test("no usable date, no window", () => {
    expect(nearOrderWindow({ orderDate: null, invoiceDate: null, createdAt: null })).toBeNull();
    expect(nearOrderWindow({ orderDate: "not a date", createdAt: null })).toBeNull();
  });

  test("on, it is sent as acquiredFrom / acquiredTo; removed, nothing is sent", () => {
    const window = nearOrderWindow({ orderDate: "2026-03-03T00:00:00.000Z", createdAt: CREATED });
    const on = assetListSearchParams(linkPickerFilters({ q: "", modelId: null, notLinked: false, canReadPurchases: false, window }));
    expect(on.get("acquiredFrom")).toBe("2025-12-03T00:00:00.000Z");
    expect(on.get("acquiredTo")).toBe("2026-06-01T23:59:59.999Z");
    const off = assetListSearchParams(linkPickerFilters({ q: "", modelId: null, notLinked: false, canReadPurchases: false, window: null }));
    expect(off.has("acquiredFrom")).toBe(false);
    expect(off.has("acquiredTo")).toBe(false);
  });

  test("it needs no purchase permission: it filters on the asset's own dates", () => {
    const window = nearOrderWindow({ orderDate: "2026-03-03T00:00:00.000Z", createdAt: CREATED });
    const params = assetListSearchParams(linkPickerFilters({ q: "", modelId: null, notLinked: true, canReadPurchases: false, window }));
    expect(params.has("purchaseLinked")).toBe(false);
    expect(params.has("acquiredFrom")).toBe(true);
  });
});
