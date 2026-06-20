import { describe, expect, test } from "bun:test";
import {
  CreateDirectoryPersonSchema,
  CreateUserSchema,
  ManagerInputSchema,
  RoleSchema,
  RoleSourceSchema,
  TempPasswordSchema,
  UpdateUserSchema,
  UserSchema,
} from "./user";

// A complete, valid READ shape (ADR-0058 added the required-nullable legajo / username / manager).
// Reused across the response-shape tests below.
const READ_BASE = {
  id: "00000000-0000-0000-0000-000000000000",
  email: "a@b.com",
  firstName: "Ada",
  lastName: "Lovelace",
  isActive: true,
  role: "VIEWER" as const,
  externalId: null,
  legajo: null,
  username: null,
  manager: null,
  // ADR-0069 REDESIGN §3/§5.5 — directoryOnly is required on the wire (server default false);
  // directoryAttrs is optional/nullable so it can be omitted by a normal account.
  directoryOnly: false,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  deletedAt: null,
};

// SEC-006 — externalId is the IdP `sub` linkage (ADR-0016), server-owned. A client must not be able
// to set it on create, or it could pre-link a local row to a future federated identity.
describe("CreateUserSchema (SEC-006)", () => {
  const valid = { email: "a@b.com", firstName: "Ada", lastName: "Lovelace" };

  test("accepts a valid payload", () => {
    expect(CreateUserSchema.safeParse(valid).success).toBe(true);
  });

  test("rejects a client-supplied externalId (strictObject, unknown key)", () => {
    const result = CreateUserSchema.safeParse({
      ...valid,
      externalId: "victim-idp-sub",
    });
    expect(result.success).toBe(false);
  });

  // ADR-0040 — role is OPTIONAL on create (omitted → server default MEMBER) but must be one of the
  // three enum values when present. The Users controller is ADMIN-gated, so accepting it is safe.
  test("accepts an optional role on create", () => {
    expect(CreateUserSchema.safeParse({ ...valid, role: "ADMIN" }).success).toBe(
      true,
    );
    expect(CreateUserSchema.safeParse(valid).success).toBe(true);
  });

  test("rejects an unknown role value", () => {
    expect(
      CreateUserSchema.safeParse({ ...valid, role: "SUPERADMIN" }).success,
    ).toBe(false);
  });
});

// ADR-0064 (issue #411) — optional admin-provisioned TEMPORARY password. Honored only on the bundled-
// Zitadel management path by the API; here we just guard the wire contract (optional + complexity).
describe("CreateUserSchema temporary password (ADR-0064)", () => {
  const valid = { email: "a@b.com", firstName: "Ada", lastName: "Lovelace" };

  test("password is optional — a create without it is valid (back-compat)", () => {
    expect(CreateUserSchema.safeParse(valid).success).toBe(true);
  });

  test("accepts a password meeting the complexity policy", () => {
    expect(
      CreateUserSchema.safeParse({ ...valid, password: "Str0ng!Pass" }).success,
    ).toBe(true);
  });

  test("rejects a too-short / non-complex / empty password", () => {
    expect(
      CreateUserSchema.safeParse({ ...valid, password: "weak" }).success,
    ).toBe(false);
    expect(
      CreateUserSchema.safeParse({ ...valid, password: "" }).success,
    ).toBe(false);
    // Missing a symbol — the same rule the bootstrap SetupPasswordSchema enforces.
    expect(
      CreateUserSchema.safeParse({ ...valid, password: "Abcdef12" }).success,
    ).toBe(false);
  });

  // The policy mirrors the bootstrap SetupPasswordSchema rule-for-rule (min 8 / max 70 / upper / lower /
  // digit / symbol) so Zitadel never rejects an admin-provisioned temp password mid-mirror.
  test("TempPasswordSchema enforces the Zitadel default complexity policy", () => {
    expect(TempPasswordSchema.safeParse("Str0ng!Pass").success).toBe(true);
    expect(TempPasswordSchema.safeParse("nouppercas3!").success).toBe(false);
    expect(TempPasswordSchema.safeParse("NOLOWERCASE3!").success).toBe(false);
    expect(TempPasswordSchema.safeParse("NoDigits!!").success).toBe(false);
    expect(TempPasswordSchema.safeParse("Ab1!" + "x".repeat(70)).success).toBe(
      false,
    );
  });
});

// ADR-0041 — email is case-insensitive (citext column). Write payloads normalize input (trim +
// lowercase) so the stored value is canonical and "Bob@x" / "bob@x" can never become two users.
describe("email normalization (ADR-0041)", () => {
  test("CreateUserSchema lowercases and trims the email", () => {
    const result = CreateUserSchema.safeParse({
      email: "  Bob@Example.COM  ",
      firstName: "Bob",
      lastName: "Builder",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("bob@example.com");
    }
  });

  test("UpdateUserSchema lowercases and trims the email", () => {
    const result = UpdateUserSchema.safeParse({ email: "ALICE@X.IO" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("alice@x.io");
    }
  });

  test("still rejects a non-email string", () => {
    expect(
      CreateUserSchema.safeParse({
        email: "not-an-email",
        firstName: "X",
        lastName: "Y",
      }).success,
    ).toBe(false);
  });
});

// ADR-0040 — the User wire shape always carries the role; the enum is the front/back contract.
describe("UserSchema role (ADR-0040)", () => {
  test("RoleSchema accepts exactly ADMIN / MEMBER / VIEWER", () => {
    expect(RoleSchema.options).toEqual(["ADMIN", "MEMBER", "VIEWER"]);
  });

  test("requires role on the full User response shape", () => {
    const { role: _role, ...withoutRole } = READ_BASE;
    expect(UserSchema.safeParse(withoutRole).success).toBe(false);
    expect(UserSchema.safeParse({ ...withoutRole, role: "VIEWER" }).success).toBe(
      true,
    );
  });
});

// ADR-0043 — `roleSource` is an OPTIONAL, additive field on the User response (informational only; the
// API still authorizes from the DB role). It must not break existing responses that omit it.
describe("UserSchema roleSource (ADR-0043)", () => {
  const base = READ_BASE;

  test("RoleSourceSchema accepts exactly local / idp", () => {
    expect(RoleSourceSchema.options).toEqual(["local", "idp"]);
  });

  test("roleSource is optional (omitted is still valid — additive, no break)", () => {
    expect(UserSchema.safeParse(base).success).toBe(true);
  });

  test("accepts a present roleSource of local or idp", () => {
    expect(
      UserSchema.safeParse({ ...base, roleSource: "local" }).success,
    ).toBe(true);
    expect(UserSchema.safeParse({ ...base, roleSource: "idp" }).success).toBe(
      true,
    );
  });

  test("rejects an unknown roleSource value", () => {
    expect(
      UserSchema.safeParse({ ...base, roleSource: "token" }).success,
    ).toBe(false);
  });
});

// ADR-0058 — legajo / username on WRITE: optional + normalized (legajo trim; username trim+lowercase),
// mirroring the email precedent so "Ana" / "ana" collide against the live-only partial unique index.
describe("legajo / username normalization (ADR-0058)", () => {
  const valid = { email: "a@b.com", firstName: "Ada", lastName: "Lovelace" };

  test("create trims legajo and trim+lowercases username", () => {
    const result = CreateUserSchema.safeParse({
      ...valid,
      legajo: "  12345  ",
      username: "  Ana.Perez  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.legajo).toBe("12345");
      expect(result.data.username).toBe("ana.perez");
    }
  });

  test("legajo / username are optional on create", () => {
    expect(CreateUserSchema.safeParse(valid).success).toBe(true);
  });

  test("update clears legajo / username with null", () => {
    expect(
      UpdateUserSchema.safeParse({ legajo: null, username: null }).success,
    ).toBe(true);
  });
});

// ADR-0058 — the `manager` INPUT union mirrors the DB CHECK users_manager_at_most_one: EITHER a linked
// user (managerId), OR a free-text name (managerName), OR null (clear) — never both id + name.
describe("ManagerInputSchema cross-field refine (ADR-0058)", () => {
  const MGR = "11111111-1111-4111-8111-111111111111";

  test("accepts managerId alone", () => {
    expect(ManagerInputSchema.safeParse({ managerId: MGR }).success).toBe(true);
  });

  test("accepts managerName alone (trimmed)", () => {
    const result = ManagerInputSchema.safeParse({ managerName: "  Ana (HR) " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.managerName).toBe("Ana (HR)");
    }
  });

  test("accepts the empty object (both omitted)", () => {
    expect(ManagerInputSchema.safeParse({}).success).toBe(true);
  });

  test("REJECTS both managerId and managerName at once (the XOR)", () => {
    expect(
      ManagerInputSchema.safeParse({ managerId: MGR, managerName: "Ana" })
        .success,
    ).toBe(false);
  });

  test("create accepts manager: { managerId } and manager: null", () => {
    const valid = { email: "a@b.com", firstName: "Ada", lastName: "Lovelace" };
    expect(
      CreateUserSchema.safeParse({ ...valid, manager: { managerId: MGR } })
        .success,
    ).toBe(true);
    expect(
      CreateUserSchema.safeParse({ ...valid, manager: null }).success,
    ).toBe(true);
  });

  test("create REJECTS manager with both id + name (the refine fires through CreateUser)", () => {
    const valid = { email: "a@b.com", firstName: "Ada", lastName: "Lovelace" };
    expect(
      CreateUserSchema.safeParse({
        ...valid,
        manager: { managerId: MGR, managerName: "Ana" },
      }).success,
    ).toBe(false);
  });
});

// ADR-0058 — the READ `manager` descriptor is a discriminated union resolved from the FK. A
// soft-deleted linked manager surfaces isOffboarded=true (never a dangle/leak); the external fallback
// carries only a display name.
describe("UserSchema.manager read descriptor (ADR-0058)", () => {
  test("accepts a live linked-user manager (isOffboarded false)", () => {
    const m = {
      type: "user" as const,
      id: "11111111-1111-4111-8111-111111111111",
      firstName: "Boss",
      lastName: "Person",
      isOffboarded: false,
    };
    expect(UserSchema.safeParse({ ...READ_BASE, manager: m }).success).toBe(true);
  });

  test("accepts an offboarded linked-user manager (isOffboarded true)", () => {
    const m = {
      type: "user" as const,
      id: "11111111-1111-4111-8111-111111111111",
      firstName: "Former",
      lastName: "Boss",
      isOffboarded: true,
    };
    expect(UserSchema.safeParse({ ...READ_BASE, manager: m }).success).toBe(true);
  });

  test("accepts the external (free-text) manager descriptor", () => {
    const m = { type: "external" as const, name: "Ana Pérez (HR)" };
    expect(UserSchema.safeParse({ ...READ_BASE, manager: m }).success).toBe(true);
  });

  test("accepts null (no manager) and requires the field to be present", () => {
    expect(UserSchema.safeParse({ ...READ_BASE, manager: null }).success).toBe(
      true,
    );
    const { manager: _m, ...withoutManager } = READ_BASE;
    expect(UserSchema.safeParse(withoutManager).success).toBe(false);
  });

  test("rejects a user descriptor missing isOffboarded", () => {
    const m = {
      type: "user" as const,
      id: "11111111-1111-4111-8111-111111111111",
      firstName: "Boss",
      lastName: "Person",
    };
    expect(UserSchema.safeParse({ ...READ_BASE, manager: m }).success).toBe(
      false,
    );
  });

  test("accepts the directory-only flag + free-form directoryAttrs on the read shape", () => {
    expect(
      UserSchema.safeParse({
        ...READ_BASE,
        directoryOnly: true,
        directoryAttrs: { jobTitle: "Engineer", department: "IT" },
      }).success,
    ).toBe(true);
    // directoryAttrs is optional/nullable — both omitted and null are valid.
    expect(
      UserSchema.safeParse({ ...READ_BASE, directoryAttrs: null }).success,
    ).toBe(true);
  });

  test("requires directoryOnly to be present on the wire (server default false)", () => {
    const { directoryOnly: _d, ...withoutFlag } = READ_BASE;
    expect(UserSchema.safeParse(withoutFlag).success).toBe(false);
  });
});

// ADR-0069 REDESIGN §5.5 — a directory person is a User WITHOUT a login. CreateDirectoryPersonSchema is
// strict (no role / no externalId) and demands at least one identity key (CEO Q5: email ∨ legajo ∨ username).
describe("CreateDirectoryPersonSchema (SEC-006 + identity guarantee, CEO Q5)", () => {
  test("accepts a person identified by email", () => {
    expect(
      CreateDirectoryPersonSchema.safeParse({ name: "Ada Lovelace", email: "a@b.com" }).success,
    ).toBe(true);
  });

  test("accepts a person identified by legajo only (no email)", () => {
    expect(
      CreateDirectoryPersonSchema.safeParse({ name: "Bob", legajo: "12345" }).success,
    ).toBe(true);
  });

  test("accepts a person identified by username only (3rd identity key, Q5)", () => {
    expect(
      CreateDirectoryPersonSchema.safeParse({ name: "Carol", username: "carol.x" }).success,
    ).toBe(true);
  });

  test("accepts the directory attribute sub-fields (jobTitle / department / supervisor)", () => {
    expect(
      CreateDirectoryPersonSchema.safeParse({
        name: "Dave",
        legajo: "777",
        jobTitle: "Engineer",
        department: "IT",
        supervisor: "Eve Manager",
      }).success,
    ).toBe(true);
  });

  test("REJECTS a person with NO identity key (name alone — even with attributes)", () => {
    expect(
      CreateDirectoryPersonSchema.safeParse({
        name: "Frank",
        jobTitle: "Engineer",
        department: "IT",
      }).success,
    ).toBe(false);
  });

  test("REJECTS a client-supplied role (strict, never role-escalation)", () => {
    expect(
      CreateDirectoryPersonSchema.safeParse({
        name: "Grace",
        email: "g@x.com",
        role: "ADMIN",
      }).success,
    ).toBe(false);
  });

  test("REJECTS a client-supplied externalId (strict, never identity pre-linking)", () => {
    expect(
      CreateDirectoryPersonSchema.safeParse({
        name: "Heidi",
        email: "h@x.com",
        externalId: "victim-idp-sub",
      }).success,
    ).toBe(false);
  });

  test("REJECTS a person with no name", () => {
    expect(CreateDirectoryPersonSchema.safeParse({ email: "a@b.com" }).success).toBe(false);
  });

  test("normalizes email (trim + lowercase) like the write path (ADR-0041)", () => {
    const parsed = CreateDirectoryPersonSchema.safeParse({ name: "Ivan", email: "  Bob@X.COM " });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.email).toBe("bob@x.com");
  });
});
