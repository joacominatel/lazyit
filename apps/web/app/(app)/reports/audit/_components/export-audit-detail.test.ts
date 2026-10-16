import { describe, expect, test } from "bun:test";
import {
  type ExportDetailTranslate,
  exportAuditDetailLine,
  parseExportAuditDetail,
} from "./export-audit-detail";

const t: ExportDetailTranslate = (key, values) =>
  key === "rows" ? `${values?.count} rows` : "no filters";

describe("the export audit row's detail", () => {
  test("reads the row count and the filters the export ran with", () => {
    const detail = JSON.stringify({
      rowCount: 1204,
      filters: { q: "dell", status: ["DRAFT", "ORDERED"], purchaseLinked: false, deleted: "active" },
    });
    expect(exportAuditDetailLine(detail, t)).toBe(
      "1204 rows · q: dell · status: DRAFT, ORDERED · purchaseLinked: false",
    );
  });

  test("keeps the archived slice, the one deleted value that says something", () => {
    const detail = JSON.stringify({ rowCount: 3, filters: { deleted: "only" } });
    expect(exportAuditDetailLine(detail, t)).toBe("3 rows · deleted: only");
  });

  test("an export with no filters says so", () => {
    expect(exportAuditDetailLine(JSON.stringify({ rowCount: 0, filters: {} }), t)).toBe(
      "0 rows · no filters",
    );
    expect(parseExportAuditDetail(JSON.stringify({ rowCount: 7 }))).toEqual({
      rowCount: 7,
      filters: [],
    });
  });

  test("anything that is not the export shape is left to the caller", () => {
    expect(exportAuditDetailLine(null, t)).toBeNull();
    expect(exportAuditDetailLine("not json", t)).toBeNull();
    expect(exportAuditDetailLine(JSON.stringify({ filters: {} }), t)).toBeNull();
    expect(exportAuditDetailLine("[1,2]", t)).toBeNull();
  });
});
