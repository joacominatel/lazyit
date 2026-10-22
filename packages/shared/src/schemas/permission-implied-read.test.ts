import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ROLE_PERMISSIONS,
  EDITABLE_ROLES,
  IMPLIED_READS,
  PERMISSIONS,
  READ_IMPLICATION_EXEMPT,
  dependentsOfRead,
  impliedReadOf,
  missingImpliedReads,
  withImpliedReads,
  withoutOrphanedDependents,
  type Permission,
} from "./permission";
import { PERMISSION_PRESETS } from "./permission-meta";

// Write implies read (#1518, CEO decision 2026-10-21): a role holding a non-read verb on a domain must
// hold that domain's read. The mapping is derived from the catalog, so these tests pin the derivation,
// the explicit exemptions, and that every shipped default and preset already obeys the rule (an
// upgrade never needs to heal a default).

describe("IMPLIED_READS (derived from the catalog)", () => {
  test("maps the usual verbs of a domain to its read", () => {
    expect(impliedReadOf("asset:write")).toBe("asset:read");
    expect(impliedReadOf("asset:delete")).toBe("asset:read");
    expect(impliedReadOf("accessGrant:grant")).toBe("accessGrant:read");
    expect(impliedReadOf("accessGrant:write")).toBe("accessGrant:read");
    expect(impliedReadOf("user:manage")).toBe("user:read");
    expect(impliedReadOf("article:manage")).toBe("article:read");
    expect(impliedReadOf("settings:manage")).toBe("settings:read");
    expect(impliedReadOf("secret:manage")).toBe("secret:read");
    expect(impliedReadOf("infra:manage")).toBe("infra:read");
    for (const verb of ["manage", "run", "task", "secrets"] as const) {
      expect(impliedReadOf(`workflow:${verb}`)).toBe("workflow:read");
    }
  });

  test("a read implies nothing", () => {
    for (const p of PERMISSIONS.filter((p) => p.endsWith(":read"))) {
      expect(impliedReadOf(p)).toBeUndefined();
    }
  });

  test("the exempt verbs and the verbs of read-less domains imply nothing", () => {
    for (const p of READ_IMPLICATION_EXEMPT) expect(impliedReadOf(p)).toBeUndefined();
    for (const p of ["import:run", "ai:use", "ai:connect"] as const) {
      expect(impliedReadOf(p)).toBeUndefined();
    }
  });

  test("covers EVERY non-read verb of a domain that has a read, except the exemptions", () => {
    const unmapped = PERMISSIONS.filter(
      (p) =>
        !p.endsWith(":read") &&
        PERMISSIONS.includes(`${p.split(":")[0]}:read` as Permission) &&
        IMPLIED_READS[p] === undefined,
    );
    expect(unmapped).toEqual([...READ_IMPLICATION_EXEMPT]);
  });

  test("every implied read is a catalog read of the same domain", () => {
    for (const [p, read] of Object.entries(IMPLIED_READS)) {
      expect(read).toBe(`${p.split(":")[0]}:read` as Permission);
      expect(PERMISSIONS).toContain(read as Permission);
    }
  });

  test("dependentsOfRead is the inverse map", () => {
    expect(dependentsOfRead("asset:read")).toEqual(["asset:write", "asset:delete"]);
    expect(dependentsOfRead("accessRequest:read")).toEqual([]);
    expect(dependentsOfRead("dashboard:read")).toEqual([]);
  });
});

describe("missingImpliedReads / withImpliedReads / withoutOrphanedDependents", () => {
  test("a set with a write and its read is valid", () => {
    expect(missingImpliedReads(["asset:read", "asset:write"])).toEqual([]);
  });

  test("lists each write-without-read, in catalog order", () => {
    expect(
      missingImpliedReads(["user:manage", "asset:delete", "asset:write", "location:read"]),
    ).toEqual([
      { permission: "asset:write", requires: "asset:read" },
      { permission: "asset:delete", requires: "asset:read" },
      { permission: "user:manage", requires: "user:read" },
    ]);
  });

  test("withImpliedReads only ADDS the reads (never drops the write)", () => {
    expect(withImpliedReads(["asset:write", "user:manage", "ai:use"])).toEqual([
      "asset:read",
      "asset:write",
      "user:read",
      "user:manage",
      "ai:use",
    ]);
    expect(missingImpliedReads(withImpliedReads(["workflow:secrets"]))).toEqual([]);
  });

  test("withoutOrphanedDependents only REMOVES the writes whose read is gone (never adds)", () => {
    expect(
      withoutOrphanedDependents(["asset:write", "asset:delete", "location:read", "location:write"]),
    ).toEqual(["location:read", "location:write"]);
  });

  test("the self-service request needs no estate-wide read", () => {
    expect(missingImpliedReads(["accessRequest:create"])).toEqual([]);
  });
});

describe("every shipped default and preset already obeys the rule", () => {
  test("the seeded MEMBER and VIEWER defaults", () => {
    for (const role of EDITABLE_ROLES) {
      expect(missingImpliedReads(DEFAULT_ROLE_PERMISSIONS[role])).toEqual([]);
    }
  });

  test("every preset", () => {
    for (const preset of PERMISSION_PRESETS) {
      expect(missingImpliedReads(preset.permissions)).toEqual([]);
    }
  });
});
