import { describe, expect, test } from "bun:test";
import { createTranslator } from "next-intl";

import enAi from "../../messages/en/ai.json";
import esAi from "../../messages/es/ai.json";
import { ApiError } from "./client";
import { stepUpLockoutMessage } from "./step-up-lockout";

type Translate = Parameters<typeof stepUpLockoutMessage>[1];

function translator(locale: "en" | "es"): Translate {
  return createTranslator({
    locale,
    timeZone: "UTC",
    messages: { ai: locale === "en" ? enAi : esAi },
    namespace: "ai.approval.errors",
    onError: (error) => {
      throw error;
    },
  } as Parameters<typeof createTranslator>[0]) as unknown as Translate;
}

const locked = (body: Record<string, unknown>) =>
  new ApiError(429, "Too many wrong passwords; wait before trying again.", {
    statusCode: 429,
    code: "STEP_UP_RATE_LIMITED",
    ...body,
  });

describe("stepUpLockoutMessage", () => {
  test("a lockout with retryAfterSec names the wait, in the UI's language", () => {
    expect(stepUpLockoutMessage(locked({ retryAfterSec: 42 }), translator("en"))).toBe(
      "Too many wrong passwords. Try again in 42 seconds.",
    );
    expect(stepUpLockoutMessage(locked({ retryAfterSec: 1 }), translator("es"))).toBe(
      "Demasiadas contraseñas incorrectas. Probá de nuevo en 1 segundo.",
    );
  });

  test("a lockout without a usable retryAfterSec falls back to the timeless message", () => {
    expect(stepUpLockoutMessage(locked({}), translator("en"))).toBe(
      "Too many wrong passwords. Wait a moment and try again.",
    );
    expect(stepUpLockoutMessage(locked({ retryAfterSec: 0 }), translator("es"))).toBe(
      "Demasiadas contraseñas incorrectas. Esperá un momento y probá de nuevo.",
    );
  });

  test("any other error is not a lockout", () => {
    const t = translator("en");
    expect(stepUpLockoutMessage(new ApiError(401, "Invalid credentials"), t)).toBeNull();
    expect(
      stepUpLockoutMessage(new ApiError(429, "Too Many Requests", { statusCode: 429 }), t),
    ).toBeNull();
    expect(stepUpLockoutMessage(new Error("network"), t)).toBeNull();
  });
});
