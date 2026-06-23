import { describe, expect, test } from "bun:test";
import {
  CROCKFORD_ALPHABET,
  RECOVERY_KEY_BITS,
  RECOVERY_KEY_BYTES,
  RECOVERY_KEY_REGEX,
  RECOVERY_KEY_SYMBOLS,
  RecoveryKeySchema,
  decodeRecoveryKeyBytes,
  encodeRecoveryKeyBytes,
  generateRecoveryKey,
  normalizeRecoveryKey,
  recoveryKeyToBytes,
} from "./recovery-key";

describe("recovery-key constants", () => {
  test("are the spec-pinned values (125-bit Crockford)", () => {
    expect(CROCKFORD_ALPHABET).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
    expect(CROCKFORD_ALPHABET.length).toBe(32);
    expect(RECOVERY_KEY_SYMBOLS).toBe(25);
    expect(RECOVERY_KEY_BYTES).toBe(16);
    expect(RECOVERY_KEY_BITS).toBe(125);
  });

  test("Crockford alphabet excludes the ambiguous I, L, O, U", () => {
    for (const ch of ["I", "L", "O", "U"]) {
      expect(CROCKFORD_ALPHABET.includes(ch)).toBe(false);
    }
  });
});

describe("generateRecoveryKey", () => {
  test("produces a shape-valid display string and 16 canonical bytes", () => {
    const { display, bytes } = generateRecoveryKey();
    expect(RECOVERY_KEY_REGEX.test(display)).toBe(true);
    expect(RecoveryKeySchema.safeParse(display).success).toBe(true);
    expect(bytes.length).toBe(RECOVERY_KEY_BYTES);
    // Canonical: the top 3 bits of byte 0 are always zero (125-bit value space).
    expect((bytes[0] as number) & 0xe0).toBe(0);
  });

  test("the display round-trips back to the same canonical bytes", () => {
    const { display, bytes } = generateRecoveryKey();
    const decoded = recoveryKeyToBytes(display);
    expect([...decoded]).toEqual([...bytes]);
  });

  test("draws different keys across calls", () => {
    const a = generateRecoveryKey().display;
    const b = generateRecoveryKey().display;
    expect(a).not.toBe(b);
  });
});

describe("encode ↔ decode (byte-exact, deterministic)", () => {
  test("a fixed canonical buffer encodes to a fixed symbol string", () => {
    // All-zero canonical buffer → 25 zero symbols ("0").
    const zero = new Uint8Array(RECOVERY_KEY_BYTES);
    expect(encodeRecoveryKeyBytes(zero)).toBe("0".repeat(25));
    expect([...decodeRecoveryKeyBytes("0".repeat(25))]).toEqual([...zero]);
  });

  test("the max 125-bit value encodes to all-Z and decodes back exactly", () => {
    // 125 one-bits: byte 0 = 0x1f (top 3 bits zero), bytes 1..15 = 0xff.
    const maxBuf = new Uint8Array(RECOVERY_KEY_BYTES).fill(0xff);
    maxBuf[0] = 0x1f;
    const lastSymbol = CROCKFORD_ALPHABET[31] as string; // "Z"
    expect(encodeRecoveryKeyBytes(maxBuf)).toBe(lastSymbol.repeat(25));
    expect([...decodeRecoveryKeyBytes(lastSymbol.repeat(25))]).toEqual([
      ...maxBuf,
    ]);
  });

  test("a known mixed vector round-trips byte-exactly", () => {
    // Deterministic 16-byte buffer; canonicalized by the encoder.
    const raw = new Uint8Array([
      0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x11, 0x22, 0x33, 0x44,
      0x55, 0x66, 0x77, 0x88,
    ]);
    const symbols = encodeRecoveryKeyBytes(raw);
    expect(symbols.length).toBe(RECOVERY_KEY_SYMBOLS);
    // Decoding recovers the CANONICAL form (top 3 bits of byte 0 zeroed).
    const canon = raw.slice();
    canon[0] = canon[0]! & 0x1f;
    expect([...decodeRecoveryKeyBytes(symbols)]).toEqual([...canon]);
  });

  test("encode→decode→encode is stable for random keys", () => {
    for (let i = 0; i < 20; i++) {
      const { bytes } = generateRecoveryKey();
      const symbols = encodeRecoveryKeyBytes(bytes);
      const decoded = decodeRecoveryKeyBytes(symbols);
      expect([...decoded]).toEqual([...bytes]);
      expect(encodeRecoveryKeyBytes(decoded)).toBe(symbols);
    }
  });
});

describe("normalizeRecoveryKey", () => {
  test("strips hyphens and upper-cases", () => {
    expect(normalizeRecoveryKey("abcde-fghjk-mnpqr-stvwx-yz012")).toBe(
      "ABCDEFGHJKMNPQRSTVWXYZ012",
    );
  });

  test("recoveryKeyToBytes accepts the displayed (hyphenated) form", () => {
    const { display, bytes } = generateRecoveryKey();
    expect([...recoveryKeyToBytes(display)]).toEqual([...bytes]);
  });
});

describe("RecoveryKeySchema (shape only)", () => {
  test("accepts a well-formed key", () => {
    const { display } = generateRecoveryKey();
    expect(RecoveryKeySchema.safeParse(display).success).toBe(true);
    expect(RecoveryKeySchema.safeParse("ABCDE-FGHJK-MNPQR-STVWX-YZ012").success).toBe(
      true,
    );
  });

  test("rejects malformed keys", () => {
    const bad = [
      "", // empty
      "ABCDE-FGHJK-MNPQR-STVWX", // 4 groups
      "ABCDE-FGHJK-MNPQR-STVWX-YZ01", // last group too short
      "ABCDEFGHJKMNPQRSTVWXYZ012", // no hyphens (display form requires them)
      "ABCDE-FGHJK-MNPQR-STVWX-YZ0I2", // contains ambiguous 'I'
      "ABCDE-FGHJK-MNPQR-STVWX-YZ0L2", // contains ambiguous 'L'
      "abcde-fghjk-mnpqr-stvwx-yz012", // lowercase (display is upper Crockford)
      "ABCDE_FGHJK_MNPQR_STVWX_YZ012", // wrong separator
    ];
    for (const k of bad) {
      expect(RecoveryKeySchema.safeParse(k).success).toBe(false);
    }
  });
});
