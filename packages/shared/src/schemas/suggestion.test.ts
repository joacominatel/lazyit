import { describe, expect, test } from "bun:test";
import { MAX_SUGGESTION_LIMIT, SuggestionFieldSchema, SuggestionQuerySchema } from "./suggestion";

describe("suggestion contract (ADR-0099 §7)", () => {
  test("only whitelisted fields are accepted", () => {
    expect(SuggestionFieldSchema.safeParse("currency").success).toBe(true);
    expect(SuggestionFieldSchema.safeParse("passwordHash").success).toBe(false);
  });

  test("limit defaults to 10 and above the maximum is refused, never clamped", () => {
    expect(SuggestionQuerySchema.parse({})).toEqual({ limit: 10 });
    expect(SuggestionQuerySchema.parse({ q: " de ", limit: "5" })).toEqual({ q: "de", limit: 5 });
    expect(SuggestionQuerySchema.safeParse({ limit: String(MAX_SUGGESTION_LIMIT + 1) }).success).toBe(false);
  });
});
