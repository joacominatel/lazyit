import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  int4,
  INT4_MAX,
  INT4_MIN,
  optionalText,
  requireAtLeastOneKey,
} from "./primitives";

describe("int4()", () => {
  test("accepts the int4 boundary values", () => {
    expect(int4().safeParse(INT4_MAX).success).toBe(true);
    expect(int4().safeParse(INT4_MIN).success).toBe(true);
    expect(int4().safeParse(0).success).toBe(true);
  });

  test("rejects values beyond the int4 range (the P2020 trigger)", () => {
    // Number.MAX_SAFE_INTEGER is what Swagger UI was autofilling and what overflowed the column.
    expect(int4().safeParse(Number.MAX_SAFE_INTEGER).success).toBe(false);
    expect(int4().safeParse(INT4_MAX + 1).success).toBe(false);
    expect(int4().safeParse(INT4_MIN - 1).success).toBe(false);
  });

  test("rejects non-integers", () => {
    expect(int4().safeParse(1.5).success).toBe(false);
  });

  test("narrows the range with min/max but never widens past int4", () => {
    expect(int4({ min: 0 }).safeParse(-1).success).toBe(false);
    expect(int4({ min: 0 }).safeParse(0).success).toBe(true);
    expect(int4({ max: 10 }).safeParse(11).success).toBe(false);
    // A caller asking for more than int4 is still clamped to int4.
    expect(int4({ max: Number.MAX_SAFE_INTEGER }).safeParse(INT4_MAX + 1).success).toBe(false);
    expect(int4({ min: Number.MIN_SAFE_INTEGER }).safeParse(INT4_MIN - 1).success).toBe(false);
  });

  test("emits int4 bounds (not safe-integer bounds) in the generated JSON Schema", () => {
    const json = z.toJSONSchema(z.object({ n: int4() }), {
      unrepresentable: "any",
    }) as { properties: { n: { maximum: number; minimum: number } } };
    expect(json.properties.n.maximum).toBe(INT4_MAX);
    expect(json.properties.n.minimum).toBe(INT4_MIN);
  });

  test("carries the example into the JSON Schema (overrides Swagger autofill)", () => {
    const json = z.toJSONSchema(z.object({ n: int4({ example: 5 }) }), {
      unrepresentable: "any",
    }) as { properties: { n: { example?: number } } };
    expect(json.properties.n.example).toBe(5);
  });
});

describe("optionalText() — empty optional free text is omitted, not rejected", () => {
  const schema = optionalText(10);

  test('coerces an empty string to undefined (the issue #165 bug)', () => {
    const result = schema.safeParse("");
    expect(result.success).toBe(true);
    expect(result.data).toBeUndefined();
  });

  test("coerces a whitespace-only string to undefined", () => {
    const result = schema.safeParse("   ");
    expect(result.success).toBe(true);
    expect(result.data).toBeUndefined();
  });

  test("still parses (and trims) a real value", () => {
    const result = schema.safeParse("  x  ");
    expect(result.success).toBe(true);
    expect(result.data).toBe("x");
  });

  test("accepts an omitted (undefined) value", () => {
    const result = z.object({ notes: schema }).safeParse({});
    expect(result.success).toBe(true);
    expect(result.data?.notes).toBeUndefined();
  });

  test("still enforces the max length on a real value", () => {
    expect(schema.safeParse("12345678901").success).toBe(false); // 11 > max 10
    expect(schema.safeParse("1234567890").success).toBe(true); // exactly 10
  });
});

describe("requireAtLeastOneKey() — reject empty PATCH bodies", () => {
  const Update = requireAtLeastOneKey(
    z.strictObject({ name: z.string(), notes: z.string().nullable() }).partial(),
  );

  test("rejects an empty body", () => {
    expect(Update.safeParse({}).success).toBe(false);
  });

  test("accepts a body with at least one field", () => {
    expect(Update.safeParse({ name: "x" }).success).toBe(true);
  });

  test("counts a field explicitly set to null as a change (clearing a field)", () => {
    expect(Update.safeParse({ notes: null }).success).toBe(true);
  });

  test("still enforces the wrapped shape (a bad value fails)", () => {
    expect(Update.safeParse({ name: 123 }).success).toBe(false);
  });
});
