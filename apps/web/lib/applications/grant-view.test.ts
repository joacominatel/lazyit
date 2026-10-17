import { describe, expect, test } from "bun:test";
import type { AccessGrant } from "@lazyit/shared";
import { MS_PER_DAY } from "@/lib/record/record-state";
import {
  accessLevelOptions,
  foldSearchText,
  grantExpiryCounts,
  grantStatusCounts,
  matchesGrantStatus,
  NO_ACCESS_LEVEL,
  seatState,
  selectGrants,
  type GrantPerson,
} from "./grant-view";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const at = (days: number) => new Date(NOW + days * MS_PER_DAY).toISOString();

function grant(overrides: Partial<AccessGrant> & { id: string }): AccessGrant {
  return {
    userId: "u-ana",
    applicationId: "app",
    accessLevel: null,
    grantedAt: at(-100),
    revokedAt: null,
    expiresAt: null,
    grantedById: null,
    revokedById: null,
    notes: null,
    createdAt: at(-100),
    updatedAt: at(-100),
    ...overrides,
  };
}

const people: Record<string, GrantPerson> = {
  "u-ana": { name: "Ana Pérez", email: "ana@example.com" },
  "u-bob": { name: "Bob Smith", email: "bob@example.com" },
  "u-jose": { name: "José Díaz", email: "jdiaz@example.com" },
};
const personOf = (id: string) => people[id];

const permanent = grant({ id: "g1", userId: "u-bob", accessLevel: "admin" });
const expiringSoon = grant({ id: "g2", userId: "u-jose", expiresAt: at(10) });
const expiredAwaitingSweep = grant({ id: "g3", userId: "u-ana", expiresAt: at(-1) });
const expiringLater = grant({ id: "g4", userId: "u-ana", expiresAt: at(90), accessLevel: "viewer" });
const revokedOld = grant({ id: "g5", userId: "u-bob", revokedAt: at(-50) });
const revokedRecent = grant({ id: "g6", userId: "u-unknown", revokedAt: at(-2) });
const all = [permanent, expiringSoon, expiredAwaitingSweep, expiringLater, revokedOld, revokedRecent];

const view = (overrides: Partial<Parameters<typeof selectGrants>[1]> = {}) =>
  selectGrants(all, { status: "active", query: "", level: null, now: NOW, personOf, ...overrides });

describe("matchesGrantStatus", () => {
  test("expiring holds grants inside 30 days and expired ones the sweep has not revoked", () => {
    expect(matchesGrantStatus(expiringSoon, "expiring", NOW)).toBe(true);
    expect(matchesGrantStatus(expiredAwaitingSweep, "expiring", NOW)).toBe(true);
    expect(matchesGrantStatus(expiringLater, "expiring", NOW)).toBe(false);
    expect(matchesGrantStatus(permanent, "expiring", NOW)).toBe(false);
  });

  test("a revoked grant is never active or expiring, even with an expiry date", () => {
    const revokedWithExpiry = grant({ id: "x", revokedAt: at(-1), expiresAt: at(5) });
    expect(matchesGrantStatus(revokedWithExpiry, "active", NOW)).toBe(false);
    expect(matchesGrantStatus(revokedWithExpiry, "expiring", NOW)).toBe(false);
    expect(matchesGrantStatus(revokedWithExpiry, "revoked", NOW)).toBe(true);
  });
});

describe("grantStatusCounts and grantExpiryCounts", () => {
  test("count every view from one pass", () => {
    expect(grantStatusCounts(all, NOW)).toEqual({ active: 4, expiring: 2, revoked: 2, all: 6 });
    expect(grantExpiryCounts(all, NOW)).toEqual({ expired: 1, expiring: 1 });
  });
});

describe("selectGrants", () => {
  test("active view sorts by person name, unresolved people last", () => {
    expect(view().map((g) => g.id)).toEqual(["g3", "g4", "g1", "g2"]);
    const withUnknown = selectGrants([grant({ id: "z", userId: "u-unknown" }), permanent], {
      status: "active",
      query: "",
      level: null,
      now: NOW,
      personOf,
    });
    expect(withUnknown.map((g) => g.id)).toEqual(["g1", "z"]);
  });

  test("expiring view puts the lapsed grant first, then the nearest expiry", () => {
    expect(view({ status: "expiring" }).map((g) => g.id)).toEqual(["g3", "g2"]);
  });

  test("revoked view lists the most recent revocation first", () => {
    expect(view({ status: "revoked" }).map((g) => g.id)).toEqual(["g6", "g5"]);
  });

  test("search matches name or email, ignoring case and accents", () => {
    expect(view({ query: "jose" }).map((g) => g.id)).toEqual(["g2"]);
    expect(view({ query: "BOB@" }).map((g) => g.id)).toEqual(["g1"]);
    expect(view({ status: "all", query: "unknown" })).toEqual([]);
  });

  test("level filter matches one level, or grants recorded without one", () => {
    expect(view({ level: "admin" }).map((g) => g.id)).toEqual(["g1"]);
    expect(view({ level: NO_ACCESS_LEVEL }).map((g) => g.id)).toEqual(["g3", "g2"]);
  });
});

describe("accessLevelOptions", () => {
  test("lists each level once with its count, no-level last", () => {
    expect(accessLevelOptions(all)).toEqual([
      { level: "admin", count: 1 },
      { level: "viewer", count: 1 },
      { level: NO_ACCESS_LEVEL, count: 4 },
    ]);
  });
});

describe("foldSearchText", () => {
  test("drops diacritics and case", () => {
    expect(foldSearchText("Díaz MUÑOZ")).toBe("diaz munoz");
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
