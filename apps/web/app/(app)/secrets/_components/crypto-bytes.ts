/**
 * base64 ⇄ bytes — the browser-only codec the Secret Manager UI uses to move public keys and DEKs
 * across the `@lazyit/shared/crypto` boundary (ADR-0061, INV-10).
 *
 * The crypto orchestration in `lib/secret-manager/crypto.ts` keeps its own PRIVATE copy of these two
 * functions (it returns/accepts already-encoded wire DTOs, so it never needs to expose them). The UI,
 * however, occasionally holds a raw `Uint8Array` on ONE side of a call and a base64 string on the
 * other — e.g. a creator's `keypair.publicKey` (base64 on the wire) must become bytes before
 * `createVaultMaterial(myPublicKey)` / `wrapDekForMember(..., targetPublicKey)`. This module is the
 * single, reusable codec for those edges.
 *
 * Defensive, dependency-free, same pattern as the shared crypto leaf: `btoa`/`atob` exist in the
 * browser (where these run — every importer is a Client Component under the `ssr:false` boundary), in
 * Node 16+, and in Bun. No `Buffer`, no `node:crypto`. These functions touch ONLY public material
 * (public keys, ciphertext) — never a private key, passphrase, recovery key, or plaintext value; those
 * never round-trip base64 in the UI layer (the crypto module owns their encoding internally).
 */

const g = globalThis as unknown as {
  btoa?: (data: string) => string;
  atob?: (data: string) => string;
};

/** Encode raw bytes to a standard base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof g.btoa !== "function") {
    throw new Error("base64 encoder unavailable in this environment.");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return g.btoa(binary);
}

/** Decode a standard base64 string back to raw bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  if (typeof g.atob !== "function") {
    throw new Error("base64 decoder unavailable in this environment.");
  }
  const binary = g.atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
