import { describe, expect, test } from "bun:test";
import {
  coerceAbsent,
  coerceBoolean,
  coerceDate,
  coerceEnum,
  coerceNumber,
  normalizeMatchKey,
} from "./coerce";
import { AssetStatusSchema } from "../asset";
import { assetImportDescriptor } from "./descriptor";

describe("normalizeMatchKey (ADR-0069 §5: trim-only)", () => {
  test("trims leading/trailing whitespace", () => {
    expect(normalizeMatchKey("  Dell Inc  ")).toBe("Dell Inc");
  });
  test("does NOT collapse internal whitespace (mirrors z.string().trim())", () => {
    expect(normalizeMatchKey("Dell  Inc")).toBe("Dell  Inc");
    expect(normalizeMatchKey("Dell  Inc")).not.toBe("Dell Inc");
  });
});

describe("coerceAbsent (''/whitespace/null-tokens are absent)", () => {
  test("blank/whitespace/null tokens → undefined", () => {
    for (const v of ["", "   ", "null", "N/A", "n/a", "-", "—", "none", "NIL", null, undefined]) {
      expect(coerceAbsent(v)).toBeUndefined();
    }
  });
  test("a real value is returned trimmed", () => {
    expect(coerceAbsent("  hello  ")).toBe("hello");
  });
});

describe("coerceNumber", () => {
  test("absent → undefined", () => {
    expect(coerceNumber("")).toBeUndefined();
    expect(coerceNumber(null)).toBeUndefined();
  });
  test("parses integers and decimals (incl. sign)", () => {
    expect(coerceNumber("42")).toBe(42);
    expect(coerceNumber(" -3.5 ")).toBe(-3.5);
    expect(coerceNumber(".5")).toBe(0.5);
  });
  test("present-but-unparseable → NaN (so the caller can surface an error)", () => {
    expect(Number.isNaN(coerceNumber("12abc") as number)).toBe(true);
    expect(Number.isNaN(coerceNumber("1,000") as number)).toBe(true);
  });
});

describe("coerceBoolean", () => {
  test("absent → undefined", () => {
    expect(coerceBoolean("")).toBeUndefined();
  });
  test("recognized truthy/falsy tokens (case-insensitive)", () => {
    for (const v of ["true", "Yes", "Y", "1", "ON"]) expect(coerceBoolean(v)).toBe(true);
    for (const v of ["false", "No", "n", "0", "off"]) expect(coerceBoolean(v)).toBe(false);
  });
  test("unrecognized token → undefined", () => {
    expect(coerceBoolean("maybe")).toBeUndefined();
  });
});

describe("coerceDate (re-emit via toISOString)", () => {
  test("absent → undefined", () => {
    expect(coerceDate("")).toBeUndefined();
  });
  test("bare date → full ISO instant (z.iso.datetime would reject the bare form)", () => {
    expect(coerceDate("2024-01-02")).toBe("2024-01-02T00:00:00.000Z");
  });
  test("an ISO instant round-trips", () => {
    expect(coerceDate("2024-01-02T03:04:05.000Z")).toBe("2024-01-02T03:04:05.000Z");
  });
  test("unparseable → undefined", () => {
    expect(coerceDate("not-a-date")).toBeUndefined();
  });
});

describe("coerceEnum (member + synonym map, case-insensitive)", () => {
  const members = AssetStatusSchema.options;
  const synonyms = assetImportDescriptor.enumValueMaps.status!.synonyms;

  test("absent → undefined", () => {
    expect(coerceEnum("", members, synonyms)).toBeUndefined();
  });
  test("exact member match is case-insensitive", () => {
    expect(coerceEnum("operational", members, synonyms)).toBe("OPERATIONAL");
    expect(coerceEnum("RETIRED", members, synonyms)).toBe("RETIRED");
  });
  test("synonym maps to the canonical member (active→OPERATIONAL, retired→RETIRED)", () => {
    expect(coerceEnum("active", members, synonyms)).toBe("OPERATIONAL");
    expect(coerceEnum("Decommissioned", members, synonyms)).toBe("RETIRED");
    expect(coerceEnum("stolen", members, synonyms)).toBe("LOST");
  });
  test("unknown value → undefined (caller surfaces the mismatch)", () => {
    expect(coerceEnum("banana", members, synonyms)).toBeUndefined();
  });
});

describe("assetImportDescriptor (compiles against the real CreateAssetSchema)", () => {
  test("natural key is serial", () => {
    expect(assetImportDescriptor.naturalKey).toBe("serial");
  });
  test("required fields are name + status", () => {
    const required = assetImportDescriptor.mappableFields.filter((f) => f.required).map((f) => f.field);
    expect(required.sort()).toEqual(["name", "status"]);
  });
  test("FK references resolve model (sku-else-name) and location (name)", () => {
    expect(assetImportDescriptor.references.modelId?.matchBy).toEqual(["sku", "name"]);
    expect(assetImportDescriptor.references.locationId?.matchBy).toEqual(["name"]);
  });
  test("status synonym map declares the full enum as its members", () => {
    expect(assetImportDescriptor.enumValueMaps.status?.members).toEqual(AssetStatusSchema.options);
  });
});
