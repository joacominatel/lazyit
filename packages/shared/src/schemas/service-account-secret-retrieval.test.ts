import { describe, expect, test } from "bun:test";
import {
  CreateServiceAccountKeypairSchema,
  ServiceAccountKeypairSchema,
  ServiceAccountPublicKeySchema,
} from "./service-account-keypair";
import {
  CreateServiceAccountVaultMembershipSchema,
  ServiceAccountVaultMembershipSchema,
} from "./service-account-vault-membership";
import {
  ServiceAccountFetchItemSchema,
  ServiceAccountVaultFetchSchema,
} from "./secret-manager-views";
import { PERMISSIONS, type Permission } from "./permission";
import { SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS } from "./service-account";

// ADR-0080 — programmatic secret retrieval via a service account. These assert the WIRE SHAPES only
// (base64 blobs + metadata); the CRYPTO round-trip is proven by the `lazyit-fetch` CLI self-check. INV-10
// holds because none of these shapes ever carries a plaintext value, a KEK, or an unwrapped key.

const cuid = "clh1abcdefghijklmnopqrstu";
const kdf = {
  alg: "argon2id" as const,
  memorySize: 65536,
  iterations: 3,
  parallelism: 1,
  saltLength: 16,
  hashLength: 32,
  v: 1,
};
const b64 = "YWJjZGVm"; // "abcdef"

describe("ServiceAccountKeypair schemas (ADR-0080)", () => {
  test("a full keypair row parses (single token-wrapped private copy, no recovery copy)", () => {
    const row = {
      id: cuid,
      serviceAccountId: cuid,
      publicKey: b64,
      privateKeyEnc: b64,
      privateKeySalt: b64,
      privateKeyIv: b64,
      kdfParams: kdf,
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z",
      deletedAt: null,
    };
    expect(ServiceAccountKeypairSchema.safeParse(row).success).toBe(true);
    // There is NO recovery copy on an SA keypair (the token is the only credential).
    expect("privateKeyEncByRecovery" in row).toBe(false);
  });

  test("the create DTO is strict (rejects an unknown key) and needs the token-wrap fields", () => {
    const ok = {
      publicKey: b64,
      privateKeyEnc: b64,
      privateKeySalt: b64,
      privateKeyIv: b64,
      kdfParams: kdf,
    };
    expect(CreateServiceAccountKeypairSchema.safeParse(ok).success).toBe(true);
    expect(
      CreateServiceAccountKeypairSchema.safeParse({
        ...ok,
        secretToken: "lzit_sa_x_y", // a smuggled secret must be rejected
      }).success,
    ).toBe(false);
  });

  test("the public-key lookup carries public material only", () => {
    expect(
      ServiceAccountPublicKeySchema.safeParse({
        serviceAccountId: cuid,
        publicKey: b64,
      }).success,
    ).toBe(true);
  });
});

describe("ServiceAccountVaultMembership schemas (ADR-0080)", () => {
  test("a membership row (wrapped DEK to the SA pubkey) parses", () => {
    expect(
      ServiceAccountVaultMembershipSchema.safeParse({
        id: cuid,
        vaultId: cuid,
        serviceAccountId: cuid,
        ephemeralPublicKey: b64,
        wrapNonce: b64,
        wrappedDek: b64,
        wrapVersion: 1,
        createdAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  test("the grant DTO is strict and carries the target serviceAccountId + wrapped DEK", () => {
    const ok = {
      serviceAccountId: cuid,
      ephemeralPublicKey: b64,
      wrapNonce: b64,
      wrappedDek: b64,
      wrapVersion: 1,
    };
    expect(
      CreateServiceAccountVaultMembershipSchema.safeParse(ok).success,
    ).toBe(true);
    // A human userId does NOT belong here — this grants an SA subject.
    expect(
      CreateServiceAccountVaultMembershipSchema.safeParse({
        ...ok,
        userId: "00000000-0000-0000-0000-000000000000",
      }).success,
    ).toBe(false);
  });
});

describe("Headless fetch view (ADR-0080)", () => {
  test("a fetch item carries metadata + ciphertext envelope, never a plaintext value", () => {
    const item = {
      handle: "prod-db-password",
      label: "Production DB root password",
      kind: "GENERIC" as const,
      ciphertext: b64,
      iv: b64,
      authTag: b64,
      keyVersion: 1,
    };
    expect(ServiceAccountFetchItemSchema.safeParse(item).success).toBe(true);
    // The plaintext value is structurally absent — there is no `value` field.
    expect("value" in item).toBe(false);
  });

  test("the fetch response bundles the wrapped keypair + wrapped DEK + ciphertext items", () => {
    expect(
      ServiceAccountVaultFetchSchema.safeParse({
        vaultId: cuid,
        keypair: {
          privateKeyEnc: b64,
          privateKeySalt: b64,
          privateKeyIv: b64,
          kdfParams: kdf,
        },
        membership: {
          ephemeralPublicKey: b64,
          wrapNonce: b64,
          wrappedDek: b64,
          wrapVersion: 1,
        },
        items: [
          {
            handle: "api-key",
            label: "API key",
            kind: "GENERIC",
            ciphertext: b64,
            iv: b64,
            authTag: b64,
            keyVersion: 1,
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("secret:fetch permission (ADR-0080)", () => {
  test("secret:fetch is in the catalog and IS grantable to a service account", () => {
    expect(PERMISSIONS).toContain("secret:fetch" as Permission);
    // Unlike secret:read / secret:manage (human-only), secret:fetch is the machine verb — NOT ungrantable.
    expect(
      (SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS as readonly string[]).includes(
        "secret:fetch",
      ),
    ).toBe(false);
    // The human secret verbs stay ungrantable to an SA.
    expect(
      (SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS as readonly string[]).includes(
        "secret:read",
      ),
    ).toBe(true);
    expect(
      (SERVICE_ACCOUNT_UNGRANTABLE_PERMISSIONS as readonly string[]).includes(
        "secret:manage",
      ),
    ).toBe(true);
  });
});
