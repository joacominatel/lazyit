import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AI_PROMPT_MAX_LENGTH,
  AI_RUN_ACTIVE_STATUSES,
  AI_RUN_WAITING_STATUSES,
  AI_RUN_TERMINAL_STATUSES,
  type AiConversationChannel,
  type AiPageContext,
  type CreateAiConversation,
  type AiRunStatus,
} from '@lazyit/shared';
import type { AiConversation, AiRun } from '../../../generated/prisma/client';
import type { DelegatedIdentity } from '../../auth/delegated-identity';
import { PrismaService } from '../../prisma/prisma.service';
import { AI_PROMPT_VERSION } from '../ai.constants';
import { AiToolService } from '../core/ai-tool.service';
import {
  AI_SETTINGS_READER,
  type AiSettingsReader,
} from '../core/ports/ai-settings.port';
import {
  CHAT_MODEL_PORT,
  type ChatModelPort,
} from '../core/ports/chat-model.port';
import { AiToolRegistry } from '../core/tool-registry';
import { messagePhrase, phrase } from '../core/sentences';
import { AiPromptService } from '../prompt/ai-prompt.module';
import { AgentLoop, frozenToolset } from './agent-loop';
import {
  AI_CONVERSATION_AUTO_APPROVE_AUDIT_ACTION,
  assertModelSettingsSupported,
  frozenWebSearchMaxUses,
  pinnedConfigChanged,
  webSearchWithdrawn,
} from './conversation-settings';
import {
  AiRunLimits,
  neutralizeTurnContext,
  principalKey,
  toolsetHashOf,
} from './limits';
import { AiRunPrincipals, type AiRunPrincipal } from './principal-context';
import { AiRunLifecycle } from './run-lifecycle';
import { AiRunQueue } from './run-queue';
import {
  AI_MESSAGE_FORMAT_RUN,
  AI_MESSAGE_FORMAT_SYSTEM_PROMPT,
  AI_RUNTIME_RECORD_ROLE,
  roleOf,
} from './run-records';
import {
  AI_MAX_ACTIVE_RUNS_PER_PRINCIPAL,
  describeError,
} from './runtime.constants';

/** A refused request: the HTTP status and the `{ code, message }` body the endpoints answer as is. */
function refusal(
  status: HttpStatus,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  const body = { code, message, ...extra };
  switch (status) {
    case HttpStatus.FORBIDDEN:
      return new ForbiddenException(body);
    case HttpStatus.NOT_FOUND:
      return new NotFoundException(body);
    case HttpStatus.CONFLICT:
      return new ConflictException(body);
    default:
      return new HttpException(body, status);
  }
}

export interface CreateConversationInput {
  identity: DelegatedIdentity;
  channel: AiConversationChannel;
  /** The interface locale for the frozen prompt (BCP 47; anything else becomes `en`). */
  locale?: string;
  /**
   * Chat only: the user's model and approval settings (#1373, #1376), validated by the shared schema;
   * the per-provider rules are checked here against the configured provider.
   */
  settings?: CreateAiConversation;
}

export interface SubmitRunInput {
  identity: DelegatedIdentity;
  channel: AiConversationChannel;
  /** The user message or the headless prompt (already validated by the shared zod schema). */
  text: string;
  /** Continue this conversation; a new one is created when absent. */
  conversationId?: string;
  /** Chat only: the page the user is on (only the route enters the turn context). */
  context?: AiPageContext;
  /** Headless: the `Idempotency-Key` header. */
  idempotencyKey?: string;
  locale?: string;
}

export interface SubmittedRun {
  runId: string;
  conversationId: string;
  status: AiRunStatus;
  /** True when an earlier submission with the same idempotency key was returned. */
  replayed: boolean;
}

/**
 * THE RUN ORCHESTRATOR (provider-and-runtime.md §6, §8, §10; synthesis §4.4, §4.7) — the service API the
 * HTTP surfaces (W3-1: `/ai/conversations`, `/ai/runs`) call. It never runs the loop itself: it validates
 * and persists, and the `ai-run` worker runs the loop from Postgres.
 *
 * - `createConversation` — freezes the conversation: the provider and model, the prompt version, the
 *   toolset the principal holds now (names + definitions hash) and the system prompt text (seq 0).
 * - `submit` — one user message (chat) or one prompt (headless): guardrails, one active run per
 *   conversation, the user message with its turn context, and the start job (`{ runId }` only).
 * - `cancel` — owner only; a QUEUED, AWAITING_APPROVAL or AWAITING_INPUT run ends now, a RUNNING one at its next step
 *   boundary (the in-flight model call is aborted when it runs in this process).
 *
 * Refusals throw Nest HTTP exceptions with `{ code, message }` bodies (the core decision-endpoint style).
 */
@Injectable()
export class AgentRunOrchestrator {
  private readonly logger = new Logger(AgentRunOrchestrator.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AI_SETTINGS_READER) private readonly settings: AiSettingsReader,
    @Inject(CHAT_MODEL_PORT) private readonly model: ChatModelPort,
    private readonly tools: AiToolService,
    private readonly registry: AiToolRegistry,
    private readonly prompts: AiPromptService,
    private readonly principals: AiRunPrincipals,
    private readonly limits: AiRunLimits,
    private readonly lifecycle: AiRunLifecycle,
    private readonly queue: AiRunQueue,
    private readonly loop: AgentLoop,
  ) {}

  /** Create and freeze a conversation for the principal (`POST /ai/conversations`). */
  async createConversation(
    input: CreateConversationInput,
  ): Promise<{ id: string }> {
    const who = await this.authorize(input.identity, input.channel);
    const conversation = await this.freezeConversation(
      who,
      input.locale,
      input.channel === 'CHAT' ? input.settings : undefined,
    );
    return { id: conversation.id };
  }

  /** Submit a message or a headless prompt → the run to follow (`202 { runId, status }`). */
  async submit(input: SubmitRunInput): Promise<SubmittedRun> {
    const text = input.text.trim();
    if (text.length === 0 || text.length > AI_PROMPT_MAX_LENGTH) {
      throw refusal(HttpStatus.BAD_REQUEST, 'INVALID_INPUT', 'Invalid prompt');
    }
    const who = await this.authorize(input.identity, input.channel);
    const owner = who.owner;

    if (input.idempotencyKey) {
      const existing = await this.findIdempotent(owner, input.idempotencyKey);
      if (existing) return this.accepted(existing, true);
    }

    const settings = await this.settings.getSettings();
    const key = principalKey(owner);
    if (!this.limits.runCreations.take(key)) {
      throw refusal(
        HttpStatus.TOO_MANY_REQUESTS,
        'RATE_LIMITED',
        'Too many runs started; wait a moment',
        { retryAfterSec: this.limits.runCreations.retryAfterSec(key) },
      );
    }
    if (
      (await this.limits.activeRuns(owner)) >= AI_MAX_ACTIVE_RUNS_PER_PRINCIPAL
    ) {
      throw refusal(
        HttpStatus.TOO_MANY_REQUESTS,
        'RATE_LIMITED',
        `At most ${AI_MAX_ACTIVE_RUNS_PER_PRINCIPAL} runs may be active at once`,
      );
    }
    if (
      await this.limits.budgetExceeded(
        owner,
        settings.dailyTokenLimitPerPrincipal,
      )
    ) {
      throw refusal(
        HttpStatus.TOO_MANY_REQUESTS,
        'BUDGET_EXCEEDED',
        'The daily AI token budget is spent',
      );
    }

    const conversation = input.conversationId
      ? await this.continuable(
          who,
          input.conversationId,
          settings.contextTokenLimit,
        )
      : await this.freezeConversation(who, input.locale);

    const activeHere = await this.prisma.aiRun.count({
      where: {
        conversationId: conversation.id,
        status: { in: [...AI_RUN_ACTIVE_STATUSES] },
      },
    });
    if (activeHere > 0) {
      throw refusal(
        HttpStatus.CONFLICT,
        'RUN_IN_PROGRESS',
        'A run is already active in this conversation',
      );
    }
    // Repair: a run that ended while its step could not be answered leaves it open; answer it before
    // the new user message so the history stays valid for the provider. (Only with no active run: an
    // active run's open step is the one its approvals are waiting on.)
    await this.lifecycle.answerOpenStep(conversation.id, null).catch((err) => {
      this.logger.error(
        `AI conversation ${conversation.id}: the open step could not be answered: ${describeError(err)}`,
      );
      throw refusal(
        HttpStatus.CONFLICT,
        'RUN_IN_PROGRESS',
        'The previous turn is still being finalized; try again',
      );
    });

    const turn = this.prompts.turnContext({
      now: new Date(),
      route: input.channel === 'CHAT' ? input.context?.route : null,
    });
    const message = this.model.userMessage(
      `${turn}\n\n${neutralizeTurnContext(text)}`,
    );

    let run: AiRun;
    try {
      run = await this.prisma.$transaction(async (tx) => {
        // Lock the conversation row: two submissions to one conversation serialize here, so the
        // active-run check below sees the other's committed run (one active run per conversation).
        const locked = await tx.aiConversation.updateMany({
          where: { id: conversation.id, closedReason: null },
          data: {
            lastActivityAt: new Date(),
            ...(conversation.title === null ? { title: titleOf(text) } : {}),
          },
        });
        if (locked.count === 0) {
          throw refusal(
            HttpStatus.CONFLICT,
            'CONVERSATION_READ_ONLY',
            'This conversation is read-only; start a new conversation',
          );
        }
        const active = await tx.aiRun.count({
          where: {
            conversationId: conversation.id,
            status: { in: [...AI_RUN_ACTIVE_STATUSES] },
          },
        });
        if (active > 0) {
          throw refusal(
            HttpStatus.CONFLICT,
            'RUN_IN_PROGRESS',
            'A run is already active in this conversation',
          );
        }
        // The pin as it is under the lock (#1373): a model change that committed between the read above
        // and this lock is what the run will use, so the run row records exactly that.
        const pinned = await tx.aiConversation.findUniqueOrThrow({
          where: { id: conversation.id },
          select: { provider: true, model: true },
        });
        const created = await tx.aiRun.create({
          data: {
            conversationId: conversation.id,
            channel: input.channel,
            userId: owner.userId,
            serviceAccountId: owner.serviceAccountId,
            status: 'QUEUED',
            approvalPolicy:
              input.channel === 'CHAT'
                ? 'REQUIRE_APPROVAL_FOR_WRITES'
                : 'AUTONOMOUS',
            provider: pinned.provider,
            model: pinned.model,
            idempotencyKey: input.idempotencyKey ?? null,
          },
        });
        await this.lifecycle.append(tx, conversation.id, created.id, [
          {
            role: AI_RUNTIME_RECORD_ROLE,
            format: AI_MESSAGE_FORMAT_RUN,
            content: {
              runId: created.id,
              sessionEpoch:
                input.identity.kind === 'human'
                  ? input.identity.sessionEpoch
                  : null,
            },
          },
          { role: roleOf(message), content: message },
        ]);
        return created;
      });
    } catch (err) {
      if (input.idempotencyKey && isUniqueViolation(err)) {
        const existing = await this.findIdempotent(owner, input.idempotencyKey);
        if (existing) return this.accepted(existing, true);
      }
      throw err;
    }

    this.lifecycle.emit(run.id, { type: 'run.status', status: 'QUEUED' });
    await this.queue.enqueueStart(run.id);
    return this.accepted(run, false);
  }

  /**
   * Cancel a run (`POST /ai/runs/:id/cancel`), owner only (anyone else: 404). Idempotent: a finished run
   * is returned as it is.
   */
  async cancel(
    runId: string,
    identity: DelegatedIdentity,
  ): Promise<{ runId: string; status: AiRunStatus }> {
    const run = await this.ownedRun(runId, identity);
    if ((AI_RUN_TERMINAL_STATUSES as readonly string[]).includes(run.status)) {
      return { runId, status: run.status as AiRunStatus };
    }
    await this.prisma.aiRun.updateMany({
      where: { id: runId, cancelRequestedAt: null },
      data: { cancelRequestedAt: new Date() },
    });
    const ended = await this.lifecycle.finalize(runId, 'CANCELLED', {
      from: ['QUEUED', ...AI_RUN_WAITING_STATUSES],
      finishReason: 'cancelled',
      error: { code: 'CANCELLED', message: 'The run was cancelled.' },
      fallback: {
        code: 'NOT_AVAILABLE',
        ...messagePhrase(phrase('refusal.runCancelledNothingExecuted')),
      },
    });
    if (!ended) {
      // RUNNING: the loop observes the request at its next step boundary; abort the model call now.
      this.loop.abort(runId);
    }
    const now = await this.prisma.aiRun.findUniqueOrThrow({
      where: { id: runId },
    });
    return { runId, status: now.status as AiRunStatus };
  }

  /** A run owned by the identity, or 404 (never a hint that someone else's run exists). */
  async ownedRun(runId: string, identity: DelegatedIdentity): Promise<AiRun> {
    const run = await this.prisma.aiRun.findUnique({ where: { id: runId } });
    const owned =
      run &&
      (identity.kind === 'human'
        ? run.userId === identity.userId
        : run.serviceAccountId === identity.serviceAccountId);
    if (!owned) {
      throw refusal(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Run not found');
    }
    return run;
  }

  // ─── Internals ───────────────────────────────────────────────────────────────────────────────────

  /** The principal, cleared to use the channel now, with AI enabled. */
  private async authorize(
    identity: DelegatedIdentity,
    channel: AiConversationChannel,
  ): Promise<AiRunPrincipal> {
    const who = await this.principals.resolve(identity, channel);
    if (!who.ok) {
      throw refusal(
        HttpStatus.FORBIDDEN,
        who.refusal.code,
        who.refusal.message,
      );
    }
    if (!(await this.settings.resolveProviderConfig())) {
      throw refusal(
        HttpStatus.CONFLICT,
        'AI_DISABLED',
        'The AI assistant is not available',
      );
    }
    return who.value;
  }

  /**
   * Create the conversation, frozen: the configured provider and model, `AI_PROMPT_VERSION`, the toolset
   * `AiToolService.list` gives this principal now, and the system prompt built ONCE from it (tools §12).
   */
  private async freezeConversation(
    who: AiRunPrincipal,
    locale: string | undefined,
    chosen: CreateAiConversation = {},
  ): Promise<AiConversation> {
    const config = await this.settings.resolveProviderConfig();
    if (!config) {
      throw refusal(
        HttpStatus.CONFLICT,
        'AI_DISABLED',
        'The AI assistant is not available',
      );
    }
    assertModelSettingsSupported(config.provider, chosen);
    const settings = await this.settings.getSettings();
    const listing = await this.tools.list({
      identity: who.identity,
      channel: who.channel,
      ...(who.ceiling ? { ceiling: who.ceiling } : {}),
    });
    const tools = listing
      .map((entry) => this.registry.get(entry.name))
      .filter((tool) => tool !== undefined);
    const model = chosen.model ?? config.model;
    // Provider-native web search (#1389), frozen with the toolset: chat only, when on and supported.
    const webSearchMaxUses = frozenWebSearchMaxUses(
      who.channel,
      config.provider,
      model,
      settings,
    );
    const prompt = this.prompts.systemPrompt({
      channel: who.channel,
      principal: who.prompt,
      locale: locale ?? 'en',
      tools: tools.map((tool) => ({ class: tool.descriptor.class })),
      instructions: settings.instructions,
      webSearch: webSearchMaxUses !== null,
    });
    return this.prisma.$transaction(async (tx) => {
      const conversation = await tx.aiConversation.create({
        data: {
          channel: who.channel,
          userId: who.owner.userId,
          serviceAccountId: who.owner.serviceAccountId,
          provider: config.provider,
          // The user's model (#1373), or the instance default — which then keeps the old pin rule.
          model,
          modelChosen: chosen.model !== undefined,
          effort: chosen.effort ?? null,
          ...(chosen.providerOptions
            ? { providerOptions: chosen.providerOptions }
            : {}),
          autoApprove: chosen.autoApprove === true,
          autoApproveEnabledAt: chosen.autoApprove === true ? new Date() : null,
          promptVersion: prompt.version,
          toolsetHash: toolsetHashOf(tools),
          toolNames: tools.map((tool) => tool.descriptor.name).sort(),
          webSearchMaxUses,
        },
      });
      if (conversation.autoApprove && who.owner.userId) {
        // Switching auto-approve on is audited, at creation as on a later toggle (#1376).
        await tx.aiConfigAuditLog.create({
          data: {
            action: AI_CONVERSATION_AUTO_APPROVE_AUDIT_ACTION,
            actorId: who.owner.userId,
            detail: {
              conversationId: conversation.id,
              before: false,
              after: true,
            },
          },
        });
      }
      await this.lifecycle.append(tx, conversation.id, null, [
        {
          role: AI_RUNTIME_RECORD_ROLE,
          format: AI_MESSAGE_FORMAT_SYSTEM_PROMPT,
          content: { text: prompt.text },
        },
      ]);
      return conversation;
    });
  }

  /**
   * An existing conversation the principal owns on this channel (else 404) that can still take a message:
   * not closed, still pinned to the configured provider, model, prompt version and toolset (else it is
   * closed now), and under the context cap.
   */
  private async continuable(
    who: AiRunPrincipal,
    conversationId: string,
    contextTokenLimit: number,
  ): Promise<AiConversation> {
    const conversation = await this.prisma.aiConversation.findUnique({
      where: { id: conversationId },
    });
    const owned =
      conversation &&
      conversation.channel === who.channel &&
      (who.owner.userId
        ? conversation.userId === who.owner.userId
        : conversation.serviceAccountId === who.owner.serviceAccountId);
    if (!owned) {
      throw refusal(
        HttpStatus.NOT_FOUND,
        'NOT_FOUND',
        'Conversation not found',
      );
    }
    const readOnly = () =>
      refusal(
        HttpStatus.CONFLICT,
        'CONVERSATION_READ_ONLY',
        'This conversation is read-only; start a new conversation',
      );
    if (conversation.closedReason) throw readOnly();
    const config = await this.settings.resolveProviderConfig();
    if (
      config &&
      (pinnedConfigChanged(config, conversation) ||
        webSearchWithdrawn(await this.settings.getSettings(), conversation))
    ) {
      await this.lifecycle.closeConversation(conversation.id, 'CONFIG_CHANGED');
      throw readOnly();
    }
    if (
      conversation.promptVersion !== AI_PROMPT_VERSION ||
      !frozenToolset(this.registry, conversation)
    ) {
      await this.lifecycle.closeConversation(
        conversation.id,
        'VERSION_CHANGED',
      );
      throw readOnly();
    }
    if (
      (await this.limits.lastInputTokens(conversation.id)) >= contextTokenLimit
    ) {
      await this.lifecycle.closeConversation(conversation.id, 'CONTEXT_LIMIT');
      throw readOnly();
    }
    return conversation;
  }

  private findIdempotent(
    owner: { userId: string | null; serviceAccountId: string | null },
    idempotencyKey: string,
  ): Promise<AiRun | null> {
    return this.prisma.aiRun.findFirst({
      where: owner.userId
        ? { userId: owner.userId, idempotencyKey }
        : { serviceAccountId: owner.serviceAccountId, idempotencyKey },
    });
  }

  private accepted(run: AiRun, replayed: boolean): SubmittedRun {
    return {
      runId: run.id,
      conversationId: run.conversationId ?? '',
      status: run.status as AiRunStatus,
      replayed,
    };
  }
}

/** The conversation title: the first line of the first message, short. */
function titleOf(text: string): string {
  const line = text.split('\n')[0]?.trim() ?? '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { code?: unknown }).code === 'P2002'
  );
}
