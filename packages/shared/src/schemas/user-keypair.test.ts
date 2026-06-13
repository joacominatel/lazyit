import { describe, expect, it } from "bun:test";
import {
  CreateUserKeypairSchema,
  KdfParamsSchema,
  ResetUserKeypairSchema,
  UserKeypairSchema,
} from "./user-keypair";
// Test-ONLY: the recovery-key shape validator lives behind the `@lazyit/shared/crypto` subpath (it
// transitively imports `@noble/*`). The DTOs themselves MUST NOT import it (apps/api's CommonJS Jest
// cannot load ESM `@noble`); a test may, via the source path, to assert the format contract holds.
import { RecoveryKeySchema } from "../crypto/recovery-key";

const KEYPAIR_ID = "clkp0000000000000000000000";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ISO = "2026-06-13T00:00:00.000Z";
const PUB = "cHVibGljS2V5cHVibGljS2V5";
const BLOB = "d3JhcHBlZFByaXZhdGVLZXk=";
const SALT = "c2FsdHNhbHRzYWx0";
const IV = "aXZpdml2aXZpdg==";

const kdfParams = {
  alg: "argon2id" as const,
  memorySize: 65536,
  iterations: 3,
  parallelism: 1,
  saltLength: 16,
  hashLength: 32,
  v: 1,
};

const base = {
  publicKey: PUB,
  privateKeyEncByPassphrase: BLOB,
  passphraseSalt: SALT,
  passphraseIv: IV,
  kdfParams,
  privateKeyEncByRecovery: BLOB,
  recoverySalt: SALT,
  recoveryIv: IV,
};

describe("KdfParamsSchema — Argon2id parameter shape", () => {
  it("accepts the frozen Argon2id parameter set", () => {
    expect(KdfParamsSchema.safeParse(kdfParams).success).toBe(true);
  });

  it("rejects a non-argon2id alg", () => {
    expect(
      KdfParamsSchema.safeParse({ ...kdfParams, alg: "pbkdf2" }).success,
    ).toBe(false);
  });

  it("rejects a zero memorySize", () => {
    expect(
      KdfParamsSchema.safeParse({ ...kdfParams, memorySize: 0 }).success,
    ).toBe(false);
  });
});

describe("UserKeypairSchema — read shape (public + both wrapped private-key copies)", () => {
  it("accepts a full keypair row", () => {
    expect(
      UserKeypairSchema.safeParse({
        id: KEYPAIR_ID,
        userId: USER_ID,
        ...base,
        createdAt: ISO,
        updatedAt: ISO,
        deletedAt: null,
      }).success,
    ).toBe(true);
  });

  it("rejects a non-uuid userId (1:1 with the uuid User)", () => {
    expect(
      UserKeypairSchema.safeParse({
        id: KEYPAIR_ID,
        userId: "clnot00000000000000000000",
        ...base,
        createdAt: ISO,
        updatedAt: ISO,
        deletedAt: null,
      }).success,
    ).toBe(false);
  });

  it("rejects a non-base64 publicKey", () => {
    expect(
      UserKeypairSchema.safeParse({
        id: KEYPAIR_ID,
        userId: USER_ID,
        ...base,
        publicKey: "not base64!!",
        createdAt: ISO,
        updatedAt: ISO,
        deletedAt: null,
      }).success,
    ).toBe(false);
  });
});

describe("CreateUserKeypairSchema — self-minted, no private key/passphrase/recovery key on the wire", () => {
  it("accepts public + wrapped blobs + kdfParams", () => {
    expect(CreateUserKeypairSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a clear `privateKey` field (never transits the server)", () => {
    expect(
      CreateUserKeypairSchema.safeParse({
        ...base,
        privateKey: "Y2xlYXJQcml2YXRl",
      }).success,
    ).toBe(false);
  });

  it("rejects a `passphrase` field (the passphrase never transits the server)", () => {
    expect(
      CreateUserKeypairSchema.safeParse({ ...base, passphrase: "hunter2" })
        .success,
    ).toBe(false);
  });

  it("rejects a `userId` in the body (the keypair is always self-minted)", () => {
    expect(
      CreateUserKeypairSchema.safeParse({ ...base, userId: USER_ID }).success,
    ).toBe(false);
  });

  it("ResetUserKeypairSchema shares the create shape", () => {
    expect(ResetUserKeypairSchema.safeParse(base).success).toBe(true);
  });
});

describe("recovery-key format contract (lives in @lazyit/shared/crypto, NOT in the DTOs)", () => {
  it("the crypto subpath validates the shown-once recovery-key format", () => {
    expect(RecoveryKeySchema.safeParse("ABCDE-FGHJK-MNPQR-STVWX-YZ012").success).toBe(
      true,
    );
    expect(RecoveryKeySchema.safeParse("too-short").success).toBe(false);
  });
});
