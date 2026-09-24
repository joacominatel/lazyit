import { describe, expect, test } from "bun:test";
import {
  AI_ENTITY_TYPES,
  AI_PREVIEW_WARNING_CODES,
  AI_RUN_ERROR_CODES,
  AI_TOOL_INVOCATION_STATUSES,
} from "@lazyit/shared";
import { ApiError } from "@/lib/api/client";
import en from "@/messages/en/ai.json";
import es from "@/messages/es/ai.json";
import {
  DECISION_ERROR_KINDS,
  decisionErrorKind,
  decisionNeedsRefresh,
  isKnownWarning,
  KNOWN_RUN_ERROR_CODES,
  runErrorKind,
  sendErrorCode,
} from "./error-kinds";

const refusal = (status: number, body: Record<string, unknown>) =>
  new ApiError(status, String(body.message ?? "x"), body, "req-1");

describe("decisionErrorKind (K5)", () => {
  test("403 STEP_UP_* are about the password, never a logout", () => {
    expect(decisionErrorKind(refusal(403, { code: "STEP_UP_REQUIRED" }))).toEqual({
      kind: "stepUpRequired",
      addedWarnings: [],
    });
    expect(decisionErrorKind(refusal(403, { code: "STEP_UP_FAILED" }))).toEqual({ kind: "stepUpFailed" });
    expect(decisionErrorKind(refusal(403, { code: "STEP_UP_UNAVAILABLE" }))).toEqual({
      kind: "stepUpUnavailable",
    });
    expect(decisionErrorKind(refusal(403, { code: "FORBIDDEN" }))).toEqual({ kind: "forbidden" });
  });

  test("STEP_UP_REQUIRED with addedWarnings: the card changed and now needs the password", () => {
    const kind = decisionErrorKind(
      refusal(403, { code: "STEP_UP_REQUIRED", addedWarnings: ["CRITICAL_APPLICATION", 7] }),
    );
    expect(kind).toEqual({ kind: "stepUpRequired", addedWarnings: ["CRITICAL_APPLICATION"] });
    expect(decisionNeedsRefresh(kind)).toBe(true);
    expect(decisionNeedsRefresh({ kind: "stepUpRequired", addedWarnings: [] })).toBe(false);
  });

  test("429 STEP_UP_RATE_LIMITED carries retryAfterSec", () => {
    expect(decisionErrorKind(refusal(429, { code: "STEP_UP_RATE_LIMITED", retryAfterSec: 42 }))).toEqual({
      kind: "stepUpRateLimited",
      retryAfterSec: 42,
    });
    expect(decisionErrorKind(refusal(429, { code: "STEP_UP_RATE_LIMITED", retryAfterSec: "x" }))).toEqual({
      kind: "stepUpRateLimited",
      retryAfterSec: null,
    });
  });

  test("409s", () => {
    expect(decisionErrorKind(refusal(409, { code: "PREVIEW_CHANGED", addedWarnings: ["NOTIFIES_USERS"] }))).toEqual({
      kind: "previewChanged",
      addedWarnings: ["NOTIFIES_USERS"],
    });
    expect(decisionErrorKind(refusal(409, { code: "RUN_NOT_AWAITING_APPROVAL" }))).toEqual({ kind: "notAwaiting" });
    expect(decisionErrorKind(refusal(409, { code: "AI_DISABLED" }))).toEqual({ kind: "aiDisabled" });
    expect(decisionErrorKind(refusal(409, { code: "STALE" }))).toEqual({ kind: "stale" });
    expect(decisionErrorKind(refusal(409, { code: "EXPIRED" }))).toEqual({ kind: "expired" });
    expect(decisionErrorKind(refusal(409, { code: "REJECTED" }))).toEqual({ kind: "alreadyDecided" });
    expect(decisionErrorKind(refusal(409, { code: "IN_PROGRESS" }))).toEqual({ kind: "alreadyDecided" });
  });

  test("the rest", () => {
    expect(decisionErrorKind(refusal(404, { code: "NOT_FOUND" }))).toEqual({ kind: "notFound" });
    expect(decisionErrorKind(refusal(500, {}))).toEqual({ kind: "unknown", requestId: "req-1" });
    expect(decisionErrorKind(new TypeError("fetch failed"))).toEqual({ kind: "unknown" });
  });

  test("which kinds re-read the card", () => {
    expect(decisionNeedsRefresh({ kind: "previewChanged", addedWarnings: [] })).toBe(true);
    expect(decisionNeedsRefresh({ kind: "notAwaiting" })).toBe(true);
    expect(decisionNeedsRefresh({ kind: "stale" })).toBe(true);
    expect(decisionNeedsRefresh({ kind: "stepUpFailed" })).toBe(false);
    expect(decisionNeedsRefresh({ kind: "stepUpRateLimited", retryAfterSec: 3 })).toBe(false);
  });
});

describe("runErrorKind", () => {
  test("known codes map to their key and recovery", () => {
    expect(runErrorKind("CONTEXT_LIMIT")).toEqual({ key: "CONTEXT_LIMIT", action: "newChat", refreshStatus: false });
    expect(runErrorKind("PROVIDER_RATE_LIMIT").action).toBe("retry");
    expect(runErrorKind("AI_DISABLED").refreshStatus).toBe(true);
  });

  test("unknown codes render generically", () => {
    expect(runErrorKind("SOMETHING_NEW")).toEqual({ key: "generic", action: "none", refreshStatus: false });
    expect(runErrorKind(undefined).key).toBe("generic");
  });

  test("send errors: API code, or NETWORK when the request never reached it", () => {
    expect(sendErrorCode(refusal(409, { code: "RUN_IN_PROGRESS" }))).toBe("RUN_IN_PROGRESS");
    expect(sendErrorCode(new TypeError("offline"))).toBe("NETWORK");
  });
});

describe("covering sets — every code has copy in BOTH catalogs", () => {
  for (const [locale, catalog] of [["en", en], ["es", es]] as const) {
    test(`${locale}: run error codes`, () => {
      for (const code of [...AI_RUN_ERROR_CODES, ...KNOWN_RUN_ERROR_CODES, "generic"]) {
        expect((catalog.errors.run as Record<string, string>)[code]).toBeString();
      }
    });
    test(`${locale}: preview warning codes`, () => {
      for (const code of AI_PREVIEW_WARNING_CODES) {
        expect(isKnownWarning(code)).toBe(true);
        expect((catalog.approval.warnings as Record<string, string>)[code]).toBeString();
      }
      expect(isKnownWarning("FUTURE_WARNING")).toBe(false);
      expect(catalog.approval.warnings.unknown).toContain("{code}");
    });
    test(`${locale}: decision error kinds`, () => {
      for (const kind of DECISION_ERROR_KINDS) {
        expect((catalog.approval.errors as Record<string, string>)[kind]).toBeString();
      }
    });
    test(`${locale}: entity types and tool statuses`, () => {
      for (const type of [...AI_ENTITY_TYPES, "unknown"]) {
        expect((catalog.entities as Record<string, string>)[type]).toBeString();
      }
      for (const status of [...AI_TOOL_INVOCATION_STATUSES, "unknown"]) {
        expect((catalog.tools.generic as Record<string, string>)[status]).toBeString();
      }
    });
  }
});
