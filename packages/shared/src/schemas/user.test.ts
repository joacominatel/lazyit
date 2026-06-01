import { describe, expect, test } from "bun:test";
import { CreateUserSchema, RoleSchema, UserSchema } from "./user";

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

// ADR-0040 — the User wire shape always carries the role; the enum is the front/back contract.
describe("UserSchema role (ADR-0040)", () => {
  test("RoleSchema accepts exactly ADMIN / MEMBER / VIEWER", () => {
    expect(RoleSchema.options).toEqual(["ADMIN", "MEMBER", "VIEWER"]);
  });

  test("requires role on the full User response shape", () => {
    const base = {
      id: "00000000-0000-0000-0000-000000000000",
      email: "a@b.com",
      firstName: "Ada",
      lastName: "Lovelace",
      isActive: true,
      externalId: null,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      deletedAt: null,
    };
    expect(UserSchema.safeParse(base).success).toBe(false);
    expect(UserSchema.safeParse({ ...base, role: "VIEWER" }).success).toBe(true);
  });
});
