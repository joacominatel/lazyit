import { describe, expect, test } from "bun:test";
import {
  ARGON2ID_PARAMS,
  generateKeyPair,
  seal,
  sealBytes,
  wrapDek,
  type SecretEnvelope,
} from "@lazyit/shared/crypto";
import type { ServiceAccountVaultFetch } from "@lazyit/shared";
import { decryptVault, deriveKek, selfCheck } from "./crypto";

// lazyit-fetch (ADR-0080) — the CLIENT-SIDE decrypt chain. These tests prove the CLI recovers the plaintext
// the browser would have sealed, and that INV-10's failure discipline holds (a wrong token / tampered blob
// throws generically, never leaking key material). All crypto is the shipped `@lazyit/shared/crypto`.

function bytesToB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
function joinBlob(env: SecretEnvelope): string {
  const ct = new Uint8Array(Buffer.from(env.ciphertext, "base64"));
  const tag = new Uint8Array(Buffer.from(env.authTag, "base64"));
  const joined = new Uint8Array(ct.length + tag.length);
  joined.set(ct, 0);
  joined.set(tag, ct.length);
  return bytesToB64(joined);
}

/** Build a fetch wire shape for `token` carrying `values` (handle→plaintext), as the server would return. */
async function makeFetch(
  token: string,
  values: Record<string, string>,
): Promise<ServiceAccountVaultFetch> {
  const kp = generateKeyPair();
  const salt = crypto.getRandomValues(
    new Uint8Array(ARGON2ID_PARAMS.saltLength),
  );
  const saltB64 = bytesToB64(salt);
  const kek = await deriveKek(token, saltB64, ARGON2ID_PARAMS);
  const sealedPriv = sealBytes(kek, kp.secretKey);
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const membership = wrapDek(dek, kp.publicKey);
  return {
    vaultId: "cvault00000000000000000000",
    keypair: {
      privateKeyEnc: joinBlob(sealedPriv),
      privateKeySalt: saltB64,
      privateKeyIv: sealedPriv.iv,
      kdfParams: { ...ARGON2ID_PARAMS },
    },
    membership,
    items: Object.entries(values).map(([handle, value]) => ({
      handle,
      label: handle,
      kind: "GENERIC" as const,
      ...seal(dek, value),
    })),
  };
}

describe("lazyit-fetch crypto (ADR-0080)", () => {
  test("selfCheck() passes (the built-in --self-check round-trip)", async () => {
    await expect(selfCheck()).resolves.toBeUndefined();
  });

  test("decryptVault recovers every item's plaintext from the token", async () => {
    const token = "lzit_sa_test_" + "B".repeat(43);
    const fetched = await makeFetch(token, {
      "prod-db-password": "hunter2",
      "api-key": "sk-live-abc123",
      "utf8-value": "clé-secrète-🔐",
    });
    const out = await decryptVault(token, fetched);
    expect(out["prod-db-password"]).toBe("hunter2");
    expect(out["api-key"]).toBe("sk-live-abc123");
    expect(out["utf8-value"]).toBe("clé-secrète-🔐");
  });

  test("a WRONG token throws the generic decrypt error (no key/plaintext leak)", async () => {
    const token = "lzit_sa_right_" + "C".repeat(43);
    const fetched = await makeFetch(token, { s: "value" });
    await expect(
      decryptVault("lzit_sa_wrong_" + "D".repeat(43), fetched),
    ).rejects.toThrow(/Failed to decrypt/);
  });

  test("a TAMPERED item ciphertext throws (GCM tag mismatch)", async () => {
    const token = "lzit_sa_tamper_" + "E".repeat(43);
    const fetched = await makeFetch(token, { s: "value" });
    // Flip the ciphertext of the item — the DEK still unwraps, but the value fails the GCM tag.
    fetched.items[0]!.ciphertext = bytesToB64(
      crypto.getRandomValues(new Uint8Array(16)),
    );
    await expect(decryptVault(token, fetched)).rejects.toThrow(
      /Failed to decrypt/,
    );
  });
});
