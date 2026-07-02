import { describe, expect, test } from "bun:test";
import {
  compareSemver,
  countVersionsBehind,
  isNewerVersion,
  maxVersion,
  parseSemver,
} from "./semver";

describe("parseSemver", () => {
  test("parses a clean vX.Y.Z tag", () => {
    expect(parseSemver("v1.4.2")).toEqual({ major: 1, minor: 4, patch: 2 });
  });

  test("tolerates a missing leading v", () => {
    expect(parseSemver("2.0.0")).toEqual({ major: 2, minor: 0, patch: 0 });
  });

  test("ignores the git-describe off-tag suffix", () => {
    expect(parseSemver("v1.4.2-3-gabc1234")).toEqual({
      major: 1,
      minor: 4,
      patch: 2,
    });
  });

  test("ignores a pre-release / build suffix", () => {
    expect(parseSemver("v1.5.0-rc.1")).toEqual({ major: 1, minor: 5, patch: 0 });
    expect(parseSemver("1.5.0+build.7")).toEqual({ major: 1, minor: 5, patch: 0 });
  });

  test("returns null for the native-dev fallbacks and junk", () => {
    for (const v of ["dev", "unknown", "", "  ", "v1", "v1.2", "banana", null, undefined]) {
      expect(parseSemver(v as string)).toBeNull();
    }
  });
});

describe("compareSemver", () => {
  test("orders major, then minor, then patch", () => {
    expect(compareSemver({ major: 2, minor: 0, patch: 0 }, { major: 1, minor: 9, patch: 9 })).toBeGreaterThan(0);
    expect(compareSemver({ major: 1, minor: 2, patch: 0 }, { major: 1, minor: 1, patch: 9 })).toBeGreaterThan(0);
    expect(compareSemver({ major: 1, minor: 1, patch: 2 }, { major: 1, minor: 1, patch: 1 })).toBeGreaterThan(0);
    expect(compareSemver({ major: 1, minor: 1, patch: 1 }, { major: 1, minor: 1, patch: 1 })).toBe(0);
  });
});

describe("isNewerVersion", () => {
  test("true only when strictly newer", () => {
    expect(isNewerVersion("v1.5.0", "v1.4.2")).toBe(true);
    expect(isNewerVersion("v1.4.2", "v1.4.2")).toBe(false);
    expect(isNewerVersion("v1.4.1", "v1.4.2")).toBe(false);
  });

  test("fail-soft: unparseable either side is never 'newer'", () => {
    expect(isNewerVersion("v1.5.0", "dev")).toBe(false);
    expect(isNewerVersion("garbage", "v1.4.2")).toBe(false);
    expect(isNewerVersion(null, null)).toBe(false);
  });

  test("compares the numeric core across describe forms", () => {
    // A running off-tag build vs a clean latest tag.
    expect(isNewerVersion("v1.5.0", "v1.4.2-3-gabc1234")).toBe(true);
  });
});

describe("countVersionsBehind", () => {
  const releases = ["v1.6.0", "v1.5.0", "v1.4.2", "v1.4.1", "v1.4.0"];

  test("counts strictly-newer releases", () => {
    expect(countVersionsBehind("v1.4.2", releases)).toBe(2); // 1.5.0, 1.6.0
    expect(countVersionsBehind("v1.6.0", releases)).toBe(0);
    expect(countVersionsBehind("v1.4.0", releases)).toBe(4);
  });

  test("unparseable current ⇒ 0 (never alarm on dev)", () => {
    expect(countVersionsBehind("dev", releases)).toBe(0);
  });

  test("ignores unparseable release entries", () => {
    expect(countVersionsBehind("v1.4.2", ["v1.5.0", "nightly", "latest"])).toBe(1);
  });
});

describe("maxVersion", () => {
  test("returns the highest tag", () => {
    expect(maxVersion(["v1.4.2", "v1.6.0", "v1.5.0"])).toBe("v1.6.0");
  });

  test("null when nothing parses", () => {
    expect(maxVersion(["dev", "nightly"])).toBeNull();
  });
});
