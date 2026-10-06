import { describe, expect, test } from "bun:test";
import {
  type AssetInventoryCsvItem,
  ASSET_INVENTORY_CSV_HEADER,
  assetInventoryCsvHeader,
  assetInventoryCsvRow,
  assetInventoryToCsv,
  moneyToCsvAmount,
} from "./asset-inventory-csv";

/**
 * Unit spec for the asset-inventory CSV util (issue #872). Focuses on the output-boundary security
 * guard reused from `recent-activity-csv.ts` (RFC-4180 + spreadsheet formula-injection), the flat
 * static column shape (no `specs` jsonb), and the `owners` join that excludes soft-deleted owners.
 */

function owner(overrides: {
  firstName?: string;
  lastName?: string;
  deletedAt?: string | null;
}): AssetInventoryCsvItem["activeAssignments"][number] {
  return {
    id: "as1",
    userId: "11111111-1111-4111-8111-111111111111",
    user: {
      id: "11111111-1111-4111-8111-111111111111",
      firstName: overrides.firstName ?? "Ada",
      lastName: overrides.lastName ?? "Lovelace",
      email: "ada@example.com",
      deletedAt: overrides.deletedAt ?? null,
    },
  };
}

function item(overrides: Partial<AssetInventoryCsvItem> = {}): AssetInventoryCsvItem {
  return {
    name: "SRV-01",
    assetTag: "LZ-0001",
    serial: "SN123",
    status: "OPERATIONAL",
    company: null,
    purchaseDate: null,
    warrantyEnd: null,
    notes: null,
    createdAt: "2026-06-30T12:00:00.000Z",
    updatedAt: "2026-06-30T12:00:00.000Z",
    model: {
      id: "m1",
      name: "PowerEdge R760",
      manufacturer: "Dell",
      category: { id: "c1", name: "Server" },
    },
    location: { id: "l1", name: "Colo A", type: "DATACENTER" },
    activeAssignments: [],
    ...overrides,
  };
}

describe("assetInventoryCsvRow — output-boundary guards", () => {
  test("defuses a spreadsheet formula-injection in a free-text field", () => {
    const line = assetInventoryCsvRow(item({ company: "=cmd|/c calc" }));
    // Leading '=' neutralized with a single quote.
    expect(line).toContain("'=cmd|/c calc");
  });

  test("RFC-4180 quote-wraps a cell with comma/quote/newline", () => {
    const line = assetInventoryCsvRow(item({ notes: 'a,b "q"\nz' }));
    expect(line).toContain('"a,b ""q""\nz"');
  });

  test("null optional fields serialize to empty cells (no crash)", () => {
    const line = assetInventoryCsvRow(
      item({
        assetTag: null,
        serial: null,
        company: null,
        notes: null,
        purchaseDate: null,
        warrantyEnd: null,
        model: null,
        location: null,
      }),
    );
    // No cell here contains a comma, so a naive split is a safe, non-fragile assertion of the shape.
    expect(line.split(",")).toEqual([
      "SRV-01",
      "",
      "",
      "OPERATIONAL",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "2026-06-30T12:00:00.000Z",
      "2026-06-30T12:00:00.000Z",
      "",
      "",
    ]);
  });

  test("category/manufacturer/model come from the joined model", () => {
    const line = assetInventoryCsvRow(item());
    expect(line).toContain("OPERATIONAL,Server,Dell,PowerEdge R760,Colo A");
  });
});

describe("assetInventoryCsvRow — owners join", () => {
  test("joins live owners 'First Last' with '; '", () => {
    const line = assetInventoryCsvRow(
      item({
        activeAssignments: [
          owner({ firstName: "Ada", lastName: "Lovelace" }),
          owner({ firstName: "Grace", lastName: "Hopper" }),
        ],
      }),
    );
    expect(line).toContain("Ada Lovelace; Grace Hopper");
  });

  test("excludes a soft-deleted (departed) owner", () => {
    const line = assetInventoryCsvRow(
      item({
        activeAssignments: [
          owner({ firstName: "Ada", lastName: "Lovelace" }),
          owner({
            firstName: "Gone",
            lastName: "User",
            deletedAt: "2026-01-01T00:00:00.000Z",
          }),
        ],
      }),
    );
    expect(line).toContain("Ada Lovelace");
    expect(line).not.toContain("Gone User");
  });
});

describe("assetInventoryToCsv — document shape (no specs column)", () => {
  test("header is flat + static and carries no specs column", () => {
    expect(ASSET_INVENTORY_CSV_HEADER).toBe(
      "name,assetTag,serial,status,category,manufacturer,model,location,company,purchaseDate,warrantyEnd,owners,notes,createdAt,updatedAt,purchaseCost,purchaseCurrency",
    );
    expect(ASSET_INVENTORY_CSV_HEADER).not.toContain("specs");
  });

  test("emits a header line + one line per row", () => {
    const doc = assetInventoryToCsv([item(), item({ name: "SW-CORE-01" })]);
    const lines = doc.split("\n");
    expect(lines[0]).toBe(ASSET_INVENTORY_CSV_HEADER);
    expect(lines).toHaveLength(3);
  });
});

describe("purchase columns (ADR-0099, #1473)", () => {
  const linked = item({
    purchaseCost: 141250000,
    purchaseCurrency: "ARS",
    purchase: { supplierName: "Compumundo", reference: "OC-4512", invoiceNumbers: "A-0003-12345" },
  });

  test("cost and currency are always exported, as the asset's own fields", () => {
    expect(assetInventoryCsvRow(linked).split(",").slice(-2)).toEqual(["1412500", "ARS"]);
  });

  test("without purchaseOrder:read the provenance columns are ABSENT, not blank — header and rows alike", () => {
    expect(assetInventoryCsvHeader()).toBe(ASSET_INVENTORY_CSV_HEADER);
    expect(assetInventoryCsvHeader()).not.toContain("supplier");
    const row = assetInventoryCsvRow(linked);
    expect(row).not.toContain("Compumundo");
    expect(row).not.toContain("OC-4512");
    expect(row.split(",")).toHaveLength(ASSET_INVENTORY_CSV_HEADER.split(",").length);
  });

  test("with purchaseOrder:read they are appended at the end: supplier, reference, invoice numbers", () => {
    const header = assetInventoryCsvHeader({ includePurchase: true });
    expect(header).toBe(`${ASSET_INVENTORY_CSV_HEADER},supplier,purchaseReference,invoiceNumbers`);
    const row = assetInventoryCsvRow(linked, { includePurchase: true });
    expect(row.split(",").slice(-3)).toEqual(["Compumundo", "OC-4512", "A-0003-12345"]);
    expect(row.split(",")).toHaveLength(header.split(",").length);
  });

  test("an unlinked asset (or an item built before #1473) reads as empty cells, never a crash", () => {
    const row = assetInventoryCsvRow(item(), { includePurchase: true });
    expect(row.split(",").slice(-5)).toEqual(["", "", "", "", ""]);
  });

  test("the provenance cells get the same formula-injection guard", () => {
    const row = assetInventoryCsvRow(
      item({ purchase: { supplierName: "=HYPERLINK(1)", reference: null, invoiceNumbers: null } }),
      { includePurchase: true },
    );
    expect(row).toContain("'=HYPERLINK(1)");
  });

  test("the document honours the option end to end", () => {
    const doc = assetInventoryToCsv([linked], { includePurchase: true }).split("\n");
    expect(doc[0]).toBe(assetInventoryCsvHeader({ includePurchase: true }));
    expect(doc[1]).toContain("Compumundo");
  });
});

describe("moneyToCsvAmount", () => {
  test("major units, dot separator, no grouping; whole amounts are not padded", () => {
    expect(moneyToCsvAmount(150000)).toBe("1500");
    expect(moneyToCsvAmount(150050)).toBe("1500.50");
    expect(moneyToCsvAmount(5)).toBe("0.05");
    expect(moneyToCsvAmount(0)).toBe("0");
    expect(moneyToCsvAmount(9_007_199_254_740_991)).toBe("90071992547409.91");
  });

  test("unknown is an empty cell", () => {
    expect(moneyToCsvAmount(null)).toBe("");
    expect(moneyToCsvAmount(undefined)).toBe("");
  });
});
