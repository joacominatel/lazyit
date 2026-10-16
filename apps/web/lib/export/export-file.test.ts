import { describe, expect, test } from "bun:test";
import { DATA_EXPORT_ROW_CAP } from "@lazyit/shared";
import { ApiError } from "@/lib/api/client";
import { exportBlock, exportErrorKind, exportFileName, exportUrl } from "./export-file";

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
  test("the file is named like the server's Content-Disposition", () => {
    expect(exportFileName("assets", new Date("2026-10-16T22:00:00.000Z"))).toBe(
      "lazyit-assets-2026-10-16.csv",
    );
  });

  test("the export URL carries the filters, or none", () => {
    expect(exportUrl("/assets/export", new URLSearchParams({ q: "dell" }))).toBe(
      "/assets/export?q=dell",
    );
    expect(exportUrl("/users/export", new URLSearchParams())).toBe("/users/export");
  });
});
