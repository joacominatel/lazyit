import { describe, expect, test } from "bun:test";
import {
  CreateSoftwareWatchSchema,
  SOFTWARE_WATCH_NAME_MAX,
  SoftwareWatchHostPageSchema,
  SoftwareWatchNameSchema,
  SoftwareWatchSummarySchema,
  compareVersionText,
  normalizeSoftwareName,
  summarizeSoftwareWatch,
  type SoftwareWatchHost,
} from "./agent-fleet";

// The software watchlist contract (#1684, split from epic #1146 item 4). It lives in agent-fleet.ts
// beside the fleet view; this file only pins the watchlist half.

describe("normalizeSoftwareName", () => {
  test("lower-cases, trims and collapses whitespace runs", () => {
    expect(normalizeSoftwareName("  OpenSSL ")).toBe("openssl");
    expect(normalizeSoftwareName("Mozilla\t\tFirefox  ESR")).toBe("mozilla firefox esr");
    expect(normalizeSoftwareName("\nLibSSL3\n")).toBe("libssl3");
  });

  test("is idempotent", () => {
    const once = normalizeSoftwareName("  Microsoft   Edge  ");
    expect(normalizeSoftwareName(once)).toBe(once);
  });

  test("does NOT fold architecture suffixes, versions or vendor spellings (no product normalization)", () => {
    expect(normalizeSoftwareName("libssl3:amd64")).not.toBe(normalizeSoftwareName("libssl3"));
    expect(normalizeSoftwareName("Mozilla Firefox (x64 en-US)")).not.toBe(
      normalizeSoftwareName("Mozilla Firefox"),
    );
  });

  test("keeps glob characters literal — a watch is an exact name, not a pattern", () => {
    expect(normalizeSoftwareName("linux-image-*")).toBe("linux-image-*");
  });
});

describe("SoftwareWatchNameSchema / CreateSoftwareWatchSchema", () => {
  test("stores the normalized form", () => {
    expect(SoftwareWatchNameSchema.parse("  OpenSSH-Server ")).toBe("openssh-server");
    expect(CreateSoftwareWatchSchema.parse({ name: "OpenSSL" })).toEqual({ name: "openssl" });
  });

  test("refuses an empty or whitespace-only name", () => {
    expect(SoftwareWatchNameSchema.safeParse("").success).toBe(false);
    expect(SoftwareWatchNameSchema.safeParse("   \t ").success).toBe(false);
  });

  test("bounds the NORMALIZED name at the report contract's own package-name cap", () => {
    expect(SoftwareWatchNameSchema.safeParse("a".repeat(SOFTWARE_WATCH_NAME_MAX)).success).toBe(true);
    expect(SoftwareWatchNameSchema.safeParse("a".repeat(SOFTWARE_WATCH_NAME_MAX + 1)).success).toBe(
      false,
    );
    // Surrounding whitespace does not count against the cap — it is gone before the bound applies.
    expect(
      SoftwareWatchNameSchema.safeParse(`   ${"a".repeat(SOFTWARE_WATCH_NAME_MAX)}   `).success,
    ).toBe(true);
  });

  test("the create body is strict — nothing else can be set", () => {
    expect(CreateSoftwareWatchSchema.safeParse({ name: "curl", createdById: "x" }).success).toBe(false);
    expect(CreateSoftwareWatchSchema.safeParse({}).success).toBe(false);
  });
});

/** A minimal host row; each test overrides only what it is about. */
function host(over: Partial<SoftwareWatchHost> = {}): SoftwareWatchHost {
  return {
    id: "clh0000000000000000000000",
    label: "web-01",
    kind: "PHYSICAL_HOST",
    status: "ONLINE",
    pending: false,
    lastReportedAt: null,
    inventoryCollectedAt: null,
    presence: "MISSING",
    versions: [],
    unknownReason: null,
    ...over,
  };
}

describe("summarizeSoftwareWatch", () => {
  test("every host lands in exactly one presence, and the three sum to hostsTotal", () => {
    const d = summarizeSoftwareWatch([
      host({ presence: "INSTALLED", versions: ["3.0.13"] }),
      host({ presence: "INSTALLED", versions: ["3.0.13"] }),
      host({ presence: "INSTALLED", versions: ["1.1.1w"] }),
      host({ presence: "MISSING" }),
      host({ presence: "UNKNOWN", unknownReason: "NOT_COLLECTED" }),
      host({ presence: "UNKNOWN", unknownReason: "EXCLUDED_BY_POLICY" }),
    ]);
    expect(d).toEqual({
      hostsTotal: 6,
      installed: 3,
      missing: 1,
      unknown: 2,
      versions: [
        { version: "3.0.13", hosts: 2 },
        { version: "1.1.1w", hosts: 1 },
      ],
    });
    expect(d.installed + d.missing + d.unknown).toBe(d.hostsTotal);
  });

  test("an UNKNOWN host is never counted as missing", () => {
    const d = summarizeSoftwareWatch([host({ presence: "UNKNOWN", unknownReason: "NOT_COLLECTED" })]);
    expect(d.missing).toBe(0);
    expect(d.unknown).toBe(1);
  });

  test("a host with two versions counts once per bucket but once in installed", () => {
    const d = summarizeSoftwareWatch([
      host({ presence: "INSTALLED", versions: ["6.1.0-17", "6.1.0-18"] }),
      host({ presence: "INSTALLED", versions: ["6.1.0-18", "6.1.0-18"] }),
    ]);
    expect(d.installed).toBe(2);
    expect(d.versions).toEqual([
      { version: "6.1.0-18", hosts: 2 },
      { version: "6.1.0-17", hosts: 1 },
    ]);
  });

  test("no version and an empty version share the null bucket, which sorts last on a tie", () => {
    const d = summarizeSoftwareWatch([
      host({ presence: "INSTALLED", versions: [null] }),
      host({ presence: "INSTALLED", versions: [""] }),
      host({ presence: "INSTALLED", versions: ["2.0", "2.0"] }),
      host({ presence: "INSTALLED", versions: ["2.0"] }),
    ]);
    expect(d.versions).toEqual([
      { version: "2.0", hosts: 2 },
      { version: null, hosts: 2 },
    ]);
  });

  test("an empty fleet is all zeros", () => {
    expect(summarizeSoftwareWatch([])).toEqual({
      hostsTotal: 0,
      installed: 0,
      missing: 0,
      unknown: 0,
      versions: [],
    });
  });
});

describe("compareVersionText — a stable display order, NOT a version comparison", () => {
  test("plain code-unit order: 10.0 sorts before 9.1", () => {
    expect(compareVersionText("10.0", "9.1")).toBeLessThan(0);
  });
  test("null sorts last; equal is zero", () => {
    expect(compareVersionText(null, "1")).toBeGreaterThan(0);
    expect(compareVersionText("1", null)).toBeLessThan(0);
    expect(compareVersionText(null, null)).toBe(0);
    expect(compareVersionText("1", "1")).toBe(0);
  });
});

describe("wire shapes", () => {
  test("a summary row parses", () => {
    const parsed = SoftwareWatchSummarySchema.parse({
      id: "clh0000000000000000000000",
      name: "openssl",
      createdAt: "2026-10-21T10:00:00.000Z",
      createdById: null,
      createdByName: null,
      distribution: summarizeSoftwareWatch([host({ presence: "INSTALLED", versions: ["3.0.13"] })]),
    });
    expect(parsed.distribution.installed).toBe(1);
  });

  test("the host page is the house Page<T> envelope", () => {
    const parsed = SoftwareWatchHostPageSchema.parse({
      items: [host({ presence: "UNKNOWN", unknownReason: "NOT_COLLECTED" })],
      total: 1,
      limit: 50,
      offset: 0,
    });
    expect(parsed.items[0]?.unknownReason).toBe("NOT_COLLECTED");
  });
});
