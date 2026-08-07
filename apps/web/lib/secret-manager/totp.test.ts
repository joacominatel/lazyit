/**
 * RFC 6238 TOTP test vectors (Appendix B). The reference seed is the ASCII string "12345678901234567890"
 * (20 bytes), whose base32 (RFC 4648) encoding is "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ". The RFC publishes
 * 8-digit codes for the SHA1 algorithm at fixed Unix times; we feed each time as ms and assert an exact
 * match — proving the counter encoding, dynamic truncation, and modulus are all correct.
 *
 * NOTE (#1126): the RFC does NOT reuse the 20-byte seed across the three columns — SHA256 uses a
 * 32-byte seed and SHA512 a 64-byte seed (the same ASCII digit run extended to the hash's block-ish
 * length). Feeding the SHA1 seed to all three is the classic way to "fail" a correct implementation.
 */

import { afterEach, expect, test } from "bun:test";
import { generateTotp, type TotpAlgorithm } from "./totp";

const SEED_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
// base32("12345678901234567890123456789012") — 32 bytes, the RFC's SHA256 seed.
const SEED_BASE32_SHA256 =
  "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA";
// base32("1234567890...1234") — 64 bytes, the RFC's SHA512 seed.
const SEED_BASE32_SHA512 =
  "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA";

const TIMES = [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000];

// RFC 6238 Appendix B — all three algorithm columns, 8 digits, 30s step.
const VECTORS: Record<
  TotpAlgorithm,
  { seed: string; codes: readonly string[] }
> = {
  SHA1: {
    seed: SEED_BASE32,
    codes: [
      "94287082",
      "07081804",
      "14050471",
      "89005924",
      "69279037",
      "65353130",
    ],
  },
  SHA256: {
    seed: SEED_BASE32_SHA256,
    codes: [
      "46119246",
      "68084774",
      "67062674",
      "91819424",
      "90698825",
      "77737706",
    ],
  },
  SHA512: {
    seed: SEED_BASE32_SHA512,
    codes: [
      "90693936",
      "25091201",
      "99943326",
      "93441116",
      "38618901",
      "47863826",
    ],
  },
};

for (const algorithm of ["SHA1", "SHA256", "SHA512"] as const) {
  const { seed, codes } = VECTORS[algorithm];
  TIMES.forEach((time, i) => {
    const code = codes[i]!;
    test(`RFC 6238 ${algorithm} vector @ t=${time} → ${code}`, async () => {
      const result = await generateTotp(
        { secret: seed, digits: 8, algorithm, period: 30 },
        time * 1000,
      );
      expect(result.code).toBe(code);
    });
  });
}

test("secondsRemaining counts down within the step", async () => {
  // t=59 → 59 % 30 = 29 → 1 second left in the step.
  const r = await generateTotp({ secret: SEED_BASE32, period: 30 }, 59_000);
  expect(r.secondsRemaining).toBe(1);
});

test("defaults to 6 digits / SHA1 / 30s", async () => {
  const r = await generateTotp({ secret: SEED_BASE32 }, 59_000);
  expect(r.code).toHaveLength(6);
  // The 6-digit truncation of the t=59 vector (94287082 → last 6 digits = 287082).
  expect(r.code).toBe("287082");
});

test("tolerates hyphen/space grouping and lowercase in the seed", async () => {
  const grouped = "gezd-gnbv gy3t-qojq gezd-gnbv gy3t-qojq";
  const r = await generateTotp(
    { secret: grouped, digits: 8, period: 30 },
    59_000,
  );
  expect(r.code).toBe("94287082");
});

/**
 * #1126 — the regression this whole change exists for. A lazyit served over plain HTTP on a LAN IP
 * (ADR-0087 `lan` mode) is NOT a secure context, so `crypto.subtle` is `undefined` there while
 * `crypto.getRandomValues` still works. `localhost` IS a secure context, which is why dev never
 * reproduced it and the bug shipped.
 *
 * Mechanism note: `subtle` is a NON-configurable property on the real `crypto` object, so
 * `Object.defineProperty(globalThis.crypto, "subtle", …)` throws. The whole global must be swapped.
 */
const realCrypto = globalThis.crypto;

function withoutSubtle(): void {
  Object.defineProperty(globalThis, "crypto", {
    // Deliberately only `getRandomValues` — that is exactly what an insecure context exposes.
    value: { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "crypto", {
    value: realCrypto,
    configurable: true,
    writable: true,
  });
});

test("derives codes in an INSECURE CONTEXT (no crypto.subtle) — #1126", async () => {
  withoutSubtle();
  // `in`, not `globalThis.crypto.subtle === undefined`: this asserts the property is ABSENT
  // (what an insecure context actually gives you) rather than merely undefined, and it keeps the
  // ESLint secure-context guard exemption-free — the guard matches `.subtle` on ANY object, so a
  // member access here would need a disable comment, and a guard with a hole in the very file
  // that proves the bug is a guard nobody can trust.
  expect("subtle" in globalThis.crypto).toBe(false);

  for (const algorithm of ["SHA1", "SHA256", "SHA512"] as const) {
    const { seed, codes } = VECTORS[algorithm];
    const r = await generateTotp(
      { secret: seed, digits: 8, algorithm, period: 30 },
      59_000,
    );
    expect(r.code).toBe(codes[0]!);
  }
});

test("insecure context: defaults still work end to end — #1126", async () => {
  withoutSubtle();
  const r = await generateTotp({ secret: SEED_BASE32 }, 59_000);
  expect(r.code).toBe("287082");
  expect(r.secondsRemaining).toBe(1);
});

/**
 * A seed that decodes to zero bytes must stay a LOUD failure. `crypto.subtle.importKey` rejected a
 * zero-length HMAC key with `DataError`, which is what made the UI's "check the seed format" message
 * correct for that case. Pure-JS HMAC happily accepts an empty key and would return a plausible but
 * meaningless six-digit code — silently useless for 2FA. Assert the rejection survives the swap.
 */
for (const bad of ["", "   ", "!!!!", "-- --"]) {
  test(`rejects a seed that decodes to no bytes: ${JSON.stringify(bad)}`, async () => {
    await expect(generateTotp({ secret: bad }, 59_000)).rejects.toThrow();
  });
}

test("an unusable seed is rejected in an insecure context too", async () => {
  withoutSubtle();
  await expect(generateTotp({ secret: "" }, 59_000)).rejects.toThrow();
});
