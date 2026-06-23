import { describe, expect, test } from "bun:test";
import {
  ADMIN_ONLY_READS,
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

  test("every domain contributes at least one permission, and every read-surfaced domain a `:read`", () => {
    // Every domain must contribute at least one catalog literal.
    for (const domain of PERMISSION_DOMAINS) {
      expect(PERMISSIONS.some((p) => p.startsWith(`${domain}:`))).toBe(true);
    }
    // Every domain EXCEPT `import` exposes a `:read` (the readable surface of the app). `import`
    // (the guided Migrator, ADR-0069) is deliberately RUN-ONLY: it has a single coarse `import:run`
    // verb and no browse surface — an import session is owner-scoped transient scratch, not a listable
    // domain — so it intentionally has no `import:read`.
    const RUN_ONLY_DOMAINS = new Set<string>(["import"]);
    for (const domain of PERMISSION_DOMAINS) {
      if (RUN_ONLY_DOMAINS.has(domain)) continue;
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

describe("Workflow permissions (Applications Workflow Engine, epic #248)", () => {
  const WORKFLOW_PERMISSIONS = [
    "workflow:read",
    "workflow:manage",
    "workflow:run",
    "workflow:task",
    "workflow:secrets",
  ] as const satisfies readonly Permission[];

  test("the `workflow` domain is in the catalog with all five verbs", () => {
    expect(PERMISSION_DOMAINS).toContain("workflow");
    for (const p of WORKFLOW_PERMISSIONS) {
      expect(PERMISSIONS).toContain(p);
    }
  });

  test("workflow:secrets is DISTINCT from workflow:manage (separation of duties)", () => {
    expect(PERMISSIONS).toContain("workflow:secrets" as Permission);
    expect(PERMISSIONS).toContain("workflow:manage" as Permission);
    expect("workflow:secrets").not.toBe("workflow:manage");
  });

  test("workflow:read is an admin-only read (treated like logs:read)", () => {
    expect(ADMIN_ONLY_READS).toContain("workflow:read");
  });

  test("SAFE DEFAULT: every workflow verb is ADMIN-only — MEMBER/VIEWER hold none", () => {
    for (const p of WORKFLOW_PERMISSIONS) {
      expect(DEFAULT_ROLE_PERMISSIONS.ADMIN).toContain(p);
      expect(DEFAULT_ROLE_PERMISSIONS.MEMBER).not.toContain(p);
      expect(DEFAULT_ROLE_PERMISSIONS.VIEWER).not.toContain(p);
    }
  });
});

describe("Notification permission (in-app notification bell, ADR-0056)", () => {
  test("the `notification` domain is in the catalog with a single `:read` verb", () => {
    expect(PERMISSION_DOMAINS).toContain("notification");
    expect(PERMISSIONS).toContain("notification:read" as Permission);
    // The bell is read-only — there is no notification:write/:delete (mark-read is a PATCH, not a perm).
    expect(PERMISSIONS).not.toContain("notification:write" as Permission);
    expect(PERMISSIONS).not.toContain("notification:delete" as Permission);
  });

  test("notification:read is an admin-only read (treated like logs:read / workflow:read)", () => {
    expect(ADMIN_ONLY_READS).toContain("notification:read");
  });

  test("SAFE DEFAULT: notification:read is ADMIN-only — MEMBER/VIEWER hold none", () => {
    expect(DEFAULT_ROLE_PERMISSIONS.ADMIN).toContain("notification:read" as Permission);
    expect(DEFAULT_ROLE_PERMISSIONS.MEMBER).not.toContain(
      "notification:read" as Permission,
    );
    expect(DEFAULT_ROLE_PERMISSIONS.VIEWER).not.toContain(
      "notification:read" as Permission,
    );
  });
});

describe("Secret permissions (human Secret Manager, ADR-0061)", () => {
  const SECRET_PERMISSIONS = [
    "secret:read",
    "secret:manage",
  ] as const satisfies readonly Permission[];

  test("the `secret` domain is in the catalog with exactly two verbs: read + manage", () => {
    expect(PERMISSION_DOMAINS).toContain("secret");
    for (const p of SECRET_PERMISSIONS) {
      expect(PERMISSIONS).toContain(p);
    }
    // No :write or :delete — vault and item mutation flows through :manage (coarse verb),
    // mirroring the workflow domain's coarse-verb model.
    expect(PERMISSIONS).not.toContain("secret:write" as Permission);
    expect(PERMISSIONS).not.toContain("secret:delete" as Permission);
  });

  test("secret:manage is DISTINCT from secret:read (separation of duties, ADR-0061 §7)", () => {
    expect(PERMISSIONS).toContain("secret:manage" as Permission);
    expect(PERMISSIONS).toContain("secret:read" as Permission);
    expect("secret:manage").not.toBe("secret:read");
  });

  test("secret:read is an admin-only read (same posture as logs:read / workflow:read)", () => {
    expect(ADMIN_ONLY_READS).toContain("secret:read");
  });

  test("SAFE DEFAULT: every secret verb is ADMIN-only — MEMBER/VIEWER hold none", () => {
    for (const p of SECRET_PERMISSIONS) {
      expect(DEFAULT_ROLE_PERMISSIONS.ADMIN).toContain(p);
      expect(DEFAULT_ROLE_PERMISSIONS.MEMBER).not.toContain(p);
      expect(DEFAULT_ROLE_PERMISSIONS.VIEWER).not.toContain(p);
    }
  });
});

describe("Import permission (guided bulk Migrator, ADR-0069 §11)", () => {
  test("the `import` domain is in the catalog with a SINGLE coarse `:run` verb", () => {
    expect(PERMISSION_DOMAINS).toContain("import");
    expect(PERMISSIONS).toContain("import:run" as Permission);
    // Run-only: no read/write/delete — the import wizard's only catalog gate is `import:run`; the
    // session is owner-scoped transient scratch (no browse surface) and the actual writes are
    // AND-checked at commit against the TARGET entity permissions.
    expect(PERMISSIONS).not.toContain("import:read" as Permission);
    expect(PERMISSIONS).not.toContain("import:write" as Permission);
    expect(PERMISSIONS).not.toContain("import:delete" as Permission);
  });

  test("SAFE DEFAULT: import:run is ADMIN-only — MEMBER/VIEWER hold none", () => {
    // A coarse verb (neither `:read` nor `:write`) is ADMIN-only by construction of the seed — it
    // never enters the MEMBER/VIEWER default sets. This MUST hold so a non-admin can't bulk-import.
    expect(DEFAULT_ROLE_PERMISSIONS.ADMIN).toContain("import:run" as Permission);
    expect(DEFAULT_ROLE_PERMISSIONS.MEMBER).not.toContain("import:run" as Permission);
    expect(DEFAULT_ROLE_PERMISSIONS.VIEWER).not.toContain("import:run" as Permission);
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

  test("MEMBER = all reads + all writes, EXCEPT the admin-only reads", () => {
    const adminOnly = new Set<string>(ADMIN_ONLY_READS);
    const expected = [
      ...READ_PERMISSIONS.filter((p) => !adminOnly.has(p)),
      ...WRITE_PERMISSIONS,
    ];
    expect(new Set(DEFAULT_ROLE_PERMISSIONS.MEMBER)).toEqual(new Set(expected));
    // No delete, no coarse capability verb leaks into MEMBER.
    for (const p of DEFAULT_ROLE_PERMISSIONS.MEMBER) {
      expect(p.endsWith(":delete")).toBe(false);
      expect(["accessGrant:grant", "user:manage", "settings:manage"]).not.toContain(p);
    }
    // The admin-only reads (logs:read) are NOT seeded to MEMBER — strictly tighter than open-by-default.
    for (const p of ADMIN_ONLY_READS) {
      expect(DEFAULT_ROLE_PERMISSIONS.MEMBER).not.toContain(p);
    }
  });

  test("VIEWER = all reads EXCEPT the pre-tightened AND the admin-only reads", () => {
    const restricted = new Set<string>([...VIEWER_DENIED_READS, ...ADMIN_ONLY_READS]);
    const expected = READ_PERMISSIONS.filter((p) => !restricted.has(p));
    expect(new Set(DEFAULT_ROLE_PERMISSIONS.VIEWER)).toEqual(new Set(expected));
    // VIEWER can mutate nothing.
    for (const p of DEFAULT_ROLE_PERMISSIONS.VIEWER) {
      expect(p.endsWith(":read")).toBe(true);
    }
  });

  test("the pre-tightening is EXACTLY accessGrant:read + user:read", () => {
    expect([...VIEWER_DENIED_READS].sort()).toEqual(
      (["accessGrant:read", "user:read"] as (typeof VIEWER_DENIED_READS)[number][]).sort(),
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
    // Default-open applies to every read that is neither pre-tightened (ADMIN+MEMBER) nor admin-only.
    const restricted = new Set<string>([...VIEWER_DENIED_READS, ...ADMIN_ONLY_READS]);
    for (const p of READ_PERMISSIONS) {
      if (restricted.has(p)) continue;
      for (const role of ["ADMIN", "MEMBER", "VIEWER"] as const) {
        expect(DEFAULT_ROLE_PERMISSIONS[role]).toContain(p);
      }
    }
  });

  test("the admin-only reads are EXACTLY logs:read + workflow:read + notification:read + secret:read, and seeded to ADMIN only", () => {
    // logs:read is the first admin-only read (issue #175); workflow:read joins it (epic #248),
    // notification:read joins it (ADR-0056, the bell), and secret:read joins it (ADR-0061 §7, the
    // human Secret Manager) — all with the same posture: strictly more restrictive than the
    // pre-tightening: excluded from BOTH MEMBER and VIEWER, held only by ADMIN's full catalog.
    expect([...ADMIN_ONLY_READS]).toEqual([
      "logs:read",
      "workflow:read",
      "notification:read",
      "secret:read",
    ]);
    for (const p of ADMIN_ONLY_READS) {
      expect(DEFAULT_ROLE_PERMISSIONS.ADMIN).toContain(p);
      expect(DEFAULT_ROLE_PERMISSIONS.MEMBER).not.toContain(p);
      expect(DEFAULT_ROLE_PERMISSIONS.VIEWER).not.toContain(p);
    }
  });

  test("ADMIN_ONLY_READS and VIEWER_DENIED_READS are disjoint", () => {
    // A read is either pre-tightened (ADMIN+MEMBER) or admin-only (ADMIN), never both.
    const pretightened = new Set<string>(VIEWER_DENIED_READS);
    for (const p of ADMIN_ONLY_READS) {
      expect(pretightened.has(p)).toBe(false);
    }
    // Every admin-only read is a real `:read` literal in the catalog.
    for (const p of ADMIN_ONLY_READS) {
      expect(p.endsWith(":read")).toBe(true);
      expect(READ_PERMISSIONS).toContain(p);
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
