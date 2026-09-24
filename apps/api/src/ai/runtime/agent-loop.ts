import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import {
  AI_WEB_SEARCH_SOURCE_REF,
  AiInputFormSchema,
  type AiConversationChannel,
  type AiInputRequest,
  type AiProviderKind,
  type AiEntityRef,
  type AiRunError,
  type AiSettings,
  type AiToolResult,
} from '@lazyit/shared';
import type { AiConversation, AiRun } from '../../../generated/prisma/client';
import type { DelegatedIdentity } from '../../auth/delegated-identity';
import { PrismaService } from '../../prisma/prisma.service';
import { AI_PROMPT_VERSION } from '../ai.constants';
import { AiToolService } from '../core/ai-tool.service';
import {
  mergeRefs,
  toPendingAction,
  type AiPendingAction,
} from '../core/pending-action';
import {
  AI_SETTINGS_READER,
  type AiSettingsReader,
} from '../core/ports/ai-settings.port';
import {
  CHAT_MODEL_PORT,
  type ChatModelPort,
  type ChatModelStepResult,
  type ChatModelToolCall,
  type ChatModelToolDefinition,
} from '../core/ports/chat-model.port';
import { isSensitiveKey, redactUrlCredentials } from '../core/redaction';
import { callKindOf, errorResult } from '../core/result-shaper';
import type {
  AiExecutionContext,
  RegisteredAiTool,
} from '../core/tool-descriptor';
import { AiToolRegistry } from '../core/tool-registry';
import { AiProviderError } from '../providers/ai-provider.error';
import {
  conversationCallOverrides,
  conversationWebSearch,
  pinnedConfigChanged,
  webSearchWithdrawn,
} from './conversation-settings';
import {
  AiRunLimits,
  capToolOutput,
  clampInt4,
  principalKey,
  toolsetHashOf,
} from './limits';
import { AiInputRequests, toInputRequest } from './input-requests';
import { AiRunPrincipals, type AiRunPrincipal } from './principal-context';
import { RepeatedFailureGuard } from './repeated-failures';
import {
  AiRunLifecycle,
  type AppendRow,
  type FallbackAnswer,
} from './run-lifecycle';
import {
  AI_MESSAGE_FORMAT_MODEL,
  AI_MESSAGE_FORMAT_RUN,
  AI_MESSAGE_FORMAT_STEP,
  AI_MESSAGE_FORMAT_SYSTEM_PROMPT,
  AI_MESSAGE_FORMAT_WEB_SEARCH,
  AI_RUNTIME_RECORD_ROLE,
  assistantMessageId,
  readRunRecord,
  readStepRecord,
  readSystemPrompt,
  roleOf,
  toApprovalRequest,
  type StepOutcome,
  type StepRecord,
  type WebSearchRecord,
} from './run-records';
import {
  AI_MAX_PENDING_PER_STEP,
  AI_MAX_TOOL_CALLS_PER_RUN,
  describeError,
} from './runtime.constants';

/** The frozen toolset of a conversation, as the model sees it and as the loop dispatches it. */
export interface FrozenToolset {
  definitions: ChatModelToolDefinition[];
  byName: Map<string, RegisteredAiTool>;
}

/**
 * Resolve a conversation's pinned tool names against the registry. Null when a tool is gone or any
 * definition changed since the conversation was created (an upgrade): the conversation is then read-only.
 */
export function frozenToolset(
  registry: AiToolRegistry,
  conversation: Pick<AiConversation, 'toolNames' | 'toolsetHash'>,
): FrozenToolset | null {
  const tools: RegisteredAiTool[] = [];
  for (const name of conversation.toolNames) {
    const tool = registry.get(name);
    if (!tool) return null;
    tools.push(tool);
  }
  if (toolsetHashOf(tools) !== conversation.toolsetHash) return null;
  const sorted = [...tools].sort((a, b) =>
    a.descriptor.name.localeCompare(b.descriptor.name),
  );
  return {
    definitions: sorted.map((tool) => ({
      name: tool.descriptor.name,
      description: tool.descriptor.description,
      inputSchema: tool.inputSchema,
    })),
    byName: new Map(sorted.map((tool) => [tool.descriptor.name, tool])),
  };
}

/** A flat, redacted summary of a call's arguments for `tool.call` — never the full input. */
export function summarizeArgs(
  input: unknown,
): Record<string, string | number | boolean | null> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(
    input as Record<string, unknown>,
  ).slice(0, 20)) {
    if (isSensitiveKey(key)) {
      out[key] = '[redacted]';
    } else if (typeof value === 'string') {
      const clean = redactUrlCredentials(value);
      out[key] = clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
    } else if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      out[key] =
        typeof value === 'number' && !Number.isFinite(value) ? null : value;
    }
  }
  return out;
}

/**
 * Every call of a run gets a non-empty id unique within the run: the id keys the step record, the
 * pending invocation (`toolUseId`), the events and the decision endpoint. A model that sends an empty or
 * repeated id gets a synthesized one (`lz_<runId>_<step>_<index>`) for that call. `seen` is updated.
 */
export function uniqueCallIds(
  calls: readonly ChatModelToolCall[],
  runId: string,
  stepIndex: number,
  seen: Set<string>,
): ChatModelToolCall[] {
  return calls.map((call, index) => {
    let id =
      typeof call.toolCallId === 'string' && call.toolCallId.trim().length > 0
        ? call.toolCallId
        : '';
    if (id === '' || seen.has(id)) {
      id = `lz_${runId}_${stepIndex}_${index}`;
      for (let n = 1; seen.has(id); n += 1) {
        id = `lz_${runId}_${stepIndex}_${index}_${n}`;
      }
    }
    seen.add(id);
    return id === call.toolCallId ? call : { ...call, toolCallId: id };
  });
}

const UNTRUSTED_TAG = '<untrusted_content>';

/** A tool name as the registry allows it; anything else the model sent is logged as `(invalid)`. */
const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** The refs of a read result that carried other-authored text (the untrusted-source banner). */
function untrustedRefsOf(result: AiToolResult): AiEntityRef[] {
  if (!result.ok) return [];
  const serialized = JSON.stringify(result.data ?? null);
  return serialized.includes(UNTRUSTED_TAG) ? result.entityRefs : [];
}

/**
 * How one call of a step was resolved. A pending call waits for the user: a write's approval card, or —
 * with `input` — a form the assistant asked them to fill (#1388).
 */
type CallResolution =
  | { kind: 'answered'; outcome: StepOutcome }
  | {
      kind: 'pending';
      toolCallId: string;
      action: AiPendingAction;
      input?: AiInputRequest;
    };

interface RunScope {
  run: AiRun;
  conversation: AiConversation;
  channel: AiConversationChannel;
  identity: DelegatedIdentity;
  instructions: string;
}

/**
 * THE AGENT LOOP (provider-and-runtime.md §6.4; ADR-0097 decision 5). One run = one user message or one
 * headless prompt, driven by the `ai-run` worker. Each iteration:
 *
 *   guardrails → one model step → persist it (assistant message, step record, usage, counters)
 *   → no tool calls: SUCCEEDED
 *   → resolve every call: reads (and headless writes) `invoke`; chat writes `propose`
 *   → a pending write: record the step, pause AWAITING_APPROVAL, release the job
 *   → else: append ONE tool message with every result, next step
 *
 * Guardrails before every step: the run not cancelled; AI still enabled; the principal re-loaded and
 * still holding `ai:use` (and, headless, its AI access setting); the conversation still pinned to the
 * configured provider, model, prompt version and toolset; the token budget; the context cap; the step cap.
 * The last allowed step runs with `toolChoice: 'none'` so the model summarizes instead of acting.
 *
 * Every call the model makes is answered — unknown tools, unparseable arguments and refused calls
 * included — and a write is never retried: a crash leaves the run to the sweeper, which marks an
 * interrupted write OUTCOME_UNKNOWN instead of running it again.
 */
@Injectable()
export class AgentLoop {
  private readonly logger = new Logger(AgentLoop.name);
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CHAT_MODEL_PORT) private readonly model: ChatModelPort,
    @Inject(AI_SETTINGS_READER) private readonly settings: AiSettingsReader,
    private readonly tools: AiToolService,
    private readonly registry: AiToolRegistry,
    private readonly principals: AiRunPrincipals,
    private readonly limits: AiRunLimits,
    private readonly lifecycle: AiRunLifecycle,
    private readonly inputs: AiInputRequests,
  ) {}

  /** Whether this process is driving the run right now (the sweeper never finalizes such a run). */
  isRunning(runId: string): boolean {
    return this.controllers.has(runId);
  }

  /** Abort the in-flight model call of a run executing in this process (cancel). */
  abort(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /**
   * Claim a QUEUED run (compare-and-set to RUNNING) and drive it until it pauses or ends. A duplicate or
   * stale job finds the run in another status and does nothing. Never throws: an unexpected fault
   * finalizes the run FAILED (a BullMQ retry could re-run a step).
   */
  async advance(runId: string): Promise<void> {
    const queued = await this.prisma.aiRun.findUnique({ where: { id: runId } });
    if (!queued || queued.status !== 'QUEUED') return;
    const claim = await this.prisma.aiRun.updateMany({
      where: { id: runId, status: 'QUEUED' },
      data: { status: 'RUNNING', startedAt: queued.startedAt ?? new Date() },
    });
    if (claim.count === 0) return;
    this.lifecycle.emit(runId, { type: 'run.status', status: 'RUNNING' });
    this.logger.log({
      event: 'ai.run.start',
      runId,
      conversationId: queued.conversationId,
      principal: queued.userId ? 'human' : 'service',
      principalId: queued.userId ?? queued.serviceAccountId,
      provider: queued.provider,
      model: queued.model,
      resumed: queued.stepCount > 0,
    });

    const controller = new AbortController();
    this.controllers.set(runId, controller);
    try {
      await this.drive(runId, controller.signal);
    } catch (err) {
      this.logger.error(
        `AI run ${runId} failed unexpectedly: ${describeError(err)}`,
      );
      await this.failUnexpectedly(runId).catch(() => undefined);
    } finally {
      this.controllers.delete(runId);
    }
  }

  /**
   * An unexpected fault mid-run: whatever call was executing may or may not have taken effect. Its
   * invocation becomes OUTCOME_UNKNOWN (never retried), and every unanswered call of the step is answered
   * `UNKNOWN_OUTCOME` — not "not executed", which could be false.
   */
  private async failUnexpectedly(runId: string): Promise<void> {
    const executing = await this.prisma.aiToolInvocation.findMany({
      where: { runId, status: 'EXECUTING' },
      select: { id: true },
    });
    for (const row of executing) {
      await this.tools.markOutcomeUnknown(row.id).catch(() => null);
    }
    await this.lifecycle.finalize(runId, 'FAILED', {
      from: ['RUNNING'],
      finishReason: 'error',
      error: { code: 'INTERNAL', message: 'The run failed unexpectedly.' },
      fallback: {
        code: 'UNKNOWN_OUTCOME',
        message:
          'The run failed while this call was pending; whether it took effect is unknown. It will not be retried.',
      },
    });
  }

  private async drive(runId: string, signal: AbortSignal): Promise<void> {
    const scope = await this.scope(runId);
    if (!scope) return;
    const { conversation, channel, identity, instructions } = scope;

    // A resume: answer the step the approvals were waiting on, in one tool message.
    await this.lifecycle.answerOpenStep(conversation.id, runId);

    const seeded = await this.seedCounters(runId, conversation);
    let toolCalls = seeded.toolCalls;
    let untrusted = seeded.untrusted;
    const callIds = seeded.callIds;
    let lastInputTokens = await this.limits.lastInputTokens(conversation.id);
    // A model repeating a failing call is told to stop (#1403); in memory, for this pass of the loop.
    const failures = new RepeatedFailureGuard();

    for (;;) {
      const run = await this.prisma.aiRun.findUnique({ where: { id: runId } });
      if (!run || run.status !== 'RUNNING') return;

      const guard = await this.guard(run, scope, lastInputTokens);
      if (!guard.ok) return;
      const { who, settings, toolset } = guard;

      const forced =
        run.stepCount + 1 >= settings.maxStepsPerRun ||
        toolCalls >= AI_MAX_TOOL_CALLS_PER_RUN;
      const history = await this.history(conversation.id);
      const webSearch = conversationWebSearch(conversation);
      const seq = await this.lifecycle.nextSeq(conversation.id);
      const messageId = assistantMessageId(conversation.id, seq);
      const started = Date.now();

      let result: ChatModelStepResult;
      try {
        result = await this.model.step({
          model: {
            provider: conversation.provider as AiProviderKind,
            modelId: conversation.model,
          },
          ...conversationCallOverrides(conversation),
          ...(webSearch ? { webSearch } : {}),
          instructions,
          messages: history,
          tools: toolset.definitions,
          toolChoice: forced ? 'none' : 'auto',
          maxOutputTokens: settings.maxOutputTokens,
          abortSignal: signal,
          onTextDelta: (text) => {
            if (text.length > 0) {
              this.lifecycle.emit(runId, {
                type: 'message.delta',
                messageId,
                text,
              });
            }
          },
        });
      } catch (err) {
        await this.failStep(runId, conversation.id, err);
        return;
      }

      const stepIndex = run.stepCount;
      result = {
        ...result,
        toolCalls: uniqueCallIds(result.toolCalls, runId, stepIndex, callIds),
      };
      // The provider searched the web (#1389): search results are other-authored text, so from here on
      // the turn has read untrusted sources — a proposal shows the banner and is never auto-approved.
      if (result.webSearch) {
        untrusted = mergeRefs(untrusted, [AI_WEB_SEARCH_SOURCE_REF]);
      }
      await this.persistStep(run, scope, result, stepIndex, untrusted);
      if (result.responseMessages.length > 0) {
        this.lifecycle.emit(runId, { type: 'message.completed', messageId });
      }
      if (result.webSearch && result.webSearch.sources.length > 0) {
        this.lifecycle.emit(runId, {
          type: 'message.sources',
          messageId,
          sources: result.webSearch.sources,
          ...(result.webSearch.queries.length > 0
            ? { queries: result.webSearch.queries }
            : {}),
        });
      }
      this.lifecycle.emit(runId, {
        type: 'step.finished',
        stepIndex,
        usage: result.usage,
      });
      this.logger.log({
        event: 'ai.step.finish',
        runId,
        conversationId: conversation.id,
        stepIndex,
        provider: conversation.provider,
        model: conversation.model,
        latencyMs: Date.now() - started,
        finishReason: result.finishReason,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        toolNames: result.toolCalls.map((call) =>
          TOOL_NAME.test(call.toolName) ? call.toolName : '(invalid)',
        ),
        // Counts only: the queries and pages are content (ADR-0031), kept in the transcript record.
        ...(result.webSearch
          ? {
              webSearches: result.webSearch.searches,
              webSources: result.webSearch.sources.length,
            }
          : {}),
        ...(result.paused ? { paused: true } : {}),
      });
      lastInputTokens = result.usage.inputTokens;

      if (result.finishReason === 'content-filter') {
        await this.lifecycle.finalize(runId, 'FAILED', {
          from: ['RUNNING'],
          finishReason: 'refused',
          error: {
            code: 'PROVIDER_REFUSED',
            message: 'The AI provider refused to answer.',
          },
        });
        return;
      }
      if (result.toolCalls.length === 0 && result.paused && !forced) {
        // The provider paused a long server-side turn (a web search still going, #1389): the paused
        // message is in the history; the next step sends it back and the provider carries on.
        continue;
      }
      if (result.toolCalls.length === 0) {
        await this.lifecycle.finalize(runId, 'SUCCEEDED', {
          from: ['RUNNING'],
          finishReason: forced ? 'max_steps' : result.finishReason,
        });
        return;
      }
      if (forced) {
        // The model acted on the forced summary step anyway: answer the calls, end the run.
        await this.lifecycle.finalize(runId, 'SUCCEEDED', {
          from: ['RUNNING'],
          finishReason: 'max_steps',
          fallback: {
            code: 'NOT_AVAILABLE',
            message:
              'The step limit of this run was reached; nothing was executed',
          },
        });
        return;
      }
      // The step boundary: before any call runs, the run must still be ours and not cancelled (the
      // sweeper or a cancel may have moved it while the model was answering).
      const now = await this.prisma.aiRun.findUnique({
        where: { id: runId },
        select: { status: true, cancelRequestedAt: true },
      });
      if (!now || now.status !== 'RUNNING') return;
      if (now.cancelRequestedAt) {
        await this.finalizeCancelled(runId);
        return;
      }

      const ctx: AiExecutionContext = {
        identity,
        channel,
        conversationId: conversation.id,
        runId,
        ...(who.ceiling ? { ceiling: who.ceiling } : {}),
        provenance: {
          provider: conversation.provider,
          model: conversation.model,
        },
      };
      const resolutions: CallResolution[] = [];
      let pendingCount = 0;
      let inputCount = 0;
      let stepUntrusted: AiEntityRef[] = [];
      // An input request pauses on its own: never in a step that also proposes a change (#1388).
      const stepWrites = result.toolCalls.some((call) => {
        const called = toolset.byName.get(call.toolName);
        return !!called && callKindOf(called.descriptor.class) === 'mutation';
      });
      for (const call of result.toolCalls) {
        const resolution = await this.resolveCall(call, {
          ctx: {
            ...ctx,
            untrustedSources: mergeRefs(untrusted, stepUntrusted),
          },
          who,
          toolset,
          toolCallsSoFar: toolCalls,
          pendingCount,
          inputCount,
          stepWrites,
          failures,
        });
        toolCalls += 1;
        if (resolution.kind === 'pending') {
          pendingCount += 1;
          if (resolution.input) inputCount += 1;
        } else if ('output' in resolution.outcome) {
          stepUntrusted = mergeRefs(stepUntrusted, resolution.untrusted ?? []);
        }
        resolutions.push(resolution);
      }
      untrusted = mergeRefs(untrusted, stepUntrusted);

      const outcomes: StepOutcome[] = resolutions.map((resolution) =>
        resolution.kind === 'pending'
          ? {
              toolCallId: resolution.toolCallId,
              invocationId: resolution.action.id,
            }
          : resolution.outcome,
      );
      if (pendingCount > 0) {
        await this.pause(
          run,
          conversation.id,
          {
            stepIndex,
            calls: result.toolCalls.map((call) => ({
              toolCallId: call.toolCallId,
              toolName: call.toolName,
            })),
            outcomes,
            // The whole turn's set, not just this step's: a resume rebuilds it from the records (T-03).
            untrustedSources: untrusted,
          },
          resolutions,
        );
        return;
      }
      const answered = result.toolCalls.map((call, index) => {
        const outcome = outcomes[index] as Extract<
          StepOutcome,
          { output: unknown }
        >;
        return {
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: outcome.output,
          isError: outcome.isError,
        };
      });
      const message = this.model.toolResultsMessage(answered);
      await this.prisma.$transaction((tx) =>
        this.lifecycle.append(tx, conversation.id, runId, [
          { role: roleOf(message), content: message },
        ]),
      );
    }
  }

  // ─── Scope and guardrails ─────────────────────────────────────────────────────────────────────────

  /** Load what a run needs once: its conversation, channel, delegated identity and frozen prompt. */
  private async scope(runId: string): Promise<RunScope | null> {
    const run = await this.prisma.aiRun.findUnique({ where: { id: runId } });
    if (!run) return null;
    const conversation = run.conversationId
      ? await this.prisma.aiConversation.findUnique({
          where: { id: run.conversationId },
        })
      : null;
    if (!conversation) {
      // The owner deleted the conversation while the run was queued or running.
      await this.lifecycle.finalize(runId, 'CANCELLED', {
        from: ['RUNNING'],
        finishReason: 'cancelled',
        error: { code: 'CANCELLED', message: 'The conversation was deleted.' },
      });
      return null;
    }
    const channel = conversation.channel;
    if (channel !== 'CHAT' && channel !== 'HEADLESS') {
      await this.fail(runId, {
        code: 'CONVERSATION_READ_ONLY',
        message: 'This conversation cannot continue on this version.',
      });
      return null;
    }

    let identity: DelegatedIdentity;
    if (run.userId) {
      const record = await this.prisma.aiMessage.findFirst({
        where: {
          conversationId: conversation.id,
          runId,
          format: AI_MESSAGE_FORMAT_RUN,
        },
      });
      const epoch = record ? readRunRecord(record.content)?.sessionEpoch : null;
      if (epoch === null || epoch === undefined) {
        await this.fail(runId, {
          code: 'FORBIDDEN',
          message: 'The session this run was started from is unknown.',
        });
        return null;
      }
      identity = { kind: 'human', userId: run.userId, sessionEpoch: epoch };
    } else if (run.serviceAccountId) {
      identity = { kind: 'service', serviceAccountId: run.serviceAccountId };
    } else {
      await this.fail(runId, {
        code: 'FORBIDDEN',
        message: 'The run has no acting principal.',
      });
      return null;
    }

    const system = await this.prisma.aiMessage.findFirst({
      where: {
        conversationId: conversation.id,
        format: AI_MESSAGE_FORMAT_SYSTEM_PROMPT,
      },
      orderBy: { seq: 'asc' },
    });
    const instructions = system ? readSystemPrompt(system.content) : null;
    if (!instructions) {
      await this.lifecycle.closeConversation(
        conversation.id,
        'VERSION_CHANGED',
      );
      await this.fail(runId, READ_ONLY);
      return null;
    }
    return { run, conversation, channel, identity, instructions };
  }

  /** The per-step guardrails. On a refusal the run is already finalized. */
  private async guard(
    run: AiRun,
    scope: RunScope,
    lastInputTokens: number,
  ): Promise<
    | {
        ok: true;
        who: AiRunPrincipal;
        settings: AiSettings;
        toolset: FrozenToolset;
      }
    | { ok: false }
  > {
    const { conversation } = scope;
    if (run.cancelRequestedAt) {
      await this.finalizeCancelled(run.id);
      return { ok: false };
    }
    const config = await this.settings.resolveProviderConfig();
    if (!config) {
      await this.lifecycle.finalize(run.id, 'CANCELLED', {
        from: ['RUNNING'],
        finishReason: 'cancelled',
        error: {
          code: 'AI_DISABLED',
          message: 'The AI assistant is turned off.',
        },
        fallback: {
          code: 'NOT_AVAILABLE',
          message: 'The AI assistant was turned off; nothing was executed',
        },
      });
      return { ok: false };
    }
    const who = await this.principals.resolve(scope.identity, scope.channel);
    if (!who.ok) {
      await this.fail(run.id, who.refusal);
      return { ok: false };
    }
    if (pinnedConfigChanged(config, conversation)) {
      await this.lifecycle.closeConversation(conversation.id, 'CONFIG_CHANGED');
      await this.fail(run.id, READ_ONLY);
      return { ok: false };
    }
    const toolset = frozenToolset(this.registry, conversation);
    if (conversation.promptVersion !== AI_PROMPT_VERSION || !toolset) {
      await this.lifecycle.closeConversation(
        conversation.id,
        'VERSION_CHANGED',
      );
      await this.fail(run.id, READ_ONLY);
      return { ok: false };
    }
    const settings = await this.settings.getSettings();
    if (webSearchWithdrawn(settings, conversation)) {
      // Web search was turned off after this conversation started with it (#1389): its tool list
      // cannot change, so it ends here — the switch applies at once.
      await this.lifecycle.closeConversation(conversation.id, 'CONFIG_CHANGED');
      await this.fail(run.id, READ_ONLY);
      return { ok: false };
    }
    if (
      await this.limits.budgetExceeded(
        who.value.owner,
        settings.dailyTokenLimitPerPrincipal,
      )
    ) {
      await this.fail(run.id, {
        code: 'BUDGET_EXCEEDED',
        message: 'The daily AI token budget is spent.',
      });
      return { ok: false };
    }
    if (lastInputTokens >= settings.contextTokenLimit) {
      await this.lifecycle.closeConversation(conversation.id, 'CONTEXT_LIMIT');
      await this.fail(run.id, CONTEXT_FULL);
      return { ok: false };
    }
    if (run.stepCount >= settings.maxStepsPerRun) {
      await this.fail(run.id, {
        code: 'MAX_STEPS',
        message: 'The step limit of this run was reached.',
      });
      return { ok: false };
    }
    return { ok: true, who: who.value, settings, toolset };
  }

  // ─── Steps ───────────────────────────────────────────────────────────────────────────────────────

  /** The provider messages of the conversation, in order (runtime records excluded). */
  private async history(conversationId: string): Promise<unknown[]> {
    const rows = await this.prisma.aiMessage.findMany({
      where: { conversationId, format: AI_MESSAGE_FORMAT_MODEL },
      orderBy: { seq: 'asc' },
      select: { content: true },
    });
    return rows.map((row) => row.content);
  }

  /**
   * Persist one model step atomically: the assistant message(s), the step record naming its calls, the
   * `AiUsage` row, and the run's counters.
   */
  private async persistStep(
    run: AiRun,
    scope: RunScope,
    result: ChatModelStepResult,
    stepIndex: number,
    untrusted: AiEntityRef[],
  ): Promise<void> {
    const usage = result.usage;
    await this.prisma.$transaction(async (tx) => {
      const rows: AppendRow[] = result.responseMessages.map((message) => ({
        role: roleOf(message),
        content: message,
      }));
      if (result.webSearch) {
        // Right after the step's assistant message: the sources shown under it, and the run's record
        // that the web was searched (#1389). Never replayed to the model.
        const record: WebSearchRecord = {
          stepIndex,
          searches: result.webSearch.searches,
          queries: result.webSearch.queries,
          sources: result.webSearch.sources,
        };
        rows.push({
          role: AI_RUNTIME_RECORD_ROLE,
          content: record,
          format: AI_MESSAGE_FORMAT_WEB_SEARCH,
        });
      }
      if (result.toolCalls.length > 0) {
        const record: StepRecord = {
          stepIndex,
          calls: result.toolCalls.map((call) => ({
            toolCallId: call.toolCallId,
            toolName: call.toolName,
          })),
          outcomes: [],
          untrustedSources: untrusted,
        };
        rows.push({
          role: AI_RUNTIME_RECORD_ROLE,
          content: record,
          format: AI_MESSAGE_FORMAT_STEP,
        });
      }
      await this.lifecycle.append(tx, scope.conversation.id, run.id, rows);
      await tx.aiUsage.create({
        data: {
          runId: run.id,
          userId: run.userId,
          serviceAccountId: run.serviceAccountId,
          provider: scope.conversation.provider,
          model: scope.conversation.model,
          inputTokens: clampInt4(usage.inputTokens),
          outputTokens: clampInt4(usage.outputTokens),
          cachedInputTokens: clampInt4(usage.cachedInputTokens),
          reasoningTokens:
            usage.reasoningTokens === undefined
              ? null
              : clampInt4(usage.reasoningTokens),
        },
      });
      await tx.aiRun.update({
        where: { id: run.id },
        data: {
          stepCount: { increment: 1 },
          inputTokens: clampInt4(
            run.inputTokens + clampInt4(usage.inputTokens),
          ),
          outputTokens: clampInt4(
            run.outputTokens + clampInt4(usage.outputTokens),
          ),
          cachedInputTokens: clampInt4(
            run.cachedInputTokens + clampInt4(usage.cachedInputTokens),
          ),
        },
      });
      await tx.aiConversation.update({
        where: { id: scope.conversation.id },
        data: { lastActivityAt: new Date() },
      });
    });
  }

  /**
   * Resolve one call. Every path answers it: an unknown tool (looked up in the frozen map, never on a
   * prototype), unparseable arguments (the raw string), a limit, a refusal, or the tool's own result.
   */
  private async resolveCall(
    call: ChatModelToolCall,
    state: {
      ctx: AiExecutionContext;
      who: AiRunPrincipal;
      toolset: FrozenToolset;
      toolCallsSoFar: number;
      pendingCount: number;
      /** Input requests already pending in this step (at most one). */
      inputCount?: number;
      /** Whether this step also calls a tool that changes data. */
      stepWrites?: boolean;
      /** The run's repeated-failure guard (#1403). */
      failures?: RepeatedFailureGuard;
    },
  ): Promise<CallResolution & { untrusted?: AiEntityRef[] }> {
    const runId = state.ctx.runId!;
    const tool = state.toolset.byName.get(call.toolName);
    const awaitsInput = tool?.descriptor.awaitsInput === true;
    const answer = (result: AiToolResult, untrusted?: AiEntityRef[]) => {
      // What the model sees: a failure it keeps repeating carries the guard's stop hint.
      const seen = state.failures
        ? state.failures.record(call.toolName, call.input, result, {
            awaitsInput,
          })
        : result;
      return {
        kind: 'answered' as const,
        outcome: {
          toolCallId: call.toolCallId,
          output: capToolOutput(seen),
          isError: !seen.ok,
        },
        ...(untrusted ? { untrusted } : {}),
      };
    };
    if (!tool) {
      return answer(
        errorResult('read', {
          code: 'NOT_AVAILABLE',
          message: `Unknown tool: ${String(call.toolName).slice(0, 80)}`,
          hint: 'Call only the tools you were given.',
        }),
      );
    }
    const toolClass = tool.descriptor.class;
    const kind = callKindOf(toolClass);
    const name = tool.descriptor.name;
    const refuse = (error: Parameters<typeof errorResult>[1]) => {
      const result = errorResult(kind, error);
      this.emitCall(runId, call, tool, 'FAILED');
      this.emitResult(runId, call.toolCallId, result);
      return answer(result);
    };

    if (typeof call.input === 'string' || call.input === undefined) {
      return refuse({
        code: 'INVALID_INPUT',
        message: 'The arguments were not a valid JSON object',
        hint: 'Send the arguments as a JSON object matching the tool schema.',
      });
    }
    const repeated = state.failures?.check(call.toolName, call.input, {
      awaitsInput,
    });
    if (repeated) {
      return refuse(repeated);
    }
    if (state.toolCallsSoFar >= AI_MAX_TOOL_CALLS_PER_RUN) {
      return refuse({
        code: 'RATE_LIMITED',
        message: 'The tool call limit of this run was reached',
      });
    }
    if (!this.limits.toolCalls.take(principalKey(state.who.owner))) {
      return refuse({
        code: 'RATE_LIMITED',
        message: 'Too many tool calls; wait a moment before calling more',
      });
    }

    if (tool.descriptor.awaitsInput === true) {
      return this.requestInput(call, tool, state, refuse, answer);
    }

    if (kind === 'mutation' && state.ctx.channel === 'CHAT') {
      if (state.pendingCount >= AI_MAX_PENDING_PER_STEP) {
        return refuse({
          code: 'RATE_LIMITED',
          message: `Propose at most ${AI_MAX_PENDING_PER_STEP} changes at a time`,
        });
      }
      const proposal = await this.tools.propose(name, call.input, state.ctx, {
        toolUseId: call.toolCallId,
      });
      if (!proposal.ok) {
        this.emitCall(runId, call, tool, 'FAILED');
        this.emitResult(runId, call.toolCallId, proposal.result);
        return answer(proposal.result);
      }
      let pending = proposal.action;
      if (await this.autoApproveOn(state.ctx)) {
        const auto = await this.autoApprove(call, tool, pending, state.ctx);
        if (auto.kind === 'executed') {
          return answer(auto.result, untrustedRefsOf(auto.result));
        }
        pending = auto.action;
      }
      this.emitCall(runId, call, tool, 'AWAITING_APPROVAL');
      return {
        kind: 'pending',
        toolCallId: call.toolCallId,
        action: pending,
      };
    }

    if (kind === 'mutation') {
      const cap = state.who.maxMutationsPerRun;
      if (cap !== null && (await this.mutationsInRun(runId)) >= cap) {
        return refuse({
          code: 'FORBIDDEN',
          status: 403,
          message: `The mutation cap of this run (${cap}) was reached`,
        });
      }
    }
    this.emitCall(runId, call, tool, 'EXECUTING');
    const result = await this.tools.invoke(name, call.input, state.ctx);
    this.emitResult(runId, call.toolCallId, result);
    return answer(result, untrustedRefsOf(result));
  }

  /**
   * An input request (#1388): the tool validates the form and resolves its `optionsFrom` lists through
   * the routes, as the user (`invoke`); the call then waits AWAITING_INPUT on a stored form, answered by
   * the owner through `POST /ai/runs/:id/tool-calls/:toolCallId/input`. Chat and a human only; one form
   * per step, and never in a step that also changes data (the pause is for the input alone).
   */
  private async requestInput(
    call: ChatModelToolCall,
    tool: RegisteredAiTool,
    state: {
      ctx: AiExecutionContext;
      pendingCount: number;
      inputCount?: number;
      stepWrites?: boolean;
    },
    refuse: (error: Parameters<typeof errorResult>[1]) => CallResolution,
    answer: (result: AiToolResult) => CallResolution,
  ): Promise<CallResolution> {
    const runId = state.ctx.runId!;
    if (state.ctx.channel !== 'CHAT' || state.ctx.identity.kind !== 'human') {
      return refuse({
        code: 'NOT_AVAILABLE',
        message: 'Nobody can answer a form on this channel',
      });
    }
    if (state.stepWrites) {
      return refuse({
        code: 'INVALID_INPUT',
        message:
          'Ask for missing data in a step of its own, before proposing any change',
        hint: 'Call only this tool (and reads) now; propose the changes after the answer.',
      });
    }
    if ((state.inputCount ?? 0) > 0) {
      return refuse({
        code: 'INVALID_INPUT',
        message: 'Ask with one form at a time; put every question in it',
      });
    }
    const result = await this.tools.invoke(
      tool.descriptor.name,
      call.input,
      state.ctx,
    );
    if (!result.ok) {
      this.emitCall(runId, call, tool, 'FAILED');
      this.emitResult(runId, call.toolCallId, result);
      return answer(result);
    }
    const form = AiInputFormSchema.safeParse(
      (result.data as { form?: unknown } | null)?.form,
    );
    if (!form.success) {
      return refuse({
        code: 'INTERNAL',
        message: 'The form could not be built',
      });
    }
    const row = await this.inputs.open({
      ctx: state.ctx,
      toolCallId: call.toolCallId,
      tool,
      input: call.input,
      form: form.data,
    });
    const request = toInputRequest(row);
    if (!request) {
      return refuse({
        code: 'INTERNAL',
        message: 'The form could not be stored',
      });
    }
    this.emitCall(runId, call, tool, 'AWAITING_INPUT');
    return {
      kind: 'pending',
      toolCallId: call.toolCallId,
      action: toPendingAction(row),
      input: request,
    };
  }

  /**
   * Whether this write may be auto-approved NOW (#1376) — read fresh per write, so a toggle mid-run
   * applies to the next proposal. Chat and a human only, and only while the run is not being cancelled
   * and the assistant is on: the same kill switches a manual decision honours (`AI_DISABLED`, a run no
   * longer running). Core re-checks the mode in the claim's transaction.
   */
  private async autoApproveOn(ctx: AiExecutionContext): Promise<boolean> {
    if (
      ctx.channel !== 'CHAT' ||
      ctx.identity.kind !== 'human' ||
      !ctx.conversationId ||
      !ctx.runId
    ) {
      return false;
    }
    const conversation = await this.prisma.aiConversation.findUnique({
      where: { id: ctx.conversationId },
      select: { autoApprove: true, userId: true },
    });
    if (
      conversation?.autoApprove !== true ||
      conversation.userId !== ctx.identity.userId
    ) {
      return false;
    }
    const run = await this.prisma.aiRun.findUnique({
      where: { id: ctx.runId },
      select: { status: true, cancelRequestedAt: true },
    });
    if (!run || run.status !== 'RUNNING' || run.cancelRequestedAt) {
      return false;
    }
    return (await this.settings.resolveProviderConfig()) !== null;
  }

  /**
   * Auto-approve a just-proposed chat write (#1376; ADR-0097 decision 4 as amended 2026-09-24) through
   * core's own `approve` — the same claim, re-authorization, precondition (`STALE`) and ledger as a
   * click, with approval provenance `AUTO`. Core refuses an elevated action, anything whose stored or
   * fresh preview needs a step-up, or that changed since propose: the action then stays pending and the
   * user gets its card,
   * reloaded because core may have added warnings to it. A fault that is not a refusal propagates (the
   * run fails and an executing write becomes OUTCOME_UNKNOWN, as for any other write).
   */
  private async autoApprove(
    call: ChatModelToolCall,
    tool: RegisteredAiTool,
    proposed: AiPendingAction,
    ctx: AiExecutionContext,
  ): Promise<
    | { kind: 'executed'; result: AiToolResult }
    | { kind: 'pending'; action: AiPendingAction }
  > {
    const runId = ctx.runId!;
    let action: AiPendingAction;
    try {
      action = await this.tools.approve(proposed.id, ctx, { auto: true });
    } catch (err) {
      if (!(err instanceof HttpException)) throw err;
      const row = await this.prisma.aiToolInvocation.findUnique({
        where: { id: proposed.id },
      });
      const now = row ? toPendingAction(row) : proposed;
      if (now.status === 'AWAITING_APPROVAL' || !now.result) {
        return { kind: 'pending', action: now };
      }
      // Closed without an approval (e.g. expired in between): answer what it holds.
      this.emitCall(runId, call, tool, 'FAILED');
      this.emitResult(runId, call.toolCallId, now.result);
      return { kind: 'executed', result: now.result };
    }
    if (action.status === 'AWAITING_APPROVAL' || !action.result) {
      return { kind: 'pending', action };
    }
    this.emitCall(runId, call, tool, 'EXECUTING');
    this.lifecycle.emit(runId, {
      type: 'tool.approval_resolved',
      toolCallId: call.toolCallId,
      decision: 'approved',
      auto: true,
      ...(action.preview ? { preview: action.preview } : {}),
    });
    this.emitResult(runId, call.toolCallId, action.result);
    return { kind: 'executed', result: action.result };
  }

  /** Headless writes this run attempted (the per-run mutation cap; refusals do not count). */
  private mutationsInRun(runId: string): Promise<number> {
    return this.prisma.aiToolInvocation.count({
      where: {
        runId,
        toolClass: { in: ['write', 'elevated'] },
        status: { not: 'DENIED' },
      },
    });
  }

  /**
   * Pause for the user: record the step with the answers known so far and the pending invocations, then
   * compare-and-set RUNNING → AWAITING_APPROVAL (pending writes) or AWAITING_INPUT (a pending form,
   * #1388 — never both: a form is refused in a step that changes data), and only then announce the cards
   * or the form — so a decision can never race a run that is not yet waiting. A decision that already
   * landed resumes at once.
   */
  private async pause(
    run: AiRun,
    conversationId: string,
    record: StepRecord,
    resolutions: CallResolution[],
  ): Promise<void> {
    const waiting = resolutions.some(
      (resolution) => resolution.kind === 'pending' && resolution.input,
    )
      ? ('AWAITING_INPUT' as const)
      : ('AWAITING_APPROVAL' as const);
    const paused = await this.prisma.$transaction(async (tx) => {
      await this.lifecycle.append(tx, conversationId, run.id, [
        {
          role: AI_RUNTIME_RECORD_ROLE,
          content: record,
          format: AI_MESSAGE_FORMAT_STEP,
        },
      ]);
      // A cancel requested while the calls were resolved wins: the run never starts waiting.
      const claim = await tx.aiRun.updateMany({
        where: { id: run.id, status: 'RUNNING', cancelRequestedAt: null },
        data: { status: waiting },
      });
      return claim.count > 0;
    });
    if (!paused) {
      // The step record above holds the answers known so far; finalizing cancels the proposals.
      if (await this.cancelRequested(run.id))
        await this.finalizeCancelled(run.id);
      return;
    }
    for (const resolution of resolutions) {
      if (resolution.kind !== 'pending') continue;
      if (resolution.input) {
        this.lifecycle.emit(run.id, {
          type: 'input.required',
          ...resolution.input,
        });
        continue;
      }
      const request = toApprovalRequest(resolution.action);
      if (request) {
        this.lifecycle.emit(run.id, {
          type: 'tool.approval_required',
          ...request,
        });
      }
    }
    this.lifecycle.emit(run.id, { type: 'run.status', status: waiting });
    await this.lifecycle.resumeIfDecided(run.id);
  }

  /** Map a failed model step onto the run (provider-and-runtime.md §6.3; errors carry a code, never a body). */
  private async failStep(
    runId: string,
    conversationId: string,
    err: unknown,
  ): Promise<void> {
    if (!(err instanceof AiProviderError)) throw err;
    switch (err.code) {
      case 'CANCELLED':
        if (await this.cancelRequested(runId)) {
          await this.finalizeCancelled(runId);
          return;
        }
        await this.fail(runId, {
          code: 'PROVIDER_UNAVAILABLE',
          message: err.message,
        });
        return;
      case 'AI_DISABLED':
        await this.lifecycle.finalize(runId, 'CANCELLED', {
          from: ['RUNNING'],
          finishReason: 'cancelled',
          error: { code: 'AI_DISABLED', message: err.message },
        });
        return;
      case 'CONTEXT_LIMIT':
        await this.lifecycle.closeConversation(conversationId, 'CONTEXT_LIMIT');
        await this.fail(runId, CONTEXT_FULL);
        return;
      case 'CONVERSATION_READ_ONLY':
        await this.lifecycle.closeConversation(
          conversationId,
          'CONFIG_CHANGED',
        );
        await this.fail(runId, READ_ONLY);
        return;
      default:
        await this.fail(runId, {
          code: err.code,
          message: err.message,
          ...(err.retryAfterSec !== undefined
            ? { retryAfterSec: clampInt4(err.retryAfterSec) }
            : {}),
        });
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────────────────────────

  private async cancelRequested(runId: string): Promise<boolean> {
    const run = await this.prisma.aiRun.findUnique({
      where: { id: runId },
      select: { cancelRequestedAt: true },
    });
    return !!run?.cancelRequestedAt;
  }

  private finalizeCancelled(runId: string): Promise<boolean> {
    return this.lifecycle.finalize(runId, 'CANCELLED', {
      from: ['RUNNING'],
      finishReason: 'cancelled',
      error: { code: 'CANCELLED', message: 'The run was cancelled.' },
      fallback: CANCELLED_ANSWER,
    });
  }

  private fail(runId: string, error: AiRunError): Promise<boolean> {
    return this.lifecycle.finalize(runId, 'FAILED', {
      from: ['RUNNING'],
      finishReason: 'error',
      error,
    });
  }

  /** How many calls this run already made, and the untrusted sources it read (a resumed run). */
  private async seedCounters(
    runId: string,
    conversation: Pick<AiConversation, 'id' | 'webSearchMaxUses'>,
  ): Promise<{
    toolCalls: number;
    untrusted: AiEntityRef[];
    callIds: Set<string>;
  }> {
    const rows = await this.prisma.aiMessage.findMany({
      where: { runId, format: AI_MESSAGE_FORMAT_STEP },
      orderBy: { seq: 'asc' },
      select: { content: true },
    });
    const latest = new Map<number, StepRecord>();
    for (const row of rows) {
      const record = readStepRecord(row.content);
      if (record) latest.set(record.stepIndex, record);
    }
    let toolCalls = 0;
    const callIds = new Set<string>();
    let untrusted: AiEntityRef[] = [];
    for (const record of latest.values()) {
      toolCalls += record.calls.length;
      for (const call of record.calls) callIds.add(call.toolCallId);
      untrusted = mergeRefs(untrusted, record.untrustedSources);
    }
    // Web search results stay in the history and are replayed to the model on every later turn, so once
    // the conversation has searched ANYWHERE — this run or an earlier one — every turn from then on counts
    // as having read untrusted sources: the banner, and never an auto-approval (#1389, G2 review).
    if (await this.conversationSearched(conversation)) {
      untrusted = mergeRefs(untrusted, [AI_WEB_SEARCH_SOURCE_REF]);
    }
    return { toolCalls, untrusted, callIds };
  }

  /** Whether any step of this conversation searched the web (a `lazyit-web-search-v1` record exists). */
  private async conversationSearched(
    conversation: Pick<AiConversation, 'id' | 'webSearchMaxUses'>,
  ): Promise<boolean> {
    if (typeof conversation.webSearchMaxUses !== 'number') return false;
    const row = await this.prisma.aiMessage.findFirst({
      where: {
        conversationId: conversation.id,
        format: AI_MESSAGE_FORMAT_WEB_SEARCH,
      },
      select: { id: true },
    });
    return row !== null;
  }

  private emitCall(
    runId: string,
    call: ChatModelToolCall,
    tool: RegisteredAiTool,
    status: 'EXECUTING' | 'AWAITING_APPROVAL' | 'AWAITING_INPUT' | 'FAILED',
  ): void {
    const args = summarizeArgs(call.input);
    this.lifecycle.emit(runId, {
      type: 'tool.call',
      toolCallId: call.toolCallId,
      name: tool.descriptor.name,
      kind: callKindOf(tool.descriptor.class),
      class: tool.descriptor.class,
      status,
      ...(args ? { args } : {}),
    });
  }

  private emitResult(
    runId: string,
    toolCallId: string,
    result: AiToolResult,
  ): void {
    this.lifecycle.emit(runId, toolResultEvent(toolCallId, result));
  }
}

/** The `tool.result` event of a finished call. */
export function toolResultEvent(toolCallId: string, result: AiToolResult) {
  return {
    type: 'tool.result' as const,
    toolCallId,
    kind: result.kind,
    status: result.ok ? ('ok' as const) : ('error' as const),
    ...(result.ok && result.summary !== undefined
      ? { summary: result.summary.slice(0, 500) }
      : {}),
    mutated: result.mutated,
    entityRefs: result.entityRefs,
    ...(!result.ok
      ? {
          error: {
            code: result.error.code,
            message: result.error.message.slice(0, 500),
          },
        }
      : {}),
  };
}

const READ_ONLY: AiRunError = {
  code: 'CONVERSATION_READ_ONLY',
  message:
    'This conversation was created with another AI configuration; start a new conversation.',
};

const CONTEXT_FULL: AiRunError = {
  code: 'CONTEXT_LIMIT',
  message: 'This conversation is full; start a new conversation.',
};

const CANCELLED_ANSWER: FallbackAnswer = {
  code: 'NOT_AVAILABLE',
  message: 'The run was cancelled; nothing was executed',
};
