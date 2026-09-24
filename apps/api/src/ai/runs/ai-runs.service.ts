import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import {
  AI_RUN_EVENT_VERSION,
  AiApprovalPolicySchema,
  AiConversationChannelSchema,
  AiRunErrorSchema,
  AiRunEventSchema,
  AiRunStatusSchema,
  type AiApprovalDecision,
  type AiApprovalRequest,
  type AiInputRequest,
  type AiInputSubmission,
  type AiPersistedMessage,
  type AiRun as AiRunWire,
  type AiRunAccepted,
  type AiRunEvent,
  type AiRunStatus,
  type CreateAiRun,
} from '@lazyit/shared';
import type { AiRun } from '../../../generated/prisma/client';
import type { DelegatedIdentity } from '../../auth/delegated-identity';
import { PrismaService } from '../../prisma/prisma.service';
import { toPendingAction } from '../core/pending-action';
import { AiToolRegistry } from '../core/tool-registry';
import { ownerWhere } from '../conversations/ai-request-identity';
import {
  AI_TRANSCRIPT_FORMATS,
  projectTranscript,
  storedUserText,
} from '../conversations/transcript-projection';
import { neutralizeTurnContext } from '../runtime/limits';
import { AgentRunOrchestrator } from '../runtime/agent-run.orchestrator';
import { AiApprovalService } from '../runtime/approval.service';
import { toInputRequest } from '../runtime/input-requests';
import { AiInputService } from '../runtime/input.service';
import {
  AI_MESSAGE_FORMAT_MODEL,
  toApprovalRequest,
} from '../runtime/run-records';

/**
 * `/ai/runs` (synthesis §4.4, §4.7; provider-and-runtime.md §9.1): create a run (the chat of a human, the
 * headless API of a Service Account), read it, cancel it, decide a pending write, answer an input form
 * (#1388), and build the
 * `run.snapshot` of the event stream. Every read is OWNER ONLY through the runtime's `ownedRun` (anyone
 * else: 404, never a hint that the run exists); the runtime owns every rule about what may run.
 */
@Injectable()
export class AiRunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: AgentRunOrchestrator,
    private readonly approvals: AiApprovalService,
    private readonly registry: AiToolRegistry,
    private readonly inputs: AiInputService,
  ) {}

  /**
   * `POST /ai/runs`. The channel follows the caller: a human's run is `CHAT` (writes wait for approval), a
   * Service Account's is `HEADLESS` (autonomous within its grants and its per-SA AI access setting; an SA
   * whose access is `off` or that holds `infra:report` is refused 403 by the runtime).
   */
  async create(input: {
    identity: DelegatedIdentity;
    channel: 'CHAT' | 'HEADLESS';
    body: CreateAiRun;
    idempotencyKey?: string;
    locale?: string;
  }): Promise<{ accepted: AiRunAccepted; replayed: boolean }> {
    if (input.idempotencyKey) {
      await this.assertSameRequest(
        input.identity,
        input.idempotencyKey,
        input.body,
      );
    }
    const run = await this.orchestrator.submit({
      identity: input.identity,
      channel: input.channel,
      text: input.body.prompt,
      ...(input.body.conversationId
        ? { conversationId: input.body.conversationId }
        : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.locale ? { locale: input.locale } : {}),
    });
    return {
      accepted: { runId: run.runId, status: run.status },
      replayed: run.replayed,
    };
  }

  /**
   * An `Idempotency-Key` names ONE request: reused with another prompt or another conversation it is
   * refused 422 `IDEMPOTENCY_KEY_MISMATCH` instead of answering an unrelated run. There is no body-hash
   * column, so the stored run is compared: its first user message (without the runtime's turn context)
   * and its conversation. An earlier run whose message is gone (its conversation deleted) is compared on
   * nothing and replays. Two first submissions racing on one key are resolved by the runtime (one run).
   */
  private async assertSameRequest(
    identity: DelegatedIdentity,
    idempotencyKey: string,
    body: CreateAiRun,
  ): Promise<void> {
    const earlier = await this.prisma.aiRun.findFirst({
      where: { ...ownerWhere(identity), idempotencyKey },
      select: { id: true, conversationId: true },
    });
    if (!earlier) return;
    const differentConversation =
      body.conversationId !== undefined &&
      earlier.conversationId !== null &&
      body.conversationId !== earlier.conversationId;
    let differentPrompt = false;
    if (earlier.conversationId) {
      const message = await this.prisma.aiMessage.findFirst({
        where: {
          conversationId: earlier.conversationId,
          runId: earlier.id,
          format: AI_MESSAGE_FORMAT_MODEL,
          role: 'user',
        },
        orderBy: { seq: 'asc' },
        select: { content: true },
      });
      const stored = message ? storedUserText(message.content) : null;
      differentPrompt =
        stored !== null && stored !== neutralizeTurnContext(body.prompt.trim());
    }
    if (differentConversation || differentPrompt) {
      throw new UnprocessableEntityException({
        code: 'IDEMPOTENCY_KEY_MISMATCH',
        message:
          'This Idempotency-Key was used for a different request; use a new key',
      });
    }
  }

  /** The run, owner only. */
  owned(runId: string, identity: DelegatedIdentity): Promise<AiRun> {
    return this.orchestrator.ownedRun(runId, identity);
  }

  /**
   * `GET /ai/runs/:id` — status, final text, usage and a summary of the tool calls; no transcript. The text
   * and the calls come from the same projection as the conversation (the `aisdk-v7` allow-list), limited to
   * this run's messages.
   */
  async get(runId: string, identity: DelegatedIdentity): Promise<AiRunWire> {
    const run = await this.orchestrator.ownedRun(runId, identity);
    const messages = await this.projectRun(run);
    const error = AiRunErrorSchema.safeParse(run.error);
    const toolCalls: AiRunWire['toolCalls'] = [];
    let finalText: string | null = null;
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      const text = message.parts
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('');
      if (text.length > 0) finalText = text;
      for (const part of message.parts) {
        if (part.type === 'tool') {
          toolCalls.push({
            toolCallId: part.toolCallId,
            name: part.name,
            class: part.class,
            status: part.status,
          });
        }
      }
    }
    return {
      id: run.id,
      conversationId: run.conversationId,
      channel: parsed(AiConversationChannelSchema, run.channel, 'CHAT'),
      status: runStatusOf(run.status),
      approvalPolicy: parsed(
        AiApprovalPolicySchema,
        run.approvalPolicy,
        'REQUIRE_APPROVAL_FOR_WRITES',
      ),
      finalText,
      finishReason: run.finishReason,
      usage: {
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        cachedInputTokens: run.cachedInputTokens,
      },
      toolCalls,
      error: error.success ? error.data : null,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
    };
  }

  /** `POST /ai/runs/:id/cancel` — owner only (404 otherwise); idempotent. */
  cancel(runId: string, identity: DelegatedIdentity): Promise<AiRunAccepted> {
    return this.orchestrator.cancel(runId, identity);
  }

  /**
   * `POST /ai/runs/:id/tool-calls/:toolCallId/decision`. The runtime decides who may (the run's own human,
   * from a human session; anyone else 404 or 403), verifies the password step-up and calls core; this
   * answers the run's status afterwards so the client knows whether to re-subscribe.
   */
  async decide(input: {
    runId: string;
    toolCallId: string;
    identity: DelegatedIdentity;
    body: AiApprovalDecision;
  }): Promise<AiRunAccepted> {
    const outcome = await this.approvals.decide({
      runId: input.runId,
      toolCallId: input.toolCallId,
      decision: input.body.decision,
      identity: input.identity,
      ...(input.body.reason ? { reason: input.body.reason } : {}),
      ...(input.body.password ? { password: input.body.password } : {}),
    });
    if (outcome.runStatus) {
      return { runId: input.runId, status: outcome.runStatus };
    }
    const run = await this.prisma.aiRun.findUnique({
      where: { id: input.runId },
      select: { status: true },
    });
    return { runId: input.runId, status: runStatusOf(run?.status) };
  }

  /**
   * `POST /ai/runs/:id/tool-calls/:toolCallId/input` (#1388). The runtime decides who may answer (the
   * run's own human; anyone else 404, a Service Account 403) and validates the answer against the stored
   * form; this answers the run's status afterwards so the client knows whether to re-subscribe.
   */
  async submitInput(input: {
    runId: string;
    toolCallId: string;
    identity: DelegatedIdentity;
    body: AiInputSubmission;
  }): Promise<AiRunAccepted> {
    const outcome = await this.inputs.submit(input);
    if (outcome.runStatus) {
      return { runId: input.runId, status: outcome.runStatus };
    }
    const run = await this.prisma.aiRun.findUnique({
      where: { id: input.runId },
      select: { status: true },
    });
    return { runId: input.runId, status: runStatusOf(run?.status) };
  }

  /**
   * The `run.snapshot` of the event stream (synthesis §4.6): the run's status, its own messages projected
   * like the conversation (the same allow-list), and its pending approvals with their stored previews.
   * `seq` is the last event the snapshot covers; the caller reads it BEFORE loading, so an event published
   * meanwhile is sent again rather than lost. The caller has already checked ownership.
   */
  async snapshot(
    run: AiRun,
    seq: number,
  ): Promise<Extract<AiRunEvent, { type: 'run.snapshot' }>> {
    const current =
      (await this.prisma.aiRun.findUnique({ where: { id: run.id } })) ?? run;
    const [messages, invocations] = await Promise.all([
      this.projectRun(current),
      this.prisma.aiToolInvocation.findMany({
        where: {
          runId: run.id,
          status: { in: ['AWAITING_APPROVAL', 'AWAITING_INPUT'] },
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const pendingApprovals = invocations
      .filter((row) => row.status === 'AWAITING_APPROVAL' && row.toolUseId)
      .map((row) => toApprovalRequest(toPendingAction(row)))
      .filter((request): request is AiApprovalRequest => request !== null);
    const pendingInputs = invocations
      .filter((row) => row.status === 'AWAITING_INPUT')
      .map((row) => toInputRequest(row))
      .filter((request): request is AiInputRequest => request !== null);
    const snapshot = {
      v: AI_RUN_EVENT_VERSION,
      type: 'run.snapshot' as const,
      seq,
      status: runStatusOf(current.status),
      messages,
      pendingApprovals,
      pendingInputs,
    };
    const valid = AiRunEventSchema.safeParse(snapshot);
    if (valid.success && valid.data.type === 'run.snapshot') return valid.data;
    // Never send an invalid frame: degrade to the status alone (the client re-reads the conversation).
    return {
      ...snapshot,
      messages: [],
      pendingApprovals: [],
      pendingInputs: [],
    };
  }

  /** The run's own messages, projected (owner already checked by the caller). */
  private async projectRun(run: AiRun): Promise<AiPersistedMessage[]> {
    const conversationId = run.conversationId;
    if (!conversationId) return [];
    const [rows, invocations] = await Promise.all([
      this.prisma.aiMessage.findMany({
        where: {
          conversationId,
          runId: run.id,
          format: { in: [...AI_TRANSCRIPT_FORMATS] },
        },
        orderBy: { seq: 'asc' },
        select: {
          seq: true,
          role: true,
          format: true,
          content: true,
          runId: true,
          createdAt: true,
        },
      }),
      this.prisma.aiToolInvocation.findMany({
        where: { runId: run.id, toolUseId: { not: null } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return projectTranscript({
      conversationId,
      rows,
      invocations,
      runs: [run],
      classOf: (name) => this.registry.get(name)?.descriptor.class,
    });
  }
}

/** A stored status this build does not know is a newer build's: shown as FAILED, never as active. */
export function runStatusOf(status: string | undefined): AiRunStatus {
  const value = AiRunStatusSchema.safeParse(status);
  return value.success ? value.data : 'FAILED';
}

function parsed<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
  value: unknown,
  fallback: T,
): T {
  const result = schema.safeParse(value);
  return result.success ? (result.data as T) : fallback;
}
