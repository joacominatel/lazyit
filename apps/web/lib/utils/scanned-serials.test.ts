import { describe, expect, test } from "bun:test";
import { parseSerials } from "@/app/(app)/assets/_components/receive-stock-payload";
import { appendSerial, type LastScan, SCAN_REPEAT_MS, scanDecision, scanStep } from "./scanned-serials";

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

  test("a code held in view stays silent, and is reported only after it was out of view for SCAN_REPEAT_MS", () => {
    let last: LastScan = null;
    let existing: string[] = [];
    const decisions: string[] = [];
    // Held in front of the camera for ten seconds, read every 100 ms.
    for (let now = 0; now <= 10_000; now += 100) {
      const step = scanStep("A1", { existing, last, now });
      decisions.push(step.decision);
      if (step.decision === "add") existing = [...existing, "A1"];
      last = step.last;
    }
    expect(decisions[0]).toBe("add");
    expect(decisions.slice(1).every((d) => d === "repeat")).toBe(true);
    // Out of view just under the window: still the same sighting.
    expect(scanStep("A1", { existing, last, now: 10_000 + SCAN_REPEAT_MS - 1 }).decision).toBe("repeat");
    // Out of view for the whole window: shown again, it is a duplicate the operator is told about.
    expect(scanStep("A1", { existing, last, now: 10_000 + SCAN_REPEAT_MS }).decision).toBe("duplicate");
  });

  test("an invalid read leaves the last sighting as it was", () => {
    const last = { code: "A1", at: 1_000 };
    expect(scanStep("   ", { existing: [], last, now: 1_500 })).toEqual({ decision: "invalid", last });
  });

  test("a blank read or one longer than a serial (a URL QR) is not a serial", () => {
    expect(scanDecision("   ", { existing: [], last: null, now: 0 })).toBe("invalid");
    expect(scanDecision("x".repeat(201), { existing: [], last: null, now: 0 })).toBe("invalid");
    expect(scanDecision("x".repeat(200), { existing: [], last: null, now: 0 })).toBe("add");
  });
});
