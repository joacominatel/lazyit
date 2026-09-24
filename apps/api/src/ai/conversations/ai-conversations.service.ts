import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AI_RUN_ACTIVE_STATUSES,
  offsetOf,
  type AiConversationDetail,
  type AiConversationSettings,
  type AiConversationState,
  type AiConversationSummary,
  type AiRunAccepted,
  type Page,
  type PageQuery,
  type CreateAiConversation,
  type SendAiMessage,
  type UpdateAiConversation,
} from '@lazyit/shared';
import { Prisma, type AiConversation } from '../../../generated/prisma/client';
import type { DelegatedIdentity } from '../../auth/delegated-identity';
import { PrismaService } from '../../prisma/prisma.service';
import { AI_PROMPT_VERSION } from '../ai.constants';
import {
  AI_SETTINGS_READER,
  type AiSettingsReader,
  type ResolvedAiProviderConfig,
} from '../core/ports/ai-settings.port';
import { AiToolRegistry } from '../core/tool-registry';
import { AgentRunOrchestrator } from '../runtime/agent-run.orchestrator';
import { AiConversationPurgeService } from '../retention/ai-conversation-purge.service';
import { AI_MESSAGE_FORMAT_MODEL } from '../runtime/run-records';
import {
  AI_CONVERSATION_AUTO_APPROVE_AUDIT_ACTION,
  assertModelSettingsSupported,
  conversationSettingsOf,
  pinnedConfigChanged,
} from '../runtime/conversation-settings';
import { projectTranscript } from './transcript-projection';

type HumanIdentity = Extract<DelegatedIdentity, { kind: 'human' }>;

/** The one `{ code, message }` 404 every owner-only read answers — never a hint that the id exists. */
export function conversationNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'NOT_FOUND',
    message: 'Conversation not found',
  });
}

/**
 * The in-app chat's conversations (`/ai/conversations`; synthesis §4.7, frontend.md K3–K4). Owner only:
 * every query is scoped to the caller's user id on the `CHAT` channel, so another user's conversation —
 * an admin's included (ADR-0097 default 3) — is indistinguishable from one that does not exist (404).
 *
 * Creating a conversation and sending a message go through the runtime's {@link AgentRunOrchestrator},
 * which re-authorizes the principal (`ai:use`), refuses while AI is off (409 `AI_DISABLED`) and freezes the
 * conversation. Reading and deleting stay available while AI is off: conversations are kept dormant
 * (frontend.md §11 item 4) until retention removes them.
 */
@Injectable()
export class AiConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: AgentRunOrchestrator,
    private readonly registry: AiToolRegistry,
    @Inject(AI_SETTINGS_READER) private readonly settings: AiSettingsReader,
    private readonly purge: AiConversationPurgeService,
  ) {}

  create(
    identity: HumanIdentity,
    locale?: string,
    settings: CreateAiConversation = {},
  ): Promise<{ id: string }> {
    return this.orchestrator.createConversation({
      identity,
      channel: 'CHAT',
      ...(locale ? { locale } : {}),
      settings,
    });
  }

  /**
   * `PATCH /ai/conversations/:id` (#1373, #1376), owner only (404 otherwise).
   *
   * - `model`, `effort`, `providerOptions`: only until the first run starts (ADR-0097 default 7 as
   *   amended) — afterwards 409 `CONVERSATION_SETTINGS_LOCKED`; a closed conversation 409
   *   `CONVERSATION_READ_ONLY`; the assistant off 409 `AI_DISABLED` (the provider rules need the
   *   configuration). The lock is a conditional update on "no run yet", so a message racing the change
   *   either sees the new model or the change is refused.
   * - `autoApprove`: any time, AI on or off; takes effect at the next proposed write. Each change writes
   *   an `ai_config_audit_log` row (actor = the owner, `{ conversationId, before, after }`).
   */
  async update(
    identity: HumanIdentity,
    conversationId: string,
    patch: UpdateAiConversation,
  ): Promise<AiConversationSettings> {
    const conversation = await this.owned(identity, conversationId);
    const modelFields =
      patch.model !== undefined ||
      patch.effort !== undefined ||
      patch.providerOptions !== undefined;

    const data: Prisma.AiConversationUpdateManyMutationInput = {};
    if (modelFields) {
      if (conversation.closedReason !== null) {
        throw new ConflictException({
          code: 'CONVERSATION_READ_ONLY',
          message: 'This conversation is read-only; start a new conversation',
        });
      }
      const config = await this.settings.resolveProviderConfig();
      if (!config) {
        throw new ConflictException({
          code: 'AI_DISABLED',
          message: 'The AI assistant is not available',
        });
      }
      if (config.provider !== conversation.provider) {
        throw new ConflictException({
          code: 'CONVERSATION_READ_ONLY',
          message: 'This conversation is read-only; start a new conversation',
        });
      }
      assertModelSettingsSupported(config.provider, patch);
      if (patch.model !== undefined) {
        data.model = patch.model;
        data.modelChosen = true;
      }
      if (patch.effort !== undefined) data.effort = patch.effort;
      if (patch.providerOptions !== undefined) {
        data.providerOptions =
          patch.providerOptions === null
            ? Prisma.DbNull
            : patch.providerOptions;
      }
    }
    const toggled =
      patch.autoApprove !== undefined &&
      patch.autoApprove !== conversation.autoApprove;
    if (toggled) {
      data.autoApprove = patch.autoApprove;
      data.autoApproveEnabledAt = patch.autoApprove ? new Date() : null;
    }

    if (Object.keys(data).length > 0) {
      await this.prisma.$transaction(async (tx) => {
        // The update takes the conversation row's lock — the same lock a submission takes before it
        // creates a run — so the run count read after it is settled.
        const updated = await tx.aiConversation.updateMany({
          where: {
            id: conversation.id,
            userId: identity.userId,
            channel: 'CHAT',
            ...(modelFields ? { closedReason: null } : {}),
          },
          data,
        });
        if (
          updated.count === 0 ||
          (modelFields &&
            (await tx.aiRun.count({
              where: { conversationId: conversation.id },
            })) > 0)
        ) {
          throw new ConflictException({
            code: 'CONVERSATION_SETTINGS_LOCKED',
            message:
              'The model of a conversation is fixed once it has started; start a new conversation',
          });
        }
        if (toggled) {
          await tx.aiConfigAuditLog.create({
            data: {
              action: AI_CONVERSATION_AUTO_APPROVE_AUDIT_ACTION,
              actorId: identity.userId,
              detail: {
                conversationId: conversation.id,
                before: conversation.autoApprove,
                after: patch.autoApprove === true,
              },
            },
          });
        }
      });
    }
    const now = await this.owned(identity, conversationId);
    return conversationSettingsOf(now, await this.hasRun(now.id));
  }

  async send(
    identity: HumanIdentity,
    conversationId: string,
    body: SendAiMessage,
  ): Promise<AiRunAccepted> {
    const run = await this.orchestrator.submit({
      identity,
      channel: 'CHAT',
      text: body.text,
      conversationId,
      ...(body.context ? { context: body.context } : {}),
    });
    return { runId: run.runId, status: run.status };
  }

  async list(
    identity: HumanIdentity,
    query: PageQuery,
  ): Promise<Page<AiConversationSummary>> {
    const where = { userId: identity.userId, channel: 'CHAT' };
    const [rows, total] = await Promise.all([
      this.prisma.aiConversation.findMany({
        where,
        orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
        ...offsetOf(query),
      }),
      this.prisma.aiConversation.count({ where }),
    ]);
    const states = await this.states(rows.map((row) => row.id));
    const config = await this.settings.resolveProviderConfig();
    return {
      items: rows.map((row) =>
        this.summary(row, states.get(row.id)?.state ?? 'idle', config),
      ),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  async detail(
    identity: HumanIdentity,
    conversationId: string,
  ): Promise<AiConversationDetail> {
    const conversation = await this.owned(identity, conversationId);
    const [rows, invocations, runs, config] = await Promise.all([
      this.prisma.aiMessage.findMany({
        // The allow-list, at the query AND again in the projection.
        where: { conversationId, format: AI_MESSAGE_FORMAT_MODEL },
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
        where: { conversationId, toolUseId: { not: null } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.aiRun.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          status: true,
          error: true,
          createdAt: true,
          finishedAt: true,
        },
      }),
      this.settings.resolveProviderConfig(),
    ]);
    const active = runs.find((run) =>
      (AI_RUN_ACTIVE_STATUSES as readonly string[]).includes(run.status),
    );
    return {
      ...this.summary(conversation, stateOf(active?.status), config),
      activeRunId: active?.id ?? null,
      settings: conversationSettingsOf(conversation, runs.length > 0),
      messages: projectTranscript({
        conversationId,
        rows,
        invocations,
        runs,
        classOf: (name) => this.registry.get(name)?.descriptor.class,
      }),
    };
  }

  /**
   * Hard-delete the owner's conversation through the retention unit's purge service (W3-6), the only
   * deleter of transcripts: 404 for anyone but the owner, 409 `RUN_IN_PROGRESS` while a run is active.
   * Messages and invocations cascade; runs, usage and the `ai_action_log` ledger are kept.
   */
  remove(identity: HumanIdentity, conversationId: string): Promise<void> {
    return this.purge.deleteOwned(identity, conversationId);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────────────────────────

  private async owned(
    identity: HumanIdentity,
    conversationId: string,
  ): Promise<AiConversation> {
    const conversation = await this.prisma.aiConversation.findFirst({
      where: { id: conversationId, userId: identity.userId, channel: 'CHAT' },
    });
    if (!conversation) throw conversationNotFound();
    return conversation;
  }

  private async hasRun(conversationId: string): Promise<boolean> {
    return (await this.prisma.aiRun.count({ where: { conversationId } })) > 0;
  }

  private async states(
    conversationIds: string[],
  ): Promise<Map<string, { state: AiConversationState }>> {
    if (conversationIds.length === 0) return new Map();
    const active = await this.prisma.aiRun.findMany({
      where: {
        conversationId: { in: conversationIds },
        status: { in: [...AI_RUN_ACTIVE_STATUSES] },
      },
      select: { conversationId: true, status: true },
    });
    const out = new Map<string, { state: AiConversationState }>();
    for (const run of active) {
      if (run.conversationId) {
        out.set(run.conversationId, { state: stateOf(run.status) });
      }
    }
    return out;
  }

  private summary(
    row: AiConversation,
    status: AiConversationState,
    config: ResolvedAiProviderConfig | null,
  ): AiConversationSummary {
    return {
      id: row.id,
      title: row.title,
      updatedAt: row.lastActivityAt.toISOString(),
      status,
      readOnly: readOnly(row, config),
    };
  }
}

function stateOf(status: string | undefined): AiConversationState {
  if (status === 'AWAITING_APPROVAL') return 'awaiting-approval';
  if (status === 'AWAITING_INPUT') return 'awaiting-input';
  if (status === 'QUEUED' || status === 'RUNNING') return 'running';
  return 'idle';
}

/**
 * Whether the conversation can take no more messages: closed, or pinned to a prompt version, provider or
 * model this instance no longer runs (the runtime closes it on the next submission; the web can say so
 * now). The toolset pin is checked only by the runtime. AI switched off does not make it read-only.
 */
function readOnly(
  row: AiConversation,
  config: ResolvedAiProviderConfig | null,
): boolean {
  if (row.closedReason !== null) return true;
  if (row.promptVersion !== AI_PROMPT_VERSION) return true;
  return config !== null && pinnedConfigChanged(config, row);
}
