import { describe, expect, test } from "bun:test";
import { coerceRow } from "./coerce-row";
import { assetImportDescriptor } from "./descriptor";
import { ImportMappingSchema, type ImportMapping } from "./mapping";

/**
 * coercion-under-mapping (ADR-0069 §3/§4/§5, #631): the bridge from a raw source row + a confirmed
 * mapping to a coerced create payload + the raw FK natural keys. Pure — no DB, no zod beyond parsing the
 * mapping fixture into its defaulted wire shape.
 */

/** Parse a partial mapping through the schema so `.default([])` on enums/references fires. */
function mapping(input: unknown): ImportMapping {
  return ImportMappingSchema.parse(input);
}

const desc = assetImportDescriptor as Parameters<typeof coerceRow>[2];

describe("coerceRow — column→field + omit-empty", () => {
  test("maps columns to fields, trims, and OMITS empty cells so defaults fire", () => {
    const m = mapping({
      columns: [
        { field: "name", column: "Name" },
        { field: "serial", column: "Serial" },
        { field: "assetTag", column: "Tag" },
      ],
    });
    const { payload, references, enumMisses } = coerceRow(
      { Name: "  Laptop 1 ", Serial: "ABC123", Tag: "" },
      m,
      desc,
    );
    expect(payload).toEqual({ name: "Laptop 1", serial: "ABC123" });
    // empty assetTag cell is omitted entirely (not "" — so the schema optional fires)
    expect("assetTag" in payload).toBe(false);
    expect(references).toEqual({});
    expect(enumMisses).toEqual([]);
  });

  test("a pinned constant overrides the column and applies to every row", () => {
    const m = mapping({
      columns: [
        { field: "name", column: "Name" },
        { field: "status", constant: "active" },
      ],
    });
    const { payload } = coerceRow({ Name: "Server" }, m, desc);
    expect(payload).toEqual({ name: "Server", status: "OPERATIONAL" });
  });

  test("null-token cells (n/a, -, none) are treated as absent", () => {
    const m = mapping({ columns: [{ field: "name", column: "N" }, { field: "serial", column: "S" }] });
    const { payload } = coerceRow({ N: "X", S: "N/A" }, m, desc);
    expect(payload).toEqual({ name: "X" });
  });
});

describe("coerceRow — status value-map", () => {
  test("descriptor synonyms map source values to enum members (case-insensitive)", () => {
    const m = mapping({ columns: [{ field: "status", column: "State" }] });
    expect(coerceRow({ State: "Retired" }, m, desc).payload).toEqual({ status: "RETIRED" });
    expect(coerceRow({ State: "in use" }, m, desc).payload).toEqual({ status: "OPERATIONAL" });
  });

  test("an operator value-map extends the descriptor synonyms", () => {
    const m = mapping({
      columns: [{ field: "status", column: "State" }],
      enums: [{ field: "status", values: [{ from: "WIP", to: "IN_MAINTENANCE" }] }],
    });
    expect(coerceRow({ State: "WIP" }, m, desc).payload).toEqual({ status: "IN_MAINTENANCE" });
  });

  test("an unmappable enum value is a miss (NOT silently dropped to a default)", () => {
    const m = mapping({ columns: [{ field: "status", column: "State" }] });
    const { payload, enumMisses } = coerceRow({ State: "frobnicated" }, m, desc);
    expect("status" in payload).toBe(false);
    expect(enumMisses).toEqual([{ field: "status", value: "frobnicated" }]);
  });
});

describe("coerceRow — FK references", () => {
  test("FK fields are pulled out as raw natural keys, never written to the payload", () => {
    const m = mapping({
      columns: [{ field: "name", column: "Name" }],
      references: [
        { field: "modelId", column: "Model" },
        { field: "locationId", column: "Loc" },
      ],
    });
    const { payload, references } = coerceRow(
      { Name: "PC", Model: " Latitude 5520 ", Loc: "HQ" },
      m,
      desc,
    );
    expect(payload).toEqual({ name: "PC" });
    expect("modelId" in payload).toBe(false);
    expect(references).toEqual({ modelId: "Latitude 5520", locationId: "HQ" });
  });

  test("an absent FK cell omits the reference (no lookup, no link)", () => {
    const m = mapping({
      columns: [{ field: "name", column: "Name" }],
      references: [{ field: "modelId", column: "Model" }],
    });
    expect(coerceRow({ Name: "PC", Model: "" }, m, desc).references).toEqual({});
  });
});

describe("coerceRow — dates", () => {
  test("a bare date is re-emitted as an ISO instant", () => {
    const m = mapping({ columns: [{ field: "name", column: "N" }, { field: "purchaseDate", column: "D" }] });
    const { payload } = coerceRow({ N: "PC", D: "2024-01-02" }, m, desc);
    expect(payload.name).toBe("PC");
    expect(payload.purchaseDate).toBe(new Date("2024-01-02").toISOString());
  });

  test("an unparseable date keeps the raw value so the schema raises the field error", () => {
    const m = mapping({ columns: [{ field: "purchaseDate", column: "D" }] });
    expect(coerceRow({ D: "not-a-date" }, m, desc).payload.purchaseDate).toBe("not-a-date");
  });
});

describe("coerceRow — custom fields → specs (ADR-0069 REDESIGN §5.4)", () => {
  test("a custom field with a value lands under specs[key], trimmed", () => {
    const m = mapping({
      columns: [{ field: "name", column: "Name" }],
      custom: [
        { column: "RAM", key: "ram" },
        { column: "Disk", key: "disk" },
      ],
    });
    const { payload, specs } = coerceRow({ Name: "PC", RAM: " 16GB ", Disk: "512GB" }, m, desc);
    expect(payload).toEqual({ name: "PC" });
    expect(specs).toEqual({ ram: "16GB", disk: "512GB" });
  });

  test("an empty custom cell is omitted (no specs entry)", () => {
    const m = mapping({
      columns: [{ field: "name", column: "Name" }],
      custom: [
        { column: "RAM", key: "ram" },
        { column: "Disk", key: "disk" },
      ],
    });
    const { specs } = coerceRow({ Name: "PC", RAM: "16GB", Disk: "" }, m, desc);
    expect(specs).toEqual({ ram: "16GB" });
    expect("disk" in (specs ?? {})).toBe(false);
  });

  test("an empty specs object is NEVER emitted (all custom cells absent → specs undefined)", () => {
    const m = mapping({
      columns: [{ field: "name", column: "Name" }],
      custom: [{ column: "RAM", key: "ram" }],
    });
    const row = coerceRow({ Name: "PC", RAM: "  " }, m, desc);
    expect(row.specs).toBeUndefined();
    expect("specs" in row).toBe(false);
  });

  test("no custom mapping → no specs key on the result", () => {
    const m = mapping({ columns: [{ field: "name", column: "Name" }] });
    const row = coerceRow({ Name: "PC" }, m, desc);
    expect(row.specs).toBeUndefined();
    expect("specs" in row).toBe(false);
  });

  test("ImportMappingSchema REJECTS a custom key colliding with a native Asset field (mass-assignment)", () => {
    for (const key of ["status", "modelId", "specs", "id", "deletedAt"]) {
      const parsed = ImportMappingSchema.safeParse({
        columns: [{ field: "name", column: "Name" }],
        custom: [{ column: "X", key }],
      });
      expect(parsed.success).toBe(false);
    }
  });

  test("ImportMappingSchema REJECTS a prototype-pollution custom key and duplicate keys", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(
        ImportMappingSchema.safeParse({ columns: [], custom: [{ column: "X", key }] }).success,
      ).toBe(false);
    }
    expect(
      ImportMappingSchema.safeParse({
        columns: [],
        custom: [
          { column: "A", key: "dup" },
          { column: "B", key: "dup" },
        ],
      }).success,
    ).toBe(false);
  });

  test("the specs WRITER skips prototype-pollution keys even if a corrupt mapping bypasses the refine", () => {
    // A persisted/corrupt mapping that never went through the superRefine — the write-time guard must
    // still refuse to pollute the prototype (defense-in-depth, ADR-0069 REDESIGN §4.3).
    const corrupt = {
      columns: [{ field: "name", column: "Name", constant: null }],
      enums: [],
      references: [],
      custom: [
        { column: "Evil", key: "__proto__" },
        { column: "RAM", key: "ram" },
      ],
    } as unknown as ImportMapping;
    const { specs } = coerceRow({ Name: "PC", Evil: "{polluted:true}", RAM: "16GB" }, corrupt, desc);
    expect(specs).toEqual({ ram: "16GB" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // null-proto specs has no inherited Object machinery.
    expect(Object.getPrototypeOf(specs)).toBeNull();
  });
});
