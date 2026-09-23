import { z } from "zod";
import {
  AiActionPreviewSchema,
  AiCallKindSchema,
  AiChannelSchema,
  AiEntityRefListSchema,
  AiEntityTypeSchema,
  AiToolClassSchema,
  AiToolNameSchema,
} from "./ai-tools";
import { int4 } from "./primitives";

/**
 * Conversations, runs, approvals and the run event stream (ADR-0097 decisions 4–6;
 * docs/ai-assistant/_synthesis.md §4.4, §4.6, §4.7, reconciliation R2; provider-and-runtime.md §8–9).
 *
 * A run is a BullMQ job with Postgres as the system of record. `POST` creates the run and answers
 * `202 { runId }`; the browser follows `GET /ai/runs/:id/events`, a fetch-streamed SSE whose events are
 * the versioned union below — lazyit's own vocabulary, not the AI SDK UI protocol.
 *
 * Status sets are upper-case and stored verbatim in text columns; a value this build does not know is a
 * newer build's and the API degrades it on read.
 */

/* ──────────────────────────────────────────────────────────────────────────────────────────────
 * Status sets (synthesis §4.4)
 * ────────────────────────────────────────────────────────────────────────────────────────────── */

/** `AiRun.status`: QUEUED → RUNNING → AWAITING_APPROVAL → … → a terminal status. */
export const AI_RUN_STATUSES = [
  "QUEUED",
  "RUNNING",
  "AWAITING_APPROVAL",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
] as const;
export const AiRunStatusSchema = z.enum(AI_RUN_STATUSES);
export type AiRunStatus = z.infer<typeof AiRunStatusSchema>;

/** The statuses after which a run never changes again. */
export const AI_RUN_TERMINAL_STATUSES = [
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
] as const satisfies readonly AiRunStatus[];

/** The statuses that count as the one active run a conversation may have (409 `RUN_IN_PROGRESS`). */
export const AI_RUN_ACTIVE_STATUSES = [
  "QUEUED",
  "RUNNING",
  "AWAITING_APPROVAL",
] as const satisfies readonly AiRunStatus[];

/** Humans approve every write; Service Accounts run autonomously within their grants. */
export const AI_APPROVAL_POLICIES = ["REQUIRE_APPROVAL_FOR_WRITES", "AUTONOMOUS"] as const;
export const AiApprovalPolicySchema = z.enum(AI_APPROVAL_POLICIES);
export type AiApprovalPolicy = z.infer<typeof AiApprovalPolicySchema>;

/**
 * `AiToolInvocation.status`. Reads and autonomous writes: EXECUTING → SUCCEEDED | FAILED | DENIED.
 * Interactive writes: AWAITING_APPROVAL → REJECTED | EXPIRED | CANCELLED, or the atomic approve claim
 * AWAITING_APPROVAL → EXECUTING → SUCCEEDED | FAILED | OUTCOME_UNKNOWN. OUTCOME_UNKNOWN is never retried.
 */
export const AI_TOOL_INVOCATION_STATUSES = [
  "AWAITING_APPROVAL",
  "EXECUTING",
  "SUCCEEDED",
  "FAILED",
  "DENIED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
  "OUTCOME_UNKNOWN",
] as const;
export const AiToolInvocationStatusSchema = z.enum(AI_TOOL_INVOCATION_STATUSES);
export type AiToolInvocationStatus = z.infer<typeof AiToolInvocationStatusSchema>;

/**
 * `AiActionLog.event` — one ledger row per write lifecycle event. MCP and headless write ATTEMPTED and
 * then the outcome; the chat writes PROPOSED, then the decision, then the outcome.
 */
export const AI_ACTION_LOG_EVENTS = [
  "PROPOSED",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
  "ATTEMPTED",
  "EXECUTED",
  "FAILED",
  "DENIED",
] as const;
export const AiActionLogEventSchema = z.enum(AI_ACTION_LOG_EVENTS);
export type AiActionLogEvent = z.infer<typeof AiActionLogEventSchema>;

/** The channels that own a conversation. MCP keeps no server-side conversation. */
export const AI_CONVERSATION_CHANNELS = ["CHAT", "HEADLESS"] as const satisfies readonly z.infer<
  typeof AiChannelSchema
>[];
export const AiConversationChannelSchema = z.enum(AI_CONVERSATION_CHANNELS);
export type AiConversationChannel = z.infer<typeof AiConversationChannelSchema>;

/** Why a conversation became read-only (synthesis §8.1 item 7, provider-and-runtime.md §7). */
export const AI_CONVERSATION_CLOSED_REASONS = [
  "CONTEXT_LIMIT",
  "CONFIG_CHANGED",
  "VERSION_CHANGED",
] as const;
export const AiConversationClosedReasonSchema = z.enum(AI_CONVERSATION_CLOSED_REASONS);
export type AiConversationClosedReason = z.infer<typeof AiConversationClosedReasonSchema>;

/** The roles of a stored, provider-replayable message (`AiMessage.role`). */
export const AI_MESSAGE_ROLES = ["user", "assistant", "tool"] as const;
export const AiMessageRoleSchema = z.enum(AI_MESSAGE_ROLES);
export type AiMessageRole = z.infer<typeof AiMessageRoleSchema>;

/**
 * Run-level error codes (synthesis §4.6). Tool-level codes are `AI_TOOL_ERROR_CODES`. On the wire a
 * code is an open string: the web maps the codes it knows and renders any other generically.
 */
export const AI_RUN_ERROR_CODES = [
  "AI_DISABLED",
  "FORBIDDEN",
  "PROVIDER_AUTH",
  "PROVIDER_RATE_LIMIT",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_BAD_REQUEST",
  "PROVIDER_REFUSED",
  "EGRESS_DENIED",
  "BUDGET_EXCEEDED",
  "CONTEXT_LIMIT",
  "MAX_STEPS",
  "CANCELLED",
  "ENGINE_RESTART",
  "RUN_IN_PROGRESS",
  "CONVERSATION_READ_ONLY",
  "STEP_UP_REQUIRED",
] as const;
export const AiRunErrorCodeSchema = z.enum(AI_RUN_ERROR_CODES);
export type AiRunErrorCode = z.infer<typeof AiRunErrorCodeSchema>;

/** A redacted, user-safe error. `code` is open (see {@link AI_RUN_ERROR_CODES}). */
export const AiRunErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  retryAfterSec: int4({ min: 0 }).optional(),
  requestId: z.string().optional(),
});
export type AiRunError = z.infer<typeof AiRunErrorSchema>;

/** Token usage of a step or a run. */
export const AiUsageSchema = z.object({
  inputTokens: int4({ min: 0 }),
  outputTokens: int4({ min: 0 }),
  cachedInputTokens: int4({ min: 0 }).optional(),
  reasoningTokens: int4({ min: 0 }).optional(),
});
export type AiUsage = z.infer<typeof AiUsageSchema>;

/* ──────────────────────────────────────────────────────────────────────────────────────────────
 * Requests (synthesis §4.7)
 * ────────────────────────────────────────────────────────────────────────────────────────────── */

/** Upper bound on one user message or headless prompt, in characters. */
export const AI_PROMPT_MAX_LENGTH = 20_000;

/**
 * The page the user is on when they send a message: the route and at most one entity, shown as a
 * removable chip. Never page content (synthesis §8.2).
 */
export const AiPageContextSchema = z.strictObject({
  route: z.string().min(1).max(2048),
  entity: z.strictObject({ type: AiEntityTypeSchema, id: z.string().min(1).max(200) }).optional(),
});
export type AiPageContext = z.infer<typeof AiPageContextSchema>;

/** `POST /ai/conversations/:id/messages` → `202 { runId, status }`. */
export const SendAiMessageSchema = z.strictObject({
  text: z.string().trim().min(1).max(AI_PROMPT_MAX_LENGTH),
  context: AiPageContextSchema.optional(),
});
export type SendAiMessage = z.infer<typeof SendAiMessageSchema>;

/** `POST /ai/runs` — the headless entry (an optional `Idempotency-Key` header dedupes retries). */
export const CreateAiRunSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(AI_PROMPT_MAX_LENGTH),
  conversationId: z.cuid().optional(),
});
export type CreateAiRun = z.infer<typeof CreateAiRunSchema>;

/** The answer to a message or a run creation: the run to follow. */
export const AiRunAcceptedSchema = z.object({
  runId: z.cuid(),
  status: AiRunStatusSchema,
});
export type AiRunAccepted = z.infer<typeof AiRunAcceptedSchema>;

/** `POST /ai/conversations` → the new conversation's id. */
export const AiConversationCreatedSchema = z.object({ id: z.cuid() });
export type AiConversationCreated = z.infer<typeof AiConversationCreatedSchema>;

/** What the user decided on a pending write. */
export const AI_APPROVAL_DECISIONS = ["approve", "reject"] as const;
export const AiApprovalDecisionValueSchema = z.enum(AI_APPROVAL_DECISIONS);
export type AiApprovalDecisionValue = z.infer<typeof AiApprovalDecisionValueSchema>;

/**
 * `POST /ai/runs/:id/tool-calls/:toolCallId/decision`. The request carries ONLY the decision — the
 * approved arguments are the server-stored ones (INV-AI-3). `password` is the step-up for `elevated`
 * actions that grant privilege or deliver a credential.
 */
export const AiApprovalDecisionSchema = z.strictObject({
  decision: AiApprovalDecisionValueSchema,
  reason: z.string().trim().min(1).max(500).optional(),
  password: z.string().min(1).max(1024).optional(),
});
export type AiApprovalDecision = z.infer<typeof AiApprovalDecisionSchema>;

/** How a pending write was resolved, as the event stream reports it. */
export const AI_APPROVAL_OUTCOMES = ["approved", "rejected", "expired", "cancelled"] as const;
export const AiApprovalOutcomeSchema = z.enum(AI_APPROVAL_OUTCOMES);
export type AiApprovalOutcome = z.infer<typeof AiApprovalOutcomeSchema>;

/* ──────────────────────────────────────────────────────────────────────────────────────────────
 * Event payloads shared by the stream and the persisted transcript
 * ────────────────────────────────────────────────────────────────────────────────────────────── */

/** A flat, redacted summary of a call's arguments — never the full input. */
const RedactedArgsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

/** A pending write waiting for the user's decision. */
export const AiApprovalRequestSchema = z.object({
  toolCallId: z.string().min(1),
  preview: AiActionPreviewSchema,
  elevated: z.boolean(),
  stepUpRequired: z.boolean(),
  untrustedSources: AiEntityRefListSchema,
  expiresAt: z.iso.datetime(),
});
export type AiApprovalRequest = z.infer<typeof AiApprovalRequestSchema>;

/** The outcome of a finished call, as the web shows it. */
export const AiToolResultSummarySchema = z.object({
  toolCallId: z.string().min(1),
  kind: AiCallKindSchema,
  status: z.enum(["ok", "error"]),
  summary: z.string().optional(),
  mutated: z.boolean(),
  entityRefs: AiEntityRefListSchema,
  error: z.object({ code: z.string().min(1), message: z.string() }).optional(),
  requestId: z.string().optional(),
});
export type AiToolResultSummary = z.infer<typeof AiToolResultSummarySchema>;

/**
 * One part of a persisted assistant message (frontend.md K3: the parts use the same types as the run
 * events — text, tool activity, an approval with its current state, a notice). Discriminated on `type`.
 */
export const AiMessagePartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool"),
    toolCallId: z.string().min(1),
    name: AiToolNameSchema,
    class: AiToolClassSchema,
    status: AiToolInvocationStatusSchema,
    result: AiToolResultSummarySchema.optional(),
  }),
  z.object({
    type: z.literal("approval"),
    request: AiApprovalRequestSchema,
    /** null while the user has not decided. */
    outcome: AiApprovalOutcomeSchema.nullable(),
  }),
  z.object({ type: z.literal("notice"), error: AiRunErrorSchema }),
]);
export type AiMessagePart = z.infer<typeof AiMessagePartSchema>;

/**
 * A transcript message projected to a provider-neutral wire shape. The stored `AiMessage.content` is the
 * provider-replayable message and never leaves the API as is.
 */
export const AiPersistedMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  parts: z.array(AiMessagePartSchema),
  createdAt: z.iso.datetime(),
});
export type AiPersistedMessage = z.infer<typeof AiPersistedMessageSchema>;

/* ──────────────────────────────────────────────────────────────────────────────────────────────
 * Read shapes (frontend.md K3)
 * ────────────────────────────────────────────────────────────────────────────────────────────── */

/** What the chat shows for a conversation's state. */
export const AI_CONVERSATION_STATES = ["idle", "running", "awaiting-approval"] as const;
export const AiConversationStateSchema = z.enum(AI_CONVERSATION_STATES);
export type AiConversationState = z.infer<typeof AiConversationStateSchema>;

/** One row of `GET /ai/conversations` (a `Page<T>` per ADR-0030). */
export const AiConversationSummarySchema = z.object({
  id: z.cuid(),
  title: z.string().nullable(),
  updatedAt: z.iso.datetime(),
  status: AiConversationStateSchema,
  readOnly: z.boolean(),
});
export type AiConversationSummary = z.infer<typeof AiConversationSummarySchema>;

/** `GET /ai/conversations/:id` — owner only; anyone else gets 404. */
export const AiConversationDetailSchema = AiConversationSummarySchema.extend({
  activeRunId: z.cuid().nullable(),
  messages: z.array(AiPersistedMessageSchema),
});
export type AiConversationDetail = z.infer<typeof AiConversationDetailSchema>;

/** `GET /ai/runs/:id` — status, final text, usage and a summary of the tool calls. No transcript. */
export const AiRunSchema = z.object({
  id: z.cuid(),
  conversationId: z.cuid().nullable(),
  channel: AiConversationChannelSchema,
  status: AiRunStatusSchema,
  approvalPolicy: AiApprovalPolicySchema,
  finalText: z.string().nullable(),
  finishReason: z.string().nullable(),
  usage: AiUsageSchema,
  toolCalls: z.array(
    z.object({
      toolCallId: z.string().min(1),
      name: AiToolNameSchema,
      class: AiToolClassSchema,
      status: AiToolInvocationStatusSchema,
    }),
  ),
  error: AiRunErrorSchema.nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type AiRun = z.infer<typeof AiRunSchema>;

/* ──────────────────────────────────────────────────────────────────────────────────────────────
 * The run event stream (synthesis §4.6) — versioned union, `v: 1`
 * ────────────────────────────────────────────────────────────────────────────────────────────── */

/** The current event-stream version. A breaking change bumps it; additive events do not. */
export const AI_RUN_EVENT_VERSION = 1 as const;

const v = z.literal(AI_RUN_EVENT_VERSION);

/**
 * The event union. Each SSE frame carries `id: <runId>:<seq>`, `event: <type>` and this object as JSON
 * `data`. A consumer parses each frame on its own and IGNORES a frame that fails to parse — an unknown
 * `type` from a newer API is skipped, never fatal.
 */
export const AiRunEventSchema = z.discriminatedUnion("type", [
  z.object({
    v,
    type: z.literal("run.snapshot"),
    /** The last sequence number the snapshot covers; replay continues after it. */
    seq: int4({ min: 0 }),
    status: AiRunStatusSchema,
    messages: z.array(AiPersistedMessageSchema),
    pendingApprovals: z.array(AiApprovalRequestSchema),
  }),
  z.object({ v, type: z.literal("run.status"), status: AiRunStatusSchema }),
  z.object({
    v,
    type: z.literal("message.delta"),
    messageId: z.string().min(1),
    text: z.string(),
  }),
  z.object({ v, type: z.literal("message.completed"), messageId: z.string().min(1) }),
  z.object({
    v,
    type: z.literal("tool.call"),
    toolCallId: z.string().min(1),
    name: AiToolNameSchema,
    kind: AiCallKindSchema,
    class: AiToolClassSchema,
    status: AiToolInvocationStatusSchema,
    args: RedactedArgsSchema.optional(),
  }),
  AiApprovalRequestSchema.extend({ v, type: z.literal("tool.approval_required") }),
  z.object({
    v,
    type: z.literal("tool.approval_resolved"),
    toolCallId: z.string().min(1),
    decision: AiApprovalOutcomeSchema,
  }),
  AiToolResultSummarySchema.extend({ v, type: z.literal("tool.result") }),
  z.object({
    v,
    type: z.literal("step.finished"),
    stepIndex: int4({ min: 0 }),
    usage: AiUsageSchema,
  }),
  z.object({
    v,
    type: z.literal("run.finished"),
    status: AiRunStatusSchema,
    finishReason: z.string().nullable(),
    usage: AiUsageSchema,
    error: AiRunErrorSchema.optional(),
  }),
]);
export type AiRunEvent = z.infer<typeof AiRunEventSchema>;
export type AiRunEventType = AiRunEvent["type"];
