/**
 * Typed-secret CLIENT codec (ADR-0075). The seam between the typed forms/renderers and the EXISTING
 * encrypt/decrypt chain (`sealItem`/`openItem`). A typed secret is a structured object the CLIENT
 * serializes to a plaintext STRING, which is then encrypted into the SAME opaque ciphertext envelope as
 * any other value — so the server still sees ONLY `kind` (metadata) + ciphertext (INV-10). All encode/
 * parse happens 100% in the browser; this module is pure (no React, no DOM, no crypto) and testable.
 *
 * WIRE CONTRACT per `kind` (the plaintext that gets encrypted):
 *   - GENERIC     → a PLAIN string (NOT JSON-wrapped) — unchanged back-compat; every legacy secret is
 *                   this and must keep decrypting/rendering exactly as before.
 *   - SSH_KEY     → JSON `{ privateKey, publicKey?, passphrase? }`
 *   - TOTP        → JSON `{ secret, issuer?, account?, digits?, period?, algorithm? }`
 *   - CERTIFICATE → JSON `{ certificate, privateKey?, chain? }`
 *
 * DEFENSIVE PARSE: a row's `kind` is server-visible metadata that can be edited independently of the
 * ciphertext, and legacy rows predate `kind`. So {@link parseSecretPayload} NEVER throws — if the
 * plaintext is not the JSON shape the `kind` promises (legacy GENERIC value, a mid-migration mismatch,
 * a hand-edited blob), it falls back to a GENERIC raw payload so the value is still shown, never lost.
 */

import type { SecretItemKind } from "@lazyit/shared";

/** TOTP HMAC hash, mirrors the shared `kind` payload contract + {@link import("./totp").TotpAlgorithm}. */
export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface SshKeyPayload {
  privateKey: string;
  publicKey?: string;
  passphrase?: string;
}

export interface TotpPayload {
  secret: string;
  issuer?: string;
  account?: string;
  digits?: number;
  period?: number;
  algorithm?: TotpAlgorithm;
}

export interface CertificatePayload {
  certificate: string;
  privateKey?: string;
  chain?: string;
}

/** A decoded typed secret — the discriminated union the reveal/render path switches on. */
export type TypedSecret =
  | { kind: "GENERIC"; value: string }
  | { kind: "SSH_KEY"; value: SshKeyPayload }
  | { kind: "TOTP"; value: TotpPayload }
  | { kind: "CERTIFICATE"; value: CertificatePayload };

/** Drop `undefined` and empty-string optionals so the encoded JSON carries only fields the user filled. */
function compact<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

/**
 * Serialize a typed secret to the plaintext STRING that the existing crypto layer encrypts. GENERIC is
 * passed through verbatim (back-compat: a GENERIC secret's ciphertext is the plain value, never JSON);
 * every other kind is compacted then `JSON.stringify`-d. The result is fed straight to `sealItem`.
 */
export function encodeSecretPayload(payload: TypedSecret): string {
  switch (payload.kind) {
    case "GENERIC":
      return payload.value;
    case "SSH_KEY":
    case "TOTP":
    case "CERTIFICATE":
      return JSON.stringify(compact(payload.value));
  }
}

/**
 * Decode a decrypted plaintext STRING back to a {@link TypedSecret}, driven by the row's `kind`. GENERIC
 * returns the raw string. For a typed `kind` we `JSON.parse` and shape-check the REQUIRED field; on ANY
 * failure (not JSON, wrong shape, legacy value under a re-typed `kind`) we fall back to a GENERIC raw
 * payload so the reveal still shows something rather than erroring. NEVER throws.
 */
export function parseSecretPayload(
  kind: SecretItemKind,
  plaintext: string,
): TypedSecret {
  if (kind === "GENERIC") return { kind: "GENERIC", value: plaintext };

  try {
    const obj: unknown = JSON.parse(plaintext);
    if (obj && typeof obj === "object") {
      const o = obj as Record<string, unknown>;
      switch (kind) {
        case "SSH_KEY":
          if (typeof o.privateKey === "string") {
            return { kind, value: o as unknown as SshKeyPayload };
          }
          break;
        case "TOTP":
          if (typeof o.secret === "string") {
            return { kind, value: o as unknown as TotpPayload };
          }
          break;
        case "CERTIFICATE":
          if (typeof o.certificate === "string") {
            return { kind, value: o as unknown as CertificatePayload };
          }
          break;
      }
    }
  } catch {
    // Not JSON (e.g. a legacy GENERIC value living under a re-typed `kind`) — fall through to raw.
  }
  // Defensive fallback: show the raw plaintext rather than lose or error on it.
  return { kind: "GENERIC", value: plaintext };
}
