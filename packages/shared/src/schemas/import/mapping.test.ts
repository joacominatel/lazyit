import { describe, expect, test } from "bun:test";
import { ASSET_SPECS_MAX_STRING_LENGTH, CreateAssetSchema } from "../asset";
import { coerceRow } from "./coerce-row";
import { assetImportDescriptor } from "./descriptor";
import { ImportMappingSchema } from "./mapping";

/**
 * The `ImportMappingSchema` superRefine is the contract gate for the migrator mapping blob (ADR-0069
 * REDESIGN §5.1 / §7). These tests assert the anti mass-assignment + anti prototype-pollution +
 * duplicate-target rules: a reserved key can NEVER be a mapping target (`columns[].field` /
 * `references[].field` / `custom[].key`), and no two columns/references/custom keys may collide
 * (last-write-wins in `coerceRow` would silently drop one's data).
 */

const base = {
  columns: [
    { field: "name", column: "Name" },
    { field: "status", constant: "active" },
  ],
};

describe("ImportMappingSchema — duplicate mapping targets (MUST-FIX 1)", () => {
  test("rejects two columns mapping to the same field", () => {
    const r = ImportMappingSchema.safeParse({
      columns: [
        { field: "name", column: "Name" },
        { field: "name", column: "FullName" },
        { field: "status", constant: "active" },
      ],
    });
    expect(r.success).toBe(false);
    expect(r.success === false && r.error.issues.some((i) => /duplicate column/.test(i.message))).toBe(
      true,
    );
  });

  test("rejects two references mapping to the same field", () => {
    const r = ImportMappingSchema.safeParse({
      ...base,
      references: [
        { field: "modelId", column: "Model" },
        { field: "modelId", column: "Model2" },
      ],
    });
    expect(r.success).toBe(false);
    expect(
      r.success === false && r.error.issues.some((i) => /duplicate reference/.test(i.message)),
    ).toBe(true);
  });

  test("accepts a mapping with all-distinct targets", () => {
    const r = ImportMappingSchema.safeParse({
      columns: [
        { field: "name", column: "Name" },
        { field: "serial", column: "Serial" },
        { field: "status", constant: "active" },
      ],
      references: [{ field: "modelId", column: "Model" }],
    });
    expect(r.success).toBe(true);
  });
});

describe("ImportMappingSchema — reserved mapping targets (MUST-FIX 2)", () => {
  test.each(["__proto__", "constructor", "prototype", "id", "deletedAt", "createdAt", "updatedAt"])(
    "rejects a column field of reserved key %p",
    (key) => {
      const r = ImportMappingSchema.safeParse({
        columns: [...base.columns, { field: key, column: "X" }],
      });
      expect(r.success).toBe(false);
      expect(
        r.success === false && r.error.issues.some((i) => /reserved field/.test(i.message)),
      ).toBe(true);
    },
  );

  test("rejects a reference field of a reserved key", () => {
    const r = ImportMappingSchema.safeParse({
      ...base,
      references: [{ field: "__proto__", column: "X" }],
    });
    expect(r.success).toBe(false);
    expect(r.success === false && r.error.issues.some((i) => /reserved field/.test(i.message))).toBe(
      true,
    );
  });

  test("still rejects a reserved custom key (unchanged)", () => {
    const r = ImportMappingSchema.safeParse({
      ...base,
      custom: [{ column: "X", key: "id" }],
    });
    expect(r.success).toBe(false);
  });

  test("ACCEPTS native create fields as targets (no over-rejection regression)", () => {
    // `specs` is a CreateAsset key, so it is NOT a reserved target (the over-rejection bug would
    // have killed `name`/`serial`/`status`/`modelId` too — guard against it).
    const r = ImportMappingSchema.safeParse({
      columns: [
        { field: "name", column: "N" },
        { field: "serial", column: "S" },
        { field: "status", constant: "active" },
      ],
      references: [
        { field: "modelId", column: "M" },
        { field: "locationId", column: "L" },
      ],
    });
    expect(r.success).toBe(true);
  });
});

describe("ImportMappingSchema — person mapping targets (E2-AUTH-01)", () => {
  test.each(["role", "__proto__", "constructor", "prototype", "id", "deletedAt"])(
    "rejects a person field that is not on the allowlist: %p",
    (key) => {
      const r = ImportMappingSchema.safeParse({
        ...base,
        person: { fields: [{ field: key, column: "X" }] },
      });
      expect(r.success).toBe(false);
      expect(
        r.success === false &&
          r.error.issues.some((i) => /not an allowed person mapping target/.test(i.message)),
      ).toBe(true);
    },
  );

  test.each(["name", "email", "legajo", "username", "jobTitle", "department", "supervisor"])(
    "ACCEPTS an allowlisted person target: %p",
    (key) => {
      const r = ImportMappingSchema.safeParse({
        ...base,
        person: { fields: [{ field: key, column: "X" }] },
      });
      expect(r.success).toBe(true);
    },
  );
});

/**
 * Custom (specs) fields vs the global specs write bound (SEC-072). A custom cell always lands in specs
 * as a STRING (never parsed as JSON), so the mapping cannot deepen specs; what it can do is carry a
 * long cell or many keys. Both the dry-run and the commit re-validate each coerced row with
 * `CreateAssetSchema`, so the global bound applies to imported rows with no mapping-specific cap.
 */
describe("ImportMappingSchema — custom fields under the global specs bound (SEC-072)", () => {
  const desc = assetImportDescriptor as Parameters<typeof coerceRow>[2];
  const rowPayload = (cell: string, customCount = 1) => {
    const m = ImportMappingSchema.parse({
      ...base,
      custom: Array.from({ length: customCount }, (_, i) => ({ column: `C${i}`, key: `k${i}` })),
    });
    const raw: Record<string, string> = { Name: "PC" };
    for (let i = 0; i < customCount; i++) raw[`C${i}`] = cell;
    const { payload, specs } = coerceRow(raw, m, desc);
    return { ...payload, status: "OPERATIONAL", specs };
  };

  test("a custom cell past the string bound fails the per-row create validation on specs", () => {
    const r = CreateAssetSchema.safeParse(rowPayload("x".repeat(ASSET_SPECS_MAX_STRING_LENGTH + 1)));
    expect(r.success).toBe(false);
    expect(r.success === false && r.error.issues[0]?.path[0]).toBe("specs");
  });

  test("a cell that looks like nested JSON stays a string, and the maximum custom-field count fits", () => {
    const deepJson = `${'{"a":'.repeat(500)}1${"}".repeat(500)}`;
    const payload = rowPayload(deepJson, 64);
    expect(typeof (payload.specs as Record<string, unknown>).k0).toBe("string");
    expect(CreateAssetSchema.safeParse(payload).success).toBe(true);
  });
});

