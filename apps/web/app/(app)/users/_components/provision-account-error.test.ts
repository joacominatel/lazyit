import { describe, expect, test } from "bun:test";
import { ApiError } from "@/lib/api/client";
import { classifyProvisionError } from "./provision-account-error";

describe("classifyProvisionError (issue #1048)", () => {
  test("a 400 because the IdP can't provision surfaces the server's real message, NOT 'needs email'", () => {
    // The LOCAL/BYOI case that used to be mis-labelled "needs a real email".
    const serverMessage =
      "Provisioning an account is only available with the bundled identity provider.";
    const result = classifyProvisionError(new ApiError(400, serverMessage));
    expect(result).toEqual({ mode: "inline", message: serverMessage });
  });

  test("a 400 with no server message yields inline with null (caller falls back to its hint)", () => {
    const result = classifyProvisionError(new ApiError(400, ""));
    expect(result).toEqual({ mode: "inline", message: null });
  });

  test("a non-400 ApiError (e.g. 503) is a transient toast", () => {
    expect(classifyProvisionError(new ApiError(503, "IdP unreachable"))).toEqual(
      {
        mode: "toast",
      },
    );
  });

  test("a non-ApiError failure is a toast", () => {
    expect(classifyProvisionError(new Error("network"))).toEqual({
      mode: "toast",
    });
  });
});
