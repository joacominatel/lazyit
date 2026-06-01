import { describe, expect, test } from "bun:test";
import { ApiErrorSchema } from "./api-error";

// The standard error envelope (ADR-0018) — mirrors Nest's HttpException response body.
describe("ApiErrorSchema", () => {
  test("accepts a single-message error", () => {
    expect(
      ApiErrorSchema.safeParse({
        statusCode: 404,
        message: "Asset not found",
        error: "Not Found",
      }).success,
    ).toBe(true);
  });

  test("accepts an array of messages (validation errors)", () => {
    expect(
      ApiErrorSchema.safeParse({
        statusCode: 400,
        message: ["name is required", "status is invalid"],
      }).success,
    ).toBe(true);
  });

  test("accepts an omitted error reason phrase", () => {
    expect(
      ApiErrorSchema.safeParse({ statusCode: 409, message: "Conflict" }).success,
    ).toBe(true);
  });

  test("rejects a missing statusCode", () => {
    expect(ApiErrorSchema.safeParse({ message: "boom" }).success).toBe(false);
  });
});
