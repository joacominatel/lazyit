import { describe, expect, test } from "bun:test";
import { idpChoiceFor, stepsFor } from "./wizard-flow";

describe("idpChoiceFor", () => {
  test("local mode stays local", () => {
    expect(idpChoiceFor("local")).toBe("local");
  });

  test("generic OIDC is the operator's own provider", () => {
    expect(idpChoiceFor("generic-oidc")).toBe("byoi");
  });

  test("a legacy zitadel value from an older API is treated as OIDC", () => {
    expect(idpChoiceFor("zitadel")).toBe("byoi");
  });
});

describe("stepsFor", () => {
  test("local mode skips the configure step", () => {
    expect(stepsFor("local")).toEqual(["welcome", "admin", "done"]);
  });

  test("OIDC mode always includes the configure step", () => {
    expect(stepsFor("byoi")).toEqual(["welcome", "configure", "admin", "done"]);
  });

  test("a legacy zitadel instance gets the full OIDC flow", () => {
    expect(stepsFor(idpChoiceFor("zitadel"))).toEqual([
      "welcome",
      "configure",
      "admin",
      "done",
    ]);
  });
});
