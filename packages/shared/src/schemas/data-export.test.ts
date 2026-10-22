import { describe, expect, it } from "bun:test";
import {
  DATA_EXPORT_RESOURCES,
  DATA_EXPORT_XLSX_RESOURCES,
  DataExportFormatSchema,
} from "./data-export";

describe("DataExportFormatSchema", () => {
  it("accepts csv and xlsx", () => {
    expect(DataExportFormatSchema.parse("csv")).toBe("csv");
    expect(DataExportFormatSchema.parse("xlsx")).toBe("xlsx");
  });

  it("rejects any other format", () => {
    for (const bad of ["XLSX", "xls", "json", ""]) {
      expect(DataExportFormatSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("DATA_EXPORT_XLSX_RESOURCES", () => {
  it("is opted in for the assets inventory and purchases only", () => {
    expect([...DATA_EXPORT_XLSX_RESOURCES]).toEqual(["ASSETS", "PURCHASE_ORDERS"]);
    for (const r of DATA_EXPORT_XLSX_RESOURCES) {
      expect(DATA_EXPORT_RESOURCES).toContain(r);
    }
  });
});
