/**
 * RFC 6238 TOTP generator (ADR-0075) — pure, client-side, context-independent.
 *
 * WHY NOT `crypto.subtle` (#1126): SubtleCrypto is a **secure-context-only** API. A self-hosted lazyit
 * reached over plain HTTP on a LAN IP is a first-class deployment shape (ADR-0087 `lan` mode), and there
 * `crypto.subtle` is simply `undefined` — every TOTP item rendered a permanent error blaming the user's
 * seed for a deployment-mode limitation. `localhost` IS a secure context, so development never
 * reproduces it. This module therefore uses the pure-JS `@noble/hashes` HMAC, which is already a direct
 * `apps/web` dependency and already the crypto vocabulary of the whole zero-knowledge envelope
 * (`docs/04-development/secret-manager-crypto-design.md` ratified "one audited noble vocabulary"; this
 * file was the lone WebCrypto holdout). ADR-0087's remediation table prescribes exactly this swap.
 *
 * There is deliberately **no** `crypto.subtle`-when-available fast path. Two code paths where dev only
 * ever exercises one is precisely how this bug shipped; one tested path is the point.
 *
 * The algorithm is unchanged: identical HMAC-SHA1/256/512, identical RFC 6238 construction, identical
 * output. `sha1` comes from noble's `legacy.js` module — that label is about **collision** resistance,
 * which HMAC-SHA1 does not rely on. HMAC-SHA1 is unbroken, is what RFC 6238 mandates, and is what every
 * authenticator app uses; do not "upgrade" the default or every existing TOTP item breaks.
 *
 * SECURITY (INV-10): the seed is a SECRET like any other — it is decrypted from the vault envelope only
 * in browser memory, generated here transiently, and never persisted/logged/sent. This module computes a
 * code from a seed it is handed; it does not store the seed. The computation stays 100% client-side.
 */

import { hmac } from "@noble/hashes/hmac.js";
import { sha1 } from "@noble/hashes/legacy.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";

/** Supported HMAC hashes (RFC 6238 §1.2) mapped to the pure-JS noble hash functions. */
const HASHES = {
  SHA1: sha1,
  SHA256: sha256,
  SHA512: sha512,
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
 * code plus the seconds left in the current step.
 *
 * The body is synchronous now that the HMAC is pure JS, but the `Promise<TotpCode>` signature is kept
 * deliberately: `typed-secret-reveal.tsx` awaits it inside a 1s ticking effect, and narrowing the
 * signature would ripple into that caller for no benefit.
 */
export async function generateTotp(
  params: TotpParams,
  now: number = Date.now(),
): Promise<TotpCode> {
  const digits = params.digits ?? 6;
  const period = params.period ?? 30;
  const algorithm = params.algorithm ?? "SHA1";

  const keyBytes = base32Decode(params.secret);
  // A seed that decodes to nothing is a genuinely malformed seed and must stay a LOUD failure.
  // `crypto.subtle.importKey` used to reject a zero-length HMAC key with `DataError`; pure-JS HMAC
  // accepts one and would return a plausible but meaningless code — silently useless for 2FA.
  if (keyBytes.length === 0) {
    throw new Error("TOTP seed is empty or not valid base32");
  }

  const seconds = Math.floor(now / 1000);
  const counter = Math.floor(seconds / period);

  // noble argument order is `hmac(hashFn, key, message)` — key first, then the counter block.
  const mac = hmac(HASHES[algorithm], keyBytes, counterToBytes(counter));

  // Dynamic truncation (RFC 4226 §5.3): low nibble of the last byte selects a 4-byte window.
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);

  const code = (binary % 10 ** digits).toString().padStart(digits, "0");
  const secondsRemaining = period - (seconds % period);
  return { code, secondsRemaining };
}
