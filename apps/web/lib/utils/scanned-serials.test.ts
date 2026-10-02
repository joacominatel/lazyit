import { describe, expect, test } from "bun:test";
import { parseSerials } from "@/app/(app)/assets/_components/receive-stock-payload";
import { appendSerial, SCAN_REPEAT_MS, scanDecision } from "./scanned-serials";

describe("scanning serials into the receive dialog (#1476)", () => {
  test("each scan lands on its own line, after whatever was typed or pasted", () => {
    expect(appendSerial("", "PF4A1X9")).toBe("PF4A1X9");
    expect(appendSerial("PF4A1X9", " PF4A1X7 ")).toBe("PF4A1X9\nPF4A1X7");
    expect(appendSerial("PF4A1X9\n", "PF4A1X7")).toBe("PF4A1X9\nPF4A1X7");
    expect(appendSerial("  \n", "A")).toBe("A");
    expect(parseSerials(appendSerial(appendSerial("", "A"), "B"))).toEqual(["A", "B"]);
  });

  test("a code already in the box is a duplicate, never appended twice", () => {
    expect(scanDecision("A1", { existing: ["A1", "B2"], last: null, now: 0 })).toBe("duplicate");
    expect(scanDecision(" C3 ", { existing: ["A1"], last: null, now: 0 })).toBe("add");
  });

  test("the same code seen on the next frames is ignored silently, then reported as a duplicate", () => {
    const last = { code: "A1", at: 1_000 };
    expect(scanDecision("A1", { existing: ["A1"], last, now: 1_000 + SCAN_REPEAT_MS - 1 })).toBe("repeat");
    expect(scanDecision("A1", { existing: ["A1"], last, now: 1_000 + SCAN_REPEAT_MS })).toBe("duplicate");
  });

  test("a blank read or one longer than a serial (a URL QR) is not a serial", () => {
    expect(scanDecision("   ", { existing: [], last: null, now: 0 })).toBe("invalid");
    expect(scanDecision("x".repeat(201), { existing: [], last: null, now: 0 })).toBe("invalid");
    expect(scanDecision("x".repeat(200), { existing: [], last: null, now: 0 })).toBe("add");
  });
});
