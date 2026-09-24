import { AiRunEventSchema, type AiRunEvent } from "@lazyit/shared";
import type { SseMessage } from "./sse-parser";

/**
 * SSE frame → run event (docs/ai-assistant/_synthesis.md §4.6). Each frame is parsed on its own and a frame
 * that does not parse — an event type from a newer API, a malformed body — is skipped, never fatal.
 */
export function parseRunEvent(message: SseMessage): AiRunEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(message.data);
  } catch {
    return null;
  }
  const parsed = AiRunEventSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * The sequence number of an event id `<runId>:<seq>` of `runId`, or `null` for another run's id or a
 * malformed one. Sequence numbers increase but are NOT consecutive: they are compared, never counted.
 */
export function eventSeq(eventId: string | null | undefined, runId: string): number | null {
  if (!eventId) return null;
  const prefix = `${runId}:`;
  if (!eventId.startsWith(prefix)) return null;
  const raw = eventId.slice(prefix.length);
  if (!/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}

/** Run statuses after which the event stream closes (waiting for the user, or over). */
export function streamClosesOn(status: string | null | undefined): boolean {
  return (
    status === "AWAITING_APPROVAL" ||
    status === "SUCCEEDED" ||
    status === "FAILED" ||
    status === "CANCELLED" ||
    status === "EXPIRED"
  );
}

/** Terminal run statuses. */
export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return streamClosesOn(status) && status !== "AWAITING_APPROVAL";
}
