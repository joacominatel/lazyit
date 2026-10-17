import { describe, expect, test } from "bun:test";
import {
  ArticleHitSchema,
  PurchaseHitSchema,
  SEARCH_ENTITIES,
  SearchEntitySchema,
  SearchResultsSchema,
  SupplierHitSchema,
} from "./search";

describe("search contract — purchases and suppliers (#1499)", () => {
  test("purchases and suppliers are searchable entities", () => {
    expect(SEARCH_ENTITIES).toContain("purchases");
    expect(SEARCH_ENTITIES).toContain("suppliers");
    expect(SearchEntitySchema.parse("purchases")).toBe("purchases");
  });

  test("a purchase hit carries display fields only, every optional one nullable", () => {
    const hit = PurchaseHitSchema.parse({
      id: "po1",
      reference: null,
      supplierName: null,
      invoiceNumbers: null,
      status: "ORDERED",
      orderDate: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      // Indexed for matching, never part of the hit contract.
      lineDescriptions: ["ThinkPad T14"],
      notes: "secret",
    });
    expect(Object.keys(hit).sort()).toEqual(
      ["createdAt", "id", "invoiceNumbers", "orderDate", "reference", "status", "supplierName"],
    );
  });

  test("a supplier hit is its name and tax ID — contact details are not in the contract", () => {
    const hit = SupplierHitSchema.parse({
      id: "s1",
      name: "Compumundo",
      taxId: null,
      salesContactEmail: "sales@example.com",
    });
    expect(hit).toEqual({ id: "s1", name: "Compumundo", taxId: null });
  });

  test("the envelope types purchases and suppliers blocks and keeps them optional", () => {
    const parsed = SearchResultsSchema.parse({
      purchases: {
        hits: [
          {
            id: "po1",
            reference: "OC-4512",
            supplierName: "Compumundo",
            invoiceNumbers: "A-0001",
            status: "ORDERED",
            orderDate: "2026-09-12T00:00:00.000Z",
            createdAt: "2026-09-12T10:00:00.000Z",
          },
        ],
        total: 1,
      },
      suppliers: { hits: [{ id: "s1", name: "Compumundo", taxId: "30-1" }], total: 1 },
    });
    expect(parsed.purchases?.total).toBe(1);
    expect(parsed.suppliers?.hits[0]?.name).toBe("Compumundo");
    // A caller without purchaseOrder:read gets neither key — still a valid envelope.
    expect(SearchResultsSchema.parse({ assets: { hits: [], total: 0 } }).purchases).toBeUndefined();
  });
});

describe("search contract — article hit folder and date (#1539)", () => {
  const base = {
    id: "a1",
    slug: "vpn",
    title: "VPN",
    excerpt: null,
    status: "PUBLISHED",
  };

  test("carries the home folder and the ISO updatedAt when the API sends them", () => {
    const hit = ArticleHitSchema.parse({
      ...base,
      categoryId: "folder1",
      updatedAt: "2026-10-01T12:00:00.000Z",
    });
    expect(hit.categoryId).toBe("folder1");
    expect(hit.updatedAt).toBe("2026-10-01T12:00:00.000Z");
  });

  test("both are nullish: an older API or a stale index document parses unchanged", () => {
    const hit = ArticleHitSchema.parse(base);
    expect(hit.categoryId).toBeUndefined();
    expect(hit.updatedAt).toBeUndefined();
    expect(
      ArticleHitSchema.safeParse({ ...base, categoryId: null, updatedAt: null })
        .success,
    ).toBe(true);
  });

  test("updatedAt must be an ISO datetime", () => {
    expect(
      ArticleHitSchema.safeParse({ ...base, updatedAt: "yesterday" }).success,
    ).toBe(false);
  });
});
