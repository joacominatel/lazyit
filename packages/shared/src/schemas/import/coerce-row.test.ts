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

describe("coerceRow — directory person → person bucket (ADR-0069 REDESIGN §5.4, CEO Q5)", () => {
  test("builds the person bucket when email is present (identity key)", () => {
    const m = mapping({
      columns: [{ field: "name", column: "Name" }],
      person: {
        fields: [
          { field: "name", column: "Owner" },
          { field: "email", column: "Email" },
          { field: "jobTitle", column: "Title" },
        ],
      },
    });
    const { person } = coerceRow(
      { Name: "PC", Owner: "  Ana Pérez ", Email: "ana@x.com", Title: "Engineer" },
      m,
      desc,
    );
    expect(person).toEqual({ name: "Ana Pérez", email: "ana@x.com", jobTitle: "Engineer" });
  });

  test("builds the person bucket when only legajo is present (no email)", () => {
    const m = mapping({
      columns: [],
      person: {
        fields: [
          { field: "name", column: "Owner" },
          { field: "legajo", column: "Legajo" },
        ],
      },
    });
    const { person } = coerceRow({ Owner: "Bob", Legajo: "12345" }, m, desc);
    expect(person).toEqual({ name: "Bob", legajo: "12345" });
  });

  test("builds the person bucket when only username is present (3rd identity key, Q5)", () => {
    const m = mapping({
      columns: [],
      person: {
        fields: [
          { field: "name", column: "Owner" },
          { field: "username", column: "User" },
        ],
      },
    });
    const { person } = coerceRow({ Owner: "Carol", User: "carol.x" }, m, desc);
    expect(person).toEqual({ name: "Carol", username: "carol.x" });
  });

  test("NO person bucket when none of email/legajo/username is present (even with name + jobTitle)", () => {
    const m = mapping({
      columns: [],
      person: {
        fields: [
          { field: "name", column: "Owner" },
          { field: "jobTitle", column: "Title" },
          { field: "department", column: "Dept" },
          { field: "supervisor", column: "Boss" },
        ],
      },
    });
    const row = coerceRow(
      { Owner: "Dave", Title: "Engineer", Dept: "IT", Boss: "Eve" },
      m,
      desc,
    );
    expect(row.person).toBeUndefined();
    expect("person" in row).toBe(false);
  });

  test("omit-empty: blank person sub-field cells are dropped from the bucket", () => {
    const m = mapping({
      columns: [],
      person: {
        fields: [
          { field: "name", column: "Owner" },
          { field: "email", column: "Email" },
          { field: "legajo", column: "Legajo" },
          { field: "department", column: "Dept" },
        ],
      },
    });
    const { person } = coerceRow(
      { Owner: "Frank", Email: "frank@x.com", Legajo: "  ", Dept: "" },
      m,
      desc,
    );
    expect(person).toEqual({ name: "Frank", email: "frank@x.com" });
    expect("legajo" in (person ?? {})).toBe(false);
    expect("department" in (person ?? {})).toBe(false);
  });

  test("identity gate: an empty identity cell does NOT count — name-only blank-email → no bucket", () => {
    const m = mapping({
      columns: [],
      person: {
        fields: [
          { field: "name", column: "Owner" },
          { field: "email", column: "Email" },
        ],
      },
    });
    const row = coerceRow({ Owner: "Grace", Email: "   " }, m, desc);
    expect(row.person).toBeUndefined();
  });

  test("no person mapping → no person key on the result", () => {
    const m = mapping({ columns: [{ field: "name", column: "Name" }] });
    const row = coerceRow({ Name: "PC" }, m, desc);
    expect(row.person).toBeUndefined();
    expect("person" in row).toBe(false);
  });
});
