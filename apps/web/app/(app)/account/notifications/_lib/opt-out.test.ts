import { describe, expect, test } from "bun:test";
import type { NotificationType } from "@lazyit/shared";
import { isEmailOn, nextOptedOutTypes } from "./opt-out";

const MANDATORY = new Set<NotificationType>(["mcp.client_connected"]);
const NONE = new Set<NotificationType>();

describe("nextOptedOutTypes (#879, security notices #1699)", () => {
  test("turning a type off adds it once, turning it on removes it", () => {
    expect(nextOptedOutTypes([], "low_stock", false, NONE)).toEqual(["low_stock"]);
    expect(nextOptedOutTypes(["low_stock"], "low_stock", false, NONE)).toEqual([
      "low_stock",
    ]);
    expect(nextOptedOutTypes(["low_stock"], "low_stock", true, NONE)).toEqual([]);
  });

  test("a security notice can never be opted out of", () => {
    expect(nextOptedOutTypes([], "mcp.client_connected", false, MANDATORY)).toEqual(
      [],
    );
  });

  test("a legacy opt-out entry for a security notice is dropped from the next save", () => {
    expect(
      nextOptedOutTypes(
        ["mcp.client_connected", "low_stock"],
        "admin_granted",
        false,
        MANDATORY,
      ),
    ).toEqual(["low_stock", "admin_granted"]);
  });
});

describe("isEmailOn", () => {
  test("a security notice reads on even with a legacy opt-out entry", () => {
    expect(isEmailOn(["mcp.client_connected"], "mcp.client_connected", MANDATORY)).toBe(
      true,
    );
  });

  test("other types follow the opt-out set", () => {
    expect(isEmailOn(["low_stock"], "low_stock", MANDATORY)).toBe(false);
    expect(isEmailOn([], "low_stock", MANDATORY)).toBe(true);
  });
});
