import { describe, expect, test } from "bun:test";
import { UpdateConsumableSchema } from "./consumable";

describe("UpdateConsumableSchema (AUD-084)", () => {
  test("null clears the optional fields and detaches the category", () => {
    const cleared = {
      sku: null,
      categoryId: null,
      description: null,
      minStock: null,
      notes: null,
    };
    expect(UpdateConsumableSchema.parse(cleared)).toEqual(cleared);
  });

  test("required columns stay non-nullable", () => {
    expect(UpdateConsumableSchema.safeParse({ name: null }).success).toBe(false);
    expect(UpdateConsumableSchema.safeParse({ unit: null }).success).toBe(false);
    expect(UpdateConsumableSchema.safeParse({ returnable: null }).success).toBe(false);
  });

  test("a value still has to be valid when set", () => {
    expect(UpdateConsumableSchema.safeParse({ minStock: -1 }).success).toBe(false);
    expect(UpdateConsumableSchema.safeParse({ sku: "" }).success).toBe(false);
  });
});
