import type {
  AiApprovalRequest,
  AiConversationDetail,
  AiConversationState,
  AiMessagePart,
  AiPersistedMessage,
  AiRunError,
  AiRunEvent,
  AiRunStatus,
} from "@lazyit/shared";
import { eventSeq, isTerminalRunStatus } from "./run-events";

/**
 * The chat's pure state machine (frontend.md §5.2, synthesis §4.6). `(ChatState, ChatAction) → ChatState`,
 * React-free and `bun test`ed. The persisted transcript (`GET /ai/conversations/:id`) and the live run
 * events build the SAME shape — `AiPersistedMessage` parts — so a reconnect's `run.snapshot` merges into
 * what the stream built without a second representation.
 *
 * Rules:
 *   - an event of another run than the one followed is ignored (a stale follower);
 *   - an event whose `<runId>:<seq>` is not after the last one applied is a replay and ignored (ids
 *     increase but are not consecutive — compared, never counted); a snapshot resets the position;
 *   - an unknown event never reaches here (`parseRunEvent` drops it); an unknown PART type from a newer
 *     API is kept as data and rendered as "unsupported content".
 */

export interface ChatMessage extends AiPersistedMessage {
  /** Text is still arriving for this message. */
  streaming?: boolean;
  /** An optimistic user message not yet confirmed by the server. */
  local?: boolean;
}

export interface FollowedRun {
  id: string;
  status: AiRunStatus;
  /** The last event id applied, for `Last-Event-ID` on reconnect. */
  lastEventId: string | null;
  /** Its sequence number; -1 before the first event. */
  lastSeq: number;
}

export interface ChatState {
  conversationId: string | null;
  messages: ChatMessage[];
  run: FollowedRun | null;
  /** The last run's error, or a client-side notice (send refused, connection lost). */
  runError: AiRunError | null;
  /** Navigate calls the web already followed, so their chip reads "Opened". */
  navigated: string[];
}

export type ChatAction =
  | { type: "reset"; conversationId: string | null }
  | { type: "hydrate"; detail: AiConversationDetail }
  | { type: "userMessage"; localId: string; text: string; createdAt: string }
  | { type: "dropLocal"; localId: string }
  | { type: "bindConversation"; conversationId: string }
  | { type: "runStarted"; runId: string; status: AiRunStatus }
  | { type: "event"; runId: string; eventId: string | null; event: AiRunEvent }
  | { type: "notice"; error: AiRunError | null }
  | { type: "navigated"; toolCallId: string };

export function initialChatState(conversationId: string | null = null): ChatState {
  return { conversationId, messages: [], run: null, runError: null, navigated: [] };
}

/** The run status a conversation summary implies, for a conversation opened with an active run. */
export function runStatusOfConversation(state: AiConversationState): AiRunStatus {
  if (state === "awaiting-approval") return "AWAITING_APPROVAL";
  return "RUNNING";
}

type ToolPart = Extract<AiMessagePart, { type: "tool" }>;
type ApprovalPart = Extract<AiMessagePart, { type: "approval" }>;

function callIdOf(part: AiMessagePart): string | null {
  if (part.type === "tool") return part.toolCallId;
  if (part.type === "approval") return part.request.toolCallId;
  return null;
}

/** Replaces one message by index, immutably. */
function withMessage(messages: ChatMessage[], index: number, next: ChatMessage): ChatMessage[] {
  const copy = messages.slice();
  copy[index] = next;
  return copy;
}

/** Updates the first part matching `pred` anywhere in the transcript; `null` when none matched. */
function updatePart(
  messages: ChatMessage[],
  pred: (part: AiMessagePart) => boolean,
  update: (part: AiMessagePart) => AiMessagePart,
): ChatMessage[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const at = message.parts.findIndex(pred);
    if (at === -1) continue;
    const parts = message.parts.slice();
    parts[at] = update(parts[at]!);
    return withMessage(messages, i, { ...message, parts });
  }
  return null;
}

/** The last assistant message of the followed run, created when the run has none yet. */
function lastAssistant(messages: ChatMessage[], runId: string): [ChatMessage[], number] {
  const last = messages.length - 1;
  if (last >= 0 && messages[last]!.role === "assistant") return [messages, last];
  const created: ChatMessage = {
    id: `live:${runId}:${messages.length}`,
    role: "assistant",
    parts: [],
    createdAt: new Date(0).toISOString(),
  };
  return [[...messages, created], messages.length];
}

function appendPart(messages: ChatMessage[], runId: string, part: AiMessagePart): ChatMessage[] {
  const [next, index] = lastAssistant(messages, runId);
  const message = next[index]!;
  return withMessage(next, index, { ...message, parts: [...message.parts, part] });
}

function approvalPart(request: AiApprovalRequest): ApprovalPart {
  return { type: "approval", request, outcome: null };
}

/** Puts a pending approval on the card of its call: updates it, or inserts it after the tool line. */
function upsertApproval(messages: ChatMessage[], runId: string, request: AiApprovalRequest): ChatMessage[] {
  const updated = updatePart(
    messages,
    (part) => part.type === "approval" && part.request.toolCallId === request.toolCallId,
    () => approvalPart(request),
  );
  if (updated) return updated;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const at = message.parts.findIndex(
      (part) => part.type === "tool" && part.toolCallId === request.toolCallId,
    );
    if (at === -1) continue;
    const parts = message.parts.slice();
    parts.splice(at + 1, 0, approvalPart(request));
    return withMessage(messages, i, { ...message, parts });
  }
  return appendPart(messages, runId, approvalPart(request));
}

/**
 * Merges a run's persisted messages (a snapshot) into the transcript: a message with a known id is
 * replaced, a new one appended, the optimistic user message dropped once the server has one, and a call
 * the snapshot carries is removed from the live messages that also held it (a live tool line lands on
 * the last assistant message; the persisted one knows its real step).
 */
function mergeMessages(current: ChatMessage[], incoming: AiPersistedMessage[]): ChatMessage[] {
  if (incoming.length === 0) return current;
  const incomingIds = new Set(incoming.map((m) => m.id));
  const incomingCalls = new Set(
    incoming.flatMap((m) => m.parts.map(callIdOf).filter((id): id is string => id !== null)),
  );
  const serverHasUser = incoming.some((m) => m.role === "user");

  // The run's messages are contiguous and ordered: they go where the first message they replace was
  // (the optimistic user message, a live assistant message), or at the end when they replace none.
  const keep: ChatMessage[] = [];
  let insertAt = -1;
  for (const message of current) {
    const replaced = incomingIds.has(message.id) || (serverHasUser && message.local === true);
    if (replaced) {
      if (insertAt === -1) insertAt = keep.length;
      continue;
    }
    const parts = message.parts.filter((p) => {
      const id = callIdOf(p);
      return id === null || !incomingCalls.has(id);
    });
    if (parts.length === 0 && message.parts.length > 0) {
      if (insertAt === -1) insertAt = keep.length;
      continue;
    }
    keep.push(parts.length === message.parts.length ? message : { ...message, parts });
  }
  if (insertAt === -1) insertAt = keep.length;
  return [
    ...keep.slice(0, insertAt),
    ...incoming.map((m) => ({ ...m })),
    ...keep.slice(insertAt),
  ];
}

function stopStreaming(messages: ChatMessage[]): ChatMessage[] {
  return messages.some((m) => m.streaming)
    ? messages.map((m) => (m.streaming ? { ...m, streaming: false } : m))
    : messages;
}

function applyEvent(state: ChatState, runId: string, event: AiRunEvent): ChatState {
  const run = state.run!;
  switch (event.type) {
    case "run.snapshot": {
      let messages = mergeMessages(state.messages, event.messages);
      for (const request of event.pendingApprovals) {
        messages = upsertApproval(messages, runId, request);
      }
      if (isTerminalRunStatus(event.status)) messages = stopStreaming(messages);
      return { ...state, messages, run: { ...run, status: event.status } };
    }
    case "run.status": {
      const messages = isTerminalRunStatus(event.status)
        ? stopStreaming(state.messages)
        : state.messages;
      return { ...state, messages, run: { ...run, status: event.status } };
    }
    case "message.delta": {
      const at = state.messages.findIndex((m) => m.id === event.messageId);
      if (at === -1) {
        const message: ChatMessage = {
          id: event.messageId,
          role: "assistant",
          parts: [{ type: "text", text: event.text }],
          createdAt: new Date().toISOString(),
          streaming: true,
        };
        return { ...state, messages: [...state.messages, message] };
      }
      const message = state.messages[at]!;
      const parts = message.parts.slice();
      const last = parts[parts.length - 1];
      if (last?.type === "text") parts[parts.length - 1] = { type: "text", text: last.text + event.text };
      else parts.push({ type: "text", text: event.text });
      return {
        ...state,
        messages: withMessage(state.messages, at, { ...message, parts, streaming: true }),
      };
    }
    case "message.completed": {
      const at = state.messages.findIndex((m) => m.id === event.messageId);
      if (at === -1) return state;
      return {
        ...state,
        messages: withMessage(state.messages, at, { ...state.messages[at]!, streaming: false }),
      };
    }
    case "tool.call": {
      const known = updatePart(
        state.messages,
        (p) => p.type === "tool" && p.toolCallId === event.toolCallId,
        (p) => ({ ...(p as ToolPart), status: event.status }),
      );
      if (known) return { ...state, messages: known };
      const part: ToolPart = {
        type: "tool",
        toolCallId: event.toolCallId,
        name: event.name,
        class: event.class,
        status: event.status,
      };
      return { ...state, messages: appendPart(state.messages, runId, part) };
    }
    case "tool.approval_required": {
      const { v: _v, type: _type, ...request } = event;
      void _v;
      void _type;
      return { ...state, messages: upsertApproval(state.messages, runId, request) };
    }
    case "tool.approval_resolved": {
      const messages = updatePart(
        state.messages,
        (p) => p.type === "approval" && p.request.toolCallId === event.toolCallId,
        (p) => ({ ...(p as ApprovalPart), outcome: event.decision }),
      );
      return messages ? { ...state, messages } : state;
    }
    case "tool.result": {
      const { v: _v, type: _type, ...result } = event;
      void _v;
      void _type;
      const messages = updatePart(
        state.messages,
        (p) => p.type === "tool" && p.toolCallId === event.toolCallId,
        (p) => ({
          ...(p as ToolPart),
          status: result.status === "ok" ? "SUCCEEDED" : "FAILED",
          result,
        }),
      );
      return messages ? { ...state, messages } : state;
    }
    case "step.finished":
      return state;
    case "run.finished": {
      return {
        ...state,
        messages: stopStreaming(state.messages),
        run: { ...run, status: event.status },
        runError: event.error ?? null,
      };
    }
    default:
      return state;
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "reset":
      return initialChatState(action.conversationId);
    case "hydrate": {
      const { detail } = action;
      const sameRun = state.run && state.run.id === detail.activeRunId ? state.run : null;
      return {
        ...state,
        conversationId: detail.id,
        messages: detail.messages.map((m) => ({ ...m })),
        run: detail.activeRunId
          ? (sameRun ?? {
              id: detail.activeRunId,
              status: runStatusOfConversation(detail.status),
              lastEventId: null,
              lastSeq: -1,
            })
          : null,
      };
    }
    case "userMessage":
      return {
        ...state,
        runError: null,
        messages: [
          ...state.messages,
          {
            id: action.localId,
            role: "user",
            parts: [{ type: "text", text: action.text }],
            createdAt: action.createdAt,
            local: true,
          },
        ],
      };
    case "dropLocal":
      return { ...state, messages: state.messages.filter((m) => m.id !== action.localId) };
    case "bindConversation":
      return { ...state, conversationId: action.conversationId };
    case "runStarted":
      return {
        ...state,
        runError: null,
        run:
          state.run?.id === action.runId
            ? { ...state.run, status: action.status }
            : { id: action.runId, status: action.status, lastEventId: null, lastSeq: -1 },
      };
    case "event": {
      if (!state.run || state.run.id !== action.runId) return state;
      const seq = eventSeq(action.eventId, action.runId);
      const isSnapshot = action.event.type === "run.snapshot";
      if (!isSnapshot && seq !== null && seq <= state.run.lastSeq) return state;
      const next = applyEvent(state, action.runId, action.event);
      const position = isSnapshot
        ? (seq ?? (action.event as { seq: number }).seq)
        : (seq ?? state.run.lastSeq);
      return {
        ...next,
        run: next.run && {
          ...next.run,
          lastSeq: position,
          lastEventId:
            action.eventId && seq !== null ? action.eventId : next.run.lastEventId,
        },
      };
    }
    case "notice":
      return { ...state, runError: action.error };
    case "navigated":
      return state.navigated.includes(action.toolCallId)
        ? state
        : { ...state, navigated: [...state.navigated, action.toolCallId] };
    default:
      return state;
  }
}

/** Whether the followed run is still working (the composer shows Stop, not Send). */
export function isRunActive(state: ChatState): boolean {
  const status = state.run?.status;
  return status === "QUEUED" || status === "RUNNING";
}

/** Whether the followed run waits for a decision. */
export function isAwaitingApproval(state: ChatState): boolean {
  return state.run?.status === "AWAITING_APPROVAL";
}
