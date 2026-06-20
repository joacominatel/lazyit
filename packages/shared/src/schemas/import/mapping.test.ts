import { describe, expect, test } from "bun:test";
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
