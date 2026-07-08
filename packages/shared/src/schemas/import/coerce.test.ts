import { describe, expect, test } from "bun:test";
import {
  coerceAbsent,
  coerceBoolean,
  coerceDate,
  coerceEnum,
  coerceInteger,
  coerceMoneyMinorUnits,
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

describe("coerceMoneyMinorUnits (#1051 — major units → integer cents, locale-tolerant)", () => {
  test("absent → undefined (not 0)", () => {
    expect(coerceMoneyMinorUnits("")).toBeUndefined();
    expect(coerceMoneyMinorUnits(null)).toBeUndefined();
    expect(coerceMoneyMinorUnits("n/a")).toBeUndefined();
  });
  test("plain decimal → ×100 rounded to cents", () => {
    expect(coerceMoneyMinorUnits("0.00")).toBe(0);
    expect(coerceMoneyMinorUnits("1234.56")).toBe(123456);
    expect(coerceMoneyMinorUnits("10")).toBe(1000);
    expect(coerceMoneyMinorUnits("12.5")).toBe(1250);
    expect(coerceMoneyMinorUnits("0.1")).toBe(10);
  });
  test("currency symbol + US thousands separator", () => {
    expect(coerceMoneyMinorUnits("$1,000.00")).toBe(100000);
    expect(coerceMoneyMinorUnits("$1,234.56")).toBe(123456);
    expect(coerceMoneyMinorUnits("USD 2 500.75")).toBe(250075);
  });
  test("LATAM format (dot thousands, comma decimal)", () => {
    expect(coerceMoneyMinorUnits("1.234,56")).toBe(123456);
    expect(coerceMoneyMinorUnits("1.000,00")).toBe(100000);
    expect(coerceMoneyMinorUnits("$ 2.500,75")).toBe(250075);
  });
  test("a lone thousands-grouped value with no decimal (US or LATAM) → whole units", () => {
    expect(coerceMoneyMinorUnits("1,234")).toBe(123400);
    expect(coerceMoneyMinorUnits("1.234")).toBe(123400);
  });
  test("negatives: leading sign and accounting parentheses both negate", () => {
    expect(coerceMoneyMinorUnits("-500")).toBe(-50000);
    expect(coerceMoneyMinorUnits("(500)")).toBe(-50000);
    expect(coerceMoneyMinorUnits("($1,000.00)")).toBe(-100000);
  });
  test("present-but-unparseable → NaN (caller surfaces a field error)", () => {
    expect(Number.isNaN(coerceMoneyMinorUnits("abc") as number)).toBe(true);
    expect(Number.isNaN(coerceMoneyMinorUnits("$$$") as number)).toBe(true);
  });
});

describe("coerceInteger (#1051 — depreciation months, no ×100)", () => {
  test("absent → undefined", () => {
    expect(coerceInteger("")).toBeUndefined();
  });
  test("plain and grouped integers stay in major units", () => {
    expect(coerceInteger("36")).toBe(36);
    expect(coerceInteger("1,200")).toBe(1200);
    expect(coerceInteger("1.200")).toBe(1200);
  });
  test("a fractional input is returned as-is so the int4 schema rejects it", () => {
    expect(coerceInteger("12.5")).toBe(12.5);
  });
  test("unparseable → NaN", () => {
    expect(Number.isNaN(coerceInteger("many") as number)).toBe(true);
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

  // #1049 — Snipe-IT status labels must not drop the row.
  test("Snipe-IT meta labels map to the right member", () => {
    expect(coerceEnum("Deployed", members, synonyms)).toBe("OPERATIONAL");
    expect(coerceEnum("Ready to Deploy", members, synonyms)).toBe("IN_STORAGE");
    expect(coerceEnum("Archived", members, synonyms)).toBe("RETIRED");
    expect(coerceEnum("Broken", members, synonyms)).toBe("IN_MAINTENANCE");
    expect(coerceEnum("Pending", members, synonyms)).toBe("IN_MAINTENANCE");
  });
  test('custom "<Label> (<meta>)" export resolves via the parenthetical meta', () => {
    expect(coerceEnum("Nueva (deployed)", members, synonyms)).toBe("OPERATIONAL");
    expect(coerceEnum("Retirada (archived)", members, synonyms)).toBe("RETIRED");
  });
  test("a bare custom label with no synonym still misses (surfaced, not silently mapped)", () => {
    expect(coerceEnum("Nueva (frobnicated)", members, synonyms)).toBeUndefined();
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
