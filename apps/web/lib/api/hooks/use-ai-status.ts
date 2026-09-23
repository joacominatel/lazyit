import { useQuery } from "@tanstack/react-query";
import { getAiStatus } from "../endpoints/ai";

/**
 * Query keys for the AI assistant. Every AI key lives under the single `["ai"]` root so the chat can
 * invalidate "everything except the assistant's own state" with one predicate
 * (docs/ai-assistant/frontend.md §5.2, Fork C).
 */
export const aiKeys = {
  all: ["ai"] as const,
  status: () => [...aiKeys.all, "status"] as const,
};

/**
 * The caller's AI status (`GET /ai/status`). Refetched on focus and after a minute, so an admin turning
 * the assistant on or off reaches other users without a reload (frontend.md Fork E). A 404 from an older
 * API is terminal and never retried (the global 4xx policy).
 */
export function useAiStatus() {
  return useQuery({
    queryKey: aiKeys.status(),
    queryFn: () => getAiStatus(),
    staleTime: 60 * 1000,
  });
}

/** The slice of a TanStack query result the gate reads. */
export interface AiStatusQueryState {
  status: "pending" | "error" | "success";
  data?: unknown;
}

/**
 * Whether the chat may render. Fails closed: only a successful read that says, literally,
 * `chat.available: true` opens it. Loading, any error (a 404 from an API without the assistant, a 401,
 * a 5xx after retries — even with an earlier answer still cached) and a body this build does not
 * recognize all read as "off". The server remains the real gate; this only decides what to draw.
 */
export function isAiChatAvailable(query: AiStatusQueryState): boolean {
  if (query.status !== "success") return false;
  const chat = (query.data as { chat?: { available?: unknown } } | null | undefined)?.chat;
  return chat?.available === true;
}

/** {@link isAiChatAvailable} over the live status query. */
export function useAiChatAvailable(): boolean {
  return isAiChatAvailable(useAiStatus());
}
