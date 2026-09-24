import { describe, expect, test } from "bun:test";
import { isRecordArray, presentPreview } from "./preview";
import { buildPreviewTable, visibleTableRows } from "./preview-table";

/** Rows shaped like `asset_create_batch`'s preview (tools-and-execution.md, "asset_create_batch"). */
const batchRows = [
  {
    row: 1,
    name: "MBP-01",
    assetTag: "LZ-0001",
    serial: "C02X1",
    status: "IN_STORAGE",
    statusDefaulted: true,
    model: { type: "assetModel", id: "m1", label: "MacBook Pro 14" },
    category: { type: "assetCategory", id: "c1", label: "Laptops" },
    location: { type: "location", id: "l1", label: "HQ" },
    company: "Acme",
    skipped: false,
    valid: true,
    errors: [],
    duplicates: [],
  },
  {
    row: 2,
    name: "MBP-02",
    assetTag: "LZ-0042",
    serial: null,
    status: "OPERATIONAL",
    model: null,
    category: null,
    location: null,
    skipped: true,
    valid: false,
    errors: [
      'assetTag "LZ-0042" already belongs to LZ-0042 · Old laptop',
      "No asset model matches “Macbok”.",
    ],
    duplicates: [
      { field: "assetTag", value: "LZ-0042", existing: { type: "asset", id: "a42", label: "LZ-0042 · Old laptop" } },
    ],
  },
  {
    row: 3,
    name: "<untrusted_content>MBP-03</untrusted_content>",
    assetTag: null,
    serial: "C02X1",
    status: "IN_STORAGE",
    model: null,
    category: null,
    location: null,
    skipped: true,
    valid: false,
    errors: ['serial "C02X1" is also used by row 1'],
    duplicates: [{ field: "serial", value: "C02X1", row: 1 }],
  },
];

describe("isRecordArray / presentPreview", () => {
  test("an array of objects keeps its records; a scalar array keeps the flat text", () => {
    expect(isRecordArray(batchRows)).toBe(true);
    expect(isRecordArray(["a", "b"])).toBe(false);
    expect(isRecordArray([])).toBe(false);
    expect(isRecordArray([{ a: 1 }, "b"])).toBe(false);
    expect(isRecordArray([[1]])).toBe(false);

    const model = presentPreview({
      changes: [
        { field: "action", after: "Create 1 of 3 assets; 2 rows skipped as requested." },
        { field: "validRows", after: 1, valueKind: "number" },
        { field: "defaultsApplied", after: ["status: IN_STORAGE (1 of 1 rows)"], valueKind: "text" },
        { field: "rows", after: batchRows, valueKind: "text" },
      ],
    });
    const byField = Object.fromEntries(model.rows.map((r) => [r.field, r]));
    expect(byField.rows!.records).toBe(batchRows);
    expect(byField.defaultsApplied!.records).toBeUndefined();
    expect(byField.defaultsApplied!.after).toEqual({
      kind: "text",
      text: "status: IN_STORAGE (1 of 1 rows)",
      untrusted: false,
    });
    expect(byField.validRows!.records).toBeUndefined();
    expect(model.notices).toEqual([]);
  });

  test("duplicatesUnchecked: true is a notice, not a field row; false says nothing", () => {
    const on = presentPreview({ changes: [{ field: "duplicatesUnchecked", after: true, valueKind: "boolean" }] });
    expect(on.notices).toEqual(["duplicatesUnchecked"]);
    expect(on.rows).toEqual([]);
    const off = presentPreview({ changes: [{ field: "duplicatesUnchecked", after: false, valueKind: "boolean" }] });
    expect(off.notices).toEqual([]);
    expect(off.rows).toEqual([]);
  });
});

describe("buildPreviewTable", () => {
  const table = buildPreviewTable(batchRows);

  test("columns: preferred order first, then the rest; row-state keys are never columns", () => {
    expect(table.columns).toEqual(["name", "assetTag", "serial", "model", "category", "location", "status", "company"]);
  });

  test("counts and row state", () => {
    expect(table.rows.map((r) => r.number)).toEqual([1, 2, 3]);
    expect(table.rows.map((r) => r.applied)).toEqual([true, false, false]);
    expect(table.skippedCount).toBe(2);
    expect(table.problemCount).toBe(2);
  });

  test("cells are plain text; entity refs link through entityHref only; defaults are flagged", () => {
    const [first, , third] = table.rows;
    expect(first!.cells.status).toEqual({
      value: { kind: "text", text: "IN_STORAGE", untrusted: false },
      href: null,
      defaulted: true,
    });
    expect(first!.cells.location!.href).toBe("/locations/l1");
    // An asset model has no page of its own: text, no link.
    expect(first!.cells.model).toEqual({
      value: { kind: "text", text: "MacBook Pro 14", untrusted: false },
      href: null,
      defaulted: false,
    });
    expect(first!.cells.serial!.defaulted).toBe(false);
    expect(first!.cells.company!.value).toEqual({ kind: "text", text: "Acme", untrusted: false });
    expect(table.rows[1]!.cells.company!.value).toEqual({ kind: "empty" });
    expect(third!.cells.name!.value).toEqual({ kind: "text", text: "MBP-03", untrusted: true });
  });

  test("problems: duplicates are structured and linked, their error sentence is not repeated", () => {
    expect(table.rows[0]!.problems).toEqual([]);
    expect(table.rows[1]!.problems).toEqual([
      { kind: "duplicateExisting", field: "assetTag", value: "LZ-0042", label: "LZ-0042 · Old laptop", href: "/assets/a42" },
      { kind: "error", text: "No asset model matches “Macbok”." },
    ]);
    expect(table.rows[2]!.problems).toEqual([{ kind: "duplicateRow", field: "serial", value: "C02X1", row: 1 }]);
  });

  test("a hostile payload cannot plant a link or markup", () => {
    const t = buildPreviewTable([
      {
        name: "<img src=x onerror=alert(1)>",
        location: { type: "location", id: "../../evil", label: "x", href: "javascript:alert(1)" },
        duplicates: [{ field: "assetTag", value: "A", existing: { type: "javascript", id: "x", label: "y" } }],
        errors: [42, null, "  "],
      },
    ]);
    const row = t.rows[0]!;
    expect(row.number).toBe(1);
    expect(row.applied).toBe(true);
    expect(row.cells.name!.value).toEqual({ kind: "text", text: "<img src=x onerror=alert(1)>", untrusted: false });
    expect(row.cells.location!.href).toBe("/locations/..%2F..%2Fevil");
    expect(row.problems).toEqual([
      { kind: "duplicateExisting", field: "assetTag", value: "A", label: "y", href: null },
      { kind: "error", text: "42" },
    ]);
  });

  test("generic: any array of records, rows numbered by position when they carry no number", () => {
    const t = buildPreviewTable([{ title: "A", owner: { type: "user", id: "u1", label: "Ana" } }, { title: "B" }]);
    expect(t.columns).toEqual(["title", "owner"]);
    expect(t.rows.map((r) => [r.number, r.applied, r.problems.length])).toEqual([
      [1, true, 0],
      [2, true, 0],
    ]);
    expect(t.rows[0]!.cells.owner!.href).toBe("/users/u1");
    expect(t.problemCount).toBe(0);
  });
});

describe("visibleTableRows", () => {
  test("only problems keeps skipped rows and rows with a problem", () => {
    const t = buildPreviewTable([
      { row: 1, name: "ok", errors: [] },
      { row: 2, name: "skipped", skipped: true, errors: [] },
      { row: 3, name: "warned", errors: ["something"] },
    ]);
    expect(visibleTableRows(t, false).map((r) => r.number)).toEqual([1, 2, 3]);
    expect(visibleTableRows(t, true).map((r) => r.number)).toEqual([2, 3]);
  });
});
