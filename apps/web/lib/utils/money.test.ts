import { describe, expect, test } from "bun:test";
import { formatMoney, MONEY_MAX, parseMoneyInput } from "./money";

const minor = (text: string, locale: string) => {
  const result = parseMoneyInput(text, locale);
  return result.ok ? result.minor : result.error;
};

describe("parseMoneyInput — es (#1470)", () => {
  test("accepts grouped and ungrouped amounts with a decimal comma", () => {
    expect(minor("1.234,56", "es")).toBe(123456);
    expect(minor("1234,56", "es")).toBe(123456);
    expect(minor("1.234", "es")).toBe(123400);
    expect(minor("1.234.567,8", "es")).toBe(123456780);
    expect(minor("12,5", "es")).toBe(1250);
    expect(minor(",5", "es")).toBe(50);
    expect(minor("12,", "es")).toBe(1200);
    expect(minor("  1500 ", "es")).toBe(150000);
    expect(minor("0", "es")).toBe(0);
  });

  test("refuses the English separators instead of guessing", () => {
    expect(minor("1,234.56", "es")).toBe("invalid");
    expect(minor("12.5", "es")).toBe("invalid");
    expect(minor("1.23.456", "es")).toBe("invalid");
    // A comma followed by three digits reads as three decimals, never as a thousands group.
    expect(minor("1,234", "es")).toBe("decimals");
  });
});

describe("parseMoneyInput — en (#1470)", () => {
  test("accepts grouped and ungrouped amounts with a decimal point", () => {
    expect(minor("1,234.56", "en")).toBe(123456);
    expect(minor("1234.56", "en")).toBe(123456);
    expect(minor("1,234", "en")).toBe(123400);
    expect(minor("12.99", "en")).toBe(1299);
    expect(minor(".5", "en")).toBe(50);
  });

  test("refuses the Spanish separators instead of guessing", () => {
    expect(minor("1.234,56", "en")).toBe("invalid");
    expect(minor("12,5", "en")).toBe("invalid");
    expect(minor("1.234", "en")).toBe("decimals");
  });
});

describe("parseMoneyInput — both locales", () => {
  test("blank is not set", () => {
    for (const locale of ["en", "es"]) {
      expect(parseMoneyInput("", locale)).toEqual({ ok: true, minor: null });
      expect(parseMoneyInput("   ", locale)).toEqual({ ok: true, minor: null });
    }
  });

  test("negatives are refused with their own reason", () => {
    expect(minor("-5", "en")).toBe("negative");
    expect(minor("-1.234,56", "es")).toBe("negative");
    expect(minor("−5", "en")).toBe("negative");
  });

  test("more than two decimals is refused, never rounded", () => {
    expect(minor("10.005", "en")).toBe("decimals");
    expect(minor("10,005", "es")).toBe("decimals");
  });

  test("garbage is refused", () => {
    for (const text of ["abc", "$12", "12 USD", "1 234", "+5", ".", ",", "1e3", "12..5"]) {
      expect(minor(text, "en")).toBe("invalid");
    }
  });

  test("no int4 ceiling: amounts past 21,474,836.47 are accepted (ADR-0100)", () => {
    expect(minor("21.474.836,48", "es")).toBe(2_147_483_648);
    expect(minor("1,412,500,000.00", "en")).toBe(141_250_000_000);
  });

  test("bounded to the wire maximum, exactly", () => {
    expect(minor("90071992547409,91", "es")).toBe(MONEY_MAX);
    expect(minor("90071992547409,92", "es")).toBe("tooLarge");
    expect(minor("999999999999999999", "en")).toBe("tooLarge");
  });

  test("a displayed amount parses back to the stored one", () => {
    for (const locale of ["en", "es"]) {
      for (const stored of [0, 5, 150000, 123456, 199_99, 100000000, MONEY_MAX]) {
        expect(minor(formatMoney(stored, locale), locale)).toBe(stored);
      }
    }
  });
});

describe("formatMoney — shown as entered (ADR-0100 §5)", () => {
  test("whole amounts carry no decimals, with grouping from four digits", () => {
    expect(formatMoney(150000, "es")).toBe("1.500");
    expect(formatMoney(150000, "en")).toBe("1,500");
    expect(formatMoney(0, "en")).toBe("0");
    expect(formatMoney(100, "es")).toBe("1");
  });

  test("fractional amounts carry two decimals", () => {
    expect(formatMoney(123456, "es")).toBe("1.234,56");
    expect(formatMoney(123456, "en")).toBe("1,234.56");
    expect(formatMoney(150050, "es")).toBe("1.500,50");
    expect(formatMoney(50, "en")).toBe("0.50");
  });

  test("the largest amount stays exact", () => {
    expect(formatMoney(MONEY_MAX, "en")).toBe("90,071,992,547,409.91");
  });

  test("a currency label precedes the amount exactly as typed", () => {
    expect(formatMoney(141250000, "es", "ARS")).toBe("ARS 1.412.500");
    expect(formatMoney(123456, "en", " usd ")).toBe("usd 1,234.56");
    expect(formatMoney(150000, "en", "")).toBe("1,500");
    expect(formatMoney(150000, "en", "   ")).toBe("1,500");
    expect(formatMoney(150000, "en", null)).toBe("1,500");
  });
});
