/**
 * The software watchlist's pure rules (#1684). The two that matter most are the ones the screen could
 * use to lie: UNKNOWN drawn as MISSING, and the "no version" drill-in widened to every host.
 */
import { describe, expect, test } from "bun:test";
import {
  SOFTWARE_WATCH_LIMIT,
  SOFTWARE_WATCH_NAME_MAX,
  type SoftwareWatchDistribution,
  summarizeSoftwareWatch,
} from "@lazyit/shared";
import {
  fleetSectionFromParam,
  fleetSectionParam,
  judgeWatchName,
  SOFTWARE_WATCH_HOSTS_PAGE,
  softwareWatchBucketCount,
  softwareWatchBucketKey,
  softwareWatchHostsQuery,
  softwareWatchNodeHref,
  softwareWatchPresenceSegments,
  softwareWatchVisibleVersions,
} from "./software-watch";

function distribution(partial: Partial<SoftwareWatchDistribution> = {}): SoftwareWatchDistribution {
  return { hostsTotal: 0, installed: 0, missing: 0, unknown: 0, versions: [], ...partial };
}

describe("fleet section param", () => {
  test("only `software` selects the watchlist; anything else is the agents list", () => {
    expect(fleetSectionFromParam("software")).toBe("software");
    expect(fleetSectionFromParam("agents")).toBe("agents");
    expect(fleetSectionFromParam(null)).toBe("agents");
    expect(fleetSectionFromParam(undefined)).toBe("agents");
    expect(fleetSectionFromParam("SOFTWARE")).toBe("agents");
    expect(fleetSectionFromParam("<script>")).toBe("agents");
  });

  test("the default section is written as an absent param", () => {
    expect(fleetSectionParam("agents")).toBeUndefined();
    expect(fleetSectionParam("software")).toBe("software");
  });
});

describe("softwareWatchHostsQuery", () => {
  test("a presence bucket sends presence, the page size and the offset", () => {
    const qs = new URLSearchParams(
      softwareWatchHostsQuery({ kind: "presence", presence: "MISSING" }, 50),
    );
    expect(qs.get("presence")).toBe("MISSING");
    expect(qs.has("version")).toBe(false);
    expect(qs.get("limit")).toBe(String(SOFTWARE_WATCH_HOSTS_PAGE));
    expect(qs.get("offset")).toBe("50");
  });

  test("UNKNOWN is asked for as its own presence, never folded into MISSING", () => {
    const qs = new URLSearchParams(
      softwareWatchHostsQuery({ kind: "presence", presence: "UNKNOWN" }, 0),
    );
    expect(qs.getAll("presence")).toEqual(["UNKNOWN"]);
  });

  test("a version bucket sends the version alone — pairing it with a presence is a 400", () => {
    const qs = new URLSearchParams(
      softwareWatchHostsQuery({ kind: "version", version: "3.0.13-0ubuntu3" }, 0),
    );
    expect(qs.get("version")).toBe("3.0.13-0ubuntu3");
    expect(qs.has("presence")).toBe(false);
  });

  test("the no-version bucket is an EMPTY version, not an absent key (which would mean every host)", () => {
    const raw = softwareWatchHostsQuery({ kind: "version", version: null }, 0);
    const qs = new URLSearchParams(raw);
    expect(qs.has("version")).toBe(true);
    expect(qs.get("version")).toBe("");
    expect(raw).toContain("version=&");
  });

  test("a version with URL-significant characters survives the round trip", () => {
    const version = "1:2.4+dfsg&x=y #1";
    const qs = new URLSearchParams(softwareWatchHostsQuery({ kind: "version", version }, 0));
    expect(qs.get("version")).toBe(version);
  });

  test("a negative or fractional offset is clamped to a valid one", () => {
    const presence = { kind: "presence", presence: "INSTALLED" } as const;
    expect(new URLSearchParams(softwareWatchHostsQuery(presence, -10)).get("offset")).toBe("0");
    expect(new URLSearchParams(softwareWatchHostsQuery(presence, 12.7)).get("offset")).toBe("12");
  });
});

describe("bucket keys and counts", () => {
  const d = distribution({
    hostsTotal: 10,
    installed: 6,
    missing: 1,
    unknown: 3,
    versions: [
      { version: "3.0.13", hosts: 4 },
      { version: null, hosts: 2 },
    ],
  });

  test("the null bucket and a version literally named `null` never share a key", () => {
    const keys = new Set([
      softwareWatchBucketKey({ kind: "version", version: null }),
      softwareWatchBucketKey({ kind: "version", version: "null" }),
      softwareWatchBucketKey({ kind: "presence", presence: "INSTALLED" }),
      softwareWatchBucketKey({ kind: "presence", presence: "MISSING" }),
      softwareWatchBucketKey({ kind: "presence", presence: "UNKNOWN" }),
    ]);
    expect(keys.size).toBe(5);
  });

  test("counts come from the distribution already on screen", () => {
    expect(softwareWatchBucketCount(d, { kind: "presence", presence: "INSTALLED" })).toBe(6);
    expect(softwareWatchBucketCount(d, { kind: "presence", presence: "MISSING" })).toBe(1);
    expect(softwareWatchBucketCount(d, { kind: "presence", presence: "UNKNOWN" })).toBe(3);
    expect(softwareWatchBucketCount(d, { kind: "version", version: "3.0.13" })).toBe(4);
    expect(softwareWatchBucketCount(d, { kind: "version", version: null })).toBe(2);
  });

  test("a bucket that has since disappeared reads 0, never throws", () => {
    expect(softwareWatchBucketCount(d, { kind: "version", version: "9.9" })).toBe(0);
  });
});

describe("softwareWatchPresenceSegments", () => {
  test("UNKNOWN is its own segment, separate from MISSING", () => {
    const segments = softwareWatchPresenceSegments(
      distribution({ hostsTotal: 10, installed: 5, missing: 2, unknown: 3 }),
    );
    expect(segments.map((segment) => segment.presence)).toEqual(["INSTALLED", "MISSING", "UNKNOWN"]);
    expect(segments.find((segment) => segment.presence === "MISSING")?.hosts).toBe(2);
    expect(segments.find((segment) => segment.presence === "UNKNOWN")?.hosts).toBe(3);
  });

  test("the segments partition the population: they sum to 100%", () => {
    const segments = softwareWatchPresenceSegments(
      distribution({ hostsTotal: 7, installed: 3, missing: 1, unknown: 3 }),
    );
    const total = segments.reduce((sum, segment) => sum + segment.percent, 0);
    expect(total).toBeCloseTo(100, 10);
  });

  test("a fleet with software collection off everywhere is all UNKNOWN, zero MISSING", () => {
    const segments = softwareWatchPresenceSegments(
      summarizeSoftwareWatch([
        { presence: "UNKNOWN", versions: [] },
        { presence: "UNKNOWN", versions: [] },
      ]),
    );
    expect(segments).toEqual([{ presence: "UNKNOWN", hosts: 2, percent: 100 }]);
  });

  test("empty presences draw nothing, and an empty population draws no bar at all", () => {
    expect(
      softwareWatchPresenceSegments(distribution({ hostsTotal: 4, installed: 4 })).map(
        (segment) => segment.presence,
      ),
    ).toEqual(["INSTALLED"]);
    expect(softwareWatchPresenceSegments(distribution())).toEqual([]);
  });
});

describe("softwareWatchVisibleVersions", () => {
  test("keeps the API's host-count order — it never re-sorts into a version order", () => {
    // Host count first, then plain text: `10.0` before `9.1` would be "newest first" only by accident.
    const d = summarizeSoftwareWatch([
      { presence: "INSTALLED", versions: ["9.1"] },
      { presence: "INSTALLED", versions: ["9.1"] },
      { presence: "INSTALLED", versions: ["10.0"] },
      { presence: "INSTALLED", versions: ["1.2"] },
      { presence: "INSTALLED", versions: ["1.2"] },
      { presence: "INSTALLED", versions: ["1.2"] },
    ]);
    const { shown, hidden } = softwareWatchVisibleVersions(d, 10);
    expect(shown.map((entry) => entry.version)).toEqual(["1.2", "9.1", "10.0"]);
    expect(hidden).toBe(0);
  });

  test("a long tail is cut to the limit and the remainder is counted", () => {
    const d = distribution({
      versions: Array.from({ length: 12 }, (_, i) => ({ version: `v${i}`, hosts: 12 - i })),
    });
    const { shown, hidden } = softwareWatchVisibleVersions(d, 8);
    expect(shown).toHaveLength(8);
    expect(shown[0]?.version).toBe("v0");
    expect(hidden).toBe(4);
  });
});

describe("judgeWatchName", () => {
  test("blank input is `empty`, not an error", () => {
    expect(judgeWatchName("", [])).toEqual({ state: "empty" });
    expect(judgeWatchName("   \t ", [])).toEqual({ state: "empty" });
  });

  test("returns the normalized name that will be stored", () => {
    expect(judgeWatchName("  OpenSSL   Server ", [])).toEqual({
      state: "ok",
      normalized: "openssl server",
    });
  });

  test("a duplicate is caught on the normalized form", () => {
    expect(judgeWatchName(" OPENSSL", [{ name: "openssl" }])).toEqual({
      state: "duplicate",
      normalized: "openssl",
    });
  });

  test("no product folding: an architecture suffix is a different name", () => {
    expect(judgeWatchName("libssl3:amd64", [{ name: "libssl3" }]).state).toBe("ok");
  });

  test("an over-long name is invalid", () => {
    expect(judgeWatchName("a".repeat(SOFTWARE_WATCH_NAME_MAX + 1), []).state).toBe("invalid");
    expect(judgeWatchName("a".repeat(SOFTWARE_WATCH_NAME_MAX), []).state).toBe("ok");
  });

  test("the instance cap stops the form before the API has to", () => {
    const full = Array.from({ length: SOFTWARE_WATCH_LIMIT }, (_, i) => ({ name: `pkg-${i}` }));
    expect(judgeWatchName("curl", full)).toEqual({ state: "limit" });
    expect(judgeWatchName("curl", full.slice(1)).state).toBe("ok");
  });
});

test("softwareWatchNodeHref deep-links the node on the Map", () => {
  expect(softwareWatchNodeHref("cl123")).toBe("/assets/diagram?view=map&node=cl123");
});
