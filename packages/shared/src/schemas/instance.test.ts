import { describe, expect, test } from "bun:test";
import { InstanceVersionSchema } from "./instance";

describe("InstanceVersionSchema", () => {
  test("accepts a clean release, an off-tag describe and the dev fallback", () => {
    expect(
      InstanceVersionSchema.parse({ current: "v1.4.2", gitSha: "abc1234" }),
    ).toEqual({ current: "v1.4.2", gitSha: "abc1234" });
    expect(
      InstanceVersionSchema.parse({
        current: "v1.4.2-3-gabc1234",
        gitSha: "abc1234",
      }).current,
    ).toBe("v1.4.2-3-gabc1234");
    expect(
      InstanceVersionSchema.parse({ current: "dev", gitSha: "unknown" }),
    ).toEqual({ current: "dev", gitSha: "unknown" });
  });

  test("rejects empty or missing fields", () => {
    expect(
      InstanceVersionSchema.safeParse({ current: "", gitSha: "abc" }).success,
    ).toBe(false);
    expect(InstanceVersionSchema.safeParse({ current: "v1.0.0" }).success).toBe(
      false,
    );
  });
});
