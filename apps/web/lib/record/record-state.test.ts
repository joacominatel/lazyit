import { describe, expect, test } from "bun:test";
import type { AccessGrant, AssetAssignment } from "@lazyit/shared";
import {
  closedRecordHistory,
  expiryState,
  MS_PER_DAY,
  resolveRecordTab,
  sortGrantsByUrgency,
} from "./record-state";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const at = (days: number) => new Date(NOW + days * MS_PER_DAY).toISOString();

describe("expiryState", () => {
  test("no date, or an unparseable one, is none", () => {
    expect(expiryState(null, NOW, 90)).toEqual({ kind: "none" });
    expect(expiryState(undefined, NOW, 90)).toEqual({ kind: "none" });
    expect(expiryState("not-a-date", NOW, 90)).toEqual({ kind: "none" });
  });

  test("beyond the window is active", () => {
    expect(expiryState(at(91), NOW, 90)).toEqual({ kind: "active", days: 91 });
  });

  test("inside the window is expiring, with days rounded up", () => {
    expect(expiryState(at(90), NOW, 90)).toEqual({ kind: "expiring", days: 90 });
    expect(expiryState(at(42), NOW, 90)).toEqual({ kind: "expiring", days: 42 });
    expect(expiryState(at(0.1), NOW, 90)).toEqual({ kind: "expiring", days: 1 });
  });

  test("at or past now is expired, with days rounded down", () => {
    expect(expiryState(at(0), NOW, 90)).toEqual({ kind: "expired", days: 0 });
    expect(expiryState(at(-0.5), NOW, 90)).toEqual({ kind: "expired", days: 0 });
    expect(expiryState(at(-3), NOW, 90)).toEqual({ kind: "expired", days: 3 });
  });

  test("the window is the caller's", () => {
    expect(expiryState(at(20), NOW, 14).kind).toBe("active");
    expect(expiryState(at(20), NOW, 30).kind).toBe("expiring");
  });
});

describe("resolveRecordTab", () => {
  const tabs = ["overview", "activity", "documents"] as const;

  test("a visible tab resolves to itself", () => {
    expect(resolveRecordTab("activity", tabs, "overview")).toBe("activity");
  });

  test("a missing, unknown or hidden tab falls back", () => {
    expect(resolveRecordTab(null, tabs, "overview")).toBe("overview");
    expect(resolveRecordTab(undefined, tabs, "overview")).toBe("overview");
    expect(resolveRecordTab("consumables", tabs, "overview")).toBe("overview");
    expect(resolveRecordTab("", tabs, "overview")).toBe("overview");
  });
});

function grant(
  id: string,
  over: Partial<AccessGrant> = {},
): AccessGrant {
  return {
    id,
    userId: "11111111-1111-4111-8111-111111111111",
    applicationId: `app-${id}`,
    accessLevel: null,
    grantedAt: at(-100),
    revokedAt: null,
    expiresAt: null,
    grantedById: null,
    revokedById: null,
    notes: null,
    createdAt: at(-100),
    updatedAt: at(-100),
    ...over,
  } as AccessGrant;
}

describe("sortGrantsByUrgency", () => {
  test("expired, then expiring soonest first, then newest granted", () => {
    const sorted = sortGrantsByUrgency(
      [
        grant("old", { grantedAt: at(-300) }),
        grant("soon-late", { expiresAt: at(25) }),
        grant("new", { grantedAt: at(-2) }),
        grant("lapsed", { expiresAt: at(-1) }),
        grant("soon-early", { expiresAt: at(3) }),
        grant("far", { expiresAt: at(200), grantedAt: at(-50) }),
      ],
      NOW,
    );
    expect(sorted.map((g) => g.id)).toEqual([
      "lapsed",
      "soon-early",
      "soon-late",
      "new",
      "far",
      "old",
    ]);
  });

  test("does not mutate its input", () => {
    const input = [grant("b", { grantedAt: at(-5) }), grant("a", { expiresAt: at(-1) })];
    sortGrantsByUrgency(input, NOW);
    expect(input.map((g) => g.id)).toEqual(["b", "a"]);
  });
});

function assignment(
  id: string,
  over: Partial<AssetAssignment> = {},
): AssetAssignment {
  return {
    id,
    assetId: `asset-${id}`,
    userId: "11111111-1111-4111-8111-111111111111",
    assignedAt: at(-60),
    releasedAt: null,
    assignedById: null,
    releasedById: null,
    notes: null,
    createdAt: at(-60),
    updatedAt: at(-60),
    ...over,
  } as AssetAssignment;
}

describe("closedRecordHistory", () => {
  test("merges released assignments and revoked grants, most recently closed first", () => {
    const history = closedRecordHistory(
      [
        assignment("live"),
        assignment("returned", { releasedAt: at(-10), notes: "Swapped" }),
      ],
      [
        grant("active"),
        grant("revoked", { revokedAt: at(-5), accessLevel: "Editor" }),
      ],
    );
    expect(history).toEqual([
      {
        kind: "access",
        id: "revoked",
        refId: "app-revoked",
        start: at(-100),
        end: at(-5),
        accessLevel: "Editor",
      },
      {
        kind: "asset",
        id: "returned",
        refId: "asset-returned",
        start: at(-60),
        end: at(-10),
        notes: "Swapped",
      },
    ]);
  });

  test("empty inputs give an empty history", () => {
    expect(closedRecordHistory([], [])).toEqual([]);
  });
});
