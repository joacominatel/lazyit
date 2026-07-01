import { describe, expect, test } from "bun:test";
import {
  type AssetInventoryCsvItem,
  ASSET_INVENTORY_CSV_HEADER,
  assetInventoryCsvRow,
  assetInventoryToCsv,
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
      "name,assetTag,serial,status,category,manufacturer,model,location,company,purchaseDate,warrantyEnd,owners,notes,createdAt,updatedAt",
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
