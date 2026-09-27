import { describe, expect, test } from "bun:test";
import { deriveOffboardingState } from "./state";

const BASE = {
  loading: false,
  coreError: false,
  consumablesError: false,
  consumablesForbidden: false,
  assetCount: 0,
  grantCount: 0,
  consumableCount: 0,
};

describe("deriveOffboardingState (issue #601 + ADR-0098)", () => {
  test("genuinely empty only when every read succeeded and nothing is held", () => {
    expect(deriveOffboardingState(BASE)).toMatchObject({ isEmpty: true, isError: false });
  });

  test("consumables alone make the person non-empty", () => {
    expect(deriveOffboardingState({ ...BASE, consumableCount: 1 }).isEmpty).toBe(false);
  });

  test("a failed consumables read is an error, never an empty act", () => {
    expect(deriveOffboardingState({ ...BASE, consumablesError: true })).toMatchObject({
      isError: true,
      isEmpty: false,
    });
  });

  test("a 403 on consumables degrades: no error, section unavailable, and emptiness is not claimed", () => {
    expect(deriveOffboardingState({ ...BASE, consumablesForbidden: true })).toEqual({
      isLoading: false,
      isError: false,
      isEmpty: false,
      consumablesUnavailable: true,
    });
  });

  test("never empty while loading or on a core read failure", () => {
    expect(deriveOffboardingState({ ...BASE, loading: true }).isEmpty).toBe(false);
    expect(deriveOffboardingState({ ...BASE, coreError: true })).toMatchObject({
      isError: true,
      isEmpty: false,
    });
  });
});
