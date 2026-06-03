import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ROLE_PERMISSIONS,
  EDITABLE_ROLES,
  MyPermissionsSchema,
  PERMISSIONS,
  PERMISSION_AUDIT_ACTIONS,
  PERMISSION_BASE_ACTIONS,
  PERMISSION_DOMAINS,
  PermissionAuditActionSchema,
  PermissionSchema,
  READ_PERMISSIONS,
  RolePermissionMatrixSchema,
  UpdateRolePermissionsSchema,
  VIEWER_DENIED_READS,
  WRITE_PERMISSIONS,
  type Permission,
} from "./permission";
import { RoleSchema } from "./user";

// Roles & Permissions v2 — foundation (ADR-0046). These guard the SHAPE of the catalog and the wire
// matrix: the catalog is the single source of truth other layers (the seed, the golden Jest test, a
// future config UI) derive from, so a malformed catalog must fail here, in the shared package.

describe("Permission catalog", () => {
  test("the zod enum mirrors the PERMISSIONS array exactly", () => {
    expect(PermissionSchema.options).toEqual([...PERMISSIONS]);
  });

  test("every permission is a well-formed `domain:action` of a known domain", () => {
    const domains = new Set<string>(PERMISSION_DOMAINS);
    for (const p of PERMISSIONS) {
      const parts = p.split(":");
      expect(parts).toHaveLength(2);
      const [domain, action] = parts;
      expect(domains.has(domain!)).toBe(true);
      expect(action!.length).toBeGreaterThan(0);
    }
  });

  test("the catalog has no duplicate literals", () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  test("every domain contributes at least a `:read` permission", () => {
    for (const domain of PERMISSION_DOMAINS) {
      expect(PERMISSIONS).toContain(`${domain}:read` as Permission);
    }
  });

  test("the three base actions are read / write / delete", () => {
    expect([...PERMISSION_BASE_ACTIONS]).toEqual(["read", "write", "delete"]);
  });

  test("the coarse capability verbs are present", () => {
    // These map 1:1 to today's ADMIN-only gates (ADR-0040) that aren't a plain write/delete.
    expect(PERMISSIONS).toContain("accessGrant:grant" as Permission);
    expect(PERMISSIONS).toContain("user:manage" as Permission);
    expect(PERMISSIONS).toContain("settings:manage" as Permission);
  });

  test("rejects an unknown permission literal", () => {
    expect(PermissionSchema.safeParse("asset:teleport").success).toBe(false);
    expect(PermissionSchema.safeParse("nope:read").success).toBe(false);
  });
});

describe("RolePermissionMatrix wire shape", () => {
  test("accepts a Role → Permission[] record for all three roles", () => {
    const matrix = {
      ADMIN: [...PERMISSIONS],
      MEMBER: ["asset:read", "asset:write"],
      VIEWER: ["asset:read"],
    };
    const result = RolePermissionMatrixSchema.safeParse(matrix);
    expect(result.success).toBe(true);
  });

  test("rejects an unknown role key", () => {
    const result = RolePermissionMatrixSchema.safeParse({
      SUPERADMIN: ["asset:read"],
    });
    expect(result.success).toBe(false);
  });

  test("rejects an unknown permission inside a role's array", () => {
    const result = RolePermissionMatrixSchema.safeParse({
      ADMIN: ["asset:read", "asset:fly"],
    });
    expect(result.success).toBe(false);
  });

  test("the matrix keys are exactly the Role enum values", () => {
    expect(new Set(RoleSchema.options)).toEqual(
      new Set(["ADMIN", "MEMBER", "VIEWER"]),
    );
  });
});

describe("DEFAULT_ROLE_PERMISSIONS (the seed source of truth)", () => {
  test("is itself a valid RolePermissionMatrix", () => {
    expect(RolePermissionMatrixSchema.safeParse(DEFAULT_ROLE_PERMISSIONS).success).toBe(
      true,
    );
  });

  test("ADMIN holds the COMPLETE catalog (immutable/full)", () => {
    expect(new Set(DEFAULT_ROLE_PERMISSIONS.ADMIN)).toEqual(new Set(PERMISSIONS));
    expect(DEFAULT_ROLE_PERMISSIONS.ADMIN).toHaveLength(PERMISSIONS.length);
  });

  test("MEMBER = all reads + all writes, and NOTHING else", () => {
    expect(new Set(DEFAULT_ROLE_PERMISSIONS.MEMBER)).toEqual(
      new Set([...READ_PERMISSIONS, ...WRITE_PERMISSIONS]),
    );
    // No delete, no coarse capability verb leaks into MEMBER.
    for (const p of DEFAULT_ROLE_PERMISSIONS.MEMBER) {
      expect(p.endsWith(":delete")).toBe(false);
      expect(["accessGrant:grant", "user:manage", "settings:manage"]).not.toContain(p);
    }
  });

  test("VIEWER = all reads EXCEPT the two pre-tightened reads", () => {
    const expected = READ_PERMISSIONS.filter(
      (p) => !VIEWER_DENIED_READS.includes(p as (typeof VIEWER_DENIED_READS)[number]),
    );
    expect(new Set(DEFAULT_ROLE_PERMISSIONS.VIEWER)).toEqual(new Set(expected));
    // VIEWER can mutate nothing.
    for (const p of DEFAULT_ROLE_PERMISSIONS.VIEWER) {
      expect(p.endsWith(":read")).toBe(true);
    }
  });

  test("the pre-tightening is EXACTLY accessGrant:read + user:read", () => {
    expect([...VIEWER_DENIED_READS].sort()).toEqual(
      ["accessGrant:read", "user:read"].sort(),
    );
    // VIEWER specifically lacks these two…
    expect(DEFAULT_ROLE_PERMISSIONS.VIEWER).not.toContain("accessGrant:read" as Permission);
    expect(DEFAULT_ROLE_PERMISSIONS.VIEWER).not.toContain("user:read" as Permission);
    // …while ADMIN and MEMBER keep them (behavior-preserving for those two roles).
    for (const role of ["ADMIN", "MEMBER"] as const) {
      expect(DEFAULT_ROLE_PERMISSIONS[role]).toContain("accessGrant:read" as Permission);
      expect(DEFAULT_ROLE_PERMISSIONS[role]).toContain("user:read" as Permission);
    }
  });

  test("every OTHER `:read` is granted to ALL THREE roles (default-open)", () => {
    const tightened = new Set<string>(VIEWER_DENIED_READS);
    for (const p of READ_PERMISSIONS) {
      if (tightened.has(p)) continue;
      for (const role of ["ADMIN", "MEMBER", "VIEWER"] as const) {
        expect(DEFAULT_ROLE_PERMISSIONS[role]).toContain(p);
      }
    }
  });
});

// Roles & Permissions v2 — P5: the configurable surface (ADR-0046 §Phased delivery P5). These guard
// the wire contracts of the ADMIN config endpoints and the caller's effective-permission response.

describe("UpdateRolePermissionsSchema (PUT /config/permissions body)", () => {
  test("accepts a body with both editable roles and valid catalog permissions", () => {
    const result = UpdateRolePermissionsSchema.safeParse({
      MEMBER: ["asset:read", "asset:write", "asset:delete"],
      VIEWER: ["asset:read"],
    });
    expect(result.success).toBe(true);
  });

  test("the editable roles are exactly MEMBER + VIEWER (ADMIN is immutable)", () => {
    expect([...EDITABLE_ROLES].sort()).toEqual(["MEMBER", "VIEWER"]);
  });

  test("rejects an ADMIN key — the ADMIN row is immutable (strict body)", () => {
    const result = UpdateRolePermissionsSchema.safeParse({
      ADMIN: ["asset:read"],
      MEMBER: ["asset:read"],
      VIEWER: ["asset:read"],
    });
    expect(result.success).toBe(false);
  });

  test("rejects any unknown extra key (strict body)", () => {
    const result = UpdateRolePermissionsSchema.safeParse({
      MEMBER: ["asset:read"],
      VIEWER: ["asset:read"],
      SUPERADMIN: ["asset:read"],
    });
    expect(result.success).toBe(false);
  });

  test("rejects an unknown permission literal → caller gets a 400", () => {
    const result = UpdateRolePermissionsSchema.safeParse({
      MEMBER: ["asset:read", "asset:teleport"],
      VIEWER: ["asset:read"],
    });
    expect(result.success).toBe(false);
  });

  test("requires BOTH MEMBER and VIEWER (a full PUT, not a patch)", () => {
    expect(UpdateRolePermissionsSchema.safeParse({ MEMBER: [] }).success).toBe(false);
    expect(UpdateRolePermissionsSchema.safeParse({ VIEWER: [] }).success).toBe(false);
  });

  test("accepts empty permission sets (a role may hold nothing)", () => {
    const result = UpdateRolePermissionsSchema.safeParse({ MEMBER: [], VIEWER: [] });
    expect(result.success).toBe(true);
  });

  test("deduplicates a role's permission list", () => {
    const result = UpdateRolePermissionsSchema.parse({
      MEMBER: ["asset:read", "asset:read", "asset:write"],
      VIEWER: [],
    });
    expect(result.MEMBER).toEqual(["asset:read", "asset:write"]);
  });
});

describe("MyPermissionsSchema (GET /config/my-permissions response)", () => {
  test("accepts a role + its catalog permission list", () => {
    const result = MyPermissionsSchema.safeParse({
      role: "MEMBER",
      permissions: ["asset:read", "asset:write"],
    });
    expect(result.success).toBe(true);
  });

  test("rejects an unknown role", () => {
    const result = MyPermissionsSchema.safeParse({
      role: "ROBOT",
      permissions: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects an unknown permission in the list", () => {
    const result = MyPermissionsSchema.safeParse({
      role: "ADMIN",
      permissions: ["asset:fly"],
    });
    expect(result.success).toBe(false);
  });
});

describe("PermissionAuditActionSchema (audit direction)", () => {
  test("the audited actions are exactly grant + revoke", () => {
    expect([...PERMISSION_AUDIT_ACTIONS].sort()).toEqual(["grant", "revoke"]);
    expect(PermissionAuditActionSchema.safeParse("grant").success).toBe(true);
    expect(PermissionAuditActionSchema.safeParse("revoke").success).toBe(true);
    expect(PermissionAuditActionSchema.safeParse("toggle").success).toBe(false);
  });
});
