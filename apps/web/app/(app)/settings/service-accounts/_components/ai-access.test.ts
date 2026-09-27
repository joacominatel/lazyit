import { describe, expect, test } from "bun:test";
import { AiServiceAccountSettingsSchema } from "@lazyit/shared";
import { aiAccessBody, aiAccessNotes } from "./ai-access";

describe("aiAccessNotes", () => {
  test("nothing to explain while access is off", () => {
    expect(aiAccessNotes(["infra:report"], "off")).toEqual([]);
  });

  test("an infra:report account is refused whatever the setting", () => {
    expect(aiAccessNotes(["infra:report", "ai:use", "ai:connect"], "read-only")).toEqual([
      "infraReport",
    ]);
  });

  test("names the missing ai:use and ai:connect", () => {
    expect(aiAccessNotes(["asset:read"], "read-write")).toEqual(["noAiUse", "noAiConnect"]);
    expect(aiAccessNotes(["ai:use"], "read-write")).toEqual(["noAiConnect"]);
    expect(aiAccessNotes(["ai:use", "ai:connect"], "read-write")).toEqual([]);
  });
});

describe("aiAccessBody", () => {
  test("the cap is kept across access levels, and dropped only when limiting is off", () => {
    expect(aiAccessBody("read-only", true, "5")).toEqual({
      access: "read-only",
      maxMutationsPerRun: 5,
    });
    expect(aiAccessBody("off", true, "5")).toEqual({ access: "off", maxMutationsPerRun: 5 });
    expect(aiAccessBody("read-only", true, "")).toEqual({
      access: "read-only",
      maxMutationsPerRun: null,
    });
    expect(aiAccessBody("read-write", false, "5")).toEqual({
      access: "read-write",
      maxMutationsPerRun: null,
    });
    expect(aiAccessBody("read-write", true, " 5 ")).toEqual({
      access: "read-write",
      maxMutationsPerRun: 5,
    });
  });

  test("an unusable cap blocks the save", () => {
    expect(aiAccessBody("read-write", true, "")).toBeUndefined();
    expect(aiAccessBody("read-write", true, "0")).toBeUndefined();
    expect(aiAccessBody("read-write", true, "1.5")).toBeUndefined();
  });

  test("every body passes the strict shared schema", () => {
    for (const body of [
      aiAccessBody("off", false, ""),
      aiAccessBody("read-write", true, "10"),
    ]) {
      expect(AiServiceAccountSettingsSchema.safeParse(body).success).toBe(true);
    }
  });
});
