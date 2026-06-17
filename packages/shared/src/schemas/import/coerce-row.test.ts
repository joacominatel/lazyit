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
