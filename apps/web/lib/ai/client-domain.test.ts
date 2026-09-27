import { describe, expect, test } from "bun:test";
import { clientDomain } from "./client-domain";

describe("clientDomain", () => {
  test("returns the reported domain", () => {
    expect(clientDomain("claude.ai")).toBe("claude.ai");
  });

  test("trims surrounding whitespace", () => {
    expect(clientDomain("  claude.ai ")).toBe("claude.ai");
  });

  test("is null for a DCR client (null) and an older API (absent)", () => {
    expect(clientDomain(null)).toBeNull();
    expect(clientDomain(undefined)).toBeNull();
  });

  test("is null for anything that is not a non-empty string", () => {
    expect(clientDomain("")).toBeNull();
    expect(clientDomain("   ")).toBeNull();
    expect(clientDomain(42)).toBeNull();
    expect(clientDomain({ host: "claude.ai" })).toBeNull();
  });
});
