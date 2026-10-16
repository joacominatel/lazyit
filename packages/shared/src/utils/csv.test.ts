import { describe, expect, test } from "bun:test";
import { CSV_BOM, CSV_EOL, csvCell, guardCsvFormula } from "./csv";
import { escapeCsvCell } from "./recent-activity-csv";

describe("guardCsvFormula", () => {
  test.each([
    ["=1+1"],
    ["+1"],
    ["-1"],
    ["@SUM(A1)"],
    ["\tcmd"],
    ["\rcmd"],
    ["\ncmd"],
    ["\uFF1D1+1"],
    ["\uFF0B1"],
    ["\uFF0D1"],
    ["\uFF20SUM(A1)"],
  ])("defuses %p", (value) => {
    expect(guardCsvFormula(value)).toBe(`'${value}`);
  });

  test("leaves ordinary text alone", () => {
    expect(guardCsvFormula("José")).toBe("José");
    expect(guardCsvFormula("a=b")).toBe("a=b");
    expect(guardCsvFormula("")).toBe("");
  });
});

describe("csvCell", () => {
  test("guards and quotes a text cell", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("\nline")).toBe(`"'\nline"`);
    expect(csvCell("a,b", "text")).toBe(`"a,b"`);
  });

  test("emits number, money and date cells raw", () => {
    expect(csvCell("-5", "number")).toBe("-5");
    expect(csvCell("-12.50", "money")).toBe("-12.50");
    expect(csvCell("2026-10-16T12:00:00.000Z", "date")).toBe(
      "2026-10-16T12:00:00.000Z",
    );
  });

  test("guards a non-text cell whose value is not a number or a timestamp", () => {
    expect(csvCell("=1+1", "number")).toBe("'=1+1");
    expect(csvCell("-cmd", "money")).toBe("'-cmd");
    expect(csvCell("@SUM(A1)", "date")).toBe("'@SUM(A1)");
    expect(csvCell("-1,5", "number")).toBe(`"'-1,5"`);
  });

  test("keeps a plain date and a numeric zero raw", () => {
    expect(csvCell("2026-10-16", "date")).toBe("2026-10-16");
    expect(csvCell("0", "number")).toBe("0");
  });
});

describe("conventions", () => {
  test("BOM and CRLF", () => {
    expect(CSV_BOM).toBe("\uFEFF");
    expect(CSV_EOL).toBe("\r\n");
  });

  test("the legacy escaper is unchanged (the existing exports keep their output)", () => {
    expect(escapeCsvCell("\nline")).toBe(`"\nline"`);
    expect(escapeCsvCell("\uFF1D1")).toBe("\uFF1D1");
    expect(escapeCsvCell("-5")).toBe("'-5");
  });
});
