import { describe, expect, test } from "bun:test";
import {
  FolderAccessRuleSchema,
  FolderAccessRulesSchema,
  isPublicAccessRules,
  UpdateFolderAccessRulesSchema,
} from "./folder";

/**
 * The CLOSED folder-access rule vocabulary (ADR-0060 §3): a folder restriction is an OR-combined list
 * of four rule KINDS — `users` / `role` / `appGrant` / `assetAssignment`. Absence/empty = PUBLIC
 * (§2). These tests pin the vocabulary so a typo'd kind or an extra key fails at the DTO edge (the
 * catalog-as-code discipline — the rule kinds are reviewable, not free-form policy).
 */
describe("FolderAccessRuleSchema — the closed rule vocabulary (ADR-0060 §3)", () => {
  test("accepts a users rule (explicit user set)", () => {
    const rule = {
      kind: "users" as const,
      userIds: ["11111111-1111-4111-8111-111111111111"],
    };
    expect(FolderAccessRuleSchema.parse(rule)).toEqual(rule);
  });

  test("rejects a users rule with zero ids (an empty set restricts to nobody — meaningless)", () => {
    expect(() =>
      FolderAccessRuleSchema.parse({ kind: "users", userIds: [] }),
    ).toThrow();
  });

  test("rejects a users rule with a non-uuid id", () => {
    expect(() =>
      FolderAccessRuleSchema.parse({ kind: "users", userIds: ["not-a-uuid"] }),
    ).toThrow();
  });

  test("accepts a role rule", () => {
    const rule = { kind: "role" as const, role: "MEMBER" as const };
    expect(FolderAccessRuleSchema.parse(rule)).toEqual(rule);
  });

  test("rejects a role rule with an unknown role", () => {
    expect(() =>
      FolderAccessRuleSchema.parse({ kind: "role", role: "SUPERADMIN" }),
    ).toThrow();
  });

  test("accepts an appGrant rule (holders of an active grant to an application)", () => {
    const rule = {
      kind: "appGrant" as const,
      applicationId: "clappapplication000000000",
    };
    expect(FolderAccessRuleSchema.parse(rule)).toEqual(rule);
  });

  test("accepts an assetAssignment rule (current assignees of an asset)", () => {
    const rule = {
      kind: "assetAssignment" as const,
      assetId: "classetasset0000000000000",
    };
    expect(FolderAccessRuleSchema.parse(rule)).toEqual(rule);
  });

  test("rejects an unknown rule kind (the vocabulary is CLOSED)", () => {
    expect(() =>
      FolderAccessRuleSchema.parse({ kind: "ipRange", cidr: "10.0.0.0/8" }),
    ).toThrow();
  });

  test("rejects extra keys on a rule (strict — no free-form policy)", () => {
    expect(() =>
      FolderAccessRuleSchema.parse({
        kind: "role",
        role: "MEMBER",
        sneaky: true,
      }),
    ).toThrow();
  });
});

describe("FolderAccessRulesSchema — the OR-combined rule list", () => {
  test("accepts a multi-rule OR list", () => {
    const rules = [
      { kind: "role" as const, role: "MEMBER" as const },
      { kind: "appGrant" as const, applicationId: "clappapplication000000000" },
    ];
    expect(FolderAccessRulesSchema.parse(rules)).toEqual(rules);
  });

  test("accepts null (= PUBLIC, no restriction)", () => {
    expect(FolderAccessRulesSchema.parse(null)).toBeNull();
  });

  test("rejects more rules than the cap (bounded — a handful per folder, ADR-0060)", () => {
    const tooMany = Array.from({ length: 50 }, () => ({
      kind: "role" as const,
      role: "MEMBER" as const,
    }));
    expect(() => FolderAccessRulesSchema.parse(tooMany)).toThrow();
  });
});

describe("isPublicAccessRules — the PUBLIC fast-path predicate (ADR-0060 §2)", () => {
  test("null is PUBLIC", () => {
    expect(isPublicAccessRules(null)).toBe(true);
  });

  test("undefined is PUBLIC", () => {
    expect(isPublicAccessRules(undefined)).toBe(true);
  });

  test("an empty array is PUBLIC (no rule narrows from public)", () => {
    expect(isPublicAccessRules([])).toBe(true);
  });

  test("a non-empty rule list is NOT public (restricted)", () => {
    expect(isPublicAccessRules([{ kind: "role", role: "MEMBER" }])).toBe(false);
  });
});

describe("UpdateFolderAccessRulesSchema — the PUT body (set/clear a folder's rules)", () => {
  test("accepts a rule list", () => {
    const body = { accessRules: [{ kind: "role" as const, role: "ADMIN" as const }] };
    expect(UpdateFolderAccessRulesSchema.parse(body)).toEqual(body);
  });

  test("accepts null to CLEAR (make the folder PUBLIC again)", () => {
    expect(UpdateFolderAccessRulesSchema.parse({ accessRules: null })).toEqual({
      accessRules: null,
    });
  });

  test("rejects a missing accessRules key (strict body)", () => {
    expect(() => UpdateFolderAccessRulesSchema.parse({})).toThrow();
  });
});
