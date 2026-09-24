import { Injectable } from '@nestjs/common';
import type {
  AiActionLogEvent,
  AiChannel,
  AiEntityRef,
  AiToolClass,
} from '@lazyit/shared';
import type { Prisma } from '../../../generated/prisma/client';
import type { DelegatedIdentity } from '../../auth/delegated-identity';
import { PrismaService } from '../../prisma/prisma.service';
import { redactInput } from './redaction';

/** One ledger event to append (tools-and-execution.md §10; synthesis §4.4, §6). */
export interface AiActionLogEntry {
  invocationId: string;
  event: AiActionLogEvent;
  channel: AiChannel;
  toolName: string;
  toolClass: AiToolClass;
  /** The acting principal — a human XOR a Service Account (at most one, CHECK `ai_action_log_one_actor`). */
  actor: { userId?: string | null; serviceAccountId?: string | null };
  conversationId?: string | null;
  runId?: string | null;
  mcpClientId?: string | null;
  oauthGrantId?: string | null;
  /** The canonical input. REDACTED here, always — callers pass the raw value. */
  input?: unknown;
  entityRefs?: readonly AiEntityRef[];
  /** Chat approval provenance: the approving human and whether a password step-up was verified. */
  approverUserId?: string | null;
  stepUp?: boolean;
  untrustedSources?: readonly AiEntityRef[];
  provider?: string | null;
  model?: string | null;
  requestId?: string | null;
  error?: { code: string; status?: number; message: string } | null;
}

/** The ledger actor columns for a delegated identity. */
export function actorOf(
  identity: DelegatedIdentity,
): AiActionLogEntry['actor'] {
  return identity.kind === 'human'
    ? { userId: identity.userId }
    : { serviceAccountId: identity.serviceAccountId };
}

/** Bound on the stored error message (a mapped tool error is already short and never a 5xx internal). */
const ERROR_MESSAGE_MAX = 500;

/**
 * THE single writer of `AiActionLog` — the permanent, append-only ledger of AI-initiated mutations on
 * every channel (R6, INV-AI-10). It only ever INSERTS: there is no update, upsert or delete here, the
 * database trigger `ai_action_log_append_only` rejects them anyway, and `action-log.service.spec.ts`
 * fails if any production file reaches `aiActionLog` other than through `create`.
 *
 * The input is redacted here (`redaction.ts`), so no caller can write a raw secret by forgetting to.
 */
@Injectable()
export class AiActionLogService {
  constructor(private readonly prisma: PrismaService) {}

  async append(entry: AiActionLogEntry): Promise<void> {
    const userId = entry.actor.userId ?? null;
    // At most one actor, by construction (the CHECK would refuse both).
    const serviceAccountId = userId
      ? null
      : (entry.actor.serviceAccountId ?? null);
    const data: Prisma.AiActionLogUncheckedCreateInput = {
      invocationId: entry.invocationId,
      event: entry.event,
      channel: entry.channel,
      toolName: entry.toolName,
      toolClass: entry.toolClass,
      userId,
      serviceAccountId,
      conversationId: entry.conversationId ?? null,
      runId: entry.runId ?? null,
      mcpClientId: entry.mcpClientId ?? null,
      oauthGrantId: entry.oauthGrantId ?? null,
      approverUserId: entry.approverUserId ?? null,
      stepUp: entry.stepUp ?? false,
      provider: entry.provider ?? null,
      model: entry.model ?? null,
      requestId: entry.requestId ?? null,
      errorCode: entry.error?.code ?? null,
      errorStatus: entry.error?.status ?? null,
      errorMessage: entry.error
        ? entry.error.message.slice(0, ERROR_MESSAGE_MAX)
        : null,
    };
    if (entry.input !== undefined) {
      data.input = redactInput(entry.input) as Prisma.InputJsonValue;
    }
    if (entry.entityRefs && entry.entityRefs.length > 0) {
      data.entityRefs = toJson(entry.entityRefs);
    }
    if (entry.untrustedSources && entry.untrustedSources.length > 0) {
      data.untrustedSources = toJson(entry.untrustedSources);
    }
    await this.prisma.aiActionLog.create({ data });
  }
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
