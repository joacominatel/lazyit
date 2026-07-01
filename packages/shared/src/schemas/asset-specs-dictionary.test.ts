import { describe, expect, test } from "bun:test";
import {
  AssetSpecsDictionarySchema,
  SpecFieldSchema,
  type AssetSpecsDictionary,
  validateSpecsAgainstDictionary,
} from "./asset-specs-dictionary";

/**
 * Asset specs dictionary contract (ADR-0007 amendment, #851). The decisive posture the ADR sets —
 * ADVISORY-first, never hard-blocking — is what these tests pin down: the dictionary shape is a small
 * declarative list (unique keys, enum fields need values), and `validateSpecsAgainstDictionary`
 * returns soft WARNINGS (never throws) with the documented rules. The number/boolean checks are
 * deliberately LENIENT because the web editor stores every value as a string.
 */

describe("SpecFieldSchema / AssetSpecsDictionarySchema", () => {
  test("accepts a typical heterogeneous dictionary", () => {
    const dict = [
      { key: "cpu", label: "CPU", type: "string" },
      { key: "ramGb", label: "RAM (GB)", type: "number", required: true },
      { key: "managed", label: "Managed", type: "boolean" },
      { key: "formFactor", label: "Form factor", type: "enum", enumValues: ["1U", "2U"] },
    ];
    expect(AssetSpecsDictionarySchema.parse(dict)).toHaveLength(4);
  });

  test("an enum field must declare at least one value", () => {
    expect(SpecFieldSchema.safeParse({ key: "x", label: "X", type: "enum" }).success).toBe(false);
    expect(
      SpecFieldSchema.safeParse({ key: "x", label: "X", type: "enum", enumValues: [] }).success,
    ).toBe(false);
    expect(
      SpecFieldSchema.safeParse({ key: "x", label: "X", type: "enum", enumValues: ["a"] }).success,
    ).toBe(true);
  });

  test("rejects unknown properties (strict) and duplicate keys", () => {
    expect(
      SpecFieldSchema.safeParse({ key: "x", label: "X", type: "string", extra: 1 }).success,
    ).toBe(false);
    const dup = [
      { key: "cpu", label: "CPU", type: "string" },
      { key: "cpu", label: "CPU again", type: "string" },
    ];
    expect(AssetSpecsDictionarySchema.safeParse(dup).success).toBe(false);
  });
});

describe("validateSpecsAgainstDictionary (advisory warnings)", () => {
  const dict: AssetSpecsDictionary = [
    { key: "cpu", label: "CPU", type: "string", required: true },
    { key: "ramGb", label: "RAM (GB)", type: "number" },
    { key: "managed", label: "Managed", type: "boolean" },
    { key: "formFactor", label: "Form factor", type: "enum", enumValues: ["1U", "2U"] },
  ];

  test("no dictionary (or empty) → no warnings (ADR-0007 default)", () => {
    expect(validateSpecsAgainstDictionary({ anything: "goes" }, null)).toEqual([]);
    expect(validateSpecsAgainstDictionary({ anything: "goes" }, [])).toEqual([]);
  });

  test("a conforming spec (string-valued, as the editor stores it) yields no warnings", () => {
    const warnings = validateSpecsAgainstDictionary(
      { cpu: "Xeon", ramGb: "64", managed: "true", formFactor: "2U" },
      dict,
    );
    expect(warnings).toEqual([]);
  });

  test("missing required, wrong type, not-in-enum, and unknown keys all warn (never throw)", () => {
    const warnings = validateSpecsAgainstDictionary(
      { ramGb: "lots", formFactor: "10U", rogue: "x" },
      dict,
    );
    expect(warnings).toContainEqual({ key: "cpu", code: "missingRequired" });
    expect(warnings).toContainEqual({ key: "ramGb", code: "wrongType" });
    expect(warnings).toContainEqual({ key: "formFactor", code: "notInEnum" });
    expect(warnings).toContainEqual({ key: "rogue", code: "unknownKey" });
  });

  test("an unfilled OPTIONAL field is silent; a blank required field still warns", () => {
    expect(validateSpecsAgainstDictionary({ cpu: "Xeon" }, dict)).toEqual([]);
    expect(validateSpecsAgainstDictionary({ cpu: "   " }, dict)).toContainEqual({
      key: "cpu",
      code: "missingRequired",
    });
  });
});
