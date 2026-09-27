import { describe, expect, test } from "bun:test";
import { CreateConsumableMovementSchema } from "@lazyit/shared";
import { issuesResolver, movementPayloadIssues } from "./movement-form";

describe("movementPayloadIssues", () => {
  test("the shared create schema is refined, so a .pick() of it throws (why the dialogs validate the payload)", () => {
    expect(() => CreateConsumableMovementSchema.pick({ quantity: true })).toThrow();
  });

  test("a valid payload has no issues", () => {
    expect(movementPayloadIssues({ type: "OUT", quantity: 2 })).toEqual({});
  });

  test("a missing or non-positive quantity is reported on `quantity`", () => {
    expect(Object.keys(movementPayloadIssues({ type: "OUT", quantity: undefined }))).toEqual([
      "quantity",
    ]);
    expect(Object.keys(movementPayloadIssues({ type: "IN", quantity: 0 }))).toEqual(["quantity"]);
  });

  test("a malformed target id is reported on its key", () => {
    expect(
      Object.keys(
        movementPayloadIssues({ type: "OUT", quantity: 1, targetUserId: "not-a-uuid" }),
      ),
    ).toEqual(["targetUserId"]);
  });
});

describe("issuesResolver", () => {
  test("passes the raw values through when there is nothing to report", async () => {
    const resolver = issuesResolver<{ quantity: number }>(() => ({}));
    const result = await resolver({ quantity: 3 }, undefined, {
      fields: {},
      shouldUseNativeValidation: false,
    });
    expect(result).toEqual({ values: { quantity: 3 }, errors: {} });
  });

  test("returns the issues as field errors and no values", async () => {
    const resolver = issuesResolver<{ quantity: number }>(() => ({
      quantity: { type: "too_big", message: "Too many" },
    }));
    const result = await resolver({ quantity: 9 }, undefined, {
      fields: {},
      shouldUseNativeValidation: false,
    });
    expect(result.values).toEqual({});
    expect(result.errors).toEqual({ quantity: { type: "too_big", message: "Too many" } });
  });
});
