import { describe, expect, test } from "bun:test";
import { CreateUserSchema } from "./user";

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
});
