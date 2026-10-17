import { describe, expect, test } from "bun:test";
import { ApplicationCategorySchema } from "./application-category";
import { AssetCategorySchema } from "./asset-category";
import { AssetModelSchema } from "./asset-model";
import { AssetModelListPageSchema } from "./asset-model-list";
import { ConsumableCategorySchema } from "./consumable-category";

// #1540: the taxonomy list reads carry a COMPUTED `usageCount` (live rows filed under the taxonomy row).
// Only the list read populates it; single reads, writes and an older API omit it — so every schema must
// accept a row with it, without it, and with `null`, and still refuse a value that is not a count.

const ID = "clh1abc0000xyz0000000abcd";
const NOW = "2026-10-08T12:00:00.000Z";
const base = { id: ID, createdAt: NOW, updatedAt: NOW, deletedAt: null };

const rows = {
  AssetCategorySchema: {
    schema: AssetCategorySchema,
    row: { ...base, name: "Laptop", description: null, icon: null, specsSchema: null },
  },
  ApplicationCategorySchema: {
    schema: ApplicationCategorySchema,
    row: { ...base, name: "SaaS", description: null, icon: null, order: null },
  },
  ConsumableCategorySchema: {
    schema: ConsumableCategorySchema,
    row: { ...base, name: "Cables", description: null, icon: null, order: 1 },
  },
  AssetModelSchema: {
    schema: AssetModelSchema,
    row: {
      ...base,
      name: "Latitude 7440",
      manufacturer: "Dell",
      sku: null,
      description: null,
      specs: null,
      categoryId: null,
    },
  },
} as const;

for (const [name, { schema, row }] of Object.entries(rows)) {
  describe(`${name} — usageCount (#1540)`, () => {
    test("accepts a row without usageCount (single reads, writes, an older API)", () => {
      const parsed = schema.safeParse(row);
      expect(parsed.success).toBe(true);
      expect(parsed.data).not.toHaveProperty("usageCount");
    });

    test("accepts a row with a count, including zero", () => {
      for (const usageCount of [0, 1, 42]) {
        const parsed = schema.safeParse({ ...row, usageCount });
        expect(parsed.success).toBe(true);
        expect(parsed.data?.usageCount).toBe(usageCount);
      }
    });

    test("accepts null", () => {
      expect(schema.safeParse({ ...row, usageCount: null }).success).toBe(true);
    });

    test("rejects a negative, fractional or non-numeric count", () => {
      for (const usageCount of [-1, 1.5, "3"]) {
        expect(schema.safeParse({ ...row, usageCount }).success).toBe(false);
      }
    });
  });
}

describe("AssetModelListPageSchema — usageCount (#1540)", () => {
  test("accepts a page mixing rows with and without usageCount", () => {
    const parsed = AssetModelListPageSchema.safeParse({
      items: [
        { ...rows.AssetModelSchema.row, usageCount: 3 },
        { ...rows.AssetModelSchema.row, id: "clh1abc0000xyz0000000abce" },
      ],
      total: 2,
      limit: 50,
      offset: 0,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.items[0].usageCount).toBe(3);
    expect(parsed.data?.items[1].usageCount).toBeUndefined();
  });
});
