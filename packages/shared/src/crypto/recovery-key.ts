/**
 * Recovery key — generator, Crockford-base32 codec, and the zod shape validator (spec §4.1).
 *
 * Format (FROZEN, ADR-0061 §3 + spec §10): `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX` — 5 groups × 5 characters,
 * hyphen-separated. Alphabet = Crockford-base32 (`0-9A-Z` minus the ambiguous `I L O U`), 32 symbols.
 * 25 symbols × log2(32) = 125 bits of entropy — high-entropy, so the recovery key uses a FAST KDF
 * (HKDF, not Argon2id) for its private-key wrap (spec §4).
 *
 * THE SUBTLE BIT — 125-bit packing (not byte-aligned). We draw 16 random bytes (128 bits) via noble's
 * unbiased `randomBytes`, then CANONICALIZE by zeroing the 3 high bits of the first byte (`& 0x1F`),
 * yielding a 125-bit value. That canonical 16-byte buffer is the HKDF input keying material; the same
 * 125 bits encode deterministically and reversibly to the 25 Crockford symbols. Decode reverses it
 * byte-exactly. We do NOT use `randomByte % 32` (which biases the alphabet).
 *
 * Pure leaf: no `window`, no DOM. Randomness comes from noble's cross-platform `randomBytes`.
 */

import { z } from "zod";
import { randomBytes } from "@noble/hashes/utils.js";

/** Crockford-base32 alphabet: `0-9A-Z` minus the ambiguous `I L O U`. 32 symbols, index = value. */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Number of Crockford symbols in a recovery key (5 groups × 5). */
export const RECOVERY_KEY_SYMBOLS = 25;

/** Group size in the displayed format. */
const GROUP_SIZE = 5;

/** Number of random bytes backing one recovery key (128 bits drawn; 125 used). */
export const RECOVERY_KEY_BYTES = 16;

/** Bits used per Crockford symbol. */
const BITS_PER_SYMBOL = 5;

/** Total entropy bits encoded (25 × 5). */
export const RECOVERY_KEY_BITS = RECOVERY_KEY_SYMBOLS * BITS_PER_SYMBOL; // 125

/**
 * The recovery-key SHAPE regex (spec §4.1). Validates the displayed `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`
 * form over the Crockford alphabet — FORMAT only, never the value. Hyphens are part of the display
 * shape here; {@link normalizeRecoveryKey} strips them before decode.
 */
export const RECOVERY_KEY_REGEX = new RegExp(
  `^[${CROCKFORD_ALPHABET}]{${GROUP_SIZE}}(?:-[${CROCKFORD_ALPHABET}]{${GROUP_SIZE}}){4}$`,
);

/**
 * Zod validator for the recovery-key SHAPE (spec §4.1). Accepts the canonical
 * `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX` Crockford form. Validates shape ONLY — the server uses this for a
 * format check and never sees or validates the value.
 */
export const RecoveryKeySchema = z
  .string()
  .regex(RECOVERY_KEY_REGEX, "Invalid recovery-key format.");

/** The inferred recovery-key string type (a shape-validated display string). */
export type RecoveryKey = z.infer<typeof RecoveryKeySchema>;

/** Build a reverse lookup (symbol → 5-bit value) for decoding. */
const DECODE_MAP: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < CROCKFORD_ALPHABET.length; i++) {
    map[CROCKFORD_ALPHABET[i] as string] = i;
  }
  return map;
})();

/**
 * Canonicalize a 16-byte buffer to the 125-bit value space by zeroing the 3 high bits of byte 0
 * (`& 0x1F`). The returned buffer is the HKDF input keying material, and is what the symbols encode.
 * Operates on a copy — the input is not mutated.
 */
function canonicalize125(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== RECOVERY_KEY_BYTES) {
    throw new Error(`Recovery-key bytes must be ${RECOVERY_KEY_BYTES} long.`);
  }
  const out = bytes.slice();
  out[0] = (out[0] as number) & 0x1f; // keep only the low 5 bits of the top byte → 125-bit value
  return out;
}

/**
 * Encode a 16-byte buffer to the 25 Crockford symbols, MSB-first (spec §4.1). Canonicalizes to the
 * 125-bit value space first (zeroing the top 3 bits of byte 0), then walks the buffer as a big-endian
 * bit string emitting 5 bits per symbol. Deterministic and reversed exactly by
 * {@link decodeRecoveryKeyBytes}. Reading bit-by-bit avoids any 32-bit accumulator overflow.
 */
export function encodeRecoveryKeyBytes(bytes: Uint8Array): string {
  const canon = canonicalize125(bytes);
  const symbols: string[] = [];
  // The 125 meaningful bits are bits [3 .. 127] of the 128-bit big-endian buffer (bit 0 = MSB of
  // byte 0). Read 25 groups of 5 bits, MSB-first, starting at bit offset 3.
  for (let s = 0; s < RECOVERY_KEY_SYMBOLS; s++) {
    let value = 0;
    for (let b = 0; b < BITS_PER_SYMBOL; b++) {
      const bitIndex = 3 + s * BITS_PER_SYMBOL + b; // absolute bit position, MSB-first
      const byteIndex = bitIndex >>> 3;
      const bitInByte = 7 - (bitIndex & 7);
      const bit = ((canon[byteIndex] as number) >>> bitInByte) & 1;
      value = (value << 1) | bit;
    }
    symbols.push(CROCKFORD_ALPHABET[value] as string);
  }
  return symbols.join("");
}

/** Decode 25 Crockford symbols back to the canonical 16-byte (125-bit) buffer. Reverses the encoder. */
export function decodeRecoveryKeyBytes(symbols: string): Uint8Array {
  if (symbols.length !== RECOVERY_KEY_SYMBOLS) {
    throw new Error(`Recovery key must decode from ${RECOVERY_KEY_SYMBOLS} symbols.`);
  }
  const out = new Uint8Array(RECOVERY_KEY_BYTES); // zero-filled → top 3 bits stay 0
  for (let s = 0; s < RECOVERY_KEY_SYMBOLS; s++) {
    const ch = symbols[s] as string;
    const value = DECODE_MAP[ch];
    if (value === undefined) {
      throw new Error("Recovery key contains a non-Crockford symbol.");
    }
    for (let b = 0; b < BITS_PER_SYMBOL; b++) {
      const bit = (value >>> (BITS_PER_SYMBOL - 1 - b)) & 1;
      const bitIndex = 3 + s * BITS_PER_SYMBOL + b;
      const byteIndex = bitIndex >>> 3;
      const bitInByte = 7 - (bitIndex & 7);
      if (bit) {
        out[byteIndex] = (out[byteIndex] as number) | (1 << bitInByte);
      }
    }
  }
  return out;
}

/** Insert the display hyphens into a 25-symbol string → `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. */
function group(symbols: string): string {
  const parts: string[] = [];
  for (let i = 0; i < symbols.length; i += GROUP_SIZE) {
    parts.push(symbols.slice(i, i + GROUP_SIZE));
  }
  return parts.join("-");
}

/**
 * Strip the display hyphens and upper-case a recovery key, returning the bare 25-symbol string ready
 * for {@link decodeRecoveryKeyBytes}. Hyphens are display-only (spec §4.1).
 */
export function normalizeRecoveryKey(key: string): string {
  return key.replace(/-/g, "").toUpperCase();
}

/** The result of generating a recovery key: the display string plus its canonical HKDF input bytes. */
export interface GeneratedRecoveryKey {
  /** The displayed `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX` string — shown ONCE, never persisted (spec §4.1). */
  display: string;
  /** The canonical 16-byte (125-bit) buffer — the HKDF input keying material for the recovery wrap. */
  bytes: Uint8Array;
}

/**
 * Generate a fresh recovery key (spec §4.1). Draws 16 unbiased random bytes via noble's `randomBytes`,
 * canonicalizes to 125 bits, and returns both the displayed Crockford string and the canonical
 * 16-byte HKDF input. The display string is shown ONCE and never persisted/logged in clear; the bytes
 * feed the recovery-key wrap (`src/crypto/keys.ts` consumers / the web slice).
 */
export function generateRecoveryKey(): GeneratedRecoveryKey {
  const canon = canonicalize125(randomBytes(RECOVERY_KEY_BYTES));
  const symbols = encodeRecoveryKeyBytes(canon);
  return { display: group(symbols), bytes: canon };
}

/**
 * Decode a displayed recovery key (with or without hyphens) to its canonical 16-byte HKDF input.
 * Throws on a malformed shape. Use {@link RecoveryKeySchema} first for shape validation at a boundary.
 */
export function recoveryKeyToBytes(key: string): Uint8Array {
  const normalized = normalizeRecoveryKey(key);
  return decodeRecoveryKeyBytes(normalized);
}
