/**
 * What the tray row and the node drill-in display for a reported form factor (ADR-0093 §6), pulled
 * out of the components because the interesting half of the answer is the half that renders NOTHING —
 * and an absence is the thing a component test would quietly stop covering.
 *
 * Every node on an install the second after `prisma migrate deploy` is in one of the two silent
 * cases, so this is also the wave-1-absent-field path for these two surfaces.
 */
import { AgentChassisSchema } from "@lazyit/shared";
import { describe, expect, test } from "bun:test";
import { displayChassis } from "./chassis";

describe("displayChassis (ADR-0093 §6)", () => {
  test("a reported form factor is shown", () => {
    expect(displayChassis("laptop")).toBe("laptop");
    expect(displayChassis("desktop")).toBe("desktop");
    expect(displayChassis("server")).toBe("server");
    expect(displayChassis("vm")).toBe("vm");
    expect(displayChassis("container")).toBe("container");
  });

  test("every member of the vocabulary except `unknown` has a label to render", () => {
    for (const option of AgentChassisSchema.options) {
      if (option === "unknown") continue;
      expect(displayChassis(option)).toBe(option);
    }
  });

  test("no signal renders nothing — absent and null alike", () => {
    // A manual node, a container child, a pre-v2 agent, a row predating the column.
    expect(displayChassis(undefined)).toBeNull();
    expect(displayChassis(null)).toBeNull();
  });

  test("`unknown` renders nothing: the probe declined, the machine did not answer", () => {
    expect(displayChassis("unknown")).toBeNull();
  });

  test("a value outside the vocabulary never becomes a missing i18n key", () => {
    expect(displayChassis("tablet")).toBeNull();
    expect(displayChassis("")).toBeNull();
    expect(displayChassis("LAPTOP")).toBeNull();
  });
});
