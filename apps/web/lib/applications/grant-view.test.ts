import { describe, expect, test } from "bun:test";
import { ANY_ACCESS_LEVEL, NO_ACCESS_LEVEL } from "./grant-list-query";
import {
  accessLevelOptions,
  grantAttention,
  seatState,
  showAccessLevelPicker,
} from "./grant-view";

describe("accessLevelOptions", () => {
  test("keeps the server's order and turns the no-level row into the picker's sentinel", () => {
    expect(
      accessLevelOptions([
        { accessLevel: "admin", count: 3 },
        { accessLevel: "viewer", count: 1 },
        { accessLevel: null, count: 4 },
      ]),
    ).toEqual([
      { level: "admin", count: 3 },
      { level: "viewer", count: 1 },
      { level: NO_ACCESS_LEVEL, count: 4 },
    ]);
  });
});

describe("showAccessLevelPicker", () => {
  test("shows with a choice to make, hides with a single level", () => {
    expect(showAccessLevelPicker([{ level: "a" }, { level: "b" }], ANY_ACCESS_LEVEL, ANY_ACCESS_LEVEL)).toBe(true);
    expect(showAccessLevelPicker([{ level: "a" }], ANY_ACCESS_LEVEL, ANY_ACCESS_LEVEL)).toBe(false);
    expect(showAccessLevelPicker([], ANY_ACCESS_LEVEL, ANY_ACCESS_LEVEL)).toBe(false);
  });

  test("stays while a level is selected, so a filter from a link can be cleared", () => {
    expect(showAccessLevelPicker([{ level: "a" }], "gone", ANY_ACCESS_LEVEL)).toBe(true);
    expect(showAccessLevelPicker([], NO_ACCESS_LEVEL, ANY_ACCESS_LEVEL)).toBe(true);
  });
});

describe("grantAttention", () => {
  test("splits the expired grants out of the expiring count", () => {
    expect(grantAttention({ active: 10, expiring: 5, expired: 2, revoked: 1, all: 11 })).toEqual({
      expired: 2,
      expiringSoon: 3,
    });
  });

  test("never goes negative on an inconsistent summary", () => {
    expect(grantAttention({ active: 1, expiring: 0, expired: 1, revoked: 0, all: 1 }).expiringSoon).toBe(0);
  });
});

describe("seatState", () => {
  test("untracked seats have no limit and no meter", () => {
    expect(seatState({ seatsPurchased: null, seatsUsed: 12 })).toEqual({
      used: 12,
      purchased: null,
      overBy: 0,
      free: 0,
      fill: null,
    });
  });

  test("over-allocation reports how far over", () => {
    expect(seatState({ seatsPurchased: 10, seatsUsed: 13 })).toMatchObject({ overBy: 3, free: 0, fill: 1.3 });
  });

  test("zero purchased seats keep the count but no meter", () => {
    expect(seatState({ seatsPurchased: 0, seatsUsed: 0 })).toMatchObject({ purchased: 0, fill: null });
  });
});
