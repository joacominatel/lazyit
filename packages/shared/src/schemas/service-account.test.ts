import { describe, expect, test } from "bun:test";
import {
  CreateServiceAccountSchema,
  SERVICE_ACCOUNT_TOKEN_PREFIX,
  ServiceAccountSchema,
  ServiceAccountWithSecretSchema,
  UpdateServiceAccountSchema,
} from "./service-account";

// Service Accounts (ADR-0048). These guard the WIRE shape both `api` (DTOs / token parsing) and a
// future `web` admin UI agree on: permissions are validated against the FROZEN catalog, the create
// payload never accepts a token, and the once-only response carries the cleartext secret.

describe("SERVICE_ACCOUNT_TOKEN_PREFIX", () => {
  test("is the stable lzit_sa_ marker the guard matches before the OIDC branch", () => {
    expect(SERVICE_ACCOUNT_TOKEN_PREFIX).toBe("lzit_sa_");
  });
});

describe("CreateServiceAccountSchema", () => {
  test("accepts a name + catalog permissions and dedupes the set", () => {
    const parsed = CreateServiceAccountSchema.parse({
      name: "ci-runner",
      permissions: ["asset:write", "asset:write", "asset:read"],
    });
    expect(parsed.name).toBe("ci-runner");
    // Deduped — the duplicate asset:write is squashed.
    expect(parsed.permissions).toEqual(["asset:write", "asset:read"]);
  });

  test("trims the name and accepts an optional description + expiresAt", () => {
    const parsed = CreateServiceAccountSchema.parse({
      name: "  backup-bot  ",
      description: "nightly backup job",
      permissions: ["asset:read"],
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    expect(parsed.name).toBe("backup-bot");
    expect(parsed.description).toBe("nightly backup job");
    expect(parsed.expiresAt).toBe("2027-01-01T00:00:00.000Z");
  });

  test("rejects an empty permission set (a credential that can pass nothing is a mistake)", () => {
    expect(
      CreateServiceAccountSchema.safeParse({ name: "x", permissions: [] })
        .success,
    ).toBe(false);
  });

  test("rejects a permission literal not in the frozen catalog", () => {
    expect(
      CreateServiceAccountSchema.safeParse({
        name: "x",
        permissions: ["asset:superuser"],
      }).success,
    ).toBe(false);
  });

  test("rejects a token / tokenHash / isActive field (strictObject — minted server-side)", () => {
    for (const extra of [
      { token: "lzit_sa_x_y" },
      { tokenHash: "deadbeef" },
      { isActive: true },
      { id: "abc" },
    ]) {
      expect(
        CreateServiceAccountSchema.safeParse({
          name: "x",
          permissions: ["asset:read"],
          ...extra,
        }).success,
      ).toBe(false);
    }
  });

  test("rejects a missing name", () => {
    expect(
      CreateServiceAccountSchema.safeParse({ permissions: ["asset:read"] })
        .success,
    ).toBe(false);
  });
});

describe("UpdateServiceAccountSchema", () => {
  test("accepts a partial update (rename only)", () => {
    expect(
      UpdateServiceAccountSchema.safeParse({ name: "renamed" }).success,
    ).toBe(true);
  });

  test("allows clearing expiresAt and description with null", () => {
    const parsed = UpdateServiceAccountSchema.parse({
      expiresAt: null,
      description: null,
    });
    expect(parsed.expiresAt).toBeNull();
    expect(parsed.description).toBeNull();
  });

  test("rejects an empty body (requireAtLeastOneKey)", () => {
    expect(UpdateServiceAccountSchema.safeParse({}).success).toBe(false);
  });

  test("rejects an unknown / immutable key (tokenHash, createdById)", () => {
    expect(
      UpdateServiceAccountSchema.safeParse({ tokenHash: "x" }).success,
    ).toBe(false);
    expect(
      UpdateServiceAccountSchema.safeParse({ createdById: "x" }).success,
    ).toBe(false);
  });

  test("rejects an empty permission set on update too", () => {
    expect(
      UpdateServiceAccountSchema.safeParse({ permissions: [] }).success,
    ).toBe(false);
  });
});

// ── INV-SA-3: never ADMIN-equivalent ─────────────────────────────────────────────────────────────
// SEC-011 golden test: the schema must REJECT the two coarse principal/authz-management verbs for
// both create and update (Layer 1 ceiling — the schema is the source of truth). If either test
// passes BEFORE the fix the remediation plan is stale — stop and check.

describe("CreateServiceAccountSchema — INV-SA-3 ceiling (SEC-011)", () => {
  test("rejects settings:manage (would give a bot ADMIN-equivalent self-escalation/persistence)", () => {
    expect(
      CreateServiceAccountSchema.safeParse({
        name: "evil-bot",
        permissions: ["settings:manage"],
      }).success,
    ).toBe(false);
  });

  test("rejects user:manage (would let a bot mint human ADMIN accounts)", () => {
    expect(
      CreateServiceAccountSchema.safeParse({
        name: "evil-bot",
        permissions: ["user:manage"],
      }).success,
    ).toBe(false);
  });

  test("rejects a grant set that includes settings:manage mixed with legitimate permissions", () => {
    expect(
      CreateServiceAccountSchema.safeParse({
        name: "evil-bot",
        permissions: ["asset:read", "settings:manage"],
      }).success,
    ).toBe(false);
  });

  test("rejects import:run (human-only by design — ADR-0069; the import controller forbids bots)", () => {
    expect(
      CreateServiceAccountSchema.safeParse({
        name: "evil-bot",
        permissions: ["import:run"],
      }).success,
    ).toBe(false);
  });

  test("still accepts a normal (non-meta) grant set — guard against over-blocking", () => {
    expect(
      CreateServiceAccountSchema.safeParse({
        name: "ci-runner",
        permissions: ["asset:read", "asset:write"],
      }).success,
    ).toBe(true);
  });
});

describe("UpdateServiceAccountSchema — INV-SA-3 ceiling (SEC-011)", () => {
  test("rejects user:manage on update (must not allow escalation via a permission-set replacement)", () => {
    expect(
      UpdateServiceAccountSchema.safeParse({
        permissions: ["user:manage"],
      }).success,
    ).toBe(false);
  });

  test("rejects settings:manage on update", () => {
    expect(
      UpdateServiceAccountSchema.safeParse({
        permissions: ["settings:manage"],
      }).success,
    ).toBe(false);
  });
});

describe("ServiceAccountSchema / ServiceAccountWithSecretSchema", () => {
  const base = {
    id: "ckg9z1a2b0000qzrmn831k4d8",
    name: "ci-runner",
    description: null,
    tokenPrefix: "lzit_sa_ckg9…",
    isActive: true,
    expiresAt: null,
    lastUsedAt: null,
    permissions: ["asset:read", "asset:write"],
    createdById: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    deletedAt: null,
  };

  test("the entity read has NO token field", () => {
    const parsed = ServiceAccountSchema.parse(base);
    expect(parsed).not.toHaveProperty("token");
  });

  test("systemManaged defaults to false (a pre-flag payload still parses)", () => {
    const parsed = ServiceAccountSchema.parse(base);
    expect(parsed.systemManaged).toBe(false);
  });

  test("systemManaged is carried through when the API marks an engine-owned account", () => {
    const parsed = ServiceAccountSchema.parse({ ...base, systemManaged: true });
    expect(parsed.systemManaged).toBe(true);
  });

  test("the once-only response extends the entity with a cleartext token", () => {
    const parsed = ServiceAccountWithSecretSchema.parse({
      ...base,
      token: "lzit_sa_ckg9z1a2b0000qzrmn831k4d8_AbCdEf",
    });
    expect(parsed.token).toContain("lzit_sa_");
    expect(parsed.tokenPrefix).toBe("lzit_sa_ckg9…");
  });
});
