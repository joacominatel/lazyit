import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { int4, INT4_MAX, INT4_MIN } from "./primitives";

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
