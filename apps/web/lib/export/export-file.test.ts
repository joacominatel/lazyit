import { describe, expect, test } from "bun:test";
import { DATA_EXPORT_RESOURCES, DATA_EXPORT_ROW_CAP, DATA_EXPORT_XLSX_RESOURCES } from "@lazyit/shared";
import { ApiError } from "@/lib/api/client";
import {
  EXPORT_FILE_TYPES,
  exportBlob,
  exportBlock,
  exportErrorKind,
  exportFileName,
  exportFormats,
  exportParams,
  exportUrl,
} from "./export-file";

describe("exportBlock — the guard before the request", () => {
  test("nothing to export while the total loads or when it is zero", () => {
    expect(exportBlock(undefined)).toBe("empty");
    expect(exportBlock(0)).toBe("empty");
  });

  test("up to the cap the export runs, exactly the cap included", () => {
    expect(exportBlock(1)).toBeNull();
    expect(exportBlock(DATA_EXPORT_ROW_CAP)).toBeNull();
  });

  test("above the cap the button warns instead of calling", () => {
    expect(exportBlock(DATA_EXPORT_ROW_CAP + 1)).toBe("overCap");
  });
});

describe("exportErrorKind — the refusals the button explains", () => {
  test("422 is over the cap, 429 the limiter, 403 the list permission", () => {
    expect(exportErrorKind(new ApiError(422, "narrow your filters"))).toBe("overCap");
    expect(exportErrorKind(new ApiError(429, "Too Many Requests"))).toBe("busy");
    expect(exportErrorKind(new ApiError(403, "Forbidden"))).toBe("forbidden");
  });

  test("anything else falls through to the generic error toast", () => {
    expect(exportErrorKind(new ApiError(500, "boom"))).toBeNull();
    expect(exportErrorKind(new ApiError(400, "Invalid status"))).toBeNull();
    expect(exportErrorKind(new TypeError("Failed to fetch"))).toBeNull();
  });
});

describe("the request and the file", () => {
  test("the file is named like the server's Content-Disposition, extension per format", () => {
    const now = new Date("2026-10-16T22:00:00.000Z");
    expect(exportFileName("assets", "csv", now)).toBe("lazyit-assets-2026-10-16.csv");
    expect(exportFileName("purchases", "xlsx", now)).toBe("lazyit-purchases-2026-10-16.xlsx");
    expect(exportFileName("assets")).toEndWith(".csv");
  });

  test("the saved file is typed as its format", () => {
    const xlsx = exportBlob(new Blob(["PK"]), "xlsx");
    expect(xlsx.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const csv = exportBlob(new Blob(["a,b"], { type: "application/octet-stream" }), "csv");
    expect(csv.type).toBe(EXPORT_FILE_TYPES.csv.mime);
    const already = new Blob(["PK"], { type: EXPORT_FILE_TYPES.xlsx.mime });
    expect(exportBlob(already, "xlsx")).toBe(already);
  });

  test("the export URL carries the filters, or none", () => {
    expect(exportUrl("/assets/export", new URLSearchParams({ q: "dell" }))).toBe(
      "/assets/export?q=dell",
    );
    expect(exportUrl("/users/export", new URLSearchParams())).toBe("/users/export");
  });
});

describe("the format choice (ADR-0103 §11)", () => {
  test("only the opted-in resources offer Excel; every other export, or none named, is CSV only", () => {
    for (const resource of DATA_EXPORT_RESOURCES) {
      const xlsx = (DATA_EXPORT_XLSX_RESOURCES as readonly string[]).includes(resource);
      expect(exportFormats(resource)).toEqual(xlsx ? ["csv", "xlsx"] : ["csv"]);
    }
    expect(exportFormats("ASSETS")).toEqual(["csv", "xlsx"]);
    expect(exportFormats("PURCHASE_ORDERS")).toEqual(["csv", "xlsx"]);
    expect(exportFormats(undefined)).toEqual(["csv"]);
  });

  test("CSV sends the filters untouched, with no format key: the request it always was", () => {
    const filters = new URLSearchParams([
      ["q", "dell"],
      ["status", "DRAFT"],
      ["status", "ORDERED"],
    ]);
    expect(exportParams(filters, "csv").toString()).toBe(filters.toString());
    expect(exportParams(filters, "csv").has("format")).toBe(false);
  });

  test("XLSX appends format=xlsx to the same filters, without touching the caller's params", () => {
    const filters = new URLSearchParams([
      ["q", "dell"],
      ["status", "DRAFT"],
      ["status", "ORDERED"],
    ]);
    const before = filters.toString();
    const xlsx = exportParams(filters, "xlsx");
    expect(xlsx.getAll("format")).toEqual(["xlsx"]);
    xlsx.delete("format");
    expect(xlsx.toString()).toBe(before);
    expect(filters.toString()).toBe(before);
  });

  test("a stray format in the list params never repeats the key (the API answers 400 to that)", () => {
    const filters = new URLSearchParams([["format", "csv"], ["q", "x"]]);
    expect(exportParams(filters, "xlsx").getAll("format")).toEqual(["xlsx"]);
    expect(exportParams(filters, "csv").has("format")).toBe(false);
  });
});
