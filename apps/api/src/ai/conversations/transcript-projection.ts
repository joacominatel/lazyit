import {
  AiApprovalRequestSchema,
  AiMessagePartSchema,
  AiRunErrorSchema,
  AiToolClassSchema,
  AiToolInvocationStatusSchema,
  AiToolNameSchema,
  AiToolResultSchema,
  AiToolResultSummarySchema,
  type AiApprovalOutcome,
  type AiApprovalRequest,
  type AiCallKind,
  type AiMessagePart,
  type AiPersistedMessage,
  type AiToolClass,
  type AiToolInvocationStatus,
  type AiToolResultSummary,
} from '@lazyit/shared';
import type { AiToolInvocation } from '../../../generated/prisma/client';
import { toPendingAction } from '../core/pending-action';
import { callKindOf } from '../core/result-shaper';
import { toolResultEvent } from '../runtime/agent-loop';
import {
  AI_MESSAGE_FORMAT_MODEL,
  assistantMessageId,
  toApprovalRequest,
} from '../runtime/run-records';

/**
 * THE CONVERSATION PROJECTION (synthesis §4.7; frontend.md K3; provider-and-runtime.md §8.1 "Stored rows").
 * Turns the stored transcript into the provider-neutral `AiPersistedMessage[]` the web renders. The stored
 * `AiMessage.content` is the provider-replayable message and NEVER leaves the API as is: only text, the
 * tool activity (name, class, status, the same result summary the live `tool.result` event carries), the
 * approval card with its current outcome (the STORED preview, never model prose) and run notices.
 *
 * ALLOW-LIST BY FORMAT. Only rows whose `format` is exactly `aisdk-v7` are read. The runtime's own
 * records (`lazyit-system-prompt-v1`, `lazyit-run-v1`, `lazyit-step-v1`, and any `lazyit-*` a later build
 * adds) are state, not transcript — the frozen system prompt, session epochs, step ledgers — and never
 * reach the wire, whatever the query that loaded the rows asked for. Tool messages are folded into the
 * calls they answer and never become messages of their own. Everything else a model message may carry
 * (reasoning, provider options, signatures, raw tool input and output) is dropped.
 *
 * Read-tolerant: a row, part or value this build cannot read is skipped, never an error — a newer build's
 * rows degrade to less detail. Every part is validated against the shared schema before it is returned.
 */

/** The stored columns the projection reads (`ai_messages`). */
export interface TranscriptRow {
  seq: number;
  role: string;
  format: string;
  content: unknown;
  runId: string | null;
  createdAt: Date;
}

/** The run columns the projection reads, for its notices. */
export interface TranscriptRun {
  id: string;
  error: unknown;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface TranscriptInput {
  conversationId: string;
  rows: readonly TranscriptRow[];
  /** The conversation's invocations; those with a `toolUseId` (chat proposals) key the approval cards. */
  invocations: readonly AiToolInvocation[];
  /** Runs whose redacted error becomes a notice part. */
  runs?: readonly TranscriptRun[];
  /** The class of a tool by name (the registry), for calls that have no invocation row (reads). */
  classOf: (toolName: string) => AiToolClass | undefined;
}

/** The turn context the runtime prefixes to every user message (`buildTurnContext`); not the user's text. */
const TURN_CONTEXT_PREFIX = /^<turn_context>\n[\s\S]*?\n<\/turn_context>\n\n/;

interface Building {
  message: AiPersistedMessage;
  runId: string | null;
}

interface ToolSlot {
  part: Extract<AiMessagePart, { type: 'tool' }>;
  kind: AiCallKind;
  /** The stored invocation row, when the call has one (chat proposals carry the tool-use id). */
  row: AiToolInvocation | undefined;
}

export function projectTranscript(
  input: TranscriptInput,
): AiPersistedMessage[] {
  const proposals = new Map<string, AiToolInvocation>();
  // Latest row per tool-use id wins (ordered by creation).
  for (const row of [...input.invocations].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  )) {
    if (row.toolUseId) proposals.set(row.toolUseId, row);
  }
  const slots = new Map<string, ToolSlot>();
  const built: Building[] = [];

  const rows = [...input.rows]
    // THE ALLOW-LIST. Never "everything but lazyit-*": an unknown format is not transcript.
    .filter((row) => row.format === AI_MESSAGE_FORMAT_MODEL)
    .sort((a, b) => a.seq - b.seq);

  for (const row of rows) {
    const id = assistantMessageId(input.conversationId, row.seq);
    const createdAt = row.createdAt.toISOString();
    const message = readModelMessage(row.content);
    if (!message || message.role !== row.role) continue;

    if (message.role === 'user') {
      const text = userText(message.content);
      if (text === null) continue;
      built.push({
        runId: row.runId,
        message: {
          id,
          role: 'user',
          parts: [{ type: 'text', text }],
          createdAt,
        },
      });
      continue;
    }

    if (message.role === 'assistant') {
      const parts: AiMessagePart[] = [];
      for (const part of contentParts(message.content)) {
        if (part.type === 'text' && typeof part.text === 'string') {
          const last = parts[parts.length - 1];
          if (last?.type === 'text') last.text += part.text;
          else parts.push({ type: 'text', text: part.text });
          continue;
        }
        if (part.type === 'tool-call' && typeof part.toolCallId === 'string') {
          const slot = toolSlot(part, proposals, input.classOf);
          if (!slot || slots.has(slot.part.toolCallId)) continue;
          slots.set(slot.part.toolCallId, slot);
          parts.push(slot.part);
          const approval = approvalPart(slot.row);
          if (approval) parts.push(approval);
        }
      }
      if (parts.length === 0) continue;
      built.push({
        runId: row.runId,
        message: { id, role: 'assistant', parts, createdAt },
      });
      continue;
    }

    if (message.role === 'tool') {
      for (const part of contentParts(message.content)) {
        if (part.type !== 'tool-result' || typeof part.toolCallId !== 'string')
          continue;
        const slot = slots.get(part.toolCallId);
        if (!slot) continue;
        const result = resultSummary(part.toolCallId, part.output, slot.kind);
        if (result) {
          slot.part.result = result;
          if (!slot.row) {
            slot.part.status = result.status === 'ok' ? 'SUCCEEDED' : 'FAILED';
          }
        }
      }
    }
  }

  // A decided proposal whose tool message is not written yet (the run is between the decision and its
  // resume): its stored result is the answer.
  for (const slot of slots.values()) {
    if (slot.part.result || !slot.row?.result) continue;
    const action = toPendingAction(slot.row);
    if (action.result) {
      const summary = AiToolResultSummarySchema.safeParse(
        stripType(toolResultEvent(slot.part.toolCallId, action.result)),
      );
      if (summary.success) slot.part.result = summary.data;
    }
  }

  addNotices(input, built);
  return built
    .map(({ message }) => validMessage(message))
    .filter((message): message is AiPersistedMessage => message !== null);
}

// ─── Model messages (read defensively: the stored shape is the provider layer's) ───────────────────

interface StoredMessage {
  role: string;
  content: unknown;
}

interface StoredPart {
  type?: unknown;
  text?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  output?: unknown;
}

function readModelMessage(content: unknown): StoredMessage | null {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return null;
  }
  const role = (content as { role?: unknown }).role;
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') return null;
  return { role, content: (content as { content?: unknown }).content };
}

function contentParts(content: unknown): StoredPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(
    (part): part is StoredPart => !!part && typeof part === 'object',
  );
}

/** The text the user typed: the text parts, without the runtime's turn-context prefix. */
function userText(content: unknown): string | null {
  const texts = contentParts(content)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string);
  if (texts.length === 0) return null;
  return texts.join('').replace(TURN_CONTEXT_PREFIX, '');
}

// ─── Tool activity ───────────────────────────────────────────────────────────────────────────────

function toolSlot(
  part: StoredPart,
  proposals: ReadonlyMap<string, AiToolInvocation>,
  classOf: (toolName: string) => AiToolClass | undefined,
): ToolSlot | null {
  const toolCallId = part.toolCallId as string;
  if (toolCallId.length === 0) return null;
  const row = proposals.get(toolCallId);
  const name = AiToolNameSchema.safeParse(row?.toolName ?? part.toolName);
  if (!name.success) return null; // a name the model invented: nothing to show
  const cls = AiToolClassSchema.safeParse(row?.toolClass ?? classOf(name.data));
  if (!cls.success) return null;
  let status: AiToolInvocationStatus = 'EXECUTING';
  if (row) {
    const parsed = AiToolInvocationStatusSchema.safeParse(row.status);
    status = parsed.success ? parsed.data : 'FAILED';
  }
  return {
    part: {
      type: 'tool',
      toolCallId,
      name: name.data,
      class: cls.data,
      status,
    },
    kind: callKindOf(cls.data),
    row,
  };
}

/** The approval card of a chat proposal, with its current outcome (`null` while undecided). */
function approvalPart(
  row: AiToolInvocation | undefined,
): Extract<AiMessagePart, { type: 'approval' }> | null {
  if (!row || row.preview == null || row.expiresAt == null) return null;
  const action = toPendingAction(row);
  const request: AiApprovalRequest | null = toApprovalRequest(action);
  if (!request || !AiApprovalRequestSchema.safeParse(request).success) {
    return null;
  }
  return { type: 'approval', request, outcome: approvalOutcome(action) };
}

function approvalOutcome(
  action: ReturnType<typeof toPendingAction>,
): AiApprovalOutcome | null {
  switch (action.status) {
    case 'AWAITING_APPROVAL':
      return null;
    case 'REJECTED':
      return 'rejected';
    case 'EXPIRED':
      return 'expired';
    case 'CANCELLED':
      return 'cancelled';
    default:
      // EXECUTING, SUCCEEDED, FAILED, OUTCOME_UNKNOWN: executed only through an approval.
      return action.decidedAt ? 'approved' : null;
  }
}

/**
 * The web's summary of a tool-result part's output — the same fields the live `tool.result` event
 * carries (kind, status, summary, mutated, entity refs, error), never the result data itself.
 */
function resultSummary(
  toolCallId: string,
  output: unknown,
  kind: AiCallKind,
): AiToolResultSummary | null {
  if (!output || typeof output !== 'object') return null;
  // The provider layer wraps the result as `{ type: 'json' | 'error-json' | 'text' | 'error-text', value }`;
  // anything else is read as the result itself.
  const wrapped = output as { type?: unknown; value?: unknown };
  const isWrapped =
    typeof wrapped.type === 'string' &&
    OUTPUT_TYPES.has(wrapped.type) &&
    'value' in wrapped;
  const type = isWrapped ? wrapped.type : undefined;
  const value = isWrapped ? wrapped.value : output;
  const isError = type === 'error-json' || type === 'error-text';
  const parsed = AiToolResultSchema.safeParse(value);
  const candidate = parsed.success
    ? stripType(toolResultEvent(toolCallId, parsed.data))
    : {
        toolCallId,
        kind: readKind(value) ?? kind,
        status: isError || readOk(value) === false ? 'error' : 'ok',
        mutated: readMutated(value),
        entityRefs: [],
      };
  const summary = AiToolResultSummarySchema.safeParse(candidate);
  return summary.success ? summary.data : null;
}

const OUTPUT_TYPES = new Set(['json', 'error-json', 'text', 'error-text']);

function readKind(value: unknown): AiCallKind | undefined {
  const kind =
    value && typeof value === 'object'
      ? (value as { kind?: unknown }).kind
      : undefined;
  return kind === 'read' || kind === 'mutation' || kind === 'navigate'
    ? kind
    : undefined;
}

function readOk(value: unknown): boolean | undefined {
  const ok =
    value && typeof value === 'object'
      ? (value as { ok?: unknown }).ok
      : undefined;
  return typeof ok === 'boolean' ? ok : undefined;
}

function readMutated(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { mutated?: unknown }).mutated === true
  );
}

function stripType<T extends { type: string }>(event: T): Omit<T, 'type'> {
  const rest: Partial<T> = { ...event };
  delete rest.type;
  return rest as Omit<T, 'type'>;
}

// ─── Notices and validation ──────────────────────────────────────────────────────────────────────

/** A run that ended with a redacted error shows it as a notice after its last message. */
function addNotices(input: TranscriptInput, built: Building[]): void {
  for (const run of input.runs ?? []) {
    const error = AiRunErrorSchema.safeParse(run.error);
    if (!error.success) continue;
    const notice: AiMessagePart = { type: 'notice', error: error.data };
    let last = -1;
    for (let i = 0; i < built.length; i += 1) {
      if (built[i].runId === run.id) last = i;
    }
    if (last < 0) continue;
    if (built[last].message.role === 'assistant') {
      built[last].message.parts.push(notice);
      continue;
    }
    built.splice(last + 1, 0, {
      runId: run.id,
      message: {
        id: `${input.conversationId}:notice:${run.id}`,
        role: 'assistant',
        parts: [notice],
        createdAt: (run.finishedAt ?? run.createdAt).toISOString(),
      },
    });
  }
}

function validMessage(message: AiPersistedMessage): AiPersistedMessage | null {
  const parts = message.parts.filter(
    (part) => AiMessagePartSchema.safeParse(part).success,
  );
  if (parts.length === 0) return null;
  return { ...message, parts };
}
