import { describe, expect, test } from "bun:test";
import { INFRA_NODE_SNOOZE_MAX_DAYS } from "@lazyit/shared";
import { nodeLifecycle, SNOOZE_MAX_MS, SNOOZE_PRESETS, snoozeUntilFor } from "./lifecycle";

const NOW = Date.parse("2026-10-22T12:00:00.000Z");

describe("nodeLifecycle (#1701)", () => {
  test("a node from an API that predates the columns is active and not snoozed", () => {
    expect(nodeLifecycle({}, NOW)).toEqual({ retired: false, snoozedUntil: null });
  });

  test("any retiredAt means retired", () => {
    expect(nodeLifecycle({ retiredAt: "2026-10-01T00:00:00.000Z" }, NOW).retired).toBe(true);
    expect(nodeLifecycle({ retiredAt: null }, NOW).retired).toBe(false);
  });

  test("only a FUTURE snooze counts — an expired one is not badged", () => {
    expect(nodeLifecycle({ alertsSnoozedUntil: "2026-10-23T00:00:00.000Z" }, NOW).snoozedUntil).toBe(
      "2026-10-23T00:00:00.000Z",
    );
    expect(
      nodeLifecycle({ alertsSnoozedUntil: "2026-10-22T11:00:00.000Z" }, NOW).snoozedUntil,
    ).toBeNull();
    expect(nodeLifecycle({ alertsSnoozedUntil: "garbage" }, NOW).snoozedUntil).toBeNull();
  });
});

describe("snoozeUntilFor (#1701)", () => {
  test("adds the preset to now", () => {
    expect(snoozeUntilFor("4h", NOW)).toBe("2026-10-22T16:00:00.000Z");
    expect(snoozeUntilFor("1d", NOW)).toBe("2026-10-23T12:00:00.000Z");
    expect(snoozeUntilFor("7d", NOW)).toBe("2026-10-29T12:00:00.000Z");
  });

  test("every preset is in the future and within the API's ceiling", () => {
    expect(SNOOZE_MAX_MS).toBe(INFRA_NODE_SNOOZE_MAX_DAYS * 24 * 60 * 60 * 1000);
    for (const preset of SNOOZE_PRESETS) {
      const until = Date.parse(snoozeUntilFor(preset, NOW));
      expect(until).toBeGreaterThan(NOW);
      expect(until - NOW).toBeLessThanOrEqual(SNOOZE_MAX_MS);
    }
  });
});
