/**
 * RFC 6238 TOTP test vectors (Appendix B). The reference seed is the ASCII string "12345678901234567890"
 * (20 bytes), whose base32 (RFC 4648) encoding is "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ". The RFC publishes
 * 8-digit codes for the SHA1 algorithm at fixed Unix times; we feed each time as ms and assert an exact
 * match — proving the counter encoding, dynamic truncation, and modulus are all correct.
 */

import { expect, test } from "bun:test";
import { generateTotp } from "./totp";

const SEED_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

// RFC 6238 Appendix B, SHA1 column (8 digits, 30s step).
const VECTORS: Array<{ time: number; code: string }> = [
  { time: 59, code: "94287082" },
  { time: 1111111109, code: "07081804" },
  { time: 1111111111, code: "14050471" },
  { time: 1234567890, code: "89005924" },
  { time: 2000000000, code: "69279037" },
  { time: 20000000000, code: "65353130" },
];

for (const { time, code } of VECTORS) {
  test(`RFC 6238 SHA1 vector @ t=${time} → ${code}`, async () => {
    const result = await generateTotp(
      { secret: SEED_BASE32, digits: 8, algorithm: "SHA1", period: 30 },
      time * 1000,
    );
    expect(result.code).toBe(code);
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
