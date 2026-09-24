import { Inject, Injectable } from '@nestjs/common';
import {
  AI_SETTINGS_DEFAULTS,
  AiInputAnswerSchema,
  AiInputFormSchema,
  AiToolResultSchema,
  type AiInputAnswer,
  type AiInputForm,
  type AiInputOutcome,
  type AiInputRequest,
  type AiToolResult,
} from '@lazyit/shared';
import type {
  AiToolInvocation,
  Prisma,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { inputHashOf } from '../core/pending-action';
import {
  AI_SETTINGS_READER,
  type AiSettingsReader,
} from '../core/ports/ai-settings.port';
import type {
  AiExecutionContext,
  RegisteredAiTool,
} from '../core/tool-descriptor';

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

/**
 * INPUT REQUESTS (#1388; ADR-0097 decision 3 as amended 2026-09-24) — the persistence of a form the
 * assistant asked the user to fill. One `ai_tool_invocations` row per request, keyed like a chat
 * proposal by the provider's tool-use id:
 *
 *   status  AWAITING_INPUT → SUCCEEDED (submitted) | REJECTED (skipped, declined) | EXPIRED | CANCELLED
 *   input   the model's validated arguments (hashed like any invocation)
 *   preview `{ kind: 'input_request', form }` — the STORED form the web renders and the answer is
 *           validated against (never an `AiActionPreview`, so no approval path can read it as a card)
 *   result  the `AiToolResult` the model receives once answered
 *
 * Not a write: no `AiActionLog` event is recorded (the ledger holds AI-initiated mutations only), and
 * core's approval primitives never claim these rows (their claims are conditional on AWAITING_APPROVAL).
 * Every transition here is a compare-and-set from AWAITING_INPUT, so exactly one actor answers a request.
 */

/** The `preview` column of an input request. */
export const AI_INPUT_RECORD_KIND = 'input_request';

interface InputRecord {
  kind: typeof AI_INPUT_RECORD_KIND;
  form: AiInputForm;
}

/** The stored form of an invocation row, or null when the row is not an input request this build reads. */
export function readInputForm(preview: unknown): AiInputForm | null {
  if (!preview || typeof preview !== 'object') return null;
  const record = preview as Partial<InputRecord>;
  if (record.kind !== AI_INPUT_RECORD_KIND) return null;
  const form = AiInputFormSchema.safeParse(record.form);
  return form.success ? form.data : null;
}

/** The wire request of an input row (`input.required`, the snapshot, the transcript), or null. */
export function toInputRequest(row: AiToolInvocation): AiInputRequest | null {
  const form = readInputForm(row.preview);
  if (!form || !row.toolUseId || !row.expiresAt) return null;
  return {
    toolCallId: row.toolUseId,
    form,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** What the model receives, as stored in `result.data` of an answered request. */
export interface AiInputResultData {
  outcome: 'submitted' | 'skipped' | 'declined';
  /** Always `user`: the owner typed it for their own run. It is not other-authored content. */
  providedBy: 'user';
  answer?: AiInputAnswer;
  note?: string;
}

/** How an input row ended (null while it waits). Read-tolerant: an unreadable row reads as cancelled. */
export function inputOutcomeOf(row: AiToolInvocation): AiInputOutcome | null {
  switch (row.status) {
    case 'AWAITING_INPUT':
      return null;
    case 'EXPIRED':
      return 'expired';
    case 'SUCCEEDED':
    case 'REJECTED': {
      const outcome = resultData(row)?.outcome;
      return outcome === 'submitted' ||
        outcome === 'skipped' ||
        outcome === 'declined'
        ? outcome
        : row.status === 'SUCCEEDED'
          ? 'submitted'
          : 'declined';
    }
    default:
      return 'cancelled';
  }
}

/** The user's answer of a submitted request (for the transcript), or undefined. */
export function inputAnswerOf(
  row: AiToolInvocation,
): AiInputAnswer | undefined {
  const answer = AiInputAnswerSchema.safeParse(resultData(row)?.answer);
  return answer.success ? answer.data : undefined;
}

function resultData(row: AiToolInvocation): Partial<AiInputResultData> | null {
  const result = AiToolResultSchema.safeParse(row.result);
  if (!result.success || !result.data.ok) return null;
  const data = result.data.data;
  return data && typeof data === 'object' ? data : null;
}

export type AiInputClosedStatus =
  | 'SUCCEEDED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELLED';

@Injectable()
export class AiInputRequests {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(AI_SETTINGS_READER) private readonly settings: AiSettingsReader,
  ) {}

  /**
   * Store a pending request for a chat call. It expires like an approval (`approvalTtlMinutes`), and is
   * owned by the run's human: only they can answer it.
   */
  async open(args: {
    ctx: AiExecutionContext;
    toolCallId: string;
    tool: RegisteredAiTool;
    input: unknown;
    form: AiInputForm;
  }): Promise<AiToolInvocation> {
    const { ctx, tool } = args;
    if (ctx.identity.kind !== 'human') {
      throw new Error('An input request belongs to a human chat run');
    }
    const canonical = json(args.input);
    const record: InputRecord = { kind: AI_INPUT_RECORD_KIND, form: args.form };
    return this.prisma.aiToolInvocation.create({
      data: {
        channel: 'CHAT',
        conversationId: ctx.conversationId ?? null,
        runId: ctx.runId ?? null,
        toolUseId: args.toolCallId,
        toolName: tool.descriptor.name,
        toolClass: tool.descriptor.class,
        userId: ctx.identity.userId,
        input: canonical,
        inputHash: inputHashOf(canonical),
        schemaHash: tool.schemaHash,
        status: 'AWAITING_INPUT',
        preview: json(record),
        expiresAt: new Date(Date.now() + (await this.ttlMinutes()) * 60_000),
      },
    });
  }

  /** AWAITING_INPUT → `status` with its result, atomically. Null when it was no longer waiting. */
  async close(
    id: string,
    status: AiInputClosedStatus,
    result: AiToolResult,
  ): Promise<AiToolInvocation | null> {
    const updated = await this.prisma.aiToolInvocation.updateMany({
      where: { id, status: 'AWAITING_INPUT' },
      data: {
        status,
        decidedAt: new Date(),
        result: json(result),
        errorCode: result.ok ? null : result.error.code,
      },
    });
    if (updated.count === 0) return null;
    return this.prisma.aiToolInvocation.findUnique({ where: { id } });
  }

  /** The pending requests of a run. */
  pending(runId: string): Promise<AiToolInvocation[]> {
    return this.prisma.aiToolInvocation.findMany({
      where: { runId, status: 'AWAITING_INPUT' },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Requests past their expiry (at most `limit`). */
  due(limit: number, now: Date): Promise<AiToolInvocation[]> {
    return this.prisma.aiToolInvocation.findMany({
      where: { status: 'AWAITING_INPUT', expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
  }

  private async ttlMinutes(): Promise<number> {
    try {
      const minutes = (await this.settings.getSettings()).approvalTtlMinutes;
      if (Number.isInteger(minutes) && minutes >= 1) return minutes;
    } catch {
      // The documented default applies.
    }
    return AI_SETTINGS_DEFAULTS.approvalTtlMinutes;
  }
}
