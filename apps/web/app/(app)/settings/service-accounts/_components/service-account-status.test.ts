import { describe, expect, test } from "bun:test";
import type { ServiceAccount } from "@lazyit/shared";
import { lifecycleCell, permissionChips } from "./service-account-status";

const NOW = Date.parse("2026-10-09T12:00:00Z");

function account(overrides: Partial<ServiceAccount>): ServiceAccount {
  return {
    isActive: true,
    expiresAt: null,
    deletedAt: null,
    ...overrides,
  } as ServiceAccount;
}

describe("permissionChips", () => {
  test("up to the limit, everything shows", () => {
    expect(permissionChips(["a", "b", "c"])).toEqual({ shown: ["a", "b", "c"], hidden: [] });
  });

  test("one over the limit still shows all — a +1 chip saves nothing", () => {
    expect(permissionChips(["a", "b", "c", "d"]).hidden).toEqual([]);
  });

  test("beyond that, the rest collapse into +N", () => {
    expect(permissionChips(["a", "b", "c", "d", "e"])).toEqual({
      shown: ["a", "b", "c"],
      hidden: ["d", "e"],
    });
  });
});

describe("lifecycleCell", () => {
  test("a live account with no expiry", () => {
    expect(lifecycleCell(account({}), NOW)).toEqual({ kind: "noExpiry" });
  });

  test("a live account with a future expiry shows the date", () => {
    expect(lifecycleCell(account({ expiresAt: "2027-01-01T00:00:00Z" }), NOW)).toEqual({
      kind: "expires",
      at: "2027-01-01T00:00:00Z",
    });
  });

  test("revoked, expired and inactive read as their status, revoked first", () => {
    expect(
      lifecycleCell(account({ deletedAt: "2026-01-01T00:00:00Z", expiresAt: "2025-01-01T00:00:00Z" }), NOW),
    ).toEqual({ kind: "status", status: "revoked" });
    expect(lifecycleCell(account({ expiresAt: "2026-01-01T00:00:00Z" }), NOW)).toEqual({
      kind: "status",
      status: "expired",
    });
    expect(lifecycleCell(account({ isActive: false }), NOW)).toEqual({
      kind: "status",
      status: "inactive",
    });
  });
});
