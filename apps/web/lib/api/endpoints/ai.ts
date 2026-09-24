import type {
  AiApprovalDecision,
  AiConversationCreated,
  AiConversationDetail,
  AiConversationSettings,
  AiConversationSummary,
  AiModelCatalog,
  AiRunAccepted,
  AiStatus,
  CreateAiConversation,
  Page,
  SendAiMessage,
  UpdateAiConversation,
} from "@lazyit/shared";
import type { SseMessage } from "../../ai/sse-parser";
import { apiFetch, apiFetchStream } from "../client";

/**
 * Data access for the AI assistant (ADR-0097; docs/ai-assistant/_synthesis.md §4.5–§4.7; frontend.md
 * K1, K3–K6). The only `apiFetch` callers for the assistant's status, conversations, runs, the run event
 * stream and approval decisions. Every conversation and run route is owner-only: anyone else gets 404.
 */
const BASE = "/ai";

const enc = encodeURIComponent;

/**
 * What the AI assistant offers the caller (`GET /ai/status`, any authenticated principal). The server
 * combines the instance switches with the caller's permissions: `chat.available` = AI enabled ∧ a
 * provider configured ∧ `ai:use`. An API older than the assistant answers 404, which the web treats as
 * "off" (see `useAiChatAvailable`).
 */
export function getAiStatus(): Promise<AiStatus> {
  return apiFetch<AiStatus>(`${BASE}/status`);
}

/** The caller's own conversations, most recent first (`Page<T>`, ADR-0030). */
export function listAiConversations(params: { limit?: number; offset?: number } = {}): Promise<
  Page<AiConversationSummary>
> {
  const query = new URLSearchParams();
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.offset !== undefined) query.set("offset", String(params.offset));
  const qs = query.toString();
  return apiFetch<Page<AiConversationSummary>>(`${BASE}/conversations${qs ? `?${qs}` : ""}`);
}

/** One conversation with its projected messages and, when a run is active, its id. */
export function getAiConversation(id: string): Promise<AiConversationDetail> {
  return apiFetch<AiConversationDetail>(`${BASE}/conversations/${enc(id)}`);
}

/**
 * Starts a conversation (409 `AI_DISABLED` while the assistant is off). The optional body carries the
 * chat's own model, effort, provider options and auto-approve (#1373, #1376); without one it is the
 * instance defaults with auto-approve off. 400 `EFFORT_UNSUPPORTED` / `PROVIDER_OPTIONS_UNSUPPORTED`.
 */
export function createAiConversation(body?: CreateAiConversation): Promise<AiConversationCreated> {
  return apiFetch<AiConversationCreated>(`${BASE}/conversations`, {
    method: "POST",
    ...(body ? { body } : {}),
  });
}

/**
 * Changes a conversation's settings (owner only). The model fields only until its first run (409
 * `CONVERSATION_SETTINGS_LOCKED` afterwards); auto-approve at any time. See `settingsErrorKey`.
 */
export function updateAiConversation(
  id: string,
  body: UpdateAiConversation,
): Promise<AiConversationSettings> {
  return apiFetch<AiConversationSettings>(`${BASE}/conversations/${enc(id)}`, {
    method: "PATCH",
    body,
  });
}

/**
 * What the chat's model picker offers (`GET /ai/models`, `ai:use`): the configured provider's models, the
 * admin's defaults and which knobs the provider takes. `listed: false` when the provider could not be
 * listed — free text stays allowed. 409 `AI_DISABLED` while the assistant is off.
 */
export function getAiModels(): Promise<AiModelCatalog> {
  return apiFetch<AiModelCatalog>(`${BASE}/models`);
}

/** Hard-deletes the transcript; the action ledger survives. 409 `RUN_IN_PROGRESS` while a run is active. */
export function deleteAiConversation(id: string): Promise<void> {
  return apiFetch<void>(`${BASE}/conversations/${enc(id)}`, { method: "DELETE" });
}

/** Sends a message → `202 { runId, status }`; follow the run's events. */
export function sendAiMessage(conversationId: string, body: SendAiMessage): Promise<AiRunAccepted> {
  return apiFetch<AiRunAccepted>(`${BASE}/conversations/${enc(conversationId)}/messages`, {
    method: "POST",
    body,
  });
}

/** Stops a run (at its next step boundary; partial output is kept). Idempotent. */
export function cancelAiRun(runId: string): Promise<AiRunAccepted> {
  return apiFetch<AiRunAccepted>(`${BASE}/runs/${enc(runId)}/cancel`, { method: "POST" });
}

/**
 * Approves or rejects a pending write. The body carries only the decision (and the password step-up);
 * the approved arguments are the server-stored ones. Refusals: see `decisionErrorKind`.
 */
export function decideAiToolCall(
  runId: string,
  toolCallId: string,
  body: AiApprovalDecision,
): Promise<AiRunAccepted> {
  return apiFetch<AiRunAccepted>(
    `${BASE}/runs/${enc(runId)}/tool-calls/${enc(toolCallId)}/decision`,
    { method: "POST", body },
  );
}

/**
 * The run's event stream (`GET /ai/runs/:id/events`), read with `fetch` and the Bearer token. Pass the
 * last event id to resume; without one the server answers with a `run.snapshot`.
 */
export function streamAiRunEvents(
  runId: string,
  options: { lastEventId?: string | null; signal?: AbortSignal } = {},
): Promise<AsyncGenerator<SseMessage, void, undefined>> {
  return apiFetchStream(`${BASE}/runs/${enc(runId)}/events`, {
    ...(options.lastEventId ? { lastEventId: options.lastEventId } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
