import type { AiStatus } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data access for the AI assistant (ADR-0097; docs/ai-assistant/_synthesis.md §4.5–§4.7). Only the
 * status read exists so far; conversations, runs, the event stream and approval decisions join this
 * file with the chat.
 */
const BASE = "/ai";

/**
 * What the AI assistant offers the caller (`GET /ai/status`, any authenticated principal). The server
 * combines the instance switches with the caller's permissions: `chat.available` = AI enabled ∧ a
 * provider configured ∧ `ai:use`. An API older than the assistant answers 404, which the web treats as
 * "off" (see `useAiChatAvailable`).
 */
export function getAiStatus(): Promise<AiStatus> {
  return apiFetch<AiStatus>(`${BASE}/status`);
}
