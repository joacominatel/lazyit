import { describe, expect, test } from "bun:test";
import type { UserSession } from "@lazyit/shared";

import { deviceLabel, sessionListEntries } from "./session-rows";

function session(id: string, current = false): UserSession {
  return {
    id,
    browser: "Firefox",
    os: "Linux",
    userAgent: "Mozilla/5.0",
    ip: "203.0.113.7",
    createdAt: "2026-09-26T10:00:00.000Z",
    lastSeenAt: "2026-09-26T11:00:00.000Z",
    expiresAt: null,
    rememberMe: false,
    current,
  };
}

describe("sessionListEntries (#1420)", () => {
  test("no data yet → nothing", () => {
    expect(sessionListEntries(undefined)).toEqual([]);
  });

  test("the current session goes first, the rest keep the API's activity order", () => {
    const entries = sessionListEntries({
      sessions: [session("a"), session("b", true), session("c")],
      currentIsLegacy: false,
    });
    expect(
      entries.map((e) => (e.kind === "session" ? e.session.id : "legacy")),
    ).toEqual(["b", "a", "c"]);
  });

  test("a pre-upgrade token shows one synthetic entry for this device, first", () => {
    const entries = sessionListEntries({
      sessions: [session("a")],
      currentIsLegacy: true,
    });
    expect(entries[0]).toEqual({ kind: "legacy" });
    expect(entries).toHaveLength(2);
  });

  test("an empty list (OIDC, or nothing live) stays empty", () => {
    expect(
      sessionListEntries({ sessions: [], currentIsLegacy: false }),
    ).toEqual([]);
  });
});

describe("deviceLabel", () => {
  test("joins browser and OS", () => {
    expect(deviceLabel({ browser: "Chrome", os: "macOS" })).toBe("Chrome · macOS");
  });

  test("keeps the half that parsed", () => {
    expect(deviceLabel({ browser: null, os: "Android" })).toBe("Android");
    expect(deviceLabel({ browser: "Safari", os: " " })).toBe("Safari");
  });

  test("unknown agent → null", () => {
    expect(deviceLabel({ browser: null, os: null })).toBeNull();
  });
});
