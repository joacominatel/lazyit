import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { INT4_MAX } from "./primitives";
import { CreateConsumableSchema } from "./consumable";
import { CreateConsumableCategorySchema } from "./consumable-category";
import { CreateApplicationCategorySchema } from "./application-category";
import { CreateArticleCategorySchema } from "./article-category";
import { CreateConsumableMovementSchema } from "./consumable-movement";

/**
 * Regression for the Swagger-UI MAX_SAFE_INTEGER overflow (issue #15). Every integer field below is
 * backed by a Postgres `Int` (int4) column; before the fix a bare `z.number().int()` allowed values
 * up to 2^53-1, so Swagger UI autofilled `9007199254740991` and the DB write crashed with P2020 →
 * 500. Each field must now reject out-of-int4 values (clean 400), accept the int4 max, and — where
 * optional — still parse when omitted. The generated OpenAPI must advertise `maximum: INT4_MAX`.
 */

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 9007199254740991 — the value Swagger was sending

// [name, schema, field, a valid base body, example used by the field]
const cases: Array<{
  name: string;
  schema: z.ZodType;
  field: string;
  base: Record<string, unknown>;
  example: number;
}> = [
  {
    name: "POST /consumables (minStock)",
    schema: CreateConsumableSchema,
    field: "minStock",
    base: { name: "Cat6 patch cable" },
    example: 5,
  },
  {
    name: "POST /consumable-categories (order)",
    schema: CreateConsumableCategorySchema,
    field: "order",
    base: { name: "Cables" },
    example: 0,
  },
  {
    name: "POST /application-categories (order)",
    schema: CreateApplicationCategorySchema,
    field: "order",
    base: { name: "SaaS" },
    example: 0,
  },
  {
    name: "POST /article-categories (order)",
    schema: CreateArticleCategorySchema,
    field: "order",
    base: { name: "Networking" },
    example: 0,
  },
  {
    name: "POST /consumables/:id/movements (quantity)",
    schema: CreateConsumableMovementSchema,
    field: "quantity",
    base: { type: "IN" },
    example: 1,
  },
];

describe.each(cases)("$name", ({ schema, field, base, example }) => {
  test(`rejects MAX_SAFE_INTEGER for "${field}" (400, not P2020/500)`, () => {
    expect(schema.safeParse({ ...base, [field]: MAX_SAFE }).success).toBe(false);
  });

  test(`accepts the int4 maximum for "${field}"`, () => {
    expect(schema.safeParse({ ...base, [field]: INT4_MAX }).success).toBe(true);
  });

  test(`accepts a sensible value for "${field}"`, () => {
    expect(schema.safeParse({ ...base, [field]: example }).success).toBe(true);
  });

  test(`OpenAPI advertises maximum=${INT4_MAX} and an example for "${field}"`, () => {
    const json = z.toJSONSchema(schema, { unrepresentable: "any" }) as {
      properties: Record<string, { maximum?: number; example?: number }>;
    };
    expect(json.properties[field]?.maximum).toBe(INT4_MAX);
    expect(json.properties[field]?.example).toBe(example);
  });
});

describe("optional int4 fields still parse when omitted", () => {
  test("CreateConsumable without minStock", () => {
    expect(CreateConsumableSchema.safeParse({ name: "Toner" }).success).toBe(true);
  });
  test("CreateConsumableCategory without order", () => {
    expect(CreateConsumableCategorySchema.safeParse({ name: "Cables" }).success).toBe(true);
  });
  test("CreateApplicationCategory without order", () => {
    expect(CreateApplicationCategorySchema.safeParse({ name: "SaaS" }).success).toBe(true);
  });
  test("CreateArticleCategory without order", () => {
    expect(CreateArticleCategorySchema.safeParse({ name: "Networking" }).success).toBe(true);
  });
});
