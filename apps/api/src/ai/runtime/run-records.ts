import type {
  AiApprovalRequest,
  AiEntityRef,
  AiMessageRole,
} from '@lazyit/shared';
import type { AiPendingAction } from '../core/pending-action';

/**
 * What the runtime stores in `ai_messages` (provider-and-runtime.md §6.4, §7), told apart by `format`:
 *
 * - `aisdk-v7` — a provider-replayable `ModelMessage` (role `user` | `assistant` | `tool`), stored and
 *   replayed byte for byte. The ONLY rows the model ever sees.
 * - `lazyit-system-prompt-v1` — the conversation's frozen system prompt `{ text }`, at seq 0, role
 *   `system`. Built once at creation (tools §12) and sent as `instructions` on every step, so it never
 *   changes under the conversation (prefix caching, Anthropic preserved thinking).
 * - `lazyit-run-v1` — the run-start record `{ runId, sessionEpoch }`, role `system`, written with the
 *   user message: the chat session epoch the run's tool calls are delegated under (a logout or password
 *   change since then refuses them, like the session token itself).
 * - `lazyit-step-v1` — a step's call ledger `{ stepIndex, calls, outcomes, untrustedSources }`, role
 *   `system`: the calls of the assistant message just before it, and — when the step pauses for approval
 *   — the results already known (reads) and the invocation ids still pending (writes). The latest record
 *   of a step wins. It is what lets a resume, a cancel, an expiry or a crash answer EVERY call of the step
 *   in one tool message without parsing the provider's message format.
 *
 * Every `lazyit-*` row is runtime state: never replayed to the model and never projected to the web (the
 * conversation projection reads `aisdk-v7` rows only). All rows are append-only and are deleted only with
 * their conversation (retention, owner delete).
 */
export const AI_MESSAGE_FORMAT_MODEL = 'aisdk-v7';
export const AI_MESSAGE_FORMAT_SYSTEM_PROMPT = 'lazyit-system-prompt-v1';
export const AI_MESSAGE_FORMAT_RUN = 'lazyit-run-v1';
export const AI_MESSAGE_FORMAT_STEP = 'lazyit-step-v1';

/** The role of a runtime record row (never a provider message). */
export const AI_RUNTIME_RECORD_ROLE = 'system';

export interface SystemPromptRecord {
  text: string;
}

export interface RunRecord {
  runId: string;
  /** The chat session's `sessionEpoch` at submission (humans only). */
  sessionEpoch: number | null;
}

/** One call the model made in a step. */
export interface StepCall {
  toolCallId: string;
  toolName: string;
}

/** A call's answer as recorded: the output itself, or the pending invocation that will hold it. */
export type StepOutcome =
  | { toolCallId: string; output: unknown; isError: boolean }
  | { toolCallId: string; invocationId: string };

export interface StepRecord {
  stepIndex: number;
  calls: StepCall[];
  outcomes: StepOutcome[];
  /** Other-authored content the step read (the untrusted-source banner of later proposals). */
  untrustedSources: AiEntityRef[];
}

/** The role column for a provider message; an unknown shape reads as `assistant` (a model step's output). */
export function roleOf(message: unknown): AiMessageRole {
  const role =
    message && typeof message === 'object'
      ? (message as { role?: unknown }).role
      : undefined;
  return role === 'user' || role === 'tool' ? role : 'assistant';
}

/** A stored system prompt, or null when the row is not one this build can read. */
export function readSystemPrompt(content: unknown): string | null {
  const text =
    content && typeof content === 'object'
      ? (content as { text?: unknown }).text
      : undefined;
  return typeof text === 'string' && text.length > 0 ? text : null;
}

/** A stored run record, or null when unreadable. */
export function readRunRecord(content: unknown): RunRecord | null {
  if (!content || typeof content !== 'object') return null;
  const value = content as { runId?: unknown; sessionEpoch?: unknown };
  if (typeof value.runId !== 'string') return null;
  const epoch = value.sessionEpoch;
  return {
    runId: value.runId,
    sessionEpoch:
      typeof epoch === 'number' && Number.isInteger(epoch) ? epoch : null,
  };
}

/** A stored step record, or null when unreadable (read-tolerant: bad entries are dropped). */
export function readStepRecord(content: unknown): StepRecord | null {
  if (!content || typeof content !== 'object') return null;
  const value = content as Partial<Record<keyof StepRecord, unknown>>;
  if (typeof value.stepIndex !== 'number' || !Array.isArray(value.calls)) {
    return null;
  }
  const calls = value.calls.filter(
    (call): call is StepCall =>
      !!call &&
      typeof (call as StepCall).toolCallId === 'string' &&
      typeof (call as StepCall).toolName === 'string',
  );
  const outcomes = (Array.isArray(value.outcomes) ? value.outcomes : []).filter(
    (outcome): outcome is StepOutcome =>
      !!outcome &&
      typeof (outcome as StepOutcome).toolCallId === 'string' &&
      ('invocationId' in outcome
        ? typeof (outcome as { invocationId: unknown }).invocationId ===
          'string'
        : typeof (outcome as { isError?: unknown }).isError === 'boolean'),
  );
  const untrusted = Array.isArray(value.untrustedSources)
    ? (value.untrustedSources as AiEntityRef[])
    : [];
  return {
    stepIndex: value.stepIndex,
    calls,
    outcomes,
    untrustedSources: untrusted,
  };
}

/**
 * The `messageId` of `message.delta` / `message.completed`: `<conversationId>:<seq>` of the assistant row
 * the step persists, so a projection of the stored transcript can name the same message.
 */
export function assistantMessageId(
  conversationId: string,
  seq: number,
): string {
  return `${conversationId}:${seq}`;
}

/**
 * The wire approval request (`tool.approval_required`, the `run.snapshot` pending list) for a pending
 * action: the STORED preview, never model prose. `toolCallId` is the provider's tool-use id — the id the
 * decision endpoint carries. Null when the action has no readable preview or tool-use id.
 */
export function toApprovalRequest(
  action: AiPendingAction,
): AiApprovalRequest | null {
  if (!action.preview || !action.toolUseId || !action.expiresAt) return null;
  return {
    toolCallId: action.toolUseId,
    preview: action.preview,
    elevated: action.preview.elevated,
    stepUpRequired: action.preview.stepUpRequired,
    untrustedSources: action.preview.untrustedSources,
    expiresAt: action.expiresAt.toISOString(),
  };
}
