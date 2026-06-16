import { describe, expect, test } from "bun:test";
import { SetupPasswordSchema } from "./config";
import { ZitadelPasswordSchema } from "./primitives";
import { TempPasswordSchema } from "./user";

/**
 * Drift guard (issue #474). `TempPasswordSchema` (admin temp-password, ADR-0064) and
 * `SetupPasswordSchema` (first-run wizard, ADR-0043) must enforce the IDENTICAL Zitadel default
 * complexity policy — otherwise a password could pass shared validation yet be rejected by Zitadel
 * mid-mirror (the compensate-then-503 path). Both now build from the single shared
 * `ZitadelPasswordSchema` (`schemas/primitives.ts`); these tests pin that invariant so a future edit
 * that re-diverges one schema (or the shared definition) fails CI loudly.
 */

// A corpus of valid + invalid passwords, each tagged with the policy rule it exercises. Every schema
// under test must agree (pass/fail) on every entry.
const CORPUS: { password: string; valid: boolean; why: string }[] = [
  { password: "Abcdef1!", valid: true, why: "meets every rule (min length)" },
  { password: "Str0ng!Pass", valid: true, why: "meets every rule (longer)" },
  { password: "A1!" + "a".repeat(67), valid: true, why: "exactly 70 chars" },
  { password: "Abc1!", valid: false, why: "too short (< 8)" },
  { password: "", valid: false, why: "empty" },
  { password: "abcdef1!", valid: false, why: "no uppercase" },
  { password: "ABCDEF1!", valid: false, why: "no lowercase" },
  { password: "Abcdefg!", valid: false, why: "no digit" },
  { password: "Abcdefg1", valid: false, why: "no symbol" },
  { password: "A1!" + "a".repeat(68), valid: false, why: "71 chars (> max 70)" },
];

const SCHEMAS = {
  ZitadelPasswordSchema,
  TempPasswordSchema,
  SetupPasswordSchema,
} as const;

describe("password-policy drift guard (#474)", () => {
  // Identity check: both consumers ARE the single shared source (so the corpus tests below cannot pass
  // by coincidence — a re-divergence to a fresh schema object would trip this immediately).
  test("TempPasswordSchema and SetupPasswordSchema are the shared ZitadelPasswordSchema", () => {
    expect(TempPasswordSchema).toBe(ZitadelPasswordSchema);
    expect(SetupPasswordSchema).toBe(ZitadelPasswordSchema);
  });

  for (const [name, schema] of Object.entries(SCHEMAS)) {
    describe(name, () => {
      for (const { password, valid, why } of CORPUS) {
        test(`${valid ? "accepts" : "rejects"} — ${why}`, () => {
          expect(schema.safeParse(password).success).toBe(valid);
        });
      }
    });
  }

  // The two named schemas must agree on EVERY entry (the actual anti-drift assertion, independent of
  // the identity check above — this would still catch drift even if they were separate objects).
  test("Temp and Setup agree on the full corpus (pass/fail parity)", () => {
    for (const { password } of CORPUS) {
      expect(TempPasswordSchema.safeParse(password).success).toBe(
        SetupPasswordSchema.safeParse(password).success,
      );
    }
  });
});
