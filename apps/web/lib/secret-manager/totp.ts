/**
 * RFC 6238 TOTP generator (ADR-0075) — pure, dependency-free, client-side. Uses Web Crypto
 * (`crypto.subtle` HMAC), which exists in the browser AND in Bun, so this runs unchanged in the UI and
 * under `bun test`. No npm dependency: a TOTP is a ~40-line HMAC-of-a-counter, not a library.
 *
 * SECURITY (INV-10): the seed is a SECRET like any other — it is decrypted from the vault envelope only
 * in browser memory, generated here transiently, and never persisted/logged/sent. This module computes a
 * code from a seed it is handed; it does not store the seed.
 */

/** Supported HMAC hashes (RFC 6238 §1.2) mapped to the SubtleCrypto algorithm names. */
const HASHES = {
  SHA1: "SHA-1",
  SHA256: "SHA-256",
  SHA512: "SHA-512",
} as const;

export type TotpAlgorithm = keyof typeof HASHES;

export interface TotpParams {
  /** The shared seed, base32 (RFC 4648); hyphens/spaces/casing are tolerated. */
  secret: string;
  /** Number of digits in the code (default 6). */
  digits?: number;
  /** Time step in seconds (default 30). */
  period?: number;
  /** HMAC hash (default SHA1 — the near-universal authenticator default). */
  algorithm?: TotpAlgorithm;
}

export interface TotpCode {
  /** The zero-padded one-time code for the current step. */
  code: string;
  /** Seconds until the current step rolls over (drives the countdown ring). */
  secondsRemaining: number;
}

/**
 * Decode a base32 (RFC 4648) seed to bytes. Non-alphabet characters (hyphens, spaces, `=` padding) are
 * skipped, so a seed pasted with the common `XXXX-XXXX` grouping still decodes. Lowercase is accepted.
 */
function base32Decode(input: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue; // skip hyphens / spaces / padding / stray chars
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Encode an integer counter as an 8-byte big-endian buffer (RFC 4226 §5.1). Safe past 2^32. */
function counterToBytes(counter: number): Uint8Array {
  const buf = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    buf[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  return buf;
}

/**
 * Compute the RFC 6238 TOTP code for `now` (ms since epoch; defaults to the current time). Returns the
 * code plus the seconds left in the current step. Pure async — the only effect is the WebCrypto HMAC.
 */
export async function generateTotp(
  params: TotpParams,
  now: number = Date.now(),
): Promise<TotpCode> {
  const digits = params.digits ?? 6;
  const period = params.period ?? 30;
  const algorithm = params.algorithm ?? "SHA1";

  const keyBytes = base32Decode(params.secret);
  const seconds = Math.floor(now / 1000);
  const counter = Math.floor(seconds / period);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: HASHES[algorithm] },
    false,
    ["sign"],
  );
  const hmac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      counterToBytes(counter) as BufferSource,
    ),
  );

  // Dynamic truncation (RFC 4226 §5.3): low nibble of the last byte selects a 4-byte window.
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  const code = (binary % 10 ** digits).toString().padStart(digits, "0");
  const secondsRemaining = period - (seconds % period);
  return { code, secondsRemaining };
}
