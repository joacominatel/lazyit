import { describe, expect, test } from "bun:test";
import {
  ASSET_INVENTORY_CSV_HEADER,
  assetInventoryCsvHeader,
} from "./asset-inventory-csv";

describe("the asset-inventory CSV header (#872, the importer contract)", () => {
  test("is flat + static and carries no specs column", () => {
    expect(ASSET_INVENTORY_CSV_HEADER).toBe(
      "name,assetTag,serial,status,category,manufacturer,model,location,company,purchaseDate,warrantyEnd,owners,notes,createdAt,updatedAt,purchaseCost,purchaseCurrency",
    );
    expect(ASSET_INVENTORY_CSV_HEADER).not.toContain("specs");
  });

  test("without purchaseOrder:read the provenance columns are absent, not blank", () => {
    expect(assetInventoryCsvHeader()).toBe(ASSET_INVENTORY_CSV_HEADER);
    expect(assetInventoryCsvHeader()).not.toContain("supplier");
  });

  test("with purchaseOrder:read they are appended at the end: supplier, reference, invoice numbers", () => {
    expect(assetInventoryCsvHeader({ includePurchase: true })).toBe(
      `${ASSET_INVENTORY_CSV_HEADER},supplier,purchaseReference,invoiceNumbers`,
    );
  });
});
