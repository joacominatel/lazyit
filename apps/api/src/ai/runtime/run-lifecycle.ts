import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AI_RUN_WAITING_STATUSES,
  AiRunEventSchema,
  type AiApprovalOutcome,
  type AiInputOutcome,
  type AiConversationClosedReason,
  type AiRunError,
  type AiRunEvent,
  type AiRunStatus,
  type AiToolErrorCode,
  type AiUsage,
} from '@lazyit/shared';
import type { AiRun, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AiToolService } from '../core/ai-tool.service';
import { toPendingAction } from '../core/pending-action';
import {
  CHAT_MODEL_PORT,
  type ChatModelPort,
  type ChatModelToolOutcome,
} from '../core/ports/chat-model.port';
import {
  RUN_EVENT_BUS,
  type RunEventBus,
} from '../core/ports/run-event-bus.port';
import { callKindOf, errorResult } from '../core/result-shaper';
import { AiToolRegistry } from '../core/tool-registry';
import { AiInputRequests } from './input-requests';
import { capToolOutput } from './limits';
import {
  AI_MESSAGE_FORMAT_MODEL,
  AI_MESSAGE_FORMAT_STEP,
  readStepRecord,
  roleOf,
  type StepOutcome,
  type StepRecord,
} from './run-records';
import { AiRunQueue } from './run-queue';
import { describeError } from './runtime.constants';

/** Distributive omit, so each member of the event union keeps its own fields. */
type WithoutVersion<T> = T extends unknown ? Omit<T, 'v'> : never;
export type AiRunEventInput = WithoutVersion<AiRunEvent>;

/** A row to append to a conversation. `format` defaults to the provider format. */
export interface AppendRow {
  role: string;
  content: unknown;
  format?: string;
}

/** What a synthetic answer says when a call has no recorded outcome. */
export interface FallbackAnswer {
  code: AiToolErrorCode;
  message: string;
}

export interface FinalizeOptions {
  /** The statuses the run may be finalized from (compare-and-set). */
  from: readonly AiRunStatus[];
  finishReason: string | null;
  error?: AiRunError;
  /** The answer for every call left without one; a generic "not executed" when absent. */
  fallback?: FallbackAnswer;
}

const NOT_EXECUTED: FallbackAnswer = {
  code: 'NOT_AVAILABLE',
  message: 'The run ended before this call was executed',
};

/** Statuses of an invocation that will still change (a resume must wait for them). */
const UNDECIDED = ['AWAITING_APPROVAL', 'AWAITING_INPUT', 'EXECUTING'];

export function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

/** The usage totals a run row carries, as the wire shape. */
export function runUsage(
  run: Pick<AiRun, 'inputTokens' | 'outputTokens' | 'cachedInputTokens'>,
): AiUsage {
  return {
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cachedInputTokens: run.cachedInputTokens,
  };
}

/**
 * The run state machine's shared persistence (provider-and-runtime.md §8; synthesis §4.4): events,
 * append-only messages, the answer to every call of a step, terminal transitions and the resume hand-off.
 * The loop, the orchestrator, the approval service and the sweeper all transition runs through here, each
 * transition a compare-and-set on the run's status, so exactly one actor finalizes or resumes a run.
 */
@Injectable()
export class AiRunLifecycle {
  private readonly logger = new Logger(AiRunLifecycle.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RUN_EVENT_BUS) private readonly bus: RunEventBus,
    @Inject(CHAT_MODEL_PORT) private readonly model: ChatModelPort,
    private readonly tools: AiToolService,
    private readonly registry: AiToolRegistry,
    private readonly queue: AiRunQueue,
    private readonly inputs: AiInputRequests,
  ) {}

  /**
   * Publish one event of the shared union (`v: 1`). An event that does not parse (a tool name the union
   * cannot carry) is dropped and logged: the stream only ever carries the contract. Never throws.
   */
  emit(runId: string, event: AiRunEventInput): void {
    const parsed = AiRunEventSchema.safeParse({ v: 1, ...event });
    if (!parsed.success) {
      this.logger.warn(
        `ai.run.event_dropped run=${runId} type=${event.type} (does not match the event union)`,
      );
      return;
    }
    try {
      this.bus.publish(runId, parsed.data);
    } catch (err) {
      this.logger.warn(
        `ai.run.event_failed run=${runId} type=${event.type}: ${describeError(err)}`,
      );
    }
  }

  /** Append rows after the conversation's last `seq` (append-only; `@@unique(conversationId, seq)`). */
  async append(
    tx: Prisma.TransactionClient,
    conversationId: string,
    runId: string | null,
    rows: readonly AppendRow[],
  ): Promise<number[]> {
    const last = await tx.aiMessage.findFirst({
      where: { conversationId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    let seq = last?.seq ?? -1;
    const seqs: number[] = [];
    for (const row of rows) {
      seq += 1;
      await tx.aiMessage.create({
        data: {
          conversationId,
          runId,
          seq,
          role: row.role,
          content: json(row.content),
          format: row.format ?? AI_MESSAGE_FORMAT_MODEL,
        },
      });
      seqs.push(seq);
    }
    return seqs;
  }

  /** The next `seq` of a conversation (the assistant row a step is about to persist). */
  async nextSeq(conversationId: string): Promise<number> {
    const last = await this.prisma.aiMessage.findFirst({
      where: { conversationId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    return (last?.seq ?? -1) + 1;
  }

  /**
   * The conversation's open step: the latest step record when the latest provider message is the
   * assistant message it describes (its calls not answered yet); null when there is nothing to answer.
   */
  async openStep(conversationId: string): Promise<StepRecord | null> {
    const rows = await this.prisma.aiMessage.findMany({
      where: { conversationId },
      orderBy: { seq: 'desc' },
      take: 12,
      select: { seq: true, role: true, format: true, content: true },
    });
    let record: StepRecord | null = null;
    for (const row of rows) {
      if (row.format === AI_MESSAGE_FORMAT_STEP) {
        record ??= readStepRecord(row.content);
        continue;
      }
      if (row.format !== AI_MESSAGE_FORMAT_MODEL) continue;
      // The latest provider message: only an assistant message can have open calls.
      if (row.role !== 'assistant') return null;
      return record && record.calls.length > 0 ? record : null;
    }
    return null;
  }

  /**
   * The outcome of every call of a step, in call order: the recorded output, the pending invocation's
   * stored result once it is decided, or the `fallback` error — so every call is answered (§8 invariant 5).
   */
  async outcomesOf(
    record: StepRecord,
    fallback: FallbackAnswer = NOT_EXECUTED,
  ): Promise<ChatModelToolOutcome[]> {
    const byCall = new Map<string, StepOutcome>();
    for (const outcome of record.outcomes) {
      byCall.set(outcome.toolCallId, outcome);
    }
    const outcomes: ChatModelToolOutcome[] = [];
    for (const call of record.calls) {
      const recorded = byCall.get(call.toolCallId);
      if (recorded && 'output' in recorded) {
        outcomes.push({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: recorded.output,
          isError: recorded.isError,
        });
        continue;
      }
      if (recorded && 'invocationId' in recorded) {
        const row = await this.prisma.aiToolInvocation.findUnique({
          where: { id: recorded.invocationId },
        });
        const action = row ? toPendingAction(row) : null;
        if (action?.result && !UNDECIDED.includes(action.status)) {
          outcomes.push({
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: capToolOutput(action.result),
            isError: !action.result.ok,
          });
          continue;
        }
      }
      const kind = callKindOf(
        this.registry.get(call.toolName)?.descriptor.class ?? 'read',
      );
      const synthetic = errorResult(kind, fallback);
      outcomes.push({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: synthetic,
        isError: true,
      });
    }
    return outcomes;
  }

  /**
   * Answer the conversation's open step, if any, with ONE tool message carrying every call's result
   * (Anthropic rejects a history with an unanswered tool use). Idempotent: an answered step is left as is.
   */
  async answerOpenStep(
    conversationId: string,
    runId: string | null,
    fallback: FallbackAnswer = NOT_EXECUTED,
  ): Promise<boolean> {
    const record = await this.openStep(conversationId);
    if (!record) return false;
    const outcomes = await this.outcomesOf(record, fallback);
    const message = this.model.toolResultsMessage(outcomes);
    await this.prisma.$transaction((tx) =>
      this.append(tx, conversationId, runId, [
        { role: roleOf(message), content: message },
      ]),
    );
    return true;
  }

  /** Mark a conversation read-only (idempotent: the first reason stays). */
  async closeConversation(
    conversationId: string,
    reason: AiConversationClosedReason,
  ): Promise<void> {
    await this.prisma.aiConversation.updateMany({
      where: { id: conversationId, closedReason: null },
      data: { closedReason: reason },
    });
  }

  /**
   * Finalize a run: compare-and-set its status from `from` to the terminal `to`, then — as the one actor
   * that won — cancel its still-pending approvals, answer its open step, and emit `run.status` +
   * `run.finished`. False when the run was not in `from` (someone else moved it first).
   */
  async finalize(
    runId: string,
    to: Extract<AiRunStatus, 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'EXPIRED'>,
    options: FinalizeOptions,
  ): Promise<boolean> {
    const claim = await this.prisma.aiRun.updateMany({
      where: { id: runId, status: { in: [...options.from] } },
      data: {
        status: to,
        finishReason: options.finishReason,
        ...(options.error ? { error: json(options.error) } : {}),
        finishedAt: new Date(),
      },
    });
    if (claim.count === 0) return false;

    const pending = await this.prisma.aiToolInvocation.findMany({
      where: { runId, status: 'AWAITING_APPROVAL' },
      select: { id: true, toolUseId: true },
    });
    for (const row of pending) {
      const cancelled = await this.tools
        .cancel(row.id, options.fallback?.message ?? 'The run ended')
        .catch((err: unknown) => {
          this.logger.error(
            `AI run ${runId}: invocation ${row.id} could not be cancelled: ${describeError(err)}`,
          );
          return null;
        });
      if (cancelled && row.toolUseId) {
        this.emitResolved(runId, row.toolUseId, 'cancelled');
      }
    }
    // Input requests still waiting (#1388) end with the run; the model is answered "not available".
    for (const row of await this.inputs.pending(runId)) {
      const closed = await this.inputs
        .close(
          row.id,
          'CANCELLED',
          errorResult('navigate', {
            code: 'NOT_AVAILABLE',
            message: (options.fallback?.message ?? 'The run ended').slice(
              0,
              500,
            ),
          }),
        )
        .catch((err: unknown) => {
          this.logger.error(
            `AI run ${runId}: input request ${row.id} could not be cancelled: ${describeError(err)}`,
          );
          return null;
        });
      if (closed && row.toolUseId) {
        this.emitInputResolved(runId, row.toolUseId, 'cancelled');
      }
    }

    const run = await this.prisma.aiRun.findUniqueOrThrow({
      where: { id: runId },
    });
    if (run.conversationId) {
      try {
        await this.answerOpenStep(
          run.conversationId,
          runId,
          options.fallback ?? NOT_EXECUTED,
        );
      } catch (err) {
        // The next submission in this conversation answers it (the repair in the orchestrator).
        this.logger.error(
          `AI run ${runId} finalized ${to} but its open step could not be answered: ${describeError(err)}`,
        );
      }
      await this.prisma.aiConversation
        .update({
          where: { id: run.conversationId },
          data: { lastActivityAt: new Date() },
        })
        .catch(() => undefined);
    }

    this.emit(runId, { type: 'run.status', status: to });
    this.emit(runId, {
      type: 'run.finished',
      status: to,
      finishReason: options.finishReason,
      usage: runUsage(run),
      ...(options.error ? { error: options.error } : {}),
    });
    this.logger.log({
      event: 'ai.run.finish',
      runId,
      conversationId: run.conversationId,
      principal: run.userId ? 'human' : 'service',
      principalId: run.userId ?? run.serviceAccountId,
      provider: run.provider,
      model: run.model,
      status: to,
      finishReason: options.finishReason,
      errorCode: options.error?.code,
      steps: run.stepCount,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
    });
    return true;
  }

  /**
   * After a decision or an answered input request: when no call of the run is still undecided, move it
   * AWAITING_APPROVAL | AWAITING_INPUT → QUEUED (a compare-and-set, so a double decision resumes once) and
   * enqueue the resume. A lost enqueue is recovered by the sweeper. Returns the run's status afterwards.
   */
  async resumeIfDecided(
    runId: string,
    jobId?: string,
  ): Promise<AiRunStatus | null> {
    const undecided = await this.prisma.aiToolInvocation.count({
      where: { runId, status: { in: UNDECIDED } },
    });
    const run = await this.prisma.aiRun.findUnique({ where: { id: runId } });
    if (!run) return null;
    if (
      undecided > 0 ||
      !(AI_RUN_WAITING_STATUSES as readonly string[]).includes(run.status)
    ) {
      return run.status as AiRunStatus;
    }
    const claim = await this.prisma.aiRun.updateMany({
      where: { id: runId, status: run.status },
      data: { status: 'QUEUED' },
    });
    if (claim.count === 0) {
      const now = await this.prisma.aiRun.findUnique({ where: { id: runId } });
      return (now?.status ?? null) as AiRunStatus | null;
    }
    this.emit(runId, { type: 'run.status', status: 'QUEUED' });
    await this.queue.enqueueResume(runId, run.stepCount, jobId);
    return 'QUEUED';
  }

  /** `tool.approval_resolved` for a call. */
  emitResolved(
    runId: string,
    toolCallId: string,
    decision: AiApprovalOutcome,
  ): void {
    this.emit(runId, { type: 'tool.approval_resolved', toolCallId, decision });
  }

  /** `input.resolved` for an input request (#1388). */
  emitInputResolved(
    runId: string,
    toolCallId: string,
    outcome: AiInputOutcome,
  ): void {
    this.emit(runId, { type: 'input.resolved', toolCallId, outcome });
  }
}
