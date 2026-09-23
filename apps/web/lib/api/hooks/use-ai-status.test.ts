import { describe, expect, test } from "bun:test";
import type { AiStatus } from "@lazyit/shared";
import { ApiError } from "../client";
import { skip4xxRetry } from "../retry";
import { isAiChatAvailable } from "./use-ai-status";

/**
 * The fail-closed gate behind the AI launcher and panel (docs/ai-assistant/frontend.md Fork E): the
 * chat renders only when the server said `chat.available: true`, and every other state — including an
 * API that predates the assistant — is "off".
 */

const status = (chatAvailable: boolean): AiStatus => ({
  chat: { available: chatAvailable },
  mcp: { available: false, auth: "oauth" },
  configRevision: "rev-1",
  retentionDays: 90,
});

describe("isAiChatAvailable", () => {
  test("opens only on a successful read that says the chat is available", () => {
    expect(isAiChatAvailable({ status: "success", data: status(true) })).toBe(true);
  });

  test.each([
    ["loading", { status: "pending" as const }],
    ["an older API without /ai/status (404)", { status: "error" as const, data: undefined }],
    ["an expired session (401)", { status: "error" as const }],
    ["the server failing (5xx)", { status: "error" as const }],
    ["an error while an earlier 'available' answer is still cached", { status: "error" as const, data: status(true) }],
    ["AI disabled, unconfigured, or no ai:use", { status: "success" as const, data: status(false) }],
  ])("is off for %s", (_label, query) => {
    expect(isAiChatAvailable(query)).toBe(false);
  });

  test.each([
    ["an empty body", undefined],
    ["null", null],
    ["an object without chat", {}],
    ["chat without available", { chat: {} }],
    ["a non-boolean flag", { chat: { available: "true" } }],
    ["a truthy non-boolean flag", { chat: { available: 1 } }],
  ])("is off for an unrecognized body: %s", (_label, data) => {
    expect(isAiChatAvailable({ status: "success", data })).toBe(false);
  });

  test("a 404 from an older API is never retried, so the shell settles on off at once", () => {
    expect(skip4xxRetry(0, new ApiError(404, "Cannot GET /ai/status"))).toBe(false);
  });
});
