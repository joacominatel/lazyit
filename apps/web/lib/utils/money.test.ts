import { describe, expect, test } from "bun:test";
import { formatMoney, majorToMinor, minorToMajor } from "./money";

describe("money helpers (#954)", () => {
  test("minorToMajor divides by 100", () => {
    expect(minorToMajor(1050)).toBe(10.5);
    expect(minorToMajor(0)).toBe(0);
    expect(minorToMajor(123456)).toBe(1234.56);
  });

  test("majorToMinor rounds to the nearest cent", () => {
    expect(majorToMinor("10.50")).toBe(1050);
    expect(majorToMinor("10.005")).toBe(1001); // half-up rounding
    expect(majorToMinor(12)).toBe(1200);
  });

  test("majorToMinor returns null for empty/blank/unparseable input", () => {
    expect(majorToMinor("")).toBeNull();
    expect(majorToMinor("   ")).toBeNull();
    expect(majorToMinor("abc")).toBeNull();
  });

  test("round-trips a stored minor value through the input and back", () => {
    const stored = 199_99; // $199.99
    expect(majorToMinor(String(minorToMajor(stored)))).toBe(stored);
  });

  test("formatMoney renders two decimals with no currency symbol", () => {
    expect(formatMoney(123450, "en-US")).toBe("1,234.50");
    expect(formatMoney(0, "en-US")).toBe("0.00");
    expect(formatMoney(50, "en-US")).toBe("0.50");
  });
});
