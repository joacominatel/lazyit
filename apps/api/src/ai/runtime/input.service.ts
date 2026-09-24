import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  checkAiInputAnswer,
  type AiInputAnswer,
  type AiInputForm,
  type AiInputOutcome,
  type AiInputSubmission,
  type AiInputValue,
  type AiRunStatus,
  type AiToolResult,
} from '@lazyit/shared';
import type { DelegatedIdentity } from '../../auth/delegated-identity';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AI_SETTINGS_READER,
  type AiSettingsReader,
} from '../core/ports/ai-settings.port';
import { errorResult, successResult, untrusted } from '../core/result-shaper';
import { toolResultEvent } from './agent-loop';
import {
  AiInputRequests,
  readInputForm,
  type AiInputResultData,
} from './input-requests';
import { AiRunLifecycle } from './run-lifecycle';
import { describeError } from './runtime.constants';

export interface AiInputSubmitInput {
  runId: string;
  /** The provider tool-use id the form was announced with (`input.required.toolCallId`). */
  toolCallId: string;
  body: AiInputSubmission;
  /** The answering session: the run's own human. */
  identity: DelegatedIdentity;
}

export interface AiInputSubmitOutcome {
  outcome: Extract<AiInputOutcome, 'submitted' | 'skipped' | 'declined'>;
  /** The run's status afterwards (QUEUED when this answer resumed it). */
  runStatus: AiRunStatus | null;
}

const NOTES = {
  skipped:
    'The user skipped this form without answering. Continue with what you have: use sensible defaults ' +
    'only where they are safe, and say what is still missing.',
  declined:
    'The user declined to provide this information. Do not ask for it again unless they bring it up; ' +
    'tell them what you cannot do without it.',
} as const;

/**
 * THE ANSWER TO AN INPUT REQUEST (#1388; `POST /ai/runs/:id/tool-calls/:toolCallId/input`). The runtime
 * side of a form the assistant asked the user to fill, mirroring the approval service:
 *
 *   1. who may answer: the run's own human, from a signed-in session, on their own chat run (anyone else
 *      is 404 — never a hint that someone else's run exists; a Service Account is 403);
 *   2. the answer is validated against the STORED form (never a form the client sends): unknown keys, a
 *      missing required field, a wrong type, an option that was not offered → 400 `INVALID_INPUT`;
 *   3. the call's answer is stored (a compare-and-set from AWAITING_INPUT, so a double submit answers
 *      once), `input.resolved` and `tool.result` are emitted, and the run resumes.
 *
 * The answer reaches the model as the tool result, marked `providedBy: "user"`: the owner typed it for
 * their own run, so it is not wrapped as other-authored (untrusted) content. The option labels added for an
 * `optionsFrom` select (`labels`) are lazyit records' names, other-authored: they are wrapped as untrusted.
 */
@Injectable()
export class AiInputService {
  private readonly logger = new Logger(AiInputService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inputs: AiInputRequests,
    private readonly lifecycle: AiRunLifecycle,
    @Inject(AI_SETTINGS_READER) private readonly settings: AiSettingsReader,
  ) {}

  async submit(input: AiInputSubmitInput): Promise<AiInputSubmitOutcome> {
    const identity = input.identity;
    if (identity.kind !== 'human') {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message:
          'Only the requesting user, from a signed-in session, can answer this form',
      });
    }
    const run = await this.prisma.aiRun.findUnique({
      where: { id: input.runId },
    });
    if (!run || run.userId !== identity.userId || run.channel !== 'CHAT') {
      throw notFound();
    }
    const row = await this.prisma.aiToolInvocation.findFirst({
      where: { runId: run.id, toolUseId: input.toolCallId },
      orderBy: { createdAt: 'desc' },
    });
    const form = row ? readInputForm(row.preview) : null;
    if (!row || !form || row.userId !== identity.userId) throw notFound();
    if (run.status !== 'AWAITING_INPUT' || row.status !== 'AWAITING_INPUT') {
      throw new ConflictException({
        code: 'RUN_NOT_AWAITING_INPUT',
        message: 'This form is not waiting for an answer',
      });
    }
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      await this.expire(run.id, row.id, input.toolCallId);
      throw new ConflictException({
        code: 'EXPIRED',
        message: 'This form has expired',
      });
    }
    // The answer resumes the run: never while the assistant is switched off (the kill switch).
    if (!(await this.settings.resolveProviderConfig())) {
      throw new ConflictException({
        code: 'AI_DISABLED',
        message: 'The AI assistant is turned off; this form cannot be answered',
      });
    }

    const { outcome, result, answer } = this.answer(form, input.body);
    const closed = await this.inputs.close(
      row.id,
      outcome === 'submitted' ? 'SUCCEEDED' : 'REJECTED',
      result,
      answer ? { form, answer } : undefined,
    );
    if (!closed) {
      throw new ConflictException({
        code: 'RUN_NOT_AWAITING_INPUT',
        message: 'This form is not waiting for an answer',
      });
    }
    this.lifecycle.emitInputResolved(run.id, input.toolCallId, outcome);
    this.lifecycle.emit(run.id, toolResultEvent(input.toolCallId, result));
    const runStatus = await this.lifecycle.resumeIfDecided(run.id);
    return { outcome, runStatus };
  }

  /** The tool result the model receives for this answer (400 when a submitted answer does not fit). */
  private answer(
    form: AiInputForm,
    body: AiInputSubmission,
  ): {
    outcome: AiInputSubmitOutcome['outcome'];
    result: AiToolResult;
    answer?: AiInputAnswer;
  } {
    if (body.action !== 'submit') {
      const outcome = body.action === 'skip' ? 'skipped' : 'declined';
      const data: AiInputResultData = {
        outcome,
        providedBy: 'user',
        note: NOTES[outcome],
      };
      return {
        outcome,
        result: successResult('navigate', {
          data,
          summary:
            outcome === 'skipped'
              ? 'The user skipped the form'
              : 'The user declined the form',
        }),
      };
    }
    const checked = checkAiInputAnswer(form, {
      values: body.values ?? {},
      groups: body.groups ?? {},
    });
    if (!checked.ok) {
      throw new BadRequestException({
        code: 'INVALID_INPUT',
        message: 'The answer does not match the form',
        issues: checked.issues,
      });
    }
    const data: AiInputResultData & { labels?: Record<string, string> } = {
      outcome: 'submitted',
      providedBy: 'user',
      answer: forModel(form, checked.answer),
    };
    const labels = selectedLabels(form, checked.answer);
    if (Object.keys(labels).length > 0) data.labels = labels;
    return {
      outcome: 'submitted',
      result: successResult('navigate', {
        data,
        summary: 'The user answered the form',
      }),
      answer: checked.answer,
    };
  }

  /**
   * A late answer: the form expired but the sweeper has not run yet. It ends like the sweeper's expiry —
   * the request EXPIRED, the run EXPIRED with every call answered.
   */
  private async expire(
    runId: string,
    invocationId: string,
    toolCallId: string,
  ): Promise<void> {
    try {
      const closed = await this.inputs.close(
        invocationId,
        'EXPIRED',
        errorResult('navigate', INPUT_EXPIRED),
      );
      if (closed)
        this.lifecycle.emitInputResolved(runId, toolCallId, 'expired');
      await this.lifecycle.finalize(runId, 'EXPIRED', {
        from: ['AWAITING_INPUT'],
        finishReason: 'input_expired',
        fallback: INPUT_EXPIRED,
      });
    } catch (err) {
      this.logger.error(
        `AI run ${runId}: expiry after a late answer could not be finalized: ${describeError(err)}`,
      );
    }
  }
}

/** What the model is told when nobody answered in time. */
export const INPUT_EXPIRED = {
  code: 'EXPIRED' as const,
  message: 'The user did not answer this form in time',
};

/**
 * Option lists whose VALUES are lazyit text (the manufacturer names), not ids: a value chosen from one is
 * other-authored content in the model's copy of the answer.
 */
const TEXT_VALUED_SOURCES: ReadonlySet<string> = new Set(['manufacturers']);

/**
 * The model's copy of an answer: every value the user picked from an `optionsFrom` list whose values are
 * lazyit text is wrapped as `<untrusted_content>`; values the user typed, and ids, stay as they are.
 */
function forModel(form: AiInputForm, answer: AiInputAnswer): AiInputAnswer {
  const wrap = (
    fields: AiInputForm['fields'],
    values: Record<string, AiInputValue>,
  ): Record<string, AiInputValue> => {
    const out: Record<string, AiInputValue> = { ...values };
    for (const field of fields) {
      if (!field.optionsFrom || !TEXT_VALUED_SOURCES.has(field.optionsFrom)) {
        continue;
      }
      const value = values[field.key];
      if (typeof value === 'string') {
        out[field.key] = untrusted(value);
      } else if (Array.isArray(value)) {
        out[field.key] = value.map((item) => untrusted(item) ?? item);
      }
    }
    return out;
  };
  const groups: AiInputAnswer['groups'] = {};
  for (const group of form.groups) {
    const rows = answer.groups[group.key];
    if (rows) groups[group.key] = rows.map((row) => wrap(group.fields, row));
  }
  return { values: wrap(form.fields, answer.values), groups };
}

/**
 * The option labels of the chosen select values (`values.<key>` / `groups.<key>.<row>.<key>` → label), so
 * the model can name what was chosen when the value is an id. The labels are lazyit records' names —
 * other-authored text — so each is wrapped as `<untrusted_content>`; the user's own values are not.
 */
function selectedLabels(
  form: AiInputForm,
  answer: AiInputAnswer,
): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (
    fields: AiInputForm['fields'],
    values: Record<string, AiInputValue>,
    prefix: string,
  ) => {
    for (const field of fields) {
      if (!field.options || !field.optionsFrom) continue;
      const value = values[field.key];
      const chosen = Array.isArray(value)
        ? value
        : typeof value === 'string'
          ? [value]
          : [];
      const names = chosen
        .map((v) => field.options!.find((o) => o.value === v)?.label)
        .filter((label): label is string => typeof label === 'string');
      const wrapped = untrusted(names.join(', '));
      if (wrapped) out[`${prefix}.${field.key}`] = wrapped;
    }
  };
  add(form.fields, answer.values, 'values');
  for (const group of form.groups) {
    (answer.groups[group.key] ?? []).forEach((row, index) =>
      add(group.fields, row, `groups.${group.key}.${index}`),
    );
  }
  return out;
}

function notFound(): NotFoundException {
  return new NotFoundException({
    code: 'NOT_FOUND',
    message: 'Input request not found',
  });
}
